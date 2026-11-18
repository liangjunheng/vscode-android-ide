import * as vscode from 'vscode';
import { logger } from './logger';
import * as android from './android';
import { Device } from './commonTypes';
import { getCurrentOrPickTarget } from './targetPicker';

let context: vscode.ExtensionContext;
let lldbProcessKillers: {[socket: string]: () => Promise<void>} = {};

let lastPickedAbi: string|undefined;

let currentAbiSupportedList: string[]|undefined;
let currentAbiMap: {[abi: string]: string}|undefined;
let currentAbi: string|undefined;

let currentPackageName: string|undefined;

const defaultAbiSupportedList = ["armeabi", "armeabi-v7a", "arm64-v8a", "x86", "x86_64"];

/** 根据显式设备或当前目标解析调用参数，保留项目根以选择对应 Android 工具链。 */
/** 解析显式设备或当前目标并透传项目根；native-autodetect.test.js的command wrappers用例断言无设备时调用当前目标。 */
async function resolveArgs<T extends {device?: Device}>(args: T = {} as T): Promise<T>
{
    if (!args.device)
    {
        args.device = await getCurrentOrPickTarget();
    }

    return args;
}

/** 设置进程选择的优先包名，无返回值；native-autodetect.test.js的process picker用例断言匹配包排首位。 */
export function setProcessPickerInfo(packageName: string) {
    currentPackageName = packageName;
}

/** 清除优先包上下文；native-autodetect.test.js的process picker用例断言reset后按名称排序。 */
export function resetProcessPickerInfo() {
    currentPackageName = undefined;
}

/** 读取进程后沿用原排序和PID映射，取消返回undefined，查询失败直接传播而不挂起。
 * 回归：Node>=22运行node --test tests/native-autodetect.test.js，断言排序/PID、取消及查询错误零picker。 */
export async function pickAndroidProcess(args: {device: Device}) {
    let {device} = await resolveArgs(args);
    let processList = await android.getProcessList(device, Boolean(currentPackageName));
    let quickPickItems = processList
        .sort((a, b) => {
            if (currentPackageName) {
                let result = Number(b.packages.includes(currentPackageName)) - Number(a.packages.includes(currentPackageName));
                if (result !== 0) { return result; }
            }
            return a.name.localeCompare(b.name);
        })
        .map(p => ({label: p.name, description: p.pid, pid: p.pid}));
    return (await vscode.window.showQuickPick(quickPickItems, {title: "Pick Android Process", matchOnDescription: true}))?.pid;
}

const packageNamePattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

/** 从进程信息中解析唯一包归属；共享UID不猜首项。回归：native-autodetect.test.js通过resolvePackageName断言精确/remote归属及共享UID选择。 */
function getUniqueProcessPackage(processInfo: {name?: string, packages?: string[]}): string|undefined {
    const packages = [...new Set((processInfo.packages ?? []).filter(Boolean))];
    if (processInfo.name && packages.includes(processInfo.name)) return processInfo.name;
    const ownerPackage = processInfo.name?.split(":", 1)[0];
    if (ownerPackage && packages.includes(ownerPackage)) return ownerPackage;
    if (packages.length === 1) return packages[0];
    if (!packages.length && processInfo.name && packageNamePattern.test(processInfo.name)) return processInfo.name;
    return undefined;
}

/** 展示包名候选并返回选择结果；取消返回undefined、查询错误传播。回归：native-autodetect.test.js断言候选、取消无ABI查询和ADB失败无picker。 */
async function pickPackageName(device: Device, candidates?: string[]): Promise<string|undefined> {
    const packageNames = candidates ?? await android.getInstalledPackages(device);
    const items = [...new Set(packageNames.filter(name => packageNamePattern.test(name)))].map(label => ({label}));
    return (await vscode.window.showQuickPick(items, {title: "Pick Android Package", matchOnDescription: true}))?.label;
}

/** 按显式值、PID精确归属或设备候选解析包名；缺失才选择。回归：Node>=22执行node --test tests/native-autodetect.test.js，断言自动无picker、共享UID/缺失选择和取消/错误。 */
export async function resolvePackageName(args: {device: Device, pid?: string, packageName?: string}): Promise<string|undefined> {
    const {device, pid, packageName} = await resolveArgs(args);
    if (packageName) return packageName;

    if (pid) {
        const processInfo = await android.getProcessInfo(device, pid, true);
        const processPackage = getUniqueProcessPackage(processInfo);
        if (processPackage) return processPackage;
        const processCandidates = [...new Set((processInfo.packages ?? []).filter(name => packageNamePattern.test(name)))];
        if (processCandidates.length) return await pickPackageName(device, processCandidates);
    }

    return await pickPackageName(device);
}

/** 兼容旧包名命令并保留精确PID策略；native-autodetect.test.js的command wrappers用例断言真实包装函数的结果。 */
export async function getPackageNameForPid(args: {device: Device, pid: string}) {
    return await resolvePackageName(args);
}

/** 从APK元信息解析包名并透传项目根；native-autodetect.test.js的command wrappers用例断言参数、结果与错误。 */
export async function getPackageNameFromApk(apkPath: string, projectRoot?: string) {
    return await android.getPackageNameFromApk(apkPath, projectRoot);
}

/** 沿用上次选择/设备优先排序，返回所选ABI或取消；native-autodetect.test.js断言歧义列表、取消和唯一值不弹框。 */
async function pickAppAbi(abiSupportedList: string[], deviceAbiList: string[]) {
    let abiOptions = abiSupportedList.sort((a, b) => {
        // Sort by last picked
        if (a === lastPickedAbi) { return -1; }
        if (b === lastPickedAbi) { return 1; }

        // Sort by device ABIs
        let indexA = deviceAbiList.indexOf(a);
        if (indexA < 0) { indexA = Number.MAX_SAFE_INTEGER; }

        let indexB = deviceAbiList.indexOf(b);
        if (indexB < 0) { indexB = Number.MAX_SAFE_INTEGER; }

        let result = indexA - indexB;

        if (result !== 0) { return result; }

        // Sort alphabatically
        return a.localeCompare(b);
    }).map((abi): vscode.QuickPickItem => ({
        label: abi,
        detail: getMappedAbi(abi)
    }));

    let abi = (await vscode.window.showQuickPick(abiOptions, {title: "Pick Android ABI", matchOnDescription: true}))?.label;

    if (abi) { lastPickedAbi = abi; }

    return abi;
}

/** 启动设备端 lldb-server，失败向调用方传播并释放取消订阅。 */
// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言server启动失败/停止等待/手动恢复与清理。
export async function lldbServer(args: {device: Device, packageName: string, abi: string}) {
    let {device, packageName, abi} = args;

    return vscode.window.withProgress({
        "location": vscode.ProgressLocation.Notification,
        "title": "Starting LLDB server",
        "cancellable": true
    }, async (_progress, token) => {
        let cancelled = false;
        const cancellation = token.onCancellationRequested(() => { cancelled = true; });
        try {
            const server = await android.startLldbServer(device, packageName, abi);
            if (cancelled) {
                await server.stop();
                throw new Error("Starting LLDB server was cancelled");
            }
            lldbProcessKillers[server.socket] = server.stop;
            return server.socket;
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to start lldb server: ${error.message}`);
            throw error;
        } finally {
            cancellation.dispose();
        }
    });
}

/** 异步停止指定 socket 的自有 lldb-server，重复调用安全且传播停止错误。 */
// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言server启动失败/停止等待/手动恢复与清理。
export async function lldbServerCleanup(socket: string): Promise<void> {
    logger.log(`Cleaning up lldb server at socket ${socket}`);
    const killer = lldbProcessKillers[socket];
    if (!killer) return;
    try {
        await killer();
    } finally {
        delete lldbProcessKillers[socket];
    }
}

/** 设置可选ABI、支持列表和映射供变量命令解析；native-autodetect.test.js断言覆盖、交集、映射及缺省自动识别。 */
export function setAbiResolutionInfo(abi?: string, abiSupportedList?: string[], abiMap?: {[abi: string]: string}) {
    currentAbi = abi;
    currentAbiSupportedList = abiSupportedList;
    currentAbiMap = abiMap;
}

/** 清除本次ABI变量上下文；native-autodetect.test.js的explicit ABI用例断言reset后重新查询安装包ABI。 */
export function resetAbiResolutionInfo() {
    currentAbi = undefined;
    currentAbiSupportedList = undefined;
    currentAbiMap = undefined;
}

/** 返回配置映射或undefined供调用方保留原ABI；native-autodetect.test.js的explicit ABI用例断言有映射及无映射。 */
function getMappedAbi(abi?: string): string|undefined {
    let abiMap = currentAbiMap ?? {};

    if (abi && (abi in abiMap)) {
        return abiMap[abi];
    }

    return undefined;
}

const canonicalAbis = new Set(defaultAbiSupportedList);

/** 解析Native ABI：显式值和安装包primary优先，交集歧义才选择。回归：Node>=22执行node --test tests/native-autodetect.test.js，断言32位应用、唯一/空/歧义/不兼容交集、覆盖及错误。 */
export async function getBestAbi(args: {device: Device, packageName?: string, pid?: string}) {
    const {device, packageName, pid} = await resolveArgs(args);
    const abiSupportedList = currentAbiSupportedList ?? defaultAbiSupportedList;

    if (currentAbi && currentAbi !== "select") {
        if (!canonicalAbis.has(currentAbi)) throw new Error(`Invalid Android ABI: ${currentAbi}`);
        return currentAbi;
    }

    const resolvedPackage = packageName ?? (pid ? await resolvePackageName({device, pid}) : undefined);
    if (resolvedPackage) {
        const installedAbi = await android.getInstalledAppAbi(device, resolvedPackage);
        if (installedAbi) {
            if (!canonicalAbis.has(installedAbi)) throw new Error(`Unknown installed Android ABI: ${installedAbi}`);
            if (!abiSupportedList.includes(installedAbi)) throw new Error(`Installed ABI ${installedAbi} is not supported by the app configuration`);
            currentAbi = installedAbi;
            return installedAbi;
        }
    }

    const deviceAbiList = await android.getDeviceAbiList(device);
    // 空设备属性表示无法判定设备ABI，按应用候选继续唯一自动选择或进入原选择器；非空无交集仍明确失败。
    const compatible = deviceAbiList.length === 0
        ? [...new Set(abiSupportedList)]
        : [...new Set(deviceAbiList)].filter(abi => abiSupportedList.includes(abi));
    if (!compatible.length) throw new Error("Cannot find appropriate ABI to use");
    if (compatible.length === 1) {
        currentAbi = compatible[0];
        return compatible[0];
    }

    const pickedAbi = await pickAppAbi(abiSupportedList.filter(abi => compatible.includes(abi)), deviceAbiList);
    if (!pickedAbi) return undefined;
    currentAbi = pickedAbi;
    return pickedAbi;
}

/** 返回自动ABI的配置映射或原ABI；native-autodetect.test.js断言显式覆盖、映射及reset后的安装包查询。 */
export async function getBestMappedAbi(args: {device: Device, packageName?: string, pid?: string}) {
    const abi = await getBestAbi(args);
    return getMappedAbi(abi) ?? abi;
}

/** 按所选设备/PID转发JDWP端口；native-autodetect.test.js的command wrappers用例断言参数和返回值。 */
export async function forwardJdwpPort(args: {device: Device, pid: string}) {
    let {device, pid} = await resolveArgs(args);

    return await android.forwardJdwpPort(device, pid);
}

/** 移除所选设备的转发，保留返回值/错误；native-autodetect.test.js的command wrappers用例断言设备及端口。 */
export async function removeTcpForward(device: Device, port: string) {
    return await android.removeTcpForward(device, port);
}

/** 恢复所选等待进程并等待临时JDWP清理，不延时丢弃释放错误；native-runtime.test.js验证cleanup门闩和失败传播。 */
// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言server启动失败/停止等待/手动恢复与清理。
export async function resumeWaitingProcess(args: {device: Device, pid?: string}) {
    let {device, pid} = await resolveArgs(args);

    if (device && !pid) {
        pid = await pickAndroidProcess({device});
    }

    if (!pid) {
        return;
    }

    logger.log(`Resuming process ${pid}`);

    const jdwpCleanup = await android.resumeJavaDebugger(device, pid);

    await jdwpCleanup();
}

// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言server启动失败/停止等待/手动恢复与清理。
/** 记录扩展上下文并注册server释放者；native-runtime.test.js的targetCommand用例断言停用时释放自有server。 */
export function activate(c: vscode.ExtensionContext) {
    context = c;

    // Clean all open lldb-server processes
    context.subscriptions.push({
        async dispose() {
            const errors: unknown[] = [];
            for (const socket of Object.keys(lldbProcessKillers)) {
                try { await lldbServerCleanup(socket); } catch (error) { errors.push(error); }
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, "LLDB server cleanup failed");
        }
    });
}