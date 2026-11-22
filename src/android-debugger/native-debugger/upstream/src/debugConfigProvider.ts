import * as vscode from 'vscode';
import { logger } from './logger';
import { Device } from './commonTypes';
import * as targetCommand from './targetCommand';
import * as targetPicker from './targetPicker';
import * as android from './android';
import { nativeToolchainOverrides } from '../../nativeToolchain';

/** 保留原设备选择算法，并让已解析Device及显式serial携带项目根；native-codelldb.test.js覆盖select/serial/取消与root归属。 */
async function getTarget(androidTarget: string|Device, projectRoot?: string, overrides?: ReturnType<typeof nativeToolchainOverrides>): Promise<Device|undefined> {
    if (typeof androidTarget === "object") return { ...androidTarget, ...(projectRoot ? { androidProjectRoot: projectRoot } : {}), ...(overrides ? { androidNativeToolchain: overrides } : {}) };
    if (androidTarget === "select") {
        const target = await targetPicker.pickTarget(projectRoot, overrides);
        return target ? Object.assign({}, target, projectRoot ? { androidProjectRoot: projectRoot } : {}) : undefined;
    }
    else if (androidTarget === "last-selected") {
        const target = await targetPicker.getLastOrPickTarget(projectRoot, overrides);
        return target ? Object.assign({}, target, projectRoot ? { androidProjectRoot: projectRoot } : {}) : undefined;
    }
    else if (typeof androidTarget === "string") {
        const target = await targetPicker.getTargetFromUDID(androidTarget, projectRoot, overrides);
        return target ? Object.assign({}, target, projectRoot ? { androidProjectRoot: projectRoot } : {}) : undefined;
    }

    return undefined;
}

export class LLDBDebugConfigurationProvider implements vscode.DebugConfigurationProvider
{
    /** 复用原LLDB配置阶段，携带项目根与ABI命令上下文；native-codelldb.test.js验证显式/选择设备及重复解析。 */
    async resolveDebugConfiguration(folder: vscode.WorkspaceFolder|undefined, dbgConfig: vscode.DebugConfiguration, token: vscode.CancellationToken) {
        logger.log("lldb resolveDebugConfiguration", dbgConfig);

        if (!dbgConfig.androidTarget) { return dbgConfig; }

        if (dbgConfig.request !== "attach") { return null; }

        let target: Device|undefined = await getTarget(dbgConfig.androidTarget, dbgConfig.androidProjectRoot ?? folder?.uri.fsPath, nativeToolchainOverrides(dbgConfig.androidNativeToolchain));
        if (!target) { return null; }

        dbgConfig.androidTarget = target;


        targetPicker.setCurrentTarget(target);
        targetCommand.setAbiResolutionInfo(dbgConfig.androidAbi, dbgConfig.androidAbiSupported, dbgConfig.androidAbiMap);
        dbgConfig.androidPackageName = await targetCommand.resolvePackageName({device: target, pid: dbgConfig.pid, packageName: dbgConfig.androidPackageName});
        if (!dbgConfig.androidPackageName) { return null; }
        targetCommand.setProcessPickerInfo(dbgConfig.androidPackageName);

        return dbgConfig;
    }

    /** 原server/socket/ART signal/符号命令算法，宿主负责失败回滚；native-codelldb.test.js精确断言命令顺序与清理。 */
    async resolveDebugConfigurationWithSubstitutedVariables(folder: vscode.WorkspaceFolder|undefined, dbgConfig: vscode.DebugConfiguration, token: vscode.CancellationToken) {
        logger.log("lldb resolveDebugConfigurationWithSubstitutedVariables", dbgConfig);

        if (!dbgConfig.androidTarget) { return dbgConfig; }

        let target: Device = dbgConfig.androidTarget;

        try {
            const abi = await targetCommand.getBestAbi({device: target, packageName: dbgConfig.androidPackageName, pid: dbgConfig.pid});
            if (!abi) { return null; }
            dbgConfig.androidAbi = abi;

            let socket = await targetCommand.lldbServer({
                device: target,
                packageName: dbgConfig.androidPackageName,
                abi
            });
            if (!socket) { return null; }

            dbgConfig.androidLldbServerSocket = socket;

            dbgConfig.initCommands = Array.isArray(dbgConfig.initCommands) ? dbgConfig.initCommands : [];

            dbgConfig.initCommands.unshift(
                "platform select remote-android",
                `platform connect unix-abstract-connect://[${target.udid}]${socket}`,
                "settings set plugin.jit-loader.gdb.enable off",

                // Ignoring SIGBUS and SIGSEGV signal, see https://issuetracker.google.com/issues/240007217#comment17
                // Set breakpoints on unhandled signal handlers in libart.so to break on these signals instead
                "process handle SIGBUS SIGSEGV --pass true --stop false --notify false",
                "breakpoint set --shlib libart.so --name art_sigsegv_fault",
                "breakpoint set --shlib libart.so --name art_sigbus_fault",
            );

            if (dbgConfig.symbolSearchPaths) {
                for (let symbolSeachPath of dbgConfig.symbolSearchPaths) {
                    dbgConfig.initCommands.push(`settings append target.exec-search-paths '${symbolSeachPath}'`);
                }
            }

            logger.log("lldb resolved debug configuration", dbgConfig);
            return dbgConfig;
        }
        finally {
            targetPicker.resetCurrentTarget();
            targetCommand.resetAbiResolutionInfo();
            targetCommand.resetProcessPickerInfo();
        }
    }
}

export class JavaDebugConfigurationProvider implements vscode.DebugConfigurationProvider
{
    async resolveDebugConfiguration(folder: vscode.WorkspaceFolder|undefined, dbgConfig: vscode.DebugConfiguration, token: vscode.CancellationToken) {
        logger.log("java resolveDebugConfiguration", dbgConfig);

        if (!dbgConfig.androidTarget) { return dbgConfig; }

        if (dbgConfig.request !== "attach") { return null; }

        let target: Device|undefined = await getTarget(dbgConfig.androidTarget);
        if (!target) { return null; }

        dbgConfig.androidTarget = target;

        // We need to specify hostname and port to prevent java extension to mark the config invalid.
        // This will be updated later resolveDebugConfigurationWithSubstitutedVariables.
        dbgConfig.hostName = dbgConfig.hostName || "localhost";
        dbgConfig.port = dbgConfig.port || 8000;

        dbgConfig.androidPid = dbgConfig.processId;
        dbgConfig.processId = undefined;

        targetPicker.setCurrentTarget(target);

        return dbgConfig;
    }

    async resolveDebugConfigurationWithSubstitutedVariables(folder: vscode.WorkspaceFolder|undefined, dbgConfig: vscode.DebugConfiguration, token: vscode.CancellationToken) {
        logger.log("java resolveDebugConfigurationWithSubstitutedVariables", dbgConfig);

        if (!dbgConfig.androidTarget) { return dbgConfig; }

        let target: Device = dbgConfig.androidTarget;

        targetPicker.resetCurrentTarget();

        logger.log("java configuration resolved; JDWP lease is owned by the Android debug Coordinator", dbgConfig);
        return dbgConfig;
    }
}

export class AndroidDebugConfigurationProvider implements vscode.DebugConfigurationProvider
{
    /** 原Android第一阶段解析设备并建立变量替换上下文；native-codelldb.test.js验证select/取消及准确root。 */
    async resolveDebugConfiguration(folder: vscode.WorkspaceFolder|undefined, dbgConfig: vscode.DebugConfiguration, token: vscode.CancellationToken) {
        logger.log("android resolveDebugConfiguration", dbgConfig);

        if (dbgConfig.request !== "attach" && dbgConfig.request !== "launch") { return null; }

        let target: Device|undefined = await getTarget(dbgConfig.target ?? "select", dbgConfig.androidProjectRoot ?? folder?.uri.fsPath, nativeToolchainOverrides(dbgConfig.native));
        if (!target) { return null; }

        dbgConfig.target = target;

        dbgConfig.native = dbgConfig.native ?? {};


        targetPicker.setCurrentTarget(target);
        targetCommand.setAbiResolutionInfo(dbgConfig.native?.abi, dbgConfig.native.abiSupported, dbgConfig.native.abiMap);
        targetCommand.setProcessPickerInfo(dbgConfig.packageName);

        return dbgConfig;
    }

    /** 原Android第二阶段解析包名/ABI/resume默认值并复位临时上下文；native-codelldb.test.js验证attach/launch。 */
    async resolveDebugConfigurationWithSubstitutedVariables(folder: vscode.WorkspaceFolder|undefined, dbgConfig: vscode.DebugConfiguration, token: vscode.CancellationToken) {
        logger.log("android resolveDebugConfigurationWithSubstitutedVariables", dbgConfig);

        if (!dbgConfig.target) { return dbgConfig; }

        let target: Device = dbgConfig.target;

        dbgConfig.mode = dbgConfig.mode ?? "java";

        try {
            if (dbgConfig.request === "attach") {
                // Resolve for attach
                dbgConfig.packageName = await targetCommand.resolvePackageName({device: target, pid: dbgConfig.pid, packageName: dbgConfig.packageName});
                dbgConfig.resumeProcess = dbgConfig.mode === "native" ? (dbgConfig.resumeProcess ?? false) : false;
            }
            else {
                // Resolve for launch
                if (!dbgConfig.packageName && dbgConfig.apkPath) {
                    dbgConfig.packageName = await targetCommand.getPackageNameFromApk(dbgConfig.apkPath, dbgConfig.androidProjectRoot ?? folder?.uri.fsPath);
                }
                dbgConfig.packageName = await targetCommand.resolvePackageName({device: target, packageName: dbgConfig.packageName});
                dbgConfig.resumeProcess = dbgConfig.mode === "native" ? (dbgConfig.resumeProcess ?? true) : false;
            }

            if (!dbgConfig.packageName) { return null; }
            if (dbgConfig.mode === "native" || dbgConfig.mode === "dual") {
                const abi = await targetCommand.getBestAbi({device: target, packageName: dbgConfig.packageName, pid: dbgConfig.pid});
                if (!abi) { return null; }
                dbgConfig.native.abi = abi;
            }

            logger.log("android resolved debug configuration", dbgConfig);
            return dbgConfig;
        }
        finally {
            targetPicker.resetCurrentTarget();
            targetCommand.resetAbiResolutionInfo();
            targetCommand.resetProcessPickerInfo();
        }
     }
 }

export class AndroidProfileConfigurationProvider implements vscode.DebugConfigurationProvider
{
    async resolveDebugConfiguration(folder: vscode.WorkspaceFolder|undefined, dbgConfig: vscode.DebugConfiguration, token: vscode.CancellationToken) {
        logger.log("android profiler resolveDebugConfiguration", dbgConfig);

        let target: Device|undefined = await getTarget(dbgConfig.target ?? "select");
        if (!target) { return null; }

        dbgConfig.target = target;

        dbgConfig.request = "launch";
        dbgConfig.noDebug = true;

        dbgConfig.native = dbgConfig.native ?? {};


        targetPicker.setCurrentTarget(target);
        targetCommand.setAbiResolutionInfo(dbgConfig.native.abi, dbgConfig.native.abiSupported, dbgConfig.native.abiMap);
        targetCommand.setProcessPickerInfo(dbgConfig.packageName);

        return dbgConfig;
    }

    async resolveDebugConfigurationWithSubstitutedVariables(folder: vscode.WorkspaceFolder|undefined, dbgConfig: vscode.DebugConfiguration, token: vscode.CancellationToken) {
        logger.log("android profiler resolveDebugConfigurationWithSubstitutedVariables", dbgConfig);

        if (!dbgConfig.target) { return dbgConfig; }

        const target: Device = dbgConfig.target;

        if (!dbgConfig.packageName && dbgConfig.pid) {
            dbgConfig.packageName = await targetCommand.getPackageNameForPid({device: target, pid: dbgConfig.pid});
        }

        targetPicker.resetCurrentTarget();
        targetCommand.resetAbiResolutionInfo();
        targetCommand.resetProcessPickerInfo();

        logger.log("android profiler resolved debug configuration", dbgConfig);
        return dbgConfig;
    }
}
