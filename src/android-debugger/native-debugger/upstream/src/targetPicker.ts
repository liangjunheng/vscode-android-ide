import * as vscode from 'vscode';
import { logger } from './logger';
import { Device, VerboseDevice } from './commonTypes';
import * as android from './android';
import type { NativeToolchainOverrides } from '../../nativeToolchain';

let context: vscode.ExtensionContext;

export type TargetType = "Device" | "Emulator";

export interface Target extends VerboseDevice {
    name: string,
    type: TargetType,
    avdName?: string,
};

interface TargetQuickPickItem extends vscode.QuickPickItem {
    getTarget: () => Promise<Device>;
}

// Last successfully picked target
var lastPickedTarget: Device|undefined;

// Current target for the debug session being started
var currentTarget: Device|undefined;


/** 转换设备并保留项目根；Node>=22执行node --test tests/native-picker.test.js，通过pickTarget断言目标/工具链root。 */
async function createTargetFromDevice(device: VerboseDevice, projectRoot?: string, overrides?: NativeToolchainOverrides): Promise<Target> {
    const targetDevice = {...device, ...(projectRoot ? {androidProjectRoot: projectRoot} : {}), ...(overrides ? {androidNativeToolchain: overrides} : {})};
    let deviceAdb = await android.getDeviceAdb(targetDevice);

    let type : TargetType = device.udid.startsWith("emulator-") ? "Emulator" : "Device";

    let name = undefined;
    let avdName = undefined;
    if (type === "Emulator") {
        avdName = await deviceAdb.sendTelnetCommand("avd name");
        name = await android.getAvdDisplayName(avdName, projectRoot, overrides) || device.udid;
    }
    else {
        name = await deviceAdb.getModel();
    }

    return {
        ...targetDevice,
        type,
        name,
        avdName,
    };
}

/** 枚举在线/虚拟设备并沿用排序；native-picker.test.js通过pickTarget断言顺序、离线过滤、root及ADB失败。 */
async function getTargetPickerItems(projectRoot?: string, overrides?: NativeToolchainOverrides): Promise<TargetQuickPickItem[]> {
    let adb = await android.getAdb(projectRoot, overrides);

    let avdList = await android.getAvdList(projectRoot, overrides);

    let targets = await Promise.all(
        (await adb.getConnectedDevices({verbose: true}) as VerboseDevice[])
            .filter((device) => device.state === "device")
            .map(device => createTargetFromDevice(device, projectRoot, overrides))
    );

    targets = targets.sort((a, b) => {
        if (a.udid === lastPickedTarget?.udid) { return -1; }
        if (b.udid === lastPickedTarget?.udid) { return 1; }

        if (a.type !== b.type) {
            return a.type.localeCompare(b.type);
        }

        return a.name.localeCompare(b.name);
    });

    let targetPickerItems: TargetQuickPickItem[] = [];

    if (targets.length) {
        targetPickerItems.push({
            label: "Connected Devices",
            kind: vscode.QuickPickItemKind.Separator,
            getTarget: async () => { throw new Error(); }
        });
    }

    targets.forEach(target => {
        if (target.avdName) {
            let index = avdList.indexOf(target.avdName);
            avdList.splice(index, 1);
        }

        let icon = target.type === "Device" ? "$(device-mobile)" : "$(vm)";
        let detail = target.type + (target.type === "Emulator" ? " · Running" : "") + " · " + target.udid;
        targetPickerItems.push({
            label: `${icon} ${target.name}`,
            detail: detail,
            getTarget: async () => target
        });
    });

    if (avdList.length) {
        targetPickerItems.push({
            label: "More Virtual Devices",
            kind: vscode.QuickPickItemKind.Separator,
            getTarget: async () => { throw new Error(); }
        });
    }

    targetPickerItems.push(
        ...
        await Promise.all(avdList.map(async (avdName): Promise<TargetQuickPickItem> => ({
            label: `$(vm-running) ${await android.getAvdDisplayName(avdName, projectRoot, overrides)}`,
            detail: "Emulator · Stopped",
            getTarget: async () => {
                return await android.launchAVD(avdName, projectRoot, overrides);
            }
        })))
    );

    return targetPickerItems;
}

/** 返回用户目标或取消undefined；native-picker.test.js断言真实pickTarget选择、取消、项目根与查询错误。 */
export async function pickTarget(projectRoot?: string, overrides?: NativeToolchainOverrides)
{
    let quickPickOptions: vscode.QuickPickOptions = {
        title: "Select Android Target",
        matchOnDescription: true,
        matchOnDetail: true,
    };

    let target = await (await vscode.window.showQuickPick(getTargetPickerItems(projectRoot, overrides), quickPickOptions))?.getTarget();

    logger.log("Picked target", target);

    if (target) { lastPickedTarget = target; }

    return target;
}

// Get the last picked target if still available or pick target.
/** 返回仍在线的上次目标或重新选择；native-picker.test.js的current and last target用例断言在线/离线及取消。 */
export async function getLastOrPickTarget(projectRoot?: string, overrides?: NativeToolchainOverrides) {
    if (lastPickedTarget && await android.isDeviceConnected(lastPickedTarget.udid)) {
        return {...lastPickedTarget, ...(projectRoot ? {androidProjectRoot: projectRoot} : {}), ...(overrides ? {androidNativeToolchain: overrides} : {})};
    }

    return await pickTarget(projectRoot, overrides);
}

/** 依序列号查询设备并透传项目根；Node>=22执行node --test tests/native-picker.test.js，explicit serial wrapper直接调用本函数，断言准确参数、返回设备和原始错误传播。 */
export async function getTargetFromUDID(udid: string, projectRoot?: string, overrides?: NativeToolchainOverrides) {
    return await android.getDeviceFromUDID(udid, projectRoot, overrides);
}

// Current target is only available when a new debug session is being started
// between resolveDebugConfiguration and resolveDebugConfigurationWithSubstitutedVariables calls.
/** 返回当前目标或进入选择器并传递root；native-picker.test.js的current and last target用例断言复用与reset。 */
export async function getCurrentOrPickTarget(projectRoot?: string) {
    if (currentTarget) { return projectRoot ? {...currentTarget, androidProjectRoot: projectRoot} : currentTarget; }

    return await pickTarget(projectRoot);
}

/** 返回正在解析的目标或undefined，不启动选择器；native-picker.test.js的current and last target用例断言getter前后状态。 */
export function getCurrentTarget() {
    return currentTarget;
}

/** 保存本次解析的设备供变量命令复用；native-picker.test.js的current and last target用例断言同一对象及root。 */
export function setCurrentTarget(target: Device) {
    currentTarget = target;
}

/** 清除解析上下文；native-picker.test.js的current and last target用例断言getter恢复undefined。 */
export function resetCurrentTarget() {
    currentTarget = undefined;
}


// Activation
/** 记录扩展上下文，不查询设备或分配运行资源；native-picker.test.js的activation用例断言零边界调用。 */
export function activate(c: vscode.ExtensionContext)
{
    context = c;
}
