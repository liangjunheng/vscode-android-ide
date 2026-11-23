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

// 两项 Java 产物保持严格 Shade 契约；许可摘要来自已核对的依赖原文字节。
const shadedServices = [
  { pom: 'src/android-debugger/jvm-debugger/upstream/adapter/pom.xml', jar: 'resources/jvm-debugger/kotlin-debug-adapter.jar', main: 'dev.ktdebug.MainKt' },
  {
    pom: 'src/gradle-tooling/pom.xml', jar: 'resources/gradle-tooling-server.jar', main: 'android.tools.gradle.GradleToolingServer',
    license: 'META-INF/LICENSE.txt', originalBytes: 1178, originalSha256: '4e7f90c86ab51278228bce153122f1d8df30149d13ce9ef524c8444a84c32dcc',
    externalLicense: 'resources/gradle-tooling-LICENSE.txt',
  },
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
    'adapter/src/main/kotlin/dev/ktdebug/session/DebugSession.kt',
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
          '                    val detail = "${e.javaClass.name}:${e.message ?: ""}"\n' +
          '                    Log.warn("JDWP handshake failed at $host:$port ($detail)", e)\n' +
          '                    throw ConnectException2("JDWP handshake failed at $host:$port ($detail)").also { it.initCause(e) }',
          '                    throw ConnectException2(\n' +
          '                        "Connected to $host:$port but the JDWP handshake failed. Either the port is not a JDWP " +\n' +
          '                            "debug port, or another debugger is already attached (JDWP allows one debugger at a time)."\n' +
          '                    )');
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
      } else if (entry.path === 'adapter/src/main/kotlin/dev/ktdebug/session/DebugSession.kt') {
        original = restoreAdaptation(original, '    private val startEventLock = Any()\n', '');
        original = restoreAdaptation(original,
          '    /** 功能：原子交接已配置状态及启动挂起；输入 DAP 配置完成；输出恰好一次恢复；验证：StartResumeTest。 */\n' +
          '    fun configurationDone() {\n' +
          '        val pending = synchronized(startEventLock) {\n' +
          '            configured = true\n' +
          '            startEventSet.also { startEventSet = null }\n' +
          '        }\n' +
          '        pending?.let { set ->\n' +
          '            set.resume()\n' +
          '            Log.info("Resumed VM that was waiting for the debugger")\n' +
          '        }\n    }',
          '    /** DAP `configurationDone`: breakpoints are installed, release a VM that waits for us. */\n' +
          '    fun configurationDone() {\n' +
          '        configured = true\n' +
          '        startEventSet?.let { set ->\n' +
          '            startEventSet = null\n' +
          '            Log.info("Resuming VM that was waiting for the debugger (suspend=y)")\n' +
          '            set.resume()\n' +
          '        }\n    }');
        original = restoreAdaptation(original,
          '            val suspending = set.suspendPolicy() != EventRequest.SUSPEND_NONE\n' +
          '            synchronized(startEventLock) {\n' +
          '                if (suspending && !configured) {\n' +
          '                    startEventSet = set\n' +
          '                    Outcome.Hold\n' +
          '                } else Outcome.Resume\n' +
          '            }',
          '            if (set.suspendPolicy() != EventRequest.SUSPEND_NONE && !configured) {\n' +
          '                startEventSet = set\n' +
          '                Outcome.Hold\n' +
          '            } else Outcome.Resume');
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

/**
 * 功能点：两项聚合产物的 Shade 配置保持可执行主类、服务发现和冲突许可原文。
 * 受影响对象：JVM 与 Gradle 两份 POM、build 的 Tooling 外部许可说明及 SOURCE_LOCK 中的 POM 适配。
 * 复现路径：Node>=22，读取实际 POM 和脚本，不执行 Maven、Java、网络或设备操作。
 * 测试范围：保留主类/服务 transformer，仅排除签名、依赖清单和全部模块描述符；Tooling 许可使用追加而非过滤。
 * 执行入口：node --test tests/jvm-build.test.js；也由 npm test 发现。
 * 预期结果：配置不抑制警告、不排除许可，Tooling 明确说明保留两个依赖的原文。
 * 判据：排除项及 transformer 全部匹配才通过；真实成品另由下方产物用例检查。
 */
test('Shade configuration preserves executable services and appends colliding licenses', () => {
  for (const service of shadedServices) {
    const pom = fs.readFileSync(path.join(root, service.pom), 'utf8');
    const shade = pom.match(/<plugin>\s*<groupId>org\.apache\.maven\.plugins<\/groupId>\s*<artifactId>maven-shade-plugin<\/artifactId>[\s\S]*?<\/plugin>/)?.[0];
    assert.ok(shade, service.pom);
    const transformers = [...shade.matchAll(/<transformer\b[^>]*implementation="([^"]+)"[^/>]*(?:\/>|>[\s\S]*?<\/transformer>)/g)];
    const expected = ['ManifestResourceTransformer', 'ServicesResourceTransformer'];
    if (service.license) expected.push('AppendingTransformer');
    assert.deepEqual(transformers.map(match => match[1]), expected.map(name => `org.apache.maven.plugins.shade.resource.${name}`), service.pom);
    assert.ok(transformers[0][0].includes(`<mainClass>${service.main}</mainClass>`), service.pom);
    if (service.license) assert.ok(transformers[2][0].includes(`<resource>${service.license}</resource>`), service.pom);
    const excludes = [...shade.matchAll(/<exclude>([^<]+)<\/exclude>/g)].map(match => match[1]);
    assert.deepEqual(excludes.sort(), ['META-INF/*.SF', 'META-INF/*.RSA', 'META-INF/*.DSA', 'META-INF/MANIFEST.MF', 'module-info.class', 'META-INF/versions/**/module-info.class'].sort(), service.pom);
  }
  const source = fs.readFileSync(buildScript, 'utf8');
  assert.match(source, /SLF4J API and Simple 2\.0\.17 — MIT（以下合并保留两依赖的完整许可原文）/);
  assert.match(source, /\(await slf4jLicense\.buffer\(\)\)\.toString\('utf8'\)/);
});

/**
 * 功能点：两项真实成品的清单、非 JPMS 布局和同名许可追加结果保持发布契约。
 * 受影响对象：JVM 与 Gradle 两项 resources JAR、Tooling 外部许可和 SLF4J 服务发现。
 * 复现路径：先由独立执行者运行 npm run build:jvm，再以 Node>=22 读取两份成品；本测试不构建、不启动 Java 或设备。
 * 测试范围：唯一清单及主类 class、预扫不得带入依赖模块名/外部类路径、所有版本 module-info 缺失；两依赖许可按原摘要逐字节保留两份并同步外部许可。
 * 执行入口：node --test tests/jvm-build.test.js（需要新构建的成品）；也由 npm test 发现。
 * 预期结果：两份成品均可由清单定位入口，无依赖模块描述符；同名许可仅一个条目但包含两份完整原文。
 * 判据：缺失、陈旧或损坏成品、错误主类、残留模块描述符、许可丢失/改写/去重及服务提供者丢失均失败，不跳过缺失产物。
 */
test('Shaded service artifacts retain main classes and both original licenses without module descriptors', async () => {
  for (const service of shadedServices) {
    const archive = await require('unzipper').Open.file(path.join(root, service.jar));
    const files = archive.files.filter(entry => entry.type === 'File');
    const manifests = files.filter(entry => entry.path === 'META-INF/MANIFEST.MF');
    assert.equal(manifests.length, 1, `${service.jar} 唯一清单`);
    const manifest = (await manifests[0].buffer()).toString('utf8').replace(/\r\n/g, '\n').replace(/\n /g, '');
    const mainAttributes = manifest.split('\n\n')[0].split('\n');
    assert.deepEqual(mainAttributes.filter(line => /^Main-Class:/i.test(line)), [`Main-Class: ${service.main}`], service.jar);
    assert.doesNotMatch(mainAttributes.join('\n'), /^(?:Automatic-Module-Name|Class-Path):/im, `${service.jar} 不引入依赖清单属性`);
    assert.ok(files.some(entry => entry.path === `${service.main.replaceAll('.', '/')}.class`), `${service.jar} 入口 class`);
    assert.deepEqual(files.filter(entry => /^(?:META-INF\/versions\/.*\/)?module-info\.class$/.test(entry.path)).map(entry => entry.path), [], service.jar);
    if (!service.license) continue;
    const licenses = files.filter(entry => entry.path === service.license);
    assert.equal(licenses.length, 1, `${service.jar} 唯一追加许可条目`);
    const merged = await licenses[0].buffer();
    const original = merged.subarray(0, service.originalBytes);
    assert.equal(crypto.createHash('sha256').update(original).digest('hex'), service.originalSha256, `${service.jar} 原文摘要`);
    assert.deepEqual(merged, Buffer.concat([original, Buffer.from('\n'), original, Buffer.from('\n')]), `${service.jar} 两份完整许可原字节`);
    const external = fs.readFileSync(path.join(root, service.externalLicense));
    const first = external.indexOf(original);
    const second = external.indexOf(original, first + original.length);
    assert.ok(first >= 0 && second >= first + original.length, `${service.externalLicense} 保留两个依赖原文`);
    assert.equal(external.indexOf(original, second + original.length), -1, `${service.externalLicense} 两份原文`);
    if (service.license === 'META-INF/LICENSE.txt') {
      assert.deepEqual(external.subarray(external.length - merged.length), merged, 'Tooling 外部许可保留完整追加条目');
      const providers = files.filter(entry => entry.path === 'META-INF/services/org.slf4j.spi.SLF4JServiceProvider');
      assert.equal(providers.length, 1, 'SLF4J 服务条目');
      assert.ok((await providers[0].buffer()).toString('utf8').split(/\r?\n/).includes('org.slf4j.simple.SimpleServiceProvider'), 'SLF4J Simple 提供者');
    }
  }
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
