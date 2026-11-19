import * as vscode from 'vscode';
import * as debugadapter from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';

import * as android from './android';
import { Device } from './commonTypes';
import { nativeToolchainOverrides, resolveNativeToolchain } from '../../nativeToolchain';
import { resolveLauncherActivity } from '../../nativeTarget';

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
    private subscriptions: vscode.Disposable[];

    /** 原会话事件改为会话自有监听，避免延续到扩展结束；native-codelldb.test.js断言监听释放。 */
    constructor(context: vscode.ExtensionContext, session: vscode.DebugSession, private host: NativeSessionHost, private released: () => void) {
        super();
        this.session = session;
        this.config = session.configuration;
        this.subscriptions = [vscode.debug.onDidStartDebugSession(this.onDidStartDebugSession), vscode.debug.onDidTerminateDebugSession(this.onDidTerminateDebugSession)];
    }

    /** 原child登记逻辑限定Native和所属父会话；native-codelldb.test.js验证精确child身份。 */
    private onDidStartDebugSession = (debugSession: vscode.DebugSession) => {
        if (debugSession.parentSession?.id === this.session.id && debugSession.type === 'lldb') this.childSessions[debugSession.id] = debugSession;
    };

    /** 原终止事件只响应所属child，完成清理后通知父终止；native-codelldb.test.js覆盖结束及后台错误。 */
    private onDidTerminateDebugSession = (debugSession: vscode.DebugSession) => {
        if (!(debugSession.id in this.childSessions)) return;
        delete this.childSessions[debugSession.id];
        if (!Object.keys(this.childSessions).length) void this.dispose().then(() => this.sendEvent(new debugadapter.TerminatedEvent()), this.host.report);
    };

    /** 保留原DAP控制台输出；native-codelldb.test.js经真实DAP事件通道执行。 */
    private consoleLog(message: string) { this.sendEvent(new debugadapter.OutputEvent(message + '\n', 'console')); }

    /** 保留原Native配置构造，声明C/C++源语言并增加宿主身份字段保护和副本隔离；native-codelldb.test.js断言child字段隔离和断点语言。 */
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
        let excludeProperties = ["abi", "abiSupported", "abiMap", "sdkRoot", "ndkRoot"];
        if (config.native) for (let key in config.native) if (!excludeProperties.includes(key)) lldbConfig[key] = structuredClone(config.native[key]);
        return lldbConfig;
    }

    /** 保留原先启动Native子会话的顺序与API，缺少符号目录时提示断点风险，宿主提前持有server以便失败回滚；native-codelldb.test.js覆盖提示和异常。 */
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
        let lldbSuccess = await vscode.debug.startDebugging(this.session.workspaceFolder, lldbConfig, {parentSession: this.session});
        if (!lldbSuccess) throw new Error('CodeLLDB rejected the native child configuration');
        if (!Object.keys(this.childSessions).length) throw new Error('CodeLLDB did not report a native child session');
        if (!Array.isArray(config.native?.symbolSearchPaths) || config.native.symbolSearchPaths.length === 0) {
            void vscode.window.showWarningMessage('Android Native debugger attached without symbolSearchPaths. C/C++ source breakpoints may not bind; configure native.symbolSearchPaths with unstripped .so directories.');
        }
        this.checkOpen();
        response.success = lldbSuccess;
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
            await this.attachToProcess(pid, response);
            await this.resumeProcess(pid);
        });
    }

    /** 原安装/启动/取进程/attach/resume顺序保留，默认Activity与匹配包名是必要宿主适配；同文件launch回归。 */
    protected async launchRequest(response: DebugProtocol.LaunchResponse): Promise<void> {
        await this.beginRequest(response, async () => {
            let config = this.config;
            let target: Device = config.target;
            if (config.apkPath) {
                this.consoleLog('Installing ' + config.apkPath);
                await android.installApp(target, config.apkPath);
                this.checkOpen();
                config.packageName ||= await android.getPackageNameFromApk(config.apkPath, config.androidProjectRoot, nativeToolchainOverrides(config.native));
            }
            if (!config.packageName || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(config.packageName)) throw new Error('A valid package name is required.');
            const toolchain = resolveNativeToolchain(config.androidProjectRoot, nativeToolchainOverrides(config.native));
            config.launchActivity ||= await resolveLauncherActivity(toolchain.adb, target.udid, config.packageName);
            this.checkOpen();
            this.consoleLog('Launching the app activity ' + config.packageName + '/' + config.launchActivity);
            await android.launchApp(target, config.packageName, config.launchActivity);
            this.checkOpen();
            // 沿用原项目Launch逻辑：取启动后JDWP列表的最后一个进程，避免设备返回的进程名与包名不一致时误报get-pid。
            let processList = await android.getProcessList(target, false);
            let process = processList.length ? processList[processList.length - 1] : undefined;
            if (!process?.pid) throw new Error("Could not get pid for the app. Please ensure that the app is launched correctly.");
            await this.attachToProcess(process.pid, response);
            await this.resumeProcess(process.pid);
        });
    }

    /** 对原异步请求补齐DAP错误响应和失败回滚，不创建第二套调试引擎；native-codelldb.test.js验证多重错误。 */
    private async beginRequest(response: DebugProtocol.Response, action: () => Promise<void>): Promise<void> {
        if (this.startup || this.closing) { response.success = false; response.message = 'Native session has already started or closed'; this.sendResponse(response); return; }
        this.startup = (async () => {
            try { this.config = await this.host.resolveSession(this.session.configuration); this.checkOpen(); await action(); response.success = true; }
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
    private checkOpen(): void { if (this.closing) throw new Error('Native session is closing'); }

    /** 原disconnect仍等待本会话child与JDWP，额外等待自有server并返回清理错误；同文件disconnect回归。 */
    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse): Promise<void> {
        try { await this.dispose(); response.success = true; this.consoleLog('Debugger detached'); }
        catch (error) { response.success = false; response.message = this.host.describe(error); }
        this.sendResponse(response);
    }

    /** 多入口共享关闭Promise；native-codelldb.test.js验证关闭中启动和重复dispose。 */
    override async dispose(): Promise<void> {
        await (this.closing ||= (async () => { try { await this.startup; await this.closeResources(); } finally { this.releaseListeners(); super.dispose(); } })());
    }

    /** child先结束，再结算server/JDWP，所有失败聚合；native-codelldb.test.js验证顺序与等待。 */
    private async closeResources(): Promise<void> {
        await (this.resourcesClosing ||= (async () => {
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
