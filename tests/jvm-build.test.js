const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const upstream = path.join(root, 'src', 'android-debugger', 'jvm-debugger', 'upstream');
const lockPath = path.join(upstream, 'SOURCE_LOCK.json');
const buildScript = path.join(root, 'scripts', 'build-jvm-debugger.cjs');

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 回归：node --test tests/jvm-build.test.js；核对复制字节，仅允许三个迁移适配文件，并精确逆变换重建上游摘要，拒绝无意变换。 */
test('JVM upstream source lock matches copied bytes', () => {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(lock.schemaVersion, 1);
  assert.ok(lock.files.length >= 40);
  const adaptedPaths = [
    'adapter/src/main/kotlin/dev/ktdebug/Main.kt',
    'adapter/src/test/kotlin/dev/ktdebug/AttachDebugTest.kt',
    'adapter/src/test/kotlin/dev/ktdebug/SpringBootDebugTest.kt',
  ];
  assert.deepEqual(lock.files.filter(entry => entry.upstreamSha256 || entry.adaptation).map(entry => entry.path).sort(), adaptedPaths);
  for (const entry of lock.files) {
    const file = path.join(upstream, ...entry.path.split('/'));
    assert.ok(fs.statSync(file).isFile(), entry.path);
    assert.equal(fs.statSync(file).size, entry.bytes, `${entry.path} bytes`);
    assert.equal(digest(file), entry.sha256, `${entry.path} sha256`);
    assert.match(entry.sourcePath, /^(LICENSE|adapter\/|samples\/)/);
    if (entry.upstreamSha256) {
      assert.ok(adaptedPaths.includes(entry.path), entry.path);
      let original = fs.readFileSync(file, 'utf8');
      if (entry.path === adaptedPaths[0]) {
        original = original.replaceAll('android-ide.jvmDebugger.javaHome', 'kotlin' + 'Debugger.javaHome');
      } else {
        const normalized = String.raw`.str("path")!!.replace('\\', '/').endsWith("`;
        const expectedCount = entry.path === adaptedPaths[1] ? 4 : 3;
        assert.equal(original.split(normalized).length - 1, expectedCount, `exactly ${expectedCount} source-path comparisons are normalized`);
        original = original.replaceAll(normalized, '.str("path")!!.endsWith("');
      }
      assert.equal(crypto.createHash('sha256').update(original).digest('hex'), entry.upstreamSha256);
      assert.ok(entry.adaptation);
    }
  }
});

/** 回归：检查 Maven 主类、源码布局和 fixture/test 入口，避免只复制空壳项目。 */
test('JVM upstream Maven layout preserves adapter contracts', () => {
  const pom = fs.readFileSync(path.join(upstream, 'adapter', 'pom.xml'), 'utf8');
  assert.match(pom, /<sourceDirectory>src\/main\/kotlin<\/sourceDirectory>/);
  assert.match(pom, /<testSourceDirectory>src\/test\/kotlin<\/testSourceDirectory>/);
  assert.match(pom, /<mainClass>dev\.ktdebug\.MainKt<\/mainClass>/);
  assert.match(pom, /<adapter\.jvm\.target>17<\/adapter\.jvm\.target>/);
  assert.match(pom, /<fixture\.jvm\.target>21<\/fixture\.jvm\.target>/);
  assert.ok(fs.existsSync(path.join(upstream, 'adapter', 'src', 'fixtures', 'kotlin', 'fixture', 'App.kt')));
  assert.ok(fs.existsSync(path.join(upstream, 'adapter', 'src', 'test', 'kotlin', 'dev', 'ktdebug', 'SpringBootDebugTest.kt')));
  assert.ok(fs.existsSync(path.join(upstream, 'samples', 'spring-boot-kotlin-demo', 'pom.xml')));
});

/** 回归：静态验证 Maven/JDK 错误路径、Windows cmd.exe 参数策略和产物校验未被吞掉。 */
test('JVM build script has explicit tool and artifact failure paths', () => {
  const source = fs.readFileSync(buildScript, 'utf8');
  assert.match(source, /MAVEN_HOME/);
  assert.match(source, /M2_HOME/);
  assert.match(source, /JVM_DEBUGGER_JAVA_HOME/);
  assert.match(source, /Maven download failed|Maven was downloaded/);
  assert.match(source, /JDK 21\+ not found/);
  assert.match(source, /maven\.test\.skip/);
  assert.match(source, /kotlin-debug-adapter\.jar/);
  assert.match(source, /\.cmd\$\/i/);
  assert.match(source, /cmd\.exe/);
  assert.match(source, /shaded JAR is missing/);
  assert.match(source, /process\.exitCode = 1/);
});

/** 回归：构建输出只能落在扩展运行时目录，且不会把 target 目录当发布产物。 */
test('JVM build output contract is stable', () => {
  const source = fs.readFileSync(buildScript, 'utf8');
  assert.match(source, /resources.*jvm-debugger.*kotlin-debug-adapter\.jar/s);
  assert.equal(source.includes('target\\n'), false);
});

/**
 * 功能点：coordinator 许可发布与最终 Maven runtime 依赖保持一致。
 * 受影响对象：build/writeCoordinatorLegalFiles、上游 LICENSE 和 SOURCE_LOCK、独立许可来源清单。
 * 复现路径：Node>=22，读取构建入口和已核对来源清单，不执行 Maven 或下载。
 * 测试范围：传递依赖无名称白名单、全新临时目录清理、许可先于 JAR 发布、来源证据完整。
 * 执行入口：node --test tests/jvm-build.test.js；真实 ZIP 解析见 tests/coordinator-license.test.js。
 * 预期结果：原上游许可保持独立，新增依赖无许可时不能无声发布。
 * 判据：参数契约及来源证据断言全部成立；真实解析和 VSIX 字节另由对应测试覆盖。
 */
test('Coordinator legal output follows actual Maven runtime dependencies before publishing', () => {
  const source = fs.readFileSync(buildScript, 'utf8');
  assert.match(source, /maven-dependency-plugin:[^']+:copy-dependencies/);
  assert.match(source, /-DincludeScope=runtime/);
  assert.match(source, /-Dmdep\.useRepositoryLayout=true/);
  assert.doesNotMatch(source, /-D(?:includeArtifactIds|includeGroupIds|excludeTransitive|includeTypes)=/);
  assert.match(source, /mkdtemp\(path\.join\(os\.tmpdir\(\), 'android-coordinator-licenses-'/);
  assert.match(source, /finally\s*\{\s*await fsp\.rm\(directory, \{ recursive: true, force: true \}\)/);
  assert.ok(source.indexOf('await writeCoordinatorLegalFiles(maven, env)') < source.indexOf('await fsp.copyFile(coordinatorJar, COORDINATOR_OUTPUT)'));
  assert.match(source, /coordinator-LICENSE\.txt/);
  assert.match(source, /coordinator-NOTICE\.txt/);
  assert.match(source, /copyFile\(path\.join\(UPSTREAM, 'LICENSE'\), path\.join\(path\.dirname\(OUTPUT\), 'LICENSE'\)\)/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'resources/jvm-debugger/coordinator-LICENSE-sources.json'), 'utf8'));
  const artifacts = new Set();
  for (const record of manifest.sources) {
    assert.match(record.pom, /^https:\/\//);
    assert.ok(record.files.length > 0);
    for (const artifact of record.artifacts) {
      assert.equal(artifacts.has(artifact), false, `重复许可来源：${artifact}`);
      artifacts.add(artifact);
      assert.match(artifact, /^[^\\]+\.jar$/);
    }
    for (const file of record.files) {
      assert.match(file.url, /^https:\/\//);
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      if (file.byteRange) {
        assert.ok(['license', 'notice'].includes(file.kind));
        assert.equal(file.byteRange.length, 2);
        assert.ok(file.byteRange.every(Number.isInteger));
        assert.ok(file.byteRange[0] >= 0 && file.byteRange[1] > file.byteRange[0]);
        assert.ok(record.provenance && record.sourceTree);
      } else {
        assert.match(file.path, /(?:LICENSE|NOTICE|COPYRIGHT)/);
      }
    }
  }
});
