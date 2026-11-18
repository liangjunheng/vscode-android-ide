import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SourceDiscoverySelection { projectRoot: string; modulePath: string; variant: string; wrapper: string; }
export interface SourceRoot { path: string; kind: 'java' | 'kotlin' | 'jniLibs'; priority?: number; modulePath?: string; variant?: string; }
export interface NativeSourceModule { modulePath: string; moduleRoot: string; variant: string; }
export interface SourceIndex { schema: 1; projectRoot: string; modulePath: string; moduleRoot: string; variant: string; applicationId?: string; roots: SourceRoot[]; nativeModules?: NativeSourceModule[]; capabilities: Record<string,string>; }
export type GradleSourceRunner = (command: string, args: string[], cwd: string, signal: AbortSignal) => Promise<string>;
const MARKER = '__DSH_SOURCE_INDEX__';
const PACKAGE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

// 将索引路径规范化为绝对路径；保留真实目录拼写并统一 Windows 盘符，仍拒绝符号链接别名。
// 回归：node --test tests/project-model.test.js；Windows drive identity 验证大小写盘符同项目、错模块/变体仍拒绝。
function canonical(value: unknown, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Invalid ' + label);
  const normalized = path.normalize(value);
  if (fs.existsSync(normalized)) {
    const resolved = fs.realpathSync(normalized);
    if (path.relative(resolved, normalized) !== '') throw new Error('Non-canonical ' + label);
    return resolved.replace(/^[a-z]:/, drive => drive.toUpperCase());
  }
  return normalized;
}
// 校验并返回非数组对象，阻断损坏的Gradle JSON结构并保留明确错误上下文。
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ' + label);
  return value as Record<string, unknown>;
}

// 校验来源模块/变体身份；project-model.test.js覆盖根模块、依赖变体及非法来源，拒绝不完整图身份。
function validateModuleIdentity(value: Record<string, unknown>, label: string): void {
  if (typeof value.modulePath !== 'string' || (value.modulePath !== ':' && !/^(:[A-Za-z0-9_.-]+)+$/.test(value.modulePath))) throw new Error('Invalid ' + label + ' modulePath');
  if (typeof value.variant !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(value.variant)) throw new Error('Invalid ' + label + ' variant');
}

// 校验JSON、app身份、路径、来源与nativeModules；缺省nativeModules为旧模型未知，空数组明确表示无运行时native模块。
// 回归：node --test tests/project-model.test.js；依赖来源与native模块用例断言app不变、来源保留、非法及重复模块拒绝。
export function parseSourceIndex(input: string | unknown, selection?: SourceDiscoverySelection): SourceIndex {
  let raw: unknown = input;
  if (typeof input === 'string') {
    const marked = input.split(/\r?\n/).filter(line => line.startsWith(MARKER));
    try { raw = marked.length === 1 ? JSON.parse(marked[0].slice(MARKER.length)) : JSON.parse(input); } catch { throw new Error('Invalid source index JSON'); }
  }
  const value = object(raw, 'source index');
  if (value.schema !== 1) throw new Error('Unsupported source index schema');
  const projectRoot = canonical(value.projectRoot, 'projectRoot');
  const moduleRoot = canonical(value.moduleRoot, 'moduleRoot');
  if (typeof value.modulePath !== 'string' || (value.modulePath !== ':' && !/^(:[A-Za-z0-9_.-]+)+$/.test(value.modulePath))) throw new Error('Invalid modulePath');
  if (typeof value.variant !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(value.variant)) throw new Error('Invalid variant');
  if (selection && (path.normalize(projectRoot) !== path.normalize(canonical(selection.projectRoot, 'selection projectRoot')) || value.modulePath !== selection.modulePath || value.variant !== selection.variant)) throw new Error('Source index selection mismatch');
  if (value.applicationId !== undefined && (typeof value.applicationId !== 'string' || !PACKAGE.test(value.applicationId))) throw new Error('Invalid applicationId');
  if (!Array.isArray(value.roots)) throw new Error('Invalid source roots');
  const roots = value.roots.map((entry, index) => {
    const item = object(entry, 'root ' + index);
    if (item.kind !== 'java' && item.kind !== 'kotlin' && item.kind !== 'jniLibs') throw new Error('Invalid root kind');
    const root = canonical(item.path, 'root path');
    if (item.priority !== undefined && (!Number.isInteger(item.priority) || (item.priority as number) < 0)) throw new Error('Invalid root priority');
    if ((item.modulePath === undefined) !== (item.variant === undefined)) throw new Error('Incomplete source provenance');
    if (item.modulePath !== undefined) validateModuleIdentity(item, 'source provenance');
    return { path: root, kind: item.kind, ...(item.priority === undefined ? {} : { priority: item.priority as number }), ...(item.modulePath === undefined ? {} : { modulePath: item.modulePath as string, variant: item.variant as string }) } as SourceRoot;
  });
  let nativeModules: NativeSourceModule[] | undefined;
  if (value.nativeModules !== undefined) {
    if (!Array.isArray(value.nativeModules)) throw new Error('Invalid nativeModules');
    const seen = new Set<string>();
    nativeModules = value.nativeModules.map(entry => {
      const module = object(entry, 'native module');
      validateModuleIdentity(module, 'native module');
      const key = module.modulePath + '/' + module.variant;
      if (seen.has(key)) throw new Error('Duplicate native module ' + key);
      seen.add(key);
      return { modulePath: module.modulePath as string, variant: module.variant as string, moduleRoot: canonical(module.moduleRoot, 'native moduleRoot') };
    });
  }
  const caps = object(value.capabilities || {}, 'capabilities');
  const capabilities: Record<string,string> = {};
  for (const [key, capability] of Object.entries(caps)) { if (typeof capability !== 'string') throw new Error('Invalid capability ' + key); capabilities[key] = capability; }
  return { schema: 1, projectRoot, modulePath: value.modulePath as string, moduleRoot, variant: value.variant as string, ...(value.applicationId === undefined ? {} : { applicationId: value.applicationId as string }), roots, ...(nativeModules === undefined ? {} : { nativeModules }), capabilities };
}

// 生成动态AGP脚本：按已解析生产者属性匹配compile/runtime项目变体，保留app身份并仅收集选中来源。
// projectsEvaluated接入源码Provider输入依赖，doLast在生成器完成后读根；project-model.test.js的Groovy图矩阵及显式授权smoke覆盖来源、flavor、生成根和nativeModules。
export function createSourceIndexInitScript(outputPath: string): string {
  const output = outputPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return "def dshOutput = new File('" + output + "')\n" + "def dshModule = gradle.startParameter.projectProperties['dshModulePath']\ndef dshVariant = gradle.startParameter.projectProperties['dshVariant']\ndef dshFound = false\ndef dshDescriptors = []\ndef dshRequire = { obj, name ->\n  if (!obj?.metaClass?.hasProperty(obj,name)) throw new GradleException('DSH AGP ' + name + ' API unavailable; upgrade AGP for source discovery')\n  obj.\"$name\"\n}\ndef dshFlat = { source, name ->\n  def prop = source?.metaClass?.hasProperty(source,name)\n  if (!prop) return [capability:'missing',dirs:[]]\n  def dirs = prop.getProperty(source)\n  dirs == null ? [capability:'null',dirs:[]] : [capability:'present',dirs:dirs.all.get().collect { it.asFile.canonicalPath }]\n}\ndef dshCollect = { descriptor ->\n  def v = descriptor.variant\n  def s = dshRequire(v,'sources')\n  def roots = []\n  def caps = [:]\n  ['java','kotlin'].each { kind ->\n    def data = dshFlat(s,kind)\n    caps[kind] = data.capability\n    data.dirs.each { roots << [path:it,kind:kind,modulePath:descriptor.project.path,variant:String.valueOf(v.name)] }\n  }\n  def n = s?.metaClass?.hasProperty(s,'jniLibs')?.getProperty(s)\n  caps.jniLibs = n == null ? 'missing' : 'present'\n  if (n) n.all.get().eachWithIndex { layer,i -> layer.each { roots << [path:it.asFile.canonicalPath,kind:'jniLibs',priority:i,modulePath:descriptor.project.path,variant:String.valueOf(v.name)] } }\n  [roots:roots,capabilities:caps]\n}\ndef dshResolve = { configuration ->\n  def selected = [:]\n  configuration.incoming.resolutionResult.allDependencies.each { dependency ->\n    if (dependency instanceof org.gradle.api.artifacts.result.UnresolvedDependencyResult) throw new GradleException('DSH unresolved dependency in ' + configuration.name + ': ' + dependency.attempted, dependency.failure)\n    if (dependency instanceof org.gradle.api.artifacts.result.ResolvedDependencyResult && dependency.selected.id instanceof org.gradle.api.artifacts.component.ProjectComponentIdentifier) {\n      def id = dependency.selected.id\n      if (!id.build.isCurrentBuild()) throw new GradleException('DSH included-build project sources unsupported: ' + id + '; select that build explicitly')\n      def attributes = dependency.resolvedVariant.attributes\n      def values = [:]\n      attributes.keySet().each { key -> values[key.name] = String.valueOf(attributes.getAttribute(key)) }\n      def buildType = values['com.android.build.api.attributes.BuildTypeAttr']\n      if (buildType == null) throw new GradleException('DSH selected project lacks Android BuildTypeAttr: ' + id)\n      def flavorPrefix = 'com.android.build.api.attributes.ProductFlavor:'\n      def flavors = values.findAll { key,value -> key.startsWith(flavorPrefix) }.collectEntries { key,value -> [(key.substring(flavorPrefix.length())):value] }\n      def candidates = dshDescriptors.findAll { descriptor ->\n        if (descriptor.project.path != id.projectPath || String.valueOf(descriptor.variant.buildType) != buildType) return false\n        def declared = descriptor.variant.productFlavors.collectEntries { pair -> [(String.valueOf(pair.first)):String.valueOf(pair.second)] }\n        declared == flavors\n      }\n      if (candidates.size() != 1) throw new GradleException('DSH selected producer variant is missing or ambiguous: ' + id + ' ' + buildType + ' ' + flavors)\n      def descriptor = candidates[0]\n      selected[id.projectPath + '/' + descriptor.variant.name] = descriptor\n    }\n  }\n  selected\n}\ndef dshAttach = { p ->\n  def ac = p.extensions.findByName('androidComponents')\n  if (ac == null || !ac.metaClass.respondsTo(ac,'selector')) throw new GradleException('DSH requires AGP androidComponents selector; upgrade AGP for source discovery')\n  ac.onVariants(ac.selector().all()) { v ->\n    def descriptor = [project:p,variant:v]\n    dshDescriptors << descriptor\n    if (p.path == dshModule && String.valueOf(v.name) == dshVariant) {\n      dshFound = true\n      gradle.projectsEvaluated {\n        def runtime = dshResolve(dshRequire(v,'runtimeConfiguration'))\n        def compile = dshResolve(dshRequire(v,'compileConfiguration'))\n        def ownKey = p.path + '/' + v.name\n        def all = [(ownKey):descriptor] + compile + runtime\n        p.tasks.register('__dshSourceIndex') { task ->\n          all.each { key,item ->\n            def sources = dshRequire(item.variant,'sources')\n            ['java','kotlin','jniLibs'].each { kind ->\n              def prop = sources.metaClass.hasProperty(sources,kind)\n              def dirs = prop == null ? null : prop.getProperty(sources)\n              if (dirs != null) task.inputs.files(dirs.all)\n            }\n          }\n          doLast {\n          def roots = []\n          def own = null\n          all.each { key,item ->\n            def data = dshCollect(item)\n            roots.addAll(data.roots)\n            if (key == ownKey) own = data\n          }\n          def nativeModules = []\n          ([(ownKey):descriptor] + runtime).each { key,item ->\n            if (dshRequire(item.variant,'externalNativeBuild') != null) nativeModules << [modulePath:item.project.path,moduleRoot:item.project.projectDir.canonicalPath,variant:String.valueOf(item.variant.name)]\n          }\n          def result = [schema:1,projectRoot:p.rootProject.projectDir.canonicalPath,modulePath:p.path,moduleRoot:p.projectDir.canonicalPath,variant:String.valueOf(v.name),roots:roots.unique(),nativeModules:nativeModules,capabilities:own.capabilities + [projectDependencies:'resolved']]\n          def aid = v?.metaClass?.hasProperty(v,'applicationId')?.getProperty(v)\n          if (aid != null) result.applicationId = String.valueOf(aid.respondsTo('get') ? aid.get() : aid)\n          dshOutput.text = groovy.json.JsonOutput.toJson(result)\n          }\n        }\n      }\n    }\n  }\n}\ngradle.allprojects { p ->\n  p.pluginManager.withPlugin('com.android.application') { dshAttach(p) }\n  p.pluginManager.withPlugin('com.android.library') { dshAttach(p) }\n}\ngradle.buildFinished { if (!dshFound) throw new GradleException('DSH selected module/variant was not observed: ' + dshModule + '/' + dshVariant) }\n";
}

// 临时文件归发现操作所有；runner结束后无论成功、失败或取消都清理，取消在启动前和解析前均拒绝伪成功。
export async function discoverVariantSources(selection: SourceDiscoverySelection, run: GradleSourceRunner, signal: AbortSignal = new AbortController().signal): Promise<SourceIndex> {
  const projectRoot = canonical(selection.projectRoot, 'projectRoot');
  if (selection.modulePath !== ':' && !/^(:[A-Za-z0-9_.-]+)+$/.test(selection.modulePath)) throw new Error('Invalid modulePath');
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(selection.variant)) throw new Error('Invalid variant');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-source-index-'));
  const script = path.join(temp, 'init.gradle');
  const output = path.join(temp, 'source-index.json');
  fs.writeFileSync(script, createSourceIndexInitScript(output), 'utf8');
  try {
    if (signal.aborted) throw new Error('Operation cancelled');
    await run(selection.wrapper, ['--init-script', script, (selection.modulePath === ':' ? '' : selection.modulePath) + ':__dshSourceIndex', '--console=plain', '-PdshModulePath=' + selection.modulePath, '-PdshVariant=' + selection.variant], projectRoot, signal);
    if (signal.aborted) throw new Error('Operation cancelled');
    if (!fs.existsSync(output)) throw new Error('Gradle source index was not produced');
    return parseSourceIndex(JSON.parse(fs.readFileSync(output, 'utf8')), { ...selection, projectRoot });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
