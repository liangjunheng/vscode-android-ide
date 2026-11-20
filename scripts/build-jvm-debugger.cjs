const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const UPSTREAM = path.join(ROOT, 'src', 'android-debugger', 'jvm-debugger', 'upstream');
const ADAPTER = path.join(UPSTREAM, 'adapter');
const OUTPUT = path.join(ROOT, 'resources', 'jvm-debugger', 'kotlin-debug-adapter.jar');
const MAVEN_VERSION = '3.9.16';
const MAVEN_SHA512 = '831a8591fe20c8243b1dbe7d71e3244f31d1665b0804b2e825e38cbbe5ce0cafb8338851f90780735568773e0a6cd07bbec107cda0b896b008b861075358b6f6';

function fail(message) { throw new Error(`[jvm-debugger] ${message}`); }

/** 回归：tests/jvm-build.test.js；固定候选顺序，避免构建依赖未经验证的用户 shell。 */
function executable(home, name) {
  if (!home) return undefined;
  const suffix = process.platform === 'win32' ? `${name}.cmd` : name;
  const candidate = path.join(home, 'bin', suffix);
  return fs.existsSync(candidate) ? candidate : undefined;
}

/** 回归：tests/jvm-build.test.js；只接受本机已安装 Maven，缺失时明确报错。 */
function findMaven(env = process.env) {
  const candidates = [
    executable(env.MAVEN_HOME, 'mvn'),
    executable(env.M2_HOME, 'mvn'),
    executable(path.join(ROOT, 'tools', 'maven'), 'mvn'),
    ...(env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, process.platform === 'win32' ? 'mvn.cmd' : 'mvn')),
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate));
}

/** 下载 Maven 归档并完整关闭请求、响应和文件流；回归测试覆盖重定向、HTTP/网络错误及半成品清理。 */
function download(url, destination) {
  return new Promise((resolve, reject) => {
    const https = require('node:https');
    let settled = false;
    let request;
    let response;
    let output;
    const cleanup = () => {
      response?.destroy();
      output?.destroy();
      request?.destroy();
    };
    const failDownload = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    request = https.get(url, nextResponse => {
      response = nextResponse;
      response.on('error', failDownload);
      response.on('aborted', () => failDownload(new Error('Maven download response was aborted')));
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        response.once('end', () => {
          response.destroy();
          download(new URL(response.headers.location, url).toString(), destination).then(succeed, failDownload);
        });
        return;
      }
      if (status !== 200) {
        failDownload(new Error(`Maven download failed with HTTP ${status}`));
        return;
      }
      output = fs.createWriteStream(destination);
      output.on('error', failDownload);
      output.on('finish', () => output.close(error => error ? failDownload(error) : succeed()));
      response.pipe(output);
    });
    request.on('error', failDownload);
  });
}

/** 回归：tests/jvm-build-runtime.test.js；无 Maven 时在隔离临时目录解压，验证后只重命名到不存在的 tools/maven，拒绝覆盖用户目录。 */
async function ensureMaven(env = process.env) {
  const tools = path.join(ROOT, 'tools', 'maven');
  if (fs.existsSync(tools) && !executable(tools, 'mvn')) fail(`Maven directory exists but its executable is missing: ${tools}`);
  const existing = findMaven(env);
  if (existing) return existing;
  const archive = path.join(ROOT, 'tools', `apache-maven-${MAVEN_VERSION}-bin.tar.gz`);
  await fsp.mkdir(path.dirname(archive), { recursive: true });
  if (!fs.existsSync(archive)) {
    const urls = [
      `https://dlcdn.apache.org/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz`,
      `https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz`,
    ];
    let error;
    for (const url of urls) { try { await download(url, archive); error = undefined; break; } catch (cause) { error = cause; } }
    if (error) { await fsp.rm(archive, { force: true }); fail(`Maven download failed: ${error.message}`); }
  }
  if (await sha512(archive) !== MAVEN_SHA512) { await fsp.rm(archive, { force: true }); fail('Maven archive SHA-512 does not match the pinned value'); }
  const tempRoot = await fsp.mkdtemp(path.join(path.dirname(tools), '.maven-'));
  try {
    const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
    await run(tar, ['-xzf', archive, '-C', tempRoot], tempRoot, env);
    const extracted = path.join(tempRoot, `apache-maven-${MAVEN_VERSION}`);
    if (!executable(extracted, 'mvn')) fail('Maven archive was extracted but its executable is missing');
    if (fs.existsSync(tools)) fail(`Maven directory appeared during installation: ${tools}`);
    await fsp.rename(extracted, tools);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
  return findMaven(env) || fail('Maven was downloaded but its executable is missing');
}

/** 回归：tests/jvm-build-runtime.test.js；解析 JDK 版本，供主构建的 17+ 与测试构建的 21+ 门槛复用。 */
function javaMajor(java) {
  const result = spawnSync(java, ['-version'], { encoding: 'utf8', windowsHide: true });
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  const match = /version\s+"(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return 0;
  const major = Number(match[1]);
  return major === 1 && match[2] ? Number(match[2]) : major;
}

/** 回归：tests/jvm-build-runtime.test.js；优先显式 JDK 配置，Windows 缺失 Adoptium 候选仅跳过，其他扫描错误继续抛出。 */
function findJavaHome(env = process.env, minimumMajor = 17) {
  const candidates = [env.JVM_DEBUGGER_JAVA_HOME, env.JAVA_HOME];
  if (process.platform === 'win32') {
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const adoptium = path.join(programFiles, 'Eclipse Adoptium');
    try {
      candidates.push(...fs.readdirSync(adoptium, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^jdk-/.test(entry.name))
        .map(entry => path.join(adoptium, entry.name)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  candidates.push(...(env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.dirname(path.dirname(path.join(dir, process.platform === 'win32' ? 'java.exe' : 'java')))));
  for (const home of candidates.filter(Boolean)) {
    const java = path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(java) && javaMajor(java) >= minimumMajor) return { home, java };
  }
  return undefined;
}

function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    let child;
    if (process.platform === 'win32' && /\.cmd$/i.test(command)) {
      const comspec = env.ComSpec || env.COMSPEC || path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
      // 命令和参数均为本脚本常量；不拼接用户输入到 shell 命令行。
      if (/["%&|<>^!\r\n]/.test(command) || args.some(arg => /["%&|<>^!\r\n]/.test(arg))) fail('Unsafe Maven command or argument');
      child = spawn(comspec, ['/d', '/v:off', '/s', '/c', 'mvn.cmd ' + args.map(arg => '"' + arg + '"').join(' ')], { cwd: path.dirname(command), env, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true });
    } else {
      child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    }
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with code ${code}`)));
  });
}

async function sha512(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512'); const stream = fs.createReadStream(file);
    stream.on('error', reject); stream.on('data', chunk => hash.update(chunk)); stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 回归：tests/jvm-build-runtime.test.js；主构建要求 JDK 17+，测试要求 JDK 21+，测试只运行 Maven test，不发布旧 JAR。 */
async function build({ test = false } = {}) {
  const maven = await ensureMaven();
  const minimumMajor = test ? 21 : 17;
  const runtime = findJavaHome(process.env, minimumMajor);
  if (!runtime) fail(test ? 'JDK 21+ not found; set JVM_DEBUGGER_JAVA_HOME or JAVA_HOME' : 'JDK 17+ not found; set JVM_DEBUGGER_JAVA_HOME or JAVA_HOME');
  const env = { ...process.env, JAVA_HOME: runtime.home, PATH: `${path.join(runtime.home, 'bin')}${path.delimiter}${path.dirname(maven)}${path.delimiter}${process.env.PATH || ''}` };
  const args = test ? ['-B', '-f', path.join(ADAPTER, 'pom.xml'), 'test'] : ['-B', '-f', path.join(ADAPTER, 'pom.xml'), '-DskipTests', '-Dmaven.test.skip=true', 'package'];
  await run(maven, args, ADAPTER, env);
  if (test) return;
  const jar = path.join(ADAPTER, 'target', 'kotlin-debug-adapter.jar');
  if (!fs.existsSync(jar)) fail(`Maven completed but shaded JAR is missing: ${jar}`);
  verifyJar(runtime.java, jar);
  await fsp.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fsp.copyFile(jar, OUTPUT);
  await run(maven, ['-B', '-f', path.join(ROOT, 'src', 'gradle-tooling', 'pom.xml'), '-DskipTests', 'package'], ROOT, env);
  const toolingJar = path.join(ROOT, 'src', 'gradle-tooling', 'target', 'gradle-tooling-server-1.0.0.jar');
  const toolingArchive = await require('unzipper').Open.file(toolingJar);
  const slf4jLicense = toolingArchive.files.find(entry => entry.path === 'META-INF/LICENSE.txt');
  if (!slf4jLicense) fail('Tooling API SLF4J license missing');
  const apacheLicense = await fsp.readFile(path.join(ROOT, 'resources', 'licenses', 'Apache-2.0', 'legalcode.txt'), 'utf8');
  await fsp.writeFile(path.join(ROOT, 'resources', 'gradle-tooling-LICENSE.txt'), 'Gradle Tooling API 9.8.1 — Apache-2.0\n\n' + apacheLicense + '\n\nSLF4J API and Simple 2.0.17 — MIT\n\n' + (await slf4jLicense.buffer()).toString('utf8'));
  await fsp.copyFile(toolingJar, path.join(ROOT, 'resources', 'gradle-tooling-server.jar'));
  await fsp.copyFile(path.join(UPSTREAM, 'LICENSE'), path.join(path.dirname(OUTPUT), 'LICENSE'));
  const bytes = await fsp.stat(OUTPUT);
  if (bytes.size === 0) fail(`generated JAR is empty: ${OUTPUT}`);
  return OUTPUT;
}

/** 回归：tests/jvm-build-runtime.test.js；发布前执行 java -jar --version，确保复制的是可启动的调试适配器 JAR。 */
function verifyJar(java, jar) {
  const result = spawnSync(java, ['-jar', jar, '--version'], { encoding: 'utf8', windowsHide: true });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status !== 0 || !/^\d+\.\d+\.\d+$/.test(output)) fail(`generated JAR failed version check: ${jar}`);
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help')) {
    process.stdout.write('Usage: node scripts/build-jvm-debugger.cjs [--test]\n');
  } else if ([...args].some(arg => arg !== '--test')) {
    fail('unknown argument; use --test or --help');
  } else {
    build({ test: args.has('--test') }).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}

module.exports = { build, findMaven, findJavaHome, MAVEN_VERSION, MAVEN_SHA512, OUTPUT };
