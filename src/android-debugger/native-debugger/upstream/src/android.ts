import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as ini from 'ini';
import * as teen_process from 'teen_process';

import { ADB, Device, VerboseDevice, ShellExecOptions } from 'appium-adb';

import { logger } from './logger';
import * as utils from './utils';
import * as androidPaths from './androidPaths';

import { resolveNativeToolchain, findLldbServer } from '../../nativeToolchain';
import { JDWP } from './jdwp';

const adbByToolchain = new Map<string, ADB>();

/**
 * 清空按工具链隔离的 ADB 实例；配置变化后下一次调用会重新解析共享工具链。
 */
// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言项目ADB隔离/ABI/server部署失败/forward清理。
export async function handlePathsUpdated() {
    adbByToolchain.clear();
}

// ADB helpers
/**
 * 根据可选项目根解析共享 Native 工具链并创建按工具链隔离的 Appium ADB。
 * executable.path 使用实际解析出的 adb，避免跨项目复用错误的全局实例。
 */
// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言项目ADB隔离/ABI/server部署失败/forward清理。
export async function getAdb(projectRoot?: string): Promise<ADB> {
    const toolchain = resolveNativeToolchain(projectRoot);
    const cacheKey = JSON.stringify([projectRoot ?? "", toolchain.adb, toolchain.sdkRoot, toolchain.ndkRoot]);
    let instance = adbByToolchain.get(cacheKey);
    if (!instance) {
        instance = new ADB({
            sdkRoot: toolchain.sdkRoot,
            executable: {path: toolchain.adb, defaultArgs: []}
        });
        await instance.adbExec(["start-server"]);
        adbByToolchain.set(cacheKey, instance);
    }

    return instance;
}

/**
 * 克隆指定设备的 ADB，并继承设备携带的项目根以选择正确工具链。
 */
// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言项目ADB隔离/ABI/server部署失败/forward清理。
export async function getDeviceAdb(device: Device): Promise<ADB> {
    const projectRoot = (device as Device & {androidProjectRoot?: string}).androidProjectRoot;
    let deviceAdb = (await getAdb(projectRoot)).clone();
    deviceAdb.setDevice(device);

    return deviceAdb;
}

// Connected device information
// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言项目ADB隔离/ABI/server部署失败/forward清理。
/** 按精确serial返回设备或不存在错误，项目根选择ADB；native-runtime.test.js的explicit device查询断言匹配、缺失、root及查询错误。 */
export async function getDeviceFromUDID(udid: string, projectRoot?: string): Promise<VerboseDevice> {
    let adb = await getAdb(projectRoot);

    let devices = await adb.getConnectedDevices({verbose: true}) as VerboseDevice[];

    let device = devices.filter((d) => {
        return d.udid === udid;
    });

    if (device.length > 0) {
        return device[0];
    }

    throw new Error(`Could not find connected device with serial ${udid}`);
}

/** 查询serial是否在线，不把离线/错误混淆；native-runtime.test.js的explicit device用例断言状态与错误。 */
export async function isDeviceConnected(udid: string): Promise<boolean> {
    let adb = await getAdb();

    let devices = await adb.getConnectedDevices();

    let found = devices.filter((d) => {
        return d.state === "device" && d.udid === udid;
    });

    return found.length > 0;
}

/** 读取标准ABI列表；正常缺失时沿用旧abi/abi2属性，过滤空值与重复项，ADB失败传播。
 * 回归：node --test tests/native-discovery.test.js，断言标准优先、legacy回退、全缺失和查询错误。
 */
async function getDeviceAbiListInternal(deviceAdb: ADB) {
    let abilist = (await deviceAdb.getDeviceProperty("ro.product.cpu.abilist")).split(",").map(value => value.trim()).filter(Boolean);
    if (!abilist.length) {
        abilist = [await deviceAdb.getDeviceProperty("ro.product.cpu.abi"), await deviceAdb.getDeviceProperty("ro.product.cpu.abi2")].map(value => value.trim()).filter(Boolean);
    }
    return [...new Set(abilist)];
}

/** 通过目标项目ADB返回设备ABI列表；native-discovery.test.js断言标准/legacy/空值及查询失败，不将故障当缺失。 */
export async function getDeviceAbiList(device: Device) {
    return await getDeviceAbiListInternal(await getDeviceAdb(device));
}

/** 保留原设备ABI交集首选逻辑，无交集抛错；native-runtime.test.js的project toolchains用例断言实际导出结果。 */
export async function getBestAbi(device: Device, abiSupportedList: string[]) {
    let deviceAdb = await getDeviceAdb(device);
    let deviceAbiList = await getDeviceAbiListInternal(deviceAdb);

    abiSupportedList = abiSupportedList;

    for (let abi of deviceAbiList) {
        if (abiSupportedList.indexOf(abi) >= 0) {
            return abi;
        }
    }

    throw new Error("Cannot find appropriate ABI to use");
}

// LLDB server
/**
 * 使用共享工具链的已验证 NDK 与原三候选路径查找 lldb-server。
 * 仅缺失候选会继续查找，ABI/IO 等其他错误直接传播。
 */
// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言项目ADB隔离/ABI/server部署失败/forward清理。
async function getLldbServer(abi: string, projectRoot?: string): Promise<string> {
    const toolchain = resolveNativeToolchain(projectRoot);
    return findLldbServer(toolchain.ndkRoot, abi);
}

// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言项目ADB隔离/ABI/server部署失败/forward清理。
/** 按原部署步骤启动设备server并返回自有stop；native-runtime.test.js断言copy/start错误、部署顺序和停止await。 */
export async function startLldbServer(device: Device, packageName: string, abi: string) {
    if (!packageName) {
        throw new Error("A valid package name is required.");
    }

    let deviceAdb = await getDeviceAdb(device);
    const projectRoot = (device as Device & {androidProjectRoot?: string}).androidProjectRoot;
    let lldbServerLocalPath = await getLldbServer(abi, projectRoot);

    logger.log(`Using lldb-server at ${lldbServerLocalPath}`);

    const lldbServerTmpPath = `/data/local/tmp/android-debug/lldb-server`;
    const lldbServerDir = `/data/data/${packageName}/android-debug/lldb/bin`;
    const lldbServerPath = `${lldbServerDir}/lldb-server`;

    await deviceAdb.push(lldbServerLocalPath, lldbServerTmpPath);
    await deviceAdb.shell(`run-as ${packageName} mkdir -p ${lldbServerDir}`);

    await deviceAdb.shell(`cat ${lldbServerTmpPath} | run-as ${packageName} sh -c 'cat > ${lldbServerPath} && chmod 700 ${lldbServerPath}'`);

    let socket = `/${packageName}/platform-${utils.randomString(16)}.sock`;
    let subprocess = deviceAdb.createSubProcess(['shell', `run-as ${packageName} ${lldbServerPath} platform --listen unix-abstract://${socket}`]);
    let stopPromise: Promise<void> | undefined;
    const stop = async (): Promise<void> => {
        if (!stopPromise) {
            stopPromise = subprocess.stop().then(() => undefined);
        }
        await stopPromise;
    };
    try {
        await subprocess.start();
    } catch (startError) {
        try {
            await stop();
        } catch (stopError) {
            throw new AggregateError([startError, stopError], "Failed to start and stop lldb-server");
        }
        throw startError;
    }

    subprocess.on('output', (stdout, stderr) => {
        if (stdout.trim()) { logger.log(`lldb-server out ${stdout.trim()}`); }
        if (stderr.trim()) { logger.log(`lldb-server err ${stderr.trim()}`); }
    });

    return {
        socket,
        subprocess,
        stop
    };
}

// Simpleperf
export async function pushSimpleperf(deviceAdb: ADB): Promise<string> {
    const abi = (await getDeviceAbiListInternal(deviceAdb))?.[0];
    const deviceArch = abi.startsWith("armeabi") ? "arm" : (abi === "arm64-v8a") ? "arm64" : (abi === "x86") ? "x86" : "x86_64";

    const simpleperfLocalPath = path.normalize(`${androidPaths.requireNdkRoot()}/simpleperf/bin/android/${deviceArch}/simpleperf`);

    try {
        await fsPromises.access(simpleperfLocalPath, fs.constants.R_OK);
    } catch {
        throw new Error("Could not locate simpleperf for the device");
    }

    const simpleperfDevicePath = "/data/local/tmp/simpleperf";

    await deviceAdb.push(simpleperfLocalPath, simpleperfDevicePath);
    await deviceAdb.shell(`chmod a+x ${simpleperfDevicePath}`);

    return simpleperfDevicePath;
}

export async function getHostSimpleperf(): Promise<string> {
    const osPlatform = os.platform();
    const platform = osPlatform === "win32" ? "windows" : osPlatform;

    const ext = osPlatform === "win32" ? ".exe" : "";

    const simpleperfLocalPath = path.normalize(`${androidPaths.requireNdkRoot()}/simpleperf/bin/${platform}/x86_64/simpleperf${ext}`);

    try {
        await fsPromises.access(simpleperfLocalPath, fs.constants.R_OK);
    } catch {
        throw new Error("Could not locate simpleperf for the host");
    }

    return simpleperfLocalPath;
}

// Process information
/**
 * 收集设备 JDWP 进程并在完成/异常时释放 SubProcess；保留原 200ms 收集窗口。
 * 及时观察每个进程查询的拒绝，停止及查询全部结算后保留所有错误。
 * 回归：Node>=22运行node --test tests/native-runtime.test.js，断言首批/空输出、查询/停止单错及双错、stop门闩和监听释放。
 */
export async function getProcessList(device: Device, populatePackageNames: boolean = false) {
    const deviceAdb = await getDeviceAdb(device);
    const subprocess = deviceAdb.createSubProcess(["jdwp"]);
    const processPromises: Promise<PromiseSettledResult<{pid: string, name: string, packages: string[]}>>[] = [];
    let timer: NodeJS.Timeout | undefined;
    let resolveWait: (() => void) | undefined;
    let rejectWait: ((error: unknown) => void) | undefined;
    let settled = false;
    const processWait = new Promise<void>((resolve, reject) => {
        resolveWait = () => { if (!settled) { settled = true; resolve(); } };
        rejectWait = (error) => { if (!settled) { settled = true; reject(error); } };
        timer = setTimeout(() => resolveWait?.(), 3000);
    });
    const onLines = (lines: string[]) => {
        if (timer) clearTimeout(timer);
        processPromises.push(...lines.map((line) => getProcessInfoInternal(deviceAdb, line.trim(), populatePackageNames).then(
            value => ({status: "fulfilled" as const, value}),
            reason => ({status: "rejected" as const, reason})
        )));
        timer = setTimeout(() => resolveWait?.(), 200);
    };
    const onError = (error: unknown) => rejectWait?.(error);
    subprocess.on("lines-stdout", onLines);
    subprocess.on("error", onError);
    const errors: unknown[] = [];
    try {
        await subprocess.start();
        await processWait;
    } catch (error) {
        errors.push(error);
    } finally {
        if (timer) clearTimeout(timer);
        subprocess.off("lines-stdout", onLines);
        subprocess.off("error", onError);
        try { await subprocess.stop(); } catch (error) { errors.push(error); }
    }
    const results = await Promise.all(processPromises);
    errors.push(...results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Android process discovery and cleanup failed");
    const processList = results.filter((result): result is PromiseFulfilledResult<{pid: string, name: string, packages: string[]}> => result.status === "fulfilled").map(result => result.value);
    logger.log("getProcessList", processList);
    return processList;
}

/** 读取指定 PID 的名称与可选包列表；ADB/权限异常透传，正常无包返回空数组。
 * 回归：native-runtime.test.js 覆盖名称正常/异常、包正常/无包/命令失败和 PID 校验。 */
async function getProcessInfoInternal(deviceAdb: ADB, pid: string, populatePackageNames: boolean) {
    if (!/^\d+$/.test(pid)) throw new Error("Invalid Android PID");
    let name = await deviceAdb.getNameByPid(pid);
    let packages: string[] = [];

    if (populatePackageNames) {
        packages = await getPackagesForProcess(deviceAdb, pid);

        packages = packages.sort((a, b) => {
            if (a === name) { return -1; }
            if (b === name) { return 1; }

            let result = Number(name.startsWith(b)) - Number(name.startsWith(a));
            if (result !== 0) {return result; }

            return a.localeCompare(b);
        });
    }

    return {
        pid,
        name,
        packages
    };
}

/** 通过设备携带的项目根读取进程信息，并保留底层 ADB 错误。
 * 回归：native-runtime.test.js 的 process runtime closures 用真实导出函数断言结果和异常。 */
export async function getProcessInfo(device: Device, pid: string, populatePackageNames: boolean) {
    return getProcessInfoInternal(await getDeviceAdb(device), pid, populatePackageNames);
}

/** 查询 PID 所属包；命令失败透传，正常无匹配返回空数组，并接受无 UID 后缀的 package 行。
 * 回归：native-runtime.test.js 断言命令失败不会伪装为空结果，且正常输出可解析。 */
async function getPackagesForProcess(deviceAdb: ADB, pid: string) {
    if (!/^\d+$/.test(pid)) throw new Error("Invalid Android PID");
    const output = await deviceAdb.shell(`stat -c %u /proc/${pid} | xargs -n 1 cmd package list packages --uid`);
    return [...new Set(output.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("package:"))
        .map((line) => line.slice("package:".length).trim().split(/\s+/)[0])
        .filter(Boolean))];
}

// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言项目ADB隔离/ABI/server部署失败/forward清理。
/** 以可选项目根解析APK包名，无路径/缺元数据返回空串，ADB失败传播；native-runtime.test.js的APK metadata查询断言真实结果与边界。 */
export async function getPackageNameFromApk(apkPath: string, projectRoot?: string) {
    if (!apkPath) {
        return "";
    }

    let adb = await getAdb(projectRoot);

    let appInfo = await adb.getApkInfo(apkPath);

    return "name" in appInfo ? appInfo.name : "";
}

// JDWP Port forwarding
/** 为指定设备PID分配JDWP转发端口；native-runtime.test.js的resumeJavaDebugger用例断言转发及失败清理。 */
export async function forwardJdwpPort(device: Device, pid: string) {
    let deviceAdb = await getDeviceAdb(device);
    return await deviceAdb.adbExec(["forward", `tcp:0`, `jdwp:${pid}`]) as any as string;
}

/** 移除所选设备的自有端口转发，失败传播；native-runtime.test.js的resumeJavaDebugger用例断言实际remove调用与错误。 */
export async function removeTcpForward(device: Device, port: string) {
    let deviceAdb = await getDeviceAdb(device);
    return await deviceAdb.removePortForward(port);
}

// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言项目ADB隔离/ABI/server部署失败/forward清理。
/** 连接并恢复VM，返回需等待的断开/转发清理；native-runtime.test.js断言setup/cleanup及双错聚合。 */
export async function resumeJavaDebugger(device: Device, pid: string): Promise<() => Promise<void>>  {
    let port = await forwardJdwpPort(device, pid);
    let jdwp = new JDWP(Number(port), "localhost");

    const cleanup = async () => {
        const errors: unknown[] = [];
        try { await jdwp.disconnect(); } catch (error) { errors.push(error); }
        try { await removeTcpForward(device, port); } catch (error) { errors.push(error); }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "JDWP cleanup failed");
    };

    try {
        await jdwp.connect();
        await jdwp.resume();

        return cleanup;
    }
    catch (e) {
        try { await cleanup(); } catch (cleanupError) {
            throw new AggregateError([e, cleanupError], "JDWP setup and cleanup failed");
        }
        throw e;
    }
}

// AVD helpers
// 回归：Node>=22执行 node --test tests/native-runtime.test.js，断言项目ADB隔离/ABI/server部署失败/forward清理。
/** 读取AVD显示名称或沿用原缺失回退；native-runtime.test.js的AVD display name用例断言真实配置解析。 */
export async function getAvdDisplayName(avdName: string) {
    const adb = await getAdb();
    let displayName: string|undefined = undefined;

    try {
        let avdProperties: any = await adb.getEmuImageProperties(avdName);

        if (avdProperties?.path) {
            let configPath = path.join(avdProperties.path, "config.ini");
            let avdConfig = ini.parse(await fsPromises.readFile(configPath, 'utf8'));

            displayName = avdConfig["avd.ini.displayname"];
        }
    }
    catch {
        // Ignore errors
    }

    return displayName || avdName.replace(/_/g, " ");
}

/** 通过原emulator命令读取AVD列表，保留缺失工具空集语义；native-runtime.test.js的application and AVD用例断言原命令与列表解析。 */
export async function getAvdList() {
    let adb = await getAdb();

    try {
        let emulatorPath = await adb.getBinaryFromSdkRoot("emulator");

        let result = await teen_process.exec(emulatorPath, ['-list-avds'], {shell: false});

        let avdNames: string[] = [];
        if (result.code === 0) {
            avdNames = result.stdout.split("\n")
                .map((avd) => avd.trim())
                .filter((avd) => avd && !avd.startsWith("INFO    |") && !avd.startsWith("ERROR   |"));
        }

        return avdNames;
    }
    catch {
        // Ignore errors
    }

    return [];
}

/** 调用原Appium启动AVD并返回其设备，缺失ID抛错；native-runtime.test.js的application and AVD用例断言启动及设备解析。 */
export async function launchAVD(avdName: string) {
    let adb = (await getAdb()).clone();
    await adb.launchAVD(avdName);
    if (adb.curDeviceId) {
        return getDeviceFromUDID(adb.curDeviceId);
    }
    throw new Error("Could not launch Android Virtual Device");
}

// Application install and launch
/** 向所选设备安装APK，保留原错误诊断；native-runtime.test.js的application and AVD用例断言install argv与失败。 */
export async function installApp(device: Device, apkPath: string) {
    let deviceAdb = await getDeviceAdb(device);

    try {
        await deviceAdb.adbExec(["install", "-r", apkPath]);
    }
    catch (e: any) {
        throw new Error(e.stderr ?? e.message);
    }
}

/** 执行原am start调试启动并检测Activity/权限错误；native-runtime.test.js的application and AVD用例断言命令和stderr错误。 */
export async function launchApp(device: Device, packageName: string, launchActivity: string) {
    let deviceAdb = await getDeviceAdb(device);

    let launchCmd = `am start -D -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${packageName}/${launchActivity}`;

    let {stdout, stderr} = await deviceAdb.shell(launchCmd, {outputFormat: deviceAdb.EXEC_OUTPUT_FORMAT.FULL} as ShellExecOptions) as any as {stdout: string, stderr: string};

    // The error handling is inspired from from appium-adb's startApp method
    if (stderr.includes('Error: Activity class') && stderr.includes('does not exist')) {
        throw new Error(`Activity used to start the app doesn't exist or cannot be launched. Make sure it exists and is a launchable activity.`);
    } else if (stderr.includes('Error: Intent does not match any activities') || stderr.includes('Error: Activity not started, unable to resolve Intent')) {
        throw new Error(`Activity for intent used to start the app doesn't exist or cannot be launched. Make sure it exists and is a launchable activity.`);
    } else if (stderr.includes('java.lang.SecurityException')) {
        // if the app is disabled on a real device it will throw a security exception
        throw new Error(`The permission to start activity has been denied. Make sure the activity/package names are correct.`);
    }
}

const metadataPackagePattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const installedAbis = new Set(['armeabi', 'armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64']);

/** 通过原Appium设备通道读取指定安装包的primaryCpuAbi，正常缺失返回undefined，查询失败传播。
 * 回归：Node>=22执行node --test tests/native-discovery.test.js，断言32位应用/准确包块/null/非法ABI/ADB错误与项目根。
 */
export async function getInstalledAppAbi(device: Device, packageName: string): Promise<string|undefined> {
    if (!metadataPackagePattern.test(packageName)) throw new Error('Invalid Android package name: ' + packageName);
    const deviceAdb = await getDeviceAdb(device);
    const output = await deviceAdb.shell(['dumpsys', 'package', packageName]);
    let selected = false;
    for (const line of output.split(/\r?\n/)) {
        const header = /^\s*Package \[([^\]]+)\]/.exec(line);
        if (header) { selected = header[1] === packageName; continue; }
        if (!selected) continue;
        const primary = /(?:^|\s)primaryCpuAbi=([^\s]+)/.exec(line);
        if (!primary) continue;
        if (primary[1] === 'null') return undefined;
        if (!installedAbis.has(primary[1])) throw new Error('Unknown installed Android ABI: ' + primary[1]);
        return primary[1];
    }
    return undefined;
}

/** 从所选设备获取第三方安装包候选，严格解析pm结果；正常空集保持空，设备/格式错误不伪装未知。
 * 回归：Node>=22执行node --test tests/native-discovery.test.js，断言argv、去重、空集、非法元数据及ADB失败。
 */
export async function getInstalledPackages(device: Device): Promise<string[]> {
    const deviceAdb = await getDeviceAdb(device);
    const output = await deviceAdb.shell(['pm', 'list', 'packages', '-3']);
    const packages: string[] = [];
    for (const line of output.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
        const value = /^package:(\S+)$/.exec(line)?.[1];
        if (!value || !metadataPackagePattern.test(value)) throw new Error('Invalid Android installed package metadata: ' + line);
        packages.push(value);
    }
    return [...new Set(packages)];
}
