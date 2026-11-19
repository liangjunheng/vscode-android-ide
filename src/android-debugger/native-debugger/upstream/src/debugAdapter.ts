import * as vscode from 'vscode';
import * as debugadapter from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';

import * as android from './android';
import { Device } from './commonTypes';
import { nativeToolchainOverrides, resolveNativeToolchain } from '../../nativeToolchain';
import { adbExec, resolveLauncherActivity } from '../../nativeTarget';
import { nativeLibraryCommands } from '../../nativeSymbols';

/** 原工厂的宿主适配接口：仅提供配置准备/释放，不提供调试引擎；native-codelldb.test.js通过真实工厂验证。 */
export interface NativeSessionHost {
    resolveSession(config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration>;
    prepareNative(config: vscode.DebugConfiguration, folder?: vscode.WorkspaceFolder): Promise<vscode.DebugConfiguration>;
    releaseNative(socket?: string): Promise<void>;
    processId(config: vscode.DebugConfiguration): number;
    describe(error: unknown): string;
    report(error: unknown): void;
}

export class DebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    private readonly active = new Set<DebugAdapter>();
    /** 保留原工厂入口，扩展仅持有活动会话；native-codelldb.test.js验证工厂与关闭归属。 */
    constructor(private context: vscode.ExtensionContext, private host: NativeSessionHost) { context.subscriptions.push(this); }
    /** 原InlineImplementation创建路径；native-codelldb.test.js真实handleMessage进入迁入的原DebugAdapter。 */
    createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.DebugAdapterDescriptor {
        const adapter = new DebugAdapter(this.context, session, this.host, () => this.active.delete(adapter));
        this.active.add(adapter);
        return new vscode.DebugAdapterInlineImplementation(adapter);
    }
    /** 关闭原工厂的活动会话，不保留已结束adapter；native-codelldb.test.js验证资源结算。 */
    async dispose(): Promise<void> {
        const results = await Promise.allSettled([...this.active].map(adapter => adapter.dispose()));
        const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason);
        if (errors.length) throw new AggregateError(errors, 'Native sessions cleanup failed');
    }
}

class DebugAdapter extends debugadapter.LoggingDebugSession {
    private session: vscode.DebugSession;
    private config: vscode.DebugConfiguration;
    private childSessions: {[key: string]: vscode.DebugSession} = {};
    private jdwpCleanup: (() => Promise<void>)|undefined;
    private socket?: string;
    private startup?: Promise<void>;
    private closing?: Promise<void>;
    private resourcesClosing?: Promise<void>;
    private earlyChildStop?: Promise<PromiseSettledResult<void>[]>;
    private subscriptions: vscode.Disposable[];
    private readonly controller = new AbortController();
    private pendingChild?: { type: string; session?: vscode.DebugSession; failure?: Error };
    private childFailure?: Error;

    /** 原会话事件改为会话自有监听，避免延续到扩展结束；native-codelldb.test.js断言监听释放。 */
    constructor(context: vscode.ExtensionContext, session: vscode.DebugSession, private host: NativeSessionHost, private released: () => void) {
        super();
        this.session = session;
        this.config = session.configuration;
        this.subscriptions = [vscode.debug.onDidStartDebugSession(this.onDidStartDebugSession), vscode.debug.onDidTerminateDebugSession(this.onDidTerminateDebugSession)];
    }

    /** 仅登记本次正在启动且父身份精确匹配的两类 child；同文件验证外部/错误类型不能冒充启动成功。 */
    private onDidStartDebugSession = (debugSession: vscode.DebugSession) => {
        const pending = this.pendingChild;
        if (debugSession.parentSession?.id !== this.session.id || !pending || pending.session || debugSession.type !== pending.type) return;
        pending.session = debugSession;
        this.childSessions[debugSession.id] = debugSession;
    };

    /** 任一必要 child 退出即取消启动并关闭双方，关闭期间退出不递归；同文件覆盖 start 内退出、Dual 单边退出和清理异常。 */
    private onDidTerminateDebugSession = (debugSession: vscode.DebugSession) => {
        if (!(debugSession.id in this.childSessions)) return;
        delete this.childSessions[debugSession.id];
        if (this.controller.signal.aborted || this.closing || this.resourcesClosing) return;
        this.childFailure = new Error(debugSession.type + ' child session terminated');
        if (this.pendingChild) this.pendingChild.failure = this.childFailure;
        this.controller.abort(this.childFailure);
        void this.dispose().then(() => this.sendEvent(new debugadapter.TerminatedEvent()), error => {
            this.host.report(error);
            this.sendEvent(new debugadapter.TerminatedEvent());
        });
    };

    /** 保留原DAP控制台输出；native-codelldb.test.js经真实DAP事件通道执行。 */
    private consoleLog(message: string) { this.sendEvent(new debugadapter.OutputEvent(message + '\n', 'console')); }

    /** 保留原 Native 配置及隔离副本；父会话已选 .so 时生成精确模块 preRunCommands，不将内部文件列表传给 CodeLLDB。
     * Node>=22 执行 node --test tests/native-codelldb.test.js，断言 C/C++、用户选项、副本隔离、所选文件命令及取消无 child；native-symbol-selection.test.js 验证路径转义。 */
    private prepareNativeDebugConfiguration(config: vscode.DebugConfiguration, pid: string) {
        let lldbConfig: vscode.DebugConfiguration = {
            "type": "lldb", "name": "Native", "request": "attach",
            "pid": this.host.processId({...config, pid, processId: pid}),
            "androidTarget": config.target.udid,
            "androidAbi": config.native?.abi,
            "androidPackageName": config.packageName,
            "sourceLanguages": ["c", "cpp"],
            "androidNativeToolchain": (config as Record<string, unknown>).androidNativeToolchain ?? nativeToolchainOverrides(config.native),
        };
        let excludeProperties = ["abi", "abiSupported", "abiMap", "sdkRoot", "ndkRoot", "androidNativeToolchain", "androidLldbServerSocket"];
        if (config.native) for (let key in config.native) if (!excludeProperties.includes(key)) lldbConfig[key] = structuredClone(config.native[key]);
        if (config.androidNativeLibraries?.length) {
            if (lldbConfig.preRunCommands !== undefined && (!Array.isArray(lldbConfig.preRunCommands) || lldbConfig.preRunCommands.some((value: unknown) => typeof value !== 'string'))) throw new Error('Native preRunCommands must be a string array');
            lldbConfig.preRunCommands = [...(lldbConfig.preRunCommands ?? []), ...nativeLibraryCommands(config.androidNativeLibraries)];
        }
        if (lldbConfig.postRunCommands !== undefined && (!Array.isArray(lldbConfig.postRunCommands) || lldbConfig.postRunCommands.some((value: unknown) => typeof value !== 'string'))) throw new Error('Native postRunCommands must be a string array');
        lldbConfig.postRunCommands = [...(lldbConfig.postRunCommands ?? []), 'image list -o -f'];
        Object.assign(lldbConfig, { type: 'lldb', request: 'attach', pid: this.host.processId({ ...config, pid, processId: pid }), androidTarget: config.target.udid, androidPackageName: config.packageName, androidProjectRoot: config.androidProjectRoot });
        return lldbConfig;
    }

    /** 启动并核验实际 child start，提前终止视为失败；不以 startDebugging 的布尔值伪造会话；同文件覆盖拒绝、缺事件和退出。 */
    private async startChild(config: vscode.DebugConfiguration): Promise<void> {
        this.checkOpen();
        const pending: NonNullable<DebugAdapter['pendingChild']> = { type: config.type };
        this.pendingChild = pending;
        try {
            const success = await vscode.debug.startDebugging(this.session.workspaceFolder, config, { parentSession: this.session });
            if (pending.failure) throw pending.failure;
            if (!success) throw new Error((config.type === 'lldb' ? 'CodeLLDB' : 'JVM') + ' rejected the child configuration');
            if (!pending.session) throw new Error((config.type === 'lldb' ? 'CodeLLDB' : 'JVM') + ' did not report a child session');
            this.checkOpen();
        } finally { this.pendingChild = undefined; }
    }

    /** 克隆 JVM 选项但锁定 Android 身份与 attach，不传用户端口，由 bundled JVM 分配 tcp:0；同文件覆盖嵌套源码优先和防覆盖。 */
    private prepareJavaDebugConfiguration(pid: string): vscode.DebugConfiguration {
        const config = this.config;
        const java = structuredClone(config.java ?? {});
        for (const field of ['port', 'host', 'hostName', 'androidTarget', 'androidPid', 'apkPath', 'launchActivity', 'signal']) delete java[field];
        return { ...java, type: 'kotlin-jvm', name: java.name ?? 'Android JVM', request: 'attach', android: true,
            serial: config.target.udid, target: config.target.udid, pid: Number(pid), processId: Number(pid), packageName: config.packageName,
            androidProjectRoot: config.androidProjectRoot, projectRoot: config.java?.projectRoot ?? config.projectRoot ?? config.androidProjectRoot ?? this.session.workspaceFolder?.uri.fsPath,
            sourcePaths: structuredClone(config.java?.sourcePaths ?? config.sourcePaths ?? config.androidSourceRoots) };
    }

    /** 按模式接线真实子会话，Dual 必须先 Native 再 JVM；只有 Native 执行临时 VM.Resume；同文件六组合与顺序断言。 */
    private async attachChildren(pid: string, response: DebugProtocol.Response): Promise<void> {
        const mode = this.config.mode ?? 'native';
        if (mode !== 'java') await this.attachToProcess(pid, response);
        if (mode !== 'native') {
            this.consoleLog('Starting JVM debugger for process ' + pid);
            await this.startChild(this.prepareJavaDebugConfiguration(pid));
        } else await this.resumeProcess(pid);
    }

    /** 保留原 Native 子会话启动顺序；前置为父配置已解析，宿主持有 server 供失败回滚。未发现本地符号目录仅附加成功后警告，不要求猜路径；
     * Node>=22 执行 node --test tests/native-codelldb.test.js，断言所选文件精确传至命令且无文本输入/警告、缺失仅附加后警告及异常清理。 */
    private async attachToProcess(pid: string, response: DebugProtocol.Response) {
        this.checkOpen();
        let config = this.config;
        this.consoleLog("Starting Native debugger");
        let lldbConfig = this.prepareNativeDebugConfiguration(config, pid);
        lldbConfig = await this.host.prepareNative(lldbConfig, this.session.workspaceFolder);
        this.socket = lldbConfig.androidLldbServerSocket;
        this.checkOpen();
        // CodeLLDB是android-tools的运行时依赖；父会话启动子会话前等待其provider完成激活，避免VS Code返回false而不产生child。
        if (typeof vscode.extensions?.getExtension === 'function') {
            const codeLldb = vscode.extensions.getExtension('vadimcn.vscode-lldb');
            if (!codeLldb) throw new Error('CodeLLDB extension is not installed or enabled');
            if (!codeLldb.isActive) await codeLldb.activate();
        }
        this.checkOpen();
        await this.startChild(lldbConfig);
        if (!config.androidNativeLibraries?.length && (!Array.isArray(config.native?.symbolSearchPaths) || config.native.symbolSearchPaths.length === 0)) {
            void vscode.window.showWarningMessage('Android Native debugger attached, but no project-built .so files with debug information were found for this ABI. Build the project with Native debug information and use the matching APK. External and precompiled libraries are not loaded automatically.');
        }
        this.checkOpen();
        response.success = true;
        this.consoleLog('Attached to process ' + pid);
    }

    /** 原Native模式的JDWP VM.Resume保留，但失败不吞、连接由会话持有；native-codelldb.test.js验证恢复失败与清理。 */
    private async resumeProcess(pid: string) {
        let config = this.config;
        if (config.resumeProcess ?? (config.request === 'launch')) {
            this.checkOpen();
            this.consoleLog('Resuming waiting VM (JDWP VM.Resume)');
            this.jdwpCleanup = await android.resumeJavaDebugger(config.target, pid);
            this.checkOpen();
        }
    }

    /** 原attach流程仍是attachToProcess再resumeProcess；native-codelldb.test.js验证真实原adapter DAP响应。 */
    protected async attachRequest(response: DebugProtocol.AttachResponse): Promise<void> {
        await this.beginRequest(response, async () => {
            let pid = String(this.host.processId(this.config));
            await this.attachChildren(pid, response);
        });
    }

    /** 仅显式 APK 安装一次，无 -W 启动后按精确包查询唯一 PID；Java 不解析 NDK，attach 不进入本路径；同文件六组合/PID/取消回归。 */
    protected async launchRequest(response: DebugProtocol.LaunchResponse): Promise<void> {
        await this.beginRequest(response, async () => {
            let config = this.config;
            let target: Device = config.target;
            const signal = this.controller.signal;
            const javaOnly = config.mode === 'java';
            const adb = javaOnly ? config.androidAdbPath : resolveNativeToolchain(config.androidProjectRoot, nativeToolchainOverrides(config.native)).adb;
            if (config.apkPath) {
                this.consoleLog('Installing ' + config.apkPath);
                await adbExec(adb, target.udid, ['install', '-r', config.apkPath], signal);
                this.checkOpen();
                if (!config.packageName) {
                    if (javaOnly) throw new Error('Java launch with apkPath requires packageName');
                    config.packageName = await android.getPackageNameFromApk(config.apkPath, config.androidProjectRoot, nativeToolchainOverrides(config.native));
                }
            }
            if (!config.packageName || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(config.packageName)) throw new Error('A valid package name is required.');
            config.launchActivity ||= await resolveLauncherActivity(adb, target.udid, config.packageName, signal);
            this.checkOpen();
            const component = config.packageName + '/' + config.launchActivity;
            if (!/^[\w.$]+\/[\w.$]+$/.test(component)) throw new Error('Invalid Android launch component');
            this.consoleLog('Launching the app activity ' + component);
            const output = await adbExec(adb, target.udid, ['shell', 'am', 'start', '-D', '-n', component], signal);
            if (/Error:|Exception|Status:\s*(?!ok\b)\S+/i.test(output)) throw new Error('Android launch failed: ' + output.trim());
            this.checkOpen();
            const pid = (await adbExec(adb, target.udid, ['shell', 'pidof', config.packageName], signal)).trim();
            this.host.processId({ ...config, pid, processId: pid });
            await this.attachChildren(pid, response);
        });
    }

    /** 对原异步请求补齐DAP错误响应和失败回滚，不创建第二套调试引擎；native-codelldb.test.js验证多重错误。 */
    private async beginRequest(response: DebugProtocol.Response, action: () => Promise<void>): Promise<void> {
        if (this.startup || this.closing) { response.success = false; response.message = 'Native session has already started or closed'; this.sendResponse(response); return; }
        this.startup = (async () => {
            try { this.config = await this.host.resolveSession({ ...this.session.configuration, signal: this.controller.signal }); this.checkOpen(); await action(); response.success = true; }
            catch (error) {
                let failure = error;
                try { await this.closeResources(); } catch (cleanup) { failure = new AggregateError([error, cleanup], 'Native startup and cleanup failed'); }
                response.success = false; response.message = this.host.describe(failure); this.releaseListeners();
            }
            this.sendResponse(response);
        })();
        await this.startup;
    }

    /** 已请求关闭则阻止后续异步启动与resume；native-codelldb.test.js门闩验证。 */
    private checkOpen(): void { if (this.childFailure) throw this.childFailure; this.controller.signal.throwIfAborted(); if (this.closing) throw new Error('Native session is closing'); }

    /** 原disconnect仍等待本会话child与JDWP，额外等待自有server并返回清理错误；同文件disconnect回归。 */
    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse): Promise<void> {
        try { await this.dispose(); response.success = true; this.consoleLog('Debugger detached'); }
        catch (error) { response.success = false; response.message = this.host.describe(error); }
        this.sendResponse(response);
    }

    /** 关闭时先取消 ADB 并停止已出现 child，解除仍在 startDebugging 的依赖，再等待启动结算；同文件门闩验证不死锁和错误聚合。 */
    override async dispose(): Promise<void> {
        if (!this.closing) {
            this.controller.abort(this.childFailure ?? new Error('Native session is closing'));
            this.closing = Promise.resolve().then(async () => {
                const errors: unknown[] = [];
                try {
                    const children = Object.values(this.childSessions);
                    this.childSessions = {};
                    this.earlyChildStop = Promise.allSettled(children.map(child => vscode.debug.stopDebugging(child)));
                    const results = await this.earlyChildStop;
                    errors.push(...results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason));
                    await this.startup;
                    try { await this.closeResources(); } catch (error) { errors.push(error); }
                    if (errors.length) throw new AggregateError(errors, 'Android sessions cleanup failed');
                } finally { this.releaseListeners(); super.dispose(); }
            });
        }
        await this.closing;
    }

    /** child先结束，再结算server/JDWP，所有失败聚合；native-codelldb.test.js验证顺序与等待。 */
    private async closeResources(): Promise<void> {
        await (this.resourcesClosing ||= (async () => {
            await this.earlyChildStop;
            const children = await Promise.allSettled(Object.values(this.childSessions).map(child => vscode.debug.stopDebugging(child)));
            const resources: Promise<unknown>[] = [];
            if (this.socket) resources.push(this.host.releaseNative(this.socket));
            if (this.jdwpCleanup) resources.push(this.jdwpCleanup());
            const results = [...children, ...await Promise.allSettled(resources)];
            this.childSessions = {}; this.socket = undefined; this.jdwpCleanup = undefined;
            const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason);
            if (errors.length) throw new AggregateError(errors, 'Native child/server/JDWP cleanup failed');
        })());
    }

    /** 原事件监听转为会话自有并移出活动集合；native-codelldb.test.js断言监听归零。 */
    private releaseListeners(): void { for (const owned of this.subscriptions.splice(0)) owned.dispose(); this.released(); }
}
