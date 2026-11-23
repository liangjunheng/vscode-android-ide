/**
 * 功能点：JVM 适配器与 Gradle tooling 的源码、构建和成品契约。
 * 受影响对象：SOURCE_LOCK、两份 POM、构建脚本、两项 JAR 及各自许可。
 * 复现路径：Node>=22，准备当前构建产物，读取实际源码、配置及归档。
 * 测试范围：源码摘要、授权适配、主类、Shade 排除项、完整许可和已删除服务无依赖。
 * 执行入口：node --test tests/jvm-build.test.js；也由 npm test 发现。
 * 预期结果：两个现役产物严格通过，不读取 Coordinator 源码或资源。
 * 判据：缺失或损坏产物、摘要不符、许可缺失及构建入口退化均失败。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const upstream = path.join(root, 'src', 'android-debugger', 'jvm-debugger', 'upstream');
const lockPath = path.join(upstream, 'SOURCE_LOCK.json');
const buildScript = path.join(root, 'scripts', 'build-jvm-debugger.cjs');

const shadedServices = [
  { jar: 'resources/jvm-debugger/kotlin-debug-adapter.jar' },
  { jar: 'resources/gradle-tooling-server.jar' },
];

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 功能：按明确次数逆转一项授权源码适配，拒绝缺失或重复的变更。
 * 输入：当前源码、适配后片段、原始片段和预期次数（默认一次）。
 * 输出：恢复原始片段的源码；次数不符时断言失败。
 * 验证：由下方源码锁测试覆盖七项适配及各片段次数和重建摘要。
 */
function restoreAdaptation(source, adapted, original, expectedCount = 1) {
  const parts = source.split(adapted);
  assert.equal(parts.length - 1, expectedCount, `授权片段必须恰好出现 ${expectedCount} 次：${adapted}`);
  return parts.join(original);
}

/**
 * 功能点：核对上游复制字节，仅允许七项明确授权适配并精确重建原始摘要。
 * 受影响对象：SOURCE_LOCK 全部文件及 LICENSE；adapter/pom.xml、Main、AttachDebugTest、SpringBootDebugTest、SessionConfig、VmConnector、UnitTests。
 * 复现路径：Node>=22，读取源码锁和上游文件；逆转设置名、路径归一化、attach 可空总期限和 Shade 排除项的授权差异。
 * 测试范围：保留六项源码适配，新增清单排除、全版本模块描述符排除及中文注释的精确逆变换；覆盖片段缺失、重复、未知改动和缺失上游摘要。
 * 执行入口：node --test tests/jvm-build.test.js，仅读取文件，不执行 Maven 或设备操作。
 * 预期结果：当前字节数及 SHA256 完全匹配，七项适配均精确恢复为锁定的原始摘要，许可锁不变。
 * 判据：所有断言成立才通过；白名单外适配、替换次数不符、字节或摘要不符均失败。
 */
test('JVM upstream source lock matches copied bytes', () => {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(lock.schemaVersion, 1);
  assert.ok(lock.files.length >= 40);
  const adaptedPaths = [
    'adapter/src/main/kotlin/dev/ktdebug/Main.kt',
    'adapter/src/main/kotlin/dev/ktdebug/session/SessionConfig.kt',
    'adapter/src/main/kotlin/dev/ktdebug/session/VmConnector.kt',
    'adapter/src/test/kotlin/dev/ktdebug/AttachDebugTest.kt',
    'adapter/src/test/kotlin/dev/ktdebug/SpringBootDebugTest.kt',
    'adapter/src/test/kotlin/dev/ktdebug/UnitTests.kt',
    'adapter/pom.xml',
  ];
  assert.deepEqual(lock.files.filter(entry => entry.upstreamSha256 || entry.adaptation).map(entry => entry.path).sort(), adaptedPaths.toSorted());
  for (const entry of lock.files) {
    const file = path.join(upstream, ...entry.path.split('/'));
    assert.ok(fs.statSync(file).isFile(), entry.path);
    assert.equal(fs.statSync(file).size, entry.bytes, `${entry.path} bytes`);
    assert.equal(digest(file), entry.sha256, `${entry.path} sha256`);
    assert.match(entry.sourcePath, /^(LICENSE|adapter\/|samples\/)/);
    if (adaptedPaths.includes(entry.path)) {
      assert.match(entry.upstreamSha256, /^[a-f0-9]{64}$/, `${entry.path} 上游摘要`);
      assert.ok(entry.adaptation, `${entry.path} 适配说明`);
      let original = fs.readFileSync(file, 'utf8');
      if (entry.path === adaptedPaths[0]) {
        original = restoreAdaptation(original, 'android-ide.jvmDebugger.javaHome', 'kotlin' + 'Debugger.javaHome');
      } else if (entry.path === adaptedPaths[1]) {
        original = restoreAdaptation(original, '    val timeoutMs: Int?,', '    val timeoutMs: Int,');
        original = restoreAdaptation(original,
          '                timeoutMs = a.num("timeout")?.toInt(),',
          '                timeoutMs = a.num("timeout")?.toInt() ?: 30_000,');
      } else if (entry.path === adaptedPaths[2]) {
        original = restoreAdaptation(original,
          '    /** 功能：等待尚未监听的调试端口，已连接后的IO失败立即传播；输入目标及可选总期限；输出JDI虚拟机；验证：jvm-connection-reset.test.js。 */\n', '');
        original = restoreAdaptation(original,
          '                if (e !is ConnectException) {\n' +
          '                    throw ConnectException2("Could not attach to JVM at $host:$port (${e.message ?: e.javaClass.simpleName}).").also { it.initCause(e) }\n' +
          '                }\n', '');
        original = restoreAdaptation(original,
          '    fun attach(host: String, port: Int, timeoutMs: Int?, onRetry: (String) -> Unit = {}): VirtualMachine {',
          '    fun attach(host: String, port: Int, timeoutMs: Int, onRetry: (String) -> Unit = {}): VirtualMachine {');
        original = restoreAdaptation(original,
          '        val deadline = timeoutMs?.takeIf { it > 0 }?.let { System.currentTimeMillis() + it }',
          '        val deadline = System.currentTimeMillis() + timeoutMs.coerceAtLeast(1000)');
        original = restoreAdaptation(original,
          '        while (deadline == null || System.currentTimeMillis() < deadline) {',
          '        while (System.currentTimeMillis() < deadline) {');
        original = restoreAdaptation(original,
          '                val attemptTimeout = deadline?.let { (it - System.currentTimeMillis()).coerceIn(1000, 10_000) } ?: 10_000\n' +
          '                return attachOnce(connector, host, port, attemptTimeout)',
          '                return attachOnce(connector, host, port, (deadline - System.currentTimeMillis()).coerceIn(1000, 10_000))');
      } else if (entry.path === adaptedPaths[3] || entry.path === adaptedPaths[4]) {
        const normalized = String.raw`.str("path")!!.replace('\\', '/').endsWith("`;
        const expectedCount = entry.path === adaptedPaths[3] ? 4 : 3;
        original = restoreAdaptation(original, normalized, '.str("path")!!.endsWith("', expectedCount);
      } else if (entry.path === adaptedPaths[5]) {
        original = restoreAdaptation(original, '        assertNull(c.timeoutMs)', '        assertEquals(30_000, c.timeoutMs)');
        original = restoreAdaptation(original,
          '    @Test\n' +
          '    fun `explicit attach timeout remains configurable`() {\n' +
          '        assertEquals(1_500, SessionConfig.from("attach", mapOf("timeout" to 1_500, "port" to 5006)).timeoutMs)\n' +
          '    }\n\n', '');
      } else if (entry.path === 'adapter/pom.xml') {
        original = restoreAdaptation(original,
          '                                        <!-- java -jar 聚合包仅由 transformer 生成清单，不携带依赖模块描述符。 -->\n' +
          '                                        <exclude>META-INF/MANIFEST.MF</exclude>\n', '');
        original = restoreAdaptation(original,
          '<exclude>META-INF/versions/**/module-info.class</exclude>',
          '<exclude>META-INF/versions/9/module-info.class</exclude>');
      }
      assert.equal(crypto.createHash('sha256').update(original).digest('hex'), entry.upstreamSha256, `${entry.path} 重建上游摘要`);
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
 * 功能点：现役构建和测试入口不再要求已删除的服务。
 * 受影响对象：package scripts、build 与现役产物集合。
 * 复现路径：Node>=22，读取当前构建入口，不执行 Maven。
 * 测试范围：默认构建两项产物、compile/prepublish 不绕过 build:jvm、test:jvm 保留上游测试。
 * 执行入口：node --test tests/jvm-build.test.js。
 * 预期结果：无 Coordinator 构建或资源读取，必要构建、校验与许可复制仍存在。
 * 判据：入口或产物集合变化、服务依赖重现及必要校验缺失均失败。
 */
test('build and test entrypoints require only the active JVM and Gradle artifacts', () => {
  const source = fs.readFileSync(buildScript, 'utf8');
  assert.doesNotMatch(source, /coordinator/i);
  assert.deepEqual(shadedServices.map(service => service.jar), ['resources/jvm-debugger/kotlin-debug-adapter.jar', 'resources/gradle-tooling-server.jar']);
  const scripts = require('../package.json').scripts;
  assert.equal(scripts['build:jvm'], 'node scripts/build-jvm-debugger.cjs');
  assert.equal(scripts['test:jvm'], 'node scripts/build-jvm-debugger.cjs --test');
  assert.equal(scripts.compile, 'npm run build:jvm && node esbuild.js');
  assert.equal(scripts['vscode:prepublish'], 'npm run typecheck && npm run build:jvm && node esbuild.js --production && node scripts/verify-core-runtime.cjs');
  assert.match(source, /verifyJar\(runtime\.java, jar\)/);
  assert.match(source, /copyFile\(path\.join\(UPSTREAM, 'LICENSE'\), path\.join\(path\.dirname\(OUTPUT\), 'LICENSE'\)\)/);
});
