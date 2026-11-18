const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const AbortController = global.AbortController;
const { transformSync } = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '../src/android-debugger/projectModel.ts'), 'utf8');
const compiled = transformSync(source, { loader: 'ts', format: 'cjs', platform: 'node' }).code;
const loaded = { exports: {} };
vm.runInNewContext(compiled, { require, module: loaded, exports: loaded.exports, console, process, Buffer, AbortController, setTimeout, clearTimeout });
const { parseSourceIndex, createSourceIndexInitScript, discoverVariantSources } = loaded.exports;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-model-test-'));
  const java = path.join(root, 'custom-java');
  const kotlin = path.join(root, 'generated-kotlin');
  const jni = path.join(root, 'native-libs');
  fs.mkdirSync(java, { recursive: true }); fs.mkdirSync(kotlin, { recursive: true }); fs.mkdirSync(jni, { recursive: true });
  return { root, java, kotlin, jni, selection: { projectRoot: root, modulePath: ':app', variant: 'freeDebug', wrapper: path.join(root, 'gradlew') } };
}

/** Windows drive identity：同一目录不同盘符拼写必须规范为相同身份，错项目/模块/变体和 junction 别名仍拒绝。 */
test('Windows drive identity preserves strict source selection', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  try {
    const actual = fs.realpathSync(f.root);
    const lowerDrive = actual[0].toLowerCase() + actual.slice(1);
    const raw = { schema: 1, projectRoot: actual, moduleRoot: actual, modulePath: ':app', variant: 'freeDebug', roots: [{ path: f.java, kind: 'java' }], capabilities: {} };
    const selection = { ...f.selection, projectRoot: lowerDrive };
    assert.equal(parseSourceIndex(raw, selection).projectRoot, actual);
    assert.equal(parseSourceIndex({ ...raw, projectRoot: lowerDrive }, f.selection).projectRoot, actual);
    for (const changed of [{ ...selection, projectRoot: f.java }, { ...selection, modulePath: ':other' }, { ...selection, variant: 'release' }]) assert.throws(() => parseSourceIndex(raw, changed), /mismatch/);
    const alias = path.join(f.root, 'alias');
    fs.symlinkSync(f.java, alias, 'junction');
    assert.throws(() => parseSourceIndex({ ...raw, roots: [{ path: alias, kind: 'java' }] }, selection), /Non-canonical/);
    const discovered = await discoverVariantSources(selection, async (_command, args, cwd) => {
      assert.equal(cwd, actual);
      fs.writeFileSync(path.join(path.dirname(args[1]), 'source-index.json'), JSON.stringify(raw));
      return '';
    });
    assert.equal(discovered.projectRoot, actual);
    assert.equal(discovered.modulePath, ':app');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('parses selected variant with every custom root and optional application id', () => {
  const f = fixture();
  try {
    const index = parseSourceIndex(JSON.stringify({ schema: 1, projectRoot: f.root, modulePath: ':app', moduleRoot: f.root, variant: 'freeDebug', applicationId: 'com.example.free', roots: [{ path: f.java, kind: 'java' }, { path: f.kotlin, kind: 'kotlin' }, { path: f.jni, kind: 'jniLibs', priority: 0 }], capabilities: { java: 'present', kotlin: 'present', jniLibs: 'present' } }), f.selection);
    assert.equal(index.variant, 'freeDebug');
    assert.equal(index.roots.map(r => r.path).join('|'), [f.java, f.kotlin, f.jni].join('|'));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects malformed output, identity mismatch, noncanonical paths, and conventional-root fallback', () => {
  const f = fixture();
  try {
    const base = { schema: 1, projectRoot: f.root, modulePath: ':app', moduleRoot: f.root, variant: 'freeDebug', roots: [{ path: f.java, kind: 'java' }], capabilities: {} };
    assert.throws(() => parseSourceIndex('noise\n' + JSON.stringify(base), f.selection), /Invalid/);
    assert.throws(() => parseSourceIndex(JSON.stringify({ ...base, variant: 'release' }), f.selection), /mismatch/);
    assert.equal(parseSourceIndex(JSON.stringify({ ...base, roots: [{ path: path.join(f.java, '..', 'custom-java'), kind: 'java' }] }), f.selection).roots.length, 1);
    assert.equal(parseSourceIndex(JSON.stringify({ ...base, roots: [] }), f.selection).roots.length, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('generates dynamic AGP script without hardcoded source fallback', () => {
  const script = createSourceIndexInitScript('C:\\temp\\index.json');
  assert.match(script, /androidComponents/);
  assert.match(script, /metaClass.*hasProperty/);
  assert.match(script, /jniLibs/);
  assert.match(script, /startParameter.projectProperties/);
  assert.doesNotMatch(script, /providers.gradleProperty/);
  assert.match(script, /upgrade AGP for source discovery/);
  assert.match(script, /dshModulePath/);
  assert.doesNotMatch(script, /src[\\/]main/);
  assert.match(script, /buildFinished/);
});


// 依赖图元数据回归：仅合并解析出的生产者来源，保持app身份并严格校验nativeModules。
test('dependency provenance and runtime native modules preserve selected app identity', () => {
  const f = fixture();
  try {
    const raw = { schema: 1, projectRoot: f.root, moduleRoot: f.root, modulePath: ':app', variant: 'freeDebug', applicationId: 'com.example.free', capabilities: { projectDependencies: 'resolved' }, roots: [
      { path: f.java, kind: 'java', modulePath: ':app', variant: 'freeDebug' },
      { path: f.kotlin, kind: 'kotlin', modulePath: ':lib', variant: 'paidDebug' },
      { path: f.java, kind: 'java', modulePath: ':compileOnly', variant: 'debug' }
    ], nativeModules: [{ moduleRoot: f.root, modulePath: ':lib', variant: 'paidDebug' }] };
    const model = parseSourceIndex(raw, f.selection);
    assert.equal(model.applicationId, 'com.example.free');
    assert.equal(model.modulePath, ':app');
    assert.equal(model.roots[1].modulePath, ':lib');
    assert.equal(model.roots[1].variant, 'paidDebug');
    assert.equal(model.roots.length, 3);
    assert.equal(model.nativeModules.length, 1);
    assert.equal(model.nativeModules[0].modulePath, ':lib');
    assert.equal(model.nativeModules[0].moduleRoot, f.root);
    for (const nativeModules of [null, {}, [{ modulePath: ':lib', moduleRoot: f.root }], [{ modulePath: 'lib', moduleRoot: f.root, variant: 'debug' }], [{ modulePath: ':lib', moduleRoot: 'relative', variant: 'debug' }], [raw.nativeModules[0], raw.nativeModules[0]]]) {
      assert.throws(() => parseSourceIndex({ ...raw, nativeModules }), /Invalid|Duplicate/);
    }
    assert.throws(() => parseSourceIndex({ ...raw, roots: [{ path: f.java, kind: 'java', modulePath: ':lib' }] }), /Incomplete/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('graph script selects public resolved producer attributes and rejects unsupported graph identities', () => {
  const script = createSourceIndexInitScript('index.json');
  assert.match(script, /compileConfiguration/);
  assert.match(script, /runtimeConfiguration/);
  assert.match(script, /resolutionResult.allDependencies/);
  assert.match(script, /ProjectComponentIdentifier/);
  assert.match(script, /dependency.resolvedVariant.attributes/);
  assert.match(script, /BuildTypeAttr/);
  assert.match(script, /ProductFlavor:/);
  assert.match(script, /declared == flavors/);
  assert.ok(script.includes('candidates.size() != 1'));
  assert.match(script, /projectsEvaluated/);
  assert.match(script, /task.inputs.files/);
  assert.match(script, /UnresolvedDependencyResult/);
  assert.match(script, /included-build project sources unsupported/);
  assert.doesNotMatch(script, /internal.attributes|VariantAttr|RuntimeElements/);
});


// 使用已有Gradle Groovy运行时直接执行生成脚本中的解析闭包；显式DSH_GRADLE_HOME启用，无下载或项目构建。
test('executable Gradle graph fixtures cover flavors fallback transitive unused root and errors', { skip: !process.env.DSH_GRADLE_HOME && 'DSH_GRADLE_HOME required for existing Gradle runtime' }, () => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graph-fixtures-'));
  try {
    const script = createSourceIndexInitScript(path.join(dir, 'index.json'));
    const resolver = script.slice(script.indexOf('def dshResolve ='), script.indexOf('def dshAttach ='));
    const fixture = "import org.gradle.api.GradleException\nimport org.gradle.api.attributes.Attribute\nimport org.gradle.api.attributes.AttributeContainer\nimport org.gradle.api.artifacts.component.BuildIdentifier\nimport org.gradle.api.artifacts.component.ProjectComponentIdentifier\nimport org.gradle.api.artifacts.result.*\ndef dshDescriptors = []\n__RESOLVER__\ndef descriptor = { module,name,type,flavors -> [project:[path:module],variant:[name:name,buildType:type,productFlavors:flavors.collect { key,value -> new Tuple2(key,value) }]] }\ndef dep = { module,type,flavors,current=true ->\n  def values = [:]\n  if(type != null) values[Attribute.of('com.android.build.api.attributes.BuildTypeAttr',String)] = type\n  flavors.each { key,value -> values[Attribute.of('com.android.build.api.attributes.ProductFlavor:' + key,String)] = value }\n  def attrs = [keySet:{values.keySet()},getAttribute:{key -> values[key]}] as AttributeContainer\n  def build = [isCurrentBuild:{current}] as BuildIdentifier\n  def id = [getBuild:{build},getProjectPath:{module},getDisplayName:{module}] as ProjectComponentIdentifier\n  def variant = [getAttributes:{attrs}] as ResolvedVariantResult\n  [getSelected:{ [getId:{id}] as ResolvedComponentResult },getResolvedVariant:{variant}] as ResolvedDependencyResult\n}\ndef config = { entries -> [name:'fixtureClasspath',incoming:[resolutionResult:[allDependencies:entries]]] }\ndef rejects = { entries,expected ->\n  try { dshResolve(config(entries)); throw new AssertionError('expected error ' + expected) }\n  catch(GradleException error) { assert error.message.contains(expected): error.message }\n}\ndef root = descriptor(':','rootDebug','debug',[:])\ndef selected = descriptor(':lib','paidArmDebug','debug',[tier:'paid',cpu:'arm'])\ndef otherFlavor = descriptor(':lib','freeArmDebug','debug',[tier:'free',cpu:'arm'])\ndef transitive = descriptor(':transitive','debug','debug',[:])\ndef unused = descriptor(':unused','debug','debug',[:])\ndshDescriptors.addAll([root,selected,otherFlavor,transitive,unused])\ndef resolved = dshResolve(config([dep(':lib','debug',[tier:'paid',cpu:'arm']),dep(':transitive','debug',[:]),dep(':lib','debug',[tier:'paid',cpu:'arm'])]))\nassert resolved.keySet() == [':lib/paidArmDebug',':transitive/debug'] as Set\nassert !resolved.values().contains(otherFlavor)\nassert !resolved.values().contains(unused)\n// Consumer custom build type is irrelevant: selected producer debug attributes drive matchingFallbacks.\nassert resolved[':lib/paidArmDebug'].variant.buildType == 'debug'\nassert dshResolve(config([dep(':','debug',[:])]))[':/rootDebug'] == root\nrejects([dep(':lib','release',[tier:'paid',cpu:'arm'])],'missing or ambiguous')\nrejects([dep(':lib','debug',[tier:'paid'])],'missing or ambiguous')\nrejects([dep(':lib',null,[:])],'lacks Android BuildTypeAttr')\nrejects([dep(':lib','debug',[tier:'paid',cpu:'arm'],false)],'included-build')\ndshDescriptors << descriptor(':lib','duplicate','debug',[tier:'paid',cpu:'arm'])\nrejects([dep(':lib','debug',[tier:'paid',cpu:'arm'])],'missing or ambiguous')\ndef unresolved = [getAttempted:{null},getFailure:{new RuntimeException('missing project')}] as UnresolvedDependencyResult\nrejects([unresolved],'unresolved dependency')\nprintln('DSH_GRAPH_FIXTURES_PASS')\n";
    const file = path.join(dir, 'fixture.groovy');
    fs.writeFileSync(file, fixture.replace('__RESOLVER__', resolver));
    const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
    const run = spawnSync(java, ['-cp', path.join(process.env.DSH_GRADLE_HOME, 'lib', '*'), 'groovy.ui.GroovyMain', file], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /DSH_GRAPH_FIXTURES_PASS/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


// 显式授权的真实工程回归：只允许源码生成任务图，断言生成根存在、依赖来源/nativeModules及app身份，结束后临时脚本已清理。
test('authorized AGP provider lifecycle smoke resolves generated library roots', { skip: !process.env.DSH_SOURCE_MODEL_SMOKE && 'DSH_SOURCE_MODEL_SMOKE selection JSON required' }, async () => {
  const { spawn } = require('node:child_process');
  const setup = JSON.parse(process.env.DSH_SOURCE_MODEL_SMOKE);
  let scriptDirectory;
  const execute = (command, args, cwd) => new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const joined = args.map(arg => /[\s]/.test(arg) ? '"' + arg + '"' : arg).join(' ');
    const child = windows ? spawn('cmd.exe', ['/d','/s','/c','gradlew.bat ' + joined], { cwd, windowsVerbatimArguments: true, env: process.env }) : spawn(command,args,{cwd,env:process.env});
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', status => status === 0 ? resolve(output) : reject(new Error(output)));
  });
  const model = await discoverVariantSources(setup.selection, async (command, args, cwd) => {
    scriptDirectory = path.dirname(args[1]);
    const graph = await execute(command, args.concat('--dry-run'), cwd);
    const tasks = graph.split(/\r?\n/).filter(line => /^:.* SKIPPED$/.test(line)).map(line => line.split(' ')[0]);
    assert.ok(tasks.length > 1, graph);
    for (const task of tasks) assert.match(task.split(':').pop(), /^(pre.*Build|generate.*BuildConfig|__dshSourceIndex)$/, graph);
    return execute(command,args,cwd);
  });
  assert.equal(model.applicationId, setup.applicationId);
  assert.equal(model.modulePath, setup.selection.modulePath);
  assert.equal(model.variant, setup.selection.variant);
  for (const module of setup.dependencies) assert.ok(model.roots.some(root => root.modulePath === module), module);
  assert.equal(model.nativeModules.map(module => module.modulePath).sort().join('|'), setup.nativeModules.sort().join('|'));
  const generated = model.roots.filter(root => root.path.includes(path.join('generated','source','buildConfig')));
  assert.ok(generated.length > 0);
  for (const root of generated) assert.ok(fs.statSync(root.path).isDirectory());
  assert.equal(fs.existsSync(scriptDirectory), false);
});

// 根模块回归：实际runner参数必须只有一个冒号，JSON输出身份与选择一致。
test('root module discovery invokes exact root task argv', async () => {
  const f = fixture();
  try {
    const selection = { ...f.selection, modulePath: ':' };
    const result = await discoverVariantSources(selection, async (command, args, cwd) => {
      assert.equal(command, selection.wrapper);
      assert.equal(cwd, f.root);
      assert.equal(args[2], ':__dshSourceIndex');
      assert.ok(args.includes('-PdshModulePath=:'));
      fs.writeFileSync(path.join(path.dirname(args[1]), 'source-index.json'), JSON.stringify({ schema: 1, projectRoot: f.root, moduleRoot: f.root, modulePath: ':', variant: 'freeDebug', roots: [], capabilities: {} }));
      return '';
    });
    assert.equal(result.modulePath, ':');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const [name, mode] of [['success', 'success'], ['runner failure', 'failure'], ['cancellation', 'cancel']]) {
  test('cleans temporary files after ' + name, async () => {
    const f = fixture();
    let initScript;
    try {
      const run = async (_command, args) => {
        initScript = args[1];
        if (mode === 'failure') throw new Error('gradle failed');
        if (mode === 'cancel') throw new Error('Operation cancelled');
        const output = args[1].replace(/init\.gradle$/, 'source-index.json');
        fs.writeFileSync(output, JSON.stringify({ schema: 1, projectRoot: f.root, modulePath: ':app', moduleRoot: f.root, variant: 'freeDebug', roots: [{ path: f.java, kind: 'java' }], capabilities: {} }));
        return '';
      };
      if (mode === 'success') { const result = await discoverVariantSources(f.selection, run); assert.equal(result.modulePath, ':app'); }
      else await assert.rejects(() => discoverVariantSources(f.selection, run), /failed|cancelled/);
      assert.ok(initScript);
      assert.equal(fs.existsSync(path.dirname(initScript)), false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}
