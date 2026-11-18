import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface RuntimeDependencies {
  platformTools: string;
  adb?: string;
  emulator?: string;
  sdkmanager?: string;
  avdmanager?: string;
  lldbDap?: string;
  lldbServer: (abi: string) => string | undefined;
  ndkRoot?: string;
  jdkRoot?: string;
  systemImagesRoot?: string;
  scrcpyServer: string;
}
export interface RuntimeContext {
  extensionRoot: string;
  platform: NodeJS.Platform;
  arch: string;
  target: string;
  /** 扩展内resources根；具体工具路径由dependencies及runtimeHostRoot提供，runtime-context回归验证。 */
  runtimeRoot: string;
  dependencies: RuntimeDependencies;
}
let activeContext: RuntimeContext | undefined;

/** 输入宿主平台及架构，输出不混用架构的目录标识；runtime-context回归覆盖平台矩阵。 */
export function runtimeTarget(platform = process.platform, arch = process.arch): string { return platform + '-' + arch; }
/** 输入工具名及平台，输出原生文件名；runtime-context回归覆盖Windows exe与命令行bat的区别。 */
export function executable(name: string, platform = process.platform): string { return platform === 'win32' ? name + '.exe' : name; }
/** 输入命令行工具名及平台，输出SDK脚本名；runtime-context回归验证Windows使用bat。 */
export function commandScript(name: string, platform = process.platform): string { return platform === 'win32' ? name + '.bat' : name; }
/** 只把缺失路径视为可回退结果；runtime-context回归断言权限错误原样传播。 */
function missing(error: unknown): boolean { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? ''); }
/** 读取真实文件状态，缺失返回undefined，其他IO错误传播；runtime-context回归覆盖。 */
function stat(candidate: string): fs.Stats | undefined { try { return fs.statSync(candidate); } catch (error) { if (missing(error)) return undefined; throw error; } }
/** 判断路径位于根内；runtime-context回归拒绝相邻目录和绝对路径越界。 */
function contained(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }

/**
 * 输入扩展根及工具类别/工具内相对路径，按resources/<工具>/<宿主>输出安全依赖或undefined；缺失可回退，权限/目录/越界不能吞错。
 * 仅在扩展自有可执行文件缺执行位时修复执行位；普通资源不修改权限。
 * Node>=22执行node --test tests/runtime-context.test.js，断言符号链接、权限、缺失及文件类型。
 */
export function resolveBundledPath(extensionRoot: string, relativeParts: string[], mode: 'file' | 'directory' | 'resource' = 'file'): string | undefined {
  const extension = path.resolve(extensionRoot);
  const [dependency, ...parts] = relativeParts;
  const root = runtimeHostRoot(extension, dependency);
  const candidate = path.resolve(root, ...parts);
  const dependencyDirectory = mode === 'directory' && parts.length === 0;
  if (!contained(root, candidate) && !dependencyDirectory) throw new Error('Bundled runtime escapes host root: ' + candidate);
  let real: string; let info: fs.Stats;
  try {
    const extensionReal = fs.realpathSync(extension);
    const resourcesReal = fs.realpathSync(path.join(extension, 'resources'));
    const dependencyReal = fs.realpathSync(path.join(extension, 'resources', dependency));
    const rootReal = fs.realpathSync(root);
    if (!contained(extensionReal, resourcesReal) || !contained(resourcesReal, dependencyReal) || !contained(dependencyReal, rootReal)) throw new Error('Bundled runtime symlink escapes dependency root: ' + root);
    real = fs.realpathSync(candidate);
    if (!contained(rootReal, real) && !(dependencyDirectory && real === rootReal)) throw new Error('Bundled runtime symlink escapes host root: ' + candidate);
    info = fs.statSync(real);
  } catch (error) { if (missing(error)) return undefined; throw error; }
  if (mode === 'directory') { if (!info.isDirectory()) throw new Error('Bundled runtime is not a directory: ' + candidate); }
  else {
    if (!info.isFile()) throw new Error('Bundled runtime is not a regular file: ' + candidate);
    if (mode === 'file') {
      if (process.platform !== 'win32' && (info.mode & 0o111) === 0) fs.chmodSync(real, info.mode | 0o111);
      fs.accessSync(real, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    }
  }
  return real;
}
/** 解析当前平台ADB，Node>=22的runtime-context回归断言唯一规范层级。 */
export function resolveBundledExecutable(root: string, name: string): string | undefined { return resolveBundledPath(root, ['platform-tools', executable(name)]); }
/** 返回依赖类别下的候选路径和所有权根；runtime-context回归验证lldb/platform-tools候选。 */
export function bundledRuntimeCandidate(root: string, name: string, dependency = 'platform-tools'): { candidate: string; root: string } {
  const owned = runtimeHostRoot(root, dependency);
  return { candidate: path.join(owned, executable(name)), root: owned };
}
/** 输入扩展根和工具类别，返回resources/<工具>/<宿主>所有权根；runtime-context回归拒绝工具名越界及旧目录。 */
export function runtimeHostRoot(root: string, dependency = 'platform-tools'): string {
  if (!dependency || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(dependency)) throw new Error('Bundled runtime dependency escapes resources: ' + dependency);
  return path.resolve(root, 'resources', dependency, runtimeTarget());
}
/** 仅构造规范ADB候选；android-toolchain回归验证扩展、存储、SDK及旧目录不参与回退。 */
export function adbRuntimeCandidates(root: string): Array<{ candidate: string; root: string }> {
  return [bundledRuntimeCandidate(root, 'adb')];
}
/** 解析设备端server，文件名与宿主无关；runtime-context回归覆盖ABI及目录拒绝。 */
export function resolveBundledLldbServer(root: string, abi: string): string | undefined {
  if (!['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'].includes(abi)) throw new Error('Unsupported Android ABI: ' + abi);
  return resolveBundledPath(root, ['lldb-server', abi, 'lldb-server'], 'resource');
}
/** 输入扩展根，输出已随包发布的scrcpy资源位置；runtime-context回归验证真实VSIX资源位置一致。 */
export function scrcpyServerPath(root: string): string { return path.join(root, 'resources', 'scrcpy', 'scrcpy-server.jar'); }
/** 输入用户SDK覆盖路径，输出标准SDK候选列表；SDK和android-toolchain回归验证配置/环境优先级。 */
export function sdkCandidates(configured?: string): string[] {
  return [configured, process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), 'Library', 'Android', 'sdk'), path.join(os.homedir(), 'Android', 'Sdk'), path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')].filter(Boolean) as string[];
}
/** 输入SDK覆盖路径，返回实际存在的根或空串；runtime-context回归覆盖SDK不存在情形。 */
export function discoverSdkRoot(configured?: string): string { return sdkCandidates(configured).find(root => stat(root)?.isDirectory()) ?? ''; }
/** 输入SDK根及工具类别，输出平台正确的候选；runtime-context回归覆盖cmdline latest及版本目录。 */
export function sdkToolPath(root: string, tool: 'adb' | 'emulator' | 'sdkmanager' | 'avdmanager'): string {
  if (tool === 'adb') return path.join(root, 'platform-tools', executable(tool));
  if (tool === 'emulator') return path.join(root, 'emulator', executable(tool));
  const directory = path.join(root, 'cmdline-tools');
  const versions = stat(directory)?.isDirectory() ? fs.readdirSync(directory).sort((a, b) => a === 'latest' ? -1 : b === 'latest' ? 1 : b.localeCompare(a)) : [];
  for (const version of versions) { const candidate = path.join(directory, version, 'bin', commandScript(tool)); if (stat(candidate)?.isFile()) return candidate; }
  return path.join(root, 'tools', 'bin', commandScript(tool));
}
/** 返回存在的外部普通文件或undefined，不改外部权限；runtime-context回归验证残缺SDK回退。 */
export function existingRuntimeFile(candidate: string): string | undefined { return stat(candidate)?.isFile() ? candidate : undefined; }
/**
 * 输入扩展安装根，以resources为统一资源根构造平台和内置依赖上下文；不下载、不启动进程，缺资源显式undefined。
 * Node>=22执行node --test tests/runtime-context.test.js，断言所有依赖层级、ABI和生命周期。
 */
export function createRuntimeContext(extensionRoot: string): RuntimeContext {
  const runtimeRoot = path.join(extensionRoot, 'resources');
  return { extensionRoot, platform: process.platform, arch: process.arch, target: runtimeTarget(), runtimeRoot, dependencies: {
    platformTools: runtimeHostRoot(extensionRoot, 'platform-tools'),
    adb: resolveBundledExecutable(extensionRoot, 'adb'),
    emulator: resolveBundledPath(extensionRoot, ['emulator', executable('emulator')]),
    sdkmanager: resolveBundledPath(extensionRoot, ['cmdline-tools', 'latest', 'bin', commandScript('sdkmanager')]),
    avdmanager: resolveBundledPath(extensionRoot, ['cmdline-tools', 'latest', 'bin', commandScript('avdmanager')]),
    lldbDap: resolveBundledPath(extensionRoot, ['lldb', 'bin', executable('lldb-dap')]),
    lldbServer: abi => resolveBundledLldbServer(extensionRoot, abi),
    ndkRoot: resolveBundledPath(extensionRoot, ['ndk'], 'directory'),
    jdkRoot: resolveBundledPath(extensionRoot, ['jdk'], 'directory'),
    systemImagesRoot: resolveBundledPath(extensionRoot, ['system-images'], 'directory'),
    scrcpyServer: scrcpyServerPath(extensionRoot),
  } };
}
/** 初始化一次上下文；runtime-context回归断言同根幂等且不同根拒绝，不替换活跃所有者。 */
export function initializeRuntimeContext(root: string): RuntimeContext {
  if (activeContext) { if (activeContext.extensionRoot !== root) throw new Error('RuntimeContext already initialized'); return activeContext; }
  activeContext = createRuntimeContext(root); return activeContext;
}
/** 读取激活上下文；runtime-context回归断言未初始化undefined。 */
export function getRuntimeContext(): RuntimeContext | undefined { return activeContext; }
/** 释放扩展上下文；runtime-context回归断言停用后不残留旧安装路径。 */
export function resetRuntimeContext(): void { activeContext = undefined; }
