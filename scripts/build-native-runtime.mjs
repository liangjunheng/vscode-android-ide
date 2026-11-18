import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.test-artifacts/android-debugger/native-build');
const PAYLOAD = path.join(ROOT, 'tools/win32-x64');
export const LLVM_SHA256 = '6898f963c8e938981e6c4a302e83ec5beb4630147c7311183cf61069af16333d';
export const SOURCES = Object.freeze([
  { name: 'llvm', version: '20.1.8', url: 'https://github.com/llvm/llvm-project/releases/download/llvmorg-20.1.8/llvm-project-20.1.8.src.tar.xz', sha256: LLVM_SHA256, archive: 'llvm-project-20.1.8.src.tar.xz' },
  { name: 'zlib', version: '1.4', url: 'https://github.com/madler/zlib/archive/refs/tags/v1.4.tar.gz', archive: 'zlib-1.4.tar.gz', sha512: '67f3ce120210a69aa05cece6f76d5f45b50d947c095169f0d699732d0182d7d04aec1af56a3fc6bbcc2af91a57e099cd73980b17f7d96ad90aeabbeaafbf1cbc', checksumSource: 'https://raw.githubusercontent.com/microsoft/vcpkg/master/ports/zlib/portfile.cmake' },
  { name: 'zstd', version: '1.5.7', url: 'https://github.com/facebook/zstd/archive/refs/tags/v1.5.7.tar.gz', archive: 'zstd-1.5.7.tar.gz', sha512: '26e441267305f6e58080460f96ab98645219a90d290a533410b1b0b1d2f870721c95f8384e342ee647c5e968385a5b7e30c2d04340c37f59b3e6d86762c3260c', checksumSource: 'https://raw.githubusercontent.com/microsoft/vcpkg/master/ports/zstd/portfile.cmake' },
  { name: 'lzma', version: '5.8.4', url: 'https://github.com/tukaani-project/xz/archive/refs/tags/v5.8.4.tar.gz', archive: 'xz-5.8.4.tar.gz', sha512: '6a0e9c3b05f9c20255c5e35c06fdcd44b9e201f4ed566d1dec052b6cfda6cdfb42f73ffd258eaad2d8b7737c66b78ae353aebd44502e24a3d89d8765d698dcae', checksumSource: 'https://raw.githubusercontent.com/microsoft/vcpkg/master/ports/liblzma/portfile.cmake' }
]);
const DANGEROUS_DLL = /(?:python|lua|vcruntime|msvcp|libc\+\+|zlib|zstd|lzma)/i;
const SYSTEM_DLL = /^(?:api-ms-win-[\w.-]+|ext-ms-win-[\w.-]+|kernel32|ntdll|advapi32|bcrypt|crypt32|dbghelp|imagehlp|iphlpapi|ole32|oleaut32|psapi|rpcrt4|secur32|shell32|shlwapi|user32|userenv|uuid|version|winmm|ws2_32|wsock32|msvcrt|ucrtbase)\.dll$/i;

/** 输入路径必须位于授权工作目录；输出绝对路径；测试 safe directories 断言根目录/跨卷/父目录均拒绝。 */
export function assertScopedPath(value, label, base = ROOT) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error('unsafe ' + label);
  const resolved = path.resolve(value), relative = path.relative(path.resolve(base), resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error(label + ' must be inside workspace');
  return resolved;
}

/** 输入文件和算法，流式计算摘要；测试 archive hash gate 断言完整字节哈希不匹配时不会解包。 */
export async function digest(file, algorithm = 'sha256') {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of sync.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** 输入固定 HTTPS URL 和工作区输出路径，只接受正常 HTTPS 响应；不重试、不执行下载内容。 */
async function download(url, destination) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (new URL(url).protocol !== 'https:') throw new Error('download requires HTTPS');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(600000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (redirects === 5 || !response.headers.get('location')) throw new Error('invalid or excessive HTTPS redirects');
      url = new URL(response.headers.get('location'), url).href;
      continue;
    }
    if (!response.ok || !response.body) throw new Error('download failed HTTP ' + response.status + ': ' + url);
    await pipeline(response.body, sync.createWriteStream(destination, { flags: 'wx' }));
    return;
  }
}

/** 输入 argv 使用 shell:false 执行；捕获用于工具查询或流入工作区日志；测试 process argv 覆盖 NUL/类型错误和退出失败。 */
export function run(argv, { cwd = ROOT, env = process.env, log, windowsVerbatimArguments = false } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some(a => typeof a !== 'string' || !a.length || /[\0\r\n]/.test(a))) return Promise.reject(new Error('unsafe process argv'));
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, windowsHide: true, windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { if (log) log.write(data); else stdout += data; });
    child.stderr.on('data', data => { if (log) log.write(data); else stderr += data; });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(path.basename(argv[0]) + ' exited ' + code + ' signal=' + signal + '\n' + stderr)));
  });
}

/** 输入工具环境输出已验证绝对工具路径；测试 explicit tools 断言缺失/目录不可替代编译工具。 */
export function toolPaths(env = process.env) {
  const tools = {
    cmake: env.NATIVE_CMAKE || 'C:/Strawberry/c/bin/cmake.exe', ninja: env.NATIVE_NINJA || 'C:/Strawberry/c/bin/ninja.exe',
    cl: env.NATIVE_CL || 'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64/cl.exe',
    python: env.NATIVE_PYTHON,
    readobj: env.NATIVE_READOBJ || 'C:/Program Files/LLVM/bin/llvm-readobj.exe',
    linker: env.NATIVE_LINKER || 'C:/Program Files/LLVM/bin/lld-link.exe',
    cmd: path.join(env.SystemRoot || 'C:/Windows', 'System32/cmd.exe'), tar: path.join(env.SystemRoot || 'C:/Windows', 'System32/tar.exe')
  };
  for (const [name, file] of Object.entries(tools)) if (typeof file !== 'string' || !path.isAbsolute(file) || !sync.existsSync(file) || !sync.statSync(file).isFile()) throw new Error('required tool missing: ' + name);
  return tools;
}

/** 固定开发环境命令只引用已验证 VS 脚本；解析 set 输出供子进程使用，不修改任何全局 PATH。 */
async function developerEnvironment(tools, temp) {
  const vcvars = 'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Auxiliary/Build/vcvars64.bat';
  if (!sync.existsSync(vcvars)) throw new Error('missing x64 developer environment');
  const result = await run([tools.cmd, '/d', '/s', '/c', '""' + vcvars + '" >nul && set"'], { windowsVerbatimArguments: true });
  const env = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]));
  for (const line of result.stdout.split(/\r?\n/)) { const index = line.indexOf('='); if (index > 0) env[line.slice(0, index).toUpperCase()] = line.slice(index + 1); }
  env.TEMP = temp; env.TMP = temp; env.VSLANG = '1033';
  env.PATH = path.dirname(tools.ninja) + ';' + env.PATH;
  delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.CL;
  return env;
}

/** 输入固定源码定义，校验成功后才列目录并解包；测试 archive hash gate 以替身进程断言错误摘要零调用。 */
export async function acquire(source, work, env, tools) {
  const archives = path.join(work, 'archives'), destination = path.join(work, 'src', source.name === 'llvm' ? 'llvm-required' : source.name === 'zstd' ? 'zstd-required' : source.name);
  await fs.mkdir(archives, { recursive: true });
  const archive = path.join(archives, source.archive);
  if (!sync.existsSync(archive)) await download(source.url, archive);
  const algorithm = source.sha256 ? 'sha256' : 'sha512', expected = source[algorithm];
  if (!expected || await digest(archive, algorithm) !== expected) throw new Error(source.name + ' ' + algorithm + ' mismatch before extraction');
  const sha256 = await digest(archive);
  if (sync.existsSync(destination) && !sync.existsSync(path.join(destination, '.verified-extraction.json'))) throw new Error('incomplete source extraction: ' + source.name);
  if (!sync.existsSync(destination)) {
    const listing = await run([tools.tar, '-tf', archive], { env });
    for (const entry of listing.stdout.split(/\r?\n/).filter(Boolean)) if (/^(?:[a-z]:|\/|\\)/i.test(entry) || entry.split(/[\\/]/).includes('..')) throw new Error('unsafe archive member: ' + entry);
    await fs.mkdir(destination, { recursive: true });
    const extractArgs = [tools.tar, '-xf', archive, '--strip-components', '1', '-C', destination, '--exclude=*/tests/*'];
    if (source.name === 'llvm') extractArgs.push('--exclude=*/test/*', '--exclude=*/unittests/*', '--exclude=*/lldb-vscode', ...['llvm', 'clang', 'lldb', 'cmake', 'third-party', 'LICENSE.TXT'].map(dir => 'llvm-project-20.1.8.src/' + dir));
    await run(extractArgs, { env });
    await fs.writeFile(path.join(destination, '.verified-extraction.json'), JSON.stringify({ sha256, selected: source.name === 'llvm' ? ['llvm', 'clang', 'lldb', 'cmake', 'third-party', 'LICENSE.TXT'] : 'complete', excluded: source.name === 'llvm' ? ['test', 'unittests', 'lldb-vscode compatibility symlink'] : [] }));
  }
  return { ...source, sha256, source: destination };
}

/** 构造 LLVM20 官方 finder 参数，LZMA 来自 LLDB；测试 configure argv 精确断言无解释器运行时且压缩强制开启。 */
export function configureArgs(source, build, install, deps) {
  return ['-S', source, '-B', build, '-G', 'Ninja', '-UHAVE_ZLIB', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
    '-DLLVM_ENABLE_PROJECTS=clang;lldb', '-DLLVM_TARGETS_TO_BUILD=AArch64;ARM;X86', '-DBUILD_SHARED_LIBS=OFF', '-DLLVM_LINK_LLVM_DYLIB=OFF', '-DLLVM_BUILD_LLVM_DYLIB=OFF',
    '-DLLDB_ENABLE_PYTHON=OFF', '-DLLDB_ENABLE_LUA=OFF', '-DLLDB_ENABLE_SWIG=OFF', '-DLLDB_ENABLE_LIBEDIT=OFF', '-DLLDB_ENABLE_CURSES=OFF', '-DLLDB_ENABLE_LIBXML2=OFF', '-DLLDB_ENABLE_FBSDVMCORE=OFF',
    '-DLLVM_ENABLE_LIBXML2=OFF', '-DCLANG_ENABLE_LIBXML2=OFF', '-DLLVM_ENABLE_CURL=OFF', '-DLLVM_ENABLE_HTTPLIB=OFF',
    '-DLLVM_INCLUDE_TESTS=OFF', '-DLLDB_INCLUDE_TESTS=OFF', '-DCLANG_INCLUDE_TESTS=OFF', '-DLLDB_BUILD_FRAMEWORK=OFF', '-DLLDB_TOOL_LLDB_DAP_BUILD=ON',
    '-DLLVM_ENABLE_ZLIB=FORCE_ON', '-DLLVM_ENABLE_ZSTD=FORCE_ON', '-DLLDB_ENABLE_LZMA=ON', '-DZLIB_USE_STATIC_LIBS=ON',
    '-DZLIB_INCLUDE_DIR=' + deps.zlib.include, '-DZLIB_LIBRARY=' + deps.zlib.library, '-Dzstd_INCLUDE_DIR=' + deps.zstd.include, '-Dzstd_LIBRARY=' + deps.zstd.library, '-Dzstd_STATIC_LIBRARY=' + deps.zstd.library,
    '-DLIBLZMA_INCLUDE_DIR=' + deps.lzma.include, '-DLIBLZMA_LIBRARY=' + deps.lzma.library, '-DCMAKE_C_FLAGS=/utf-8 -DLZMA_API_STATIC', '-DCMAKE_CXX_FLAGS=/utf-8 -DLZMA_API_STATIC',
    '-DLLVM_PARALLEL_COMPILE_JOBS=2', '-DLLVM_PARALLEL_LINK_JOBS=1', '-DLLVM_ENABLE_DIA_SDK=OFF', '-DCMAKE_INSTALL_PREFIX=' + install].map(arg => arg.replaceAll('\\', '/'));
}

/** 依赖静态构建只在工作区进行，返回实际生成的库；测试 configure argv 和真实 build.log 共同验证压缩没有被关闭。 */
async function buildDependencies(sources, tools, env, work, log) {
  const deps = {};
  for (const name of ['zlib', 'zstd', 'lzma']) {
    const source = sources.find(s => s.name === name), build = path.join(work, 'build-' + name), install = path.join(work, 'deps', name);
    const flags = name === 'zlib' ? ['-DZLIB_BUILD_SHARED=OFF', '-DZLIB_BUILD_STATIC=ON', '-DZLIB_BUILD_TESTING=OFF'] : name === 'zstd' ? ['-DZSTD_BUILD_SHARED=OFF', '-DZSTD_BUILD_STATIC=ON', '-DZSTD_BUILD_PROGRAMS=OFF', '-DZSTD_BUILD_TESTS=OFF', '-DZSTD_USE_STATIC_RUNTIME=ON'] : ['-DBUILD_SHARED_LIBS=OFF', '-DBUILD_TESTING=OFF', '-DXZ_TOOL_XZ=OFF', '-DXZ_TOOL_XZDEC=OFF', '-DXZ_TOOL_LZMADEC=OFF', '-DXZ_TOOL_LZMAINFO=OFF', '-DXZ_NLS=OFF', '-DXZ_DOC=OFF'];
    await run([tools.cmake, '-S', path.join(source.source, name === 'zstd' ? 'build/cmake' : '.'), '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded', '-DCMAKE_C_COMPILER=' + tools.cl, '-DCMAKE_CXX_COMPILER=' + tools.cl, '-DCMAKE_MAKE_PROGRAM=' + tools.ninja, '-DCMAKE_INSTALL_PREFIX=' + install, ...flags], { env, log });
    await run([tools.cmake, '--build', build, '--target', 'install', '--parallel', '2'], { env, log });
    const libraries = (await fs.readdir(path.join(install, 'lib'))).filter(f => f.endsWith('.lib'));
    if (libraries.length !== 1) throw new Error('expected one static library for ' + name + ': ' + libraries);
    deps[name] = { include: path.join(install, 'include'), library: path.join(install, 'lib', libraries[0]) };
  }
  return deps;
}

/** 递归枚举普通文件，拒绝符号链接逃逸；测试 payload resources/import closure 覆盖缺资源和恶意依赖。 */
async function filesUnder(dir) {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('symlink in runtime tree');
    if (entry.isDirectory()) result.push(...await filesUnder(file)); else if (entry.isFile()) result.push(file);
  }
  return result.sort();
}

/** 输入候选 payload 与 PE 导入读取器；递归闭包只允许随包 DLL 或明确 Windows 系统库，永不放行 Python/Lua/VC/压缩 DLL。 */
export async function scanPayload(payload, readobj) {
  const files = await filesUnder(payload), binaries = files.filter(f => /\.(exe|dll)$/i.test(f)), byName = new Map(binaries.map(f => [path.basename(f).toLowerCase(), f]));
  for (const file of files) if (DANGEROUS_DLL.test(path.basename(file)) && /\.(exe|dll|pyd|py|pyc)$/i.test(file)) throw new Error('forbidden staged dependency: ' + path.basename(file));
  if (!byName.has('lldb-dap.exe') || !byName.has('liblldb.dll')) throw new Error('payload requires real lldb-dap.exe and liblldb.dll');
  if (!files.some(f => /[\\/]lib[\\/]clang[\\/][\d.]+[\\/]include[\\/]stddef\.h$/.test(f))) throw new Error('payload lacks clang resource headers');
  const imports = {};
  for (const file of binaries) {
    const output = await readobj(file), text = typeof output === 'string' ? output : output.stdout;
    const names = Array.from(text.matchAll(/^\s*Name:\s+([^\s]+\.dll)\s*$/gim), m => m[1]);
    if (!names.length) throw new Error('no PE import data: ' + path.basename(file));
    for (const name of names) {
      if (DANGEROUS_DLL.test(name)) throw new Error('forbidden dynamic dependency: ' + name);
      if (!byName.has(name.toLowerCase()) && !SYSTEM_DLL.test(name)) throw new Error('unbundled dynamic dependency: ' + name);
    }
    imports[path.relative(payload, file).replaceAll('\\', '/')] = names;
  }
  return imports;
}

/** 输入候选 lldb-dap，清除 Python 变量并最小 PATH，真实 DAP initialize/disconnect 响应成功后退出；失败会终止并等待 close。 */
export async function initializeDap(executable) {
  const system = process.env.SystemRoot || 'C:/Windows';
  const env = { SystemRoot: system, WINDIR: system, PATH: path.dirname(executable) + ';' + path.join(system, 'System32'), TEMP: WORK, TMP: WORK };
  const child = spawn(executable, [], { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = []; let bytes = Buffer.alloc(0), stderr = '', failure;
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  child.stderr.on('data', b => { stderr += b; });
  let resolveReply, rejectReply;
  const reply = new Promise((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
  child.stdout.on('data', b => {
    bytes = Buffer.concat([bytes, b]);
    for (;;) {
      const boundary = bytes.indexOf('\r\n\r\n'); if (boundary < 0) return;
      const match = /Content-Length:\s*(\d+)/i.exec(bytes.subarray(0, boundary).toString());
      if (!match) { rejectReply(new Error('bad DAP header')); return; }
      const length = Number(match[1]); if (bytes.length < boundary + 4 + length) return;
      const message = JSON.parse(bytes.subarray(boundary + 4, boundary + 4 + length).toString()); bytes = bytes.subarray(boundary + 4 + length); messages.push(message);
      if (message.type === 'response' && message.request_seq === 1) message.success ? resolveReply(message) : rejectReply(new Error('DAP initialize failed'));
    }
  });
  const timer = setTimeout(() => rejectReply(new Error('DAP initialize deadline')), 15000);
  try {
    const request = JSON.stringify({ seq: 1, type: 'request', command: 'initialize', arguments: { adapterID: 'lldb-dap', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' } });
    child.stdin.write('Content-Length: ' + Buffer.byteLength(request) + '\r\n\r\n' + request);
    await Promise.race([reply, closed.then(code => { throw new Error('lldb-dap closed before initialize: ' + code + ' ' + stderr); })]);
  } catch (error) { failure = error; } finally { clearTimeout(timer); child.stdin.end(); child.kill(); await closed; }
  if (failure) throw failure;
  return { messages, stderr, environment: 'minimal PATH; no PYTHONHOME/PYTHONPATH; Windows host only' };
}

/** 输出 provenance 删除全部本机绝对路径；测试 provenance redaction 断言不包含用户名和全局 Python 路径。 */
export function portableProvenance(sources, versions, args, work = WORK) {
  return { schemaVersion: 1, sourceIdentity: 'Pinned source archive hashes are authoritative. Upstream CMake may auto-detect an enclosing repository while generating its embedded runtime version string; that enclosing revision is not an LLVM upstream commit.', target: 'win32-x64', validationHost: 'win32-x64 only', sources: sources.map(({ source, ...s }) => s), tools: versions, cmakeArguments: args.map(a => a.replaceAll(work, '$WORK').replaceAll('\\', '/')), parallelCompile: 2, parallelLink: 1, python: 'build-machine interpreter only; runtime integration disabled', liblldb: 'SHARED; deliberately bundled', compression: 'zlib/zstd/liblzma static /MT', builtInFormatters: 'upstream defaults preserved', androidPlatformPlugin: 'upstream default preserved' };
}

/** 输入同一工作区构建目录，在工作区建立短目录 junction；测试 short build alias 核验真实目标一致和拒绝已有错误目录。 */
export async function shortBuildAlias(work, buildDir) {
  assertScopedPath(buildDir, 'build directory', work);
  const alias = path.join(work, 'b');
  if (!sync.existsSync(alias)) await fs.symlink(buildDir, alias, 'junction');
  if ((await fs.realpath(alias)).toLowerCase() !== (await fs.realpath(buildDir)).toLowerCase()) throw new Error('short build alias has different real target');
  return alias;
}

/** 输入已安装静态依赖目录，返回实际库路径；stage-only 测试验证必须存在唯一静态库，不能退回全局库。 */
export async function installedDependencies(work) {
  const deps = {};
  for (const name of ['zlib', 'zstd', 'lzma']) {
    const prefix = path.join(work, 'deps', name), libs = (await fs.readdir(path.join(prefix, 'lib'))).filter(f => f.endsWith('.lib'));
    if (libs.length !== 1) throw new Error('expected one installed static library: ' + name);
    await fs.access(path.join(prefix, 'include'));
    deps[name] = { include: path.join(prefix, 'include'), library: path.join(prefix, 'lib', libs[0]) };
  }
  return deps;
}

/** 校验 stage-only 的真实 CMake 缓存与来源/禁解释器/压缩/CRT 配置；测试 installed build gate 覆盖缺项、错误值和禁用资源。 */
export function verifyInstalledBuild(cache, sourceDir, compileCommands) {
  const entries = new Map(Array.from(cache.matchAll(/^([^#/:\r\n][^:\r\n]*):[^=\r\n]+=(.*)$/gm), m => [m[1], m[2].replace(/\r$/, '')]));
  for (const [key, value] of Object.entries({ CMAKE_BUILD_TYPE: 'Release', LLDB_ENABLE_PYTHON: 'OFF', LLDB_ENABLE_LUA: 'OFF', LLDB_ENABLE_SWIG: 'OFF', LLDB_ENABLE_LZMA: 'ON', LLVM_ENABLE_ZLIB: 'FORCE_ON', LLVM_ENABLE_ZSTD: 'FORCE_ON', LLVM_TARGETS_TO_BUILD: 'AArch64;ARM;X86', LLVM_PARALLEL_COMPILE_JOBS: '2', LLVM_PARALLEL_LINK_JOBS: '1' })) if (entries.get(key) !== value) throw new Error('installed build cache mismatch: ' + key);
  const actualSource = entries.get('LLVM_EXTERNAL_LLDB_SOURCE_DIR');
  if (!actualSource || path.resolve(actualSource).toLowerCase() !== path.resolve(sourceDir, '../lldb').toLowerCase()) throw new Error('installed build source directory mismatch');
  const compiles = typeof compileCommands === 'string' ? compileCommands.split(String.fromCharCode(10)).filter(line => line.includes('cl.exe') && (line.includes(' /c ') || line.includes(' -c '))) : [];
  if (!compiles.length || compiles.some(line => !(line.includes(' -MT ') || line.includes(' /MT ')) || line.includes(' -MD ') || line.includes(' /MD '))) throw new Error('installed compiler commands do not prove static MSVC runtime');
  return Object.fromEntries(entries);
}

/** 通过 CMake 标准 tar 打包安装树并提取候选，不重新配置/编译；测试 portable install package 核验明文资源检查和错误传播。 */
export async function packageInstalledTree(install, candidate, work, tools, env) {
  const originals = await filesUnder(install), archive = path.join(work, 'installed-runtime.tar');
  await run([tools.cmake, '-E', 'tar', 'cf', archive, '--format=gnutar', 'bin', 'lib'], { cwd: install, env });
  await fs.mkdir(path.join(candidate, 'llvm'), { recursive: true });
  await run([tools.tar, '-xf', archive, '-C', path.join(candidate, 'llvm')], { env });
  const outputs = await filesUnder(path.join(candidate, 'llvm'));
  if (outputs.length !== originals.length) throw new Error('installed runtime package file count mismatch');
  for (const file of outputs) {
    const handle = await fs.open(file, 'r');
    try { const bytes = Buffer.alloc(16); await handle.read(bytes, 0, 16, 0); if (bytes.toString('ascii') === '%TSD-Header-###%') throw new Error('nonportable protected file in runtime package: ' + path.relative(candidate, file)); } finally { await handle.close(); }
  }
}

/** 只发布四个自有条目，预先拒绝冲突，失败时回滚已移动条目并传播权限错误；测试 coexist publication 验证 ADB/NOTICE 字节不变。 */
export async function publishNative(candidate, payload) {
  const names = ['llvm', 'LLVM-NOTICE.txt', 'native-provenance.json', 'native-SHA256SUMS'];
  const actual = await fs.readdir(candidate);
  if (actual.length !== names.length || names.some(name => !actual.includes(name))) throw new Error('unexpected native publication entries');
  await fs.mkdir(payload, { recursive: true });
  for (const name of names) {
    try { await fs.lstat(path.join(payload, name)); throw new Error('native publication conflict: ' + name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const moved = [];
  try {
    for (const name of names) { await fs.rename(path.join(candidate, name), path.join(payload, name)); moved.push(name); }
  } catch (error) {
    const errors = [error];
    for (const name of moved.reverse()) { try { await fs.rename(path.join(payload, name), path.join(candidate, name)); } catch (rollback) { errors.push(rollback); } }
    if (errors.length > 1) throw new AggregateError(errors, 'native publication and rollback failed');
    throw error;
  }
}

/** 真实入口支持 --stage-only 重新审计同一安装结果而不配置/编译；所有路径仍限 E 工作区，真实 imports/DAP/许可证通过后才发布。 */
export async function build({ stageOnly = false } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('requires native Windows x64 build host');
  const work = assertScopedPath(WORK, 'work'), payload = assertScopedPath(PAYLOAD, 'payload');
  if (!work.toLowerCase().startsWith('e:' + path.sep)) throw new Error('build artifacts must be on E workspace');
  const tools = toolPaths(); await fs.mkdir(work, { recursive: true }); await fs.mkdir(path.join(work, 'temp'), { recursive: true });
  const env = await developerEnvironment(tools, path.join(work, 'temp'));
  const log = sync.createWriteStream(path.join(work, 'build.log'), { flags: 'a' });
  try {
    const versions = {};
    for (const [name, argv] of Object.entries({ cmake: [tools.cmake, '--version'], ninja: [tools.ninja, '--version'], compiler: [tools.cl, '/?'], linker: [tools.linker, '--version'], readobj: [tools.readobj, '--version'], buildPython: [tools.python, '--version'] })) {
      const r = await run(argv, { env }); versions[name] = (r.stdout + r.stderr).trim(); if (!versions[name]) throw new Error('missing actual tool version: ' + name);
    }
    const sources = [];
    for (const source of SOURCES) { console.log('Acquire verified source: ' + source.name + ' ' + source.version); sources.push(await acquire(source, work, env, tools)); }
    await fs.writeFile(path.join(work, 'verified-sources.json'), JSON.stringify(sources.map(({ source, ...s }) => s), null, 2));
    const deps = stageOnly ? await installedDependencies(work) : await buildDependencies(sources, tools, env, work, log), llvm = sources.find(s => s.name === 'llvm');
    const buildDir = path.join(work, 'build-llvm'), install = path.join(work, 'install');
    const args = configureArgs(path.join(llvm.source, 'llvm'), buildDir, install, deps);
    const compilerArgs = ['-DCMAKE_C_COMPILER=' + tools.cl, '-DCMAKE_CXX_COMPILER=' + tools.cl, '-DCMAKE_MAKE_PROGRAM=' + tools.ninja, '-DPython3_EXECUTABLE=' + tools.python, '-DLLVM_USE_LINKER=', '-DLLVM_ENABLE_LLD=ON', '-DCMAKE_LINKER=' + tools.linker];
    if (!stageOnly) {
      await run([tools.cmake, ...args, ...compilerArgs], { env, log });
      const targets = await run([tools.ninja, '-C', buildDir, '-t', 'targets', 'all'], { env });
      for (const t of ['install-lldb-dap', 'install-liblldb', 'install-clang-resource-headers']) if (!targets.stdout.includes(t + ':')) throw new Error('missing install target: ' + t);
      console.log('Build lldb-dap liblldb clang-resource-headers (compile<=2, link<=1)');
      const compileDir = await shortBuildAlias(work, buildDir);
      await run([tools.ninja, '-j2', 'lldb-dap', 'liblldb', 'clang-resource-headers'], { cwd: compileDir, env, log });
      await run([tools.ninja, '-j2', 'install-lldb-dap', 'install-liblldb', 'install-clang-resource-headers'], { cwd: compileDir, env, log });
    }
    const cacheView = await run([tools.cmake, '-N', '-LAH', buildDir], { env });
    await fs.writeFile(path.join(work, 'installed-cache-view.log'), cacheView.stdout);
    const commandView = await run([tools.ninja, '-C', buildDir, '-t', 'commands', 'lldb-dap', 'liblldb'], { env });
    await fs.writeFile(path.join(work, 'installed-command-view.log'), commandView.stdout);
    verifyInstalledBuild(cacheView.stdout, path.join(llvm.source, 'llvm'), commandView.stdout);
    const candidate = path.join(work, 'candidate');
    if (sync.existsSync(candidate)) throw new Error('refusing to overwrite existing native candidate');
    await packageInstalledTree(install, candidate, work, tools, env);
    console.log('Audit real installed PE import closure');
    const rawImports = {};
    const imports = await scanPayload(candidate, async f => { const result = await run([tools.readobj, '--coff-imports', f], { env }); rawImports[path.relative(candidate, f).replaceAll('\\', '/')] = result.stdout; return result; });
    await fs.writeFile(path.join(work, 'native-imports.json'), JSON.stringify(rawImports, null, 2));
    console.log('Initialize real lldb-dap with minimal PATH and no Python variables');
    const smoke = await initializeDap(path.join(candidate, 'llvm/bin/lldb-dap.exe'));
    await fs.writeFile(path.join(work, 'native-dap-smoke.json'), JSON.stringify(smoke, null, 2));
    const notices = [], noticeFiles = [];
    for (const s of sources) {
      for (const f of await filesUnder(s.source)) {
        const relative = path.relative(s.source, f);
        if (/^(?:LICENSE(?:\.TXT|\.txt)?|COPYING(?:\.[\w.-]+)?|COPYRIGHT|NOTICE(?:\.txt)?)$/i.test(path.basename(f))) { const label = s.name + '/' + relative.replaceAll('\\', '/'); notices.push('===== ' + label + ' =====\n' + await fs.readFile(f, 'utf8')); noticeFiles.push({ source: label, sha256: await digest(f) }); }
      }
    }
    for (const name of ['llvm', 'zlib', 'zstd', 'lzma']) if (!noticeFiles.some(f => f.source.startsWith(name + '/'))) throw new Error('missing full source notice: ' + name);
    await fs.writeFile(path.join(candidate, 'LLVM-NOTICE.txt'), notices.join('\n\n'));
    const portableArgs = [...args, ...compilerArgs].map(arg => { let value = arg.replaceAll('\\', '/').replaceAll(work.replaceAll('\\', '/'), '$WORK'); for (const [name, file] of Object.entries(tools)) value = value.replaceAll(file.replaceAll('\\', '/'), '$TOOL_' + name.toUpperCase()); return value; });
    await fs.writeFile(path.join(candidate, 'native-provenance.json'), JSON.stringify({ ...portableProvenance(sources, versions, portableArgs), imports, smoke, noticeFiles, buildWorkingDirectory: '$WORK/b -> $WORK/build-llvm (validated same-tree junction)', installTargets: ['install-lldb-dap', 'install-liblldb', 'install-clang-resource-headers'], publicationAuditMode: stageOnly ? 'existing local install re-audited; no configure/build executed during staging' : 'built and audited in one invocation' }, null, 2));
    const sums = []; for (const f of await filesUnder(candidate)) sums.push(await digest(f) + '  ' + path.relative(candidate, f).replaceAll('\\', '/'));
    await fs.writeFile(path.join(candidate, 'native-SHA256SUMS'), sums.join('\n') + '\n');
    await publishNative(candidate, payload);
    console.log('Verified real native payload staged alongside existing host tools: tools/win32-x64/llvm');
  } finally { await new Promise(resolve => log.end(resolve)); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) build({ stageOnly: process.argv.slice(2).includes('--stage-only') }).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
