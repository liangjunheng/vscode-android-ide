import { readProjectLocalConfig } from './projectLocalConfig';
import { getRuntimeContext, discoverSdkRoot, sdkToolPath, existingRuntimeFile } from './runtimeContext';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { execFile, spawn } from 'child_process';

// 从项目本机 JSON 的 sdkPath 和标准环境候选中选择首个存在的 SDK 路径；可显式传入项目根，缺失时返回空串。回归：node --test tests/device-manager-ui.test.js。
export function sdkRoot(projectRoot?: string): string {
  return discoverSdkRoot(readProjectLocalConfig(projectRoot).sdkPath);
}

const exe = (n: string) => (process.platform === 'win32' ? n + '.exe' : n);


// 优先使用统一 RuntimeContext 的平台 ADB；缺失时回退 Android SDK，再回退 PATH。
// 回归：node --test tests/android-toolchain.test.js tests/runtime-context.test.js，覆盖扩展资产、SDK 和 PATH 顺序。
export function adbPath() {
  const bundled = getRuntimeContext()?.dependencies.adb;
  if (bundled) return bundled;
  const root = sdkRoot();
  return (root && existingRuntimeFile(sdkToolPath(root, 'adb'))) || exe('adb');
}

// 读取项目本机配置中的原生scrcpy路径，未配置时交给系统PATH解析；独立窗口回归验证启动参数不经过Webview。
export const nativeScrcpyPath = (projectRoot?: string) => readProjectLocalConfig(projectRoot).scrcpyPath || exe('scrcpy');

// 模拟器与命令行依赖共用RuntimeContext，缺内置工具时使用外部SDK；runtime-context回归覆盖。
export function emulatorPath() { return getRuntimeContext()?.dependencies.emulator ?? sdkToolPath(sdkRoot(), 'emulator'); }
// AVD管理工具使用平台脚本后缀；runtime-context回归验证Windows bat及SDK版本目录。
export const avdmanagerPath = () => getRuntimeContext()?.dependencies.avdmanager ?? sdkToolPath(sdkRoot(), 'avdmanager');

export function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ANDROID_HOME: sdkRoot(), ANDROID_SDK_ROOT: sdkRoot() };
    const p = execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, env }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || stdout || err.message).toString().trim())) : resolve(stdout.toString()));
    if (input !== undefined) { p.stdin?.end(input); }
  });
}

// 二进制调用可绑定连接取消信号，未传signal的既有调用不变；view-idle/SDK回归验证取消和字节结果。
export function runBuffer(cmd: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, signal }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export const adb = (serial: string | undefined, ...args: string[]) =>
  run(adbPath(), serial ? ['-s', serial, ...args] : args);

export function spawnDetached(cmd: string, args: string[]) {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', env: { ...process.env, ANDROID_HOME: sdkRoot(), ANDROID_SDK_ROOT: sdkRoot() } });
  p.unref();
}

export interface Device { serial: string; state: string; model?: string; avdName?: string; name?: string; }

const propCache = new Map<string, { model: string; api: string }>();

async function deviceProps(serial: string) {
  let p = propCache.get(serial);
  if (!p) {
    const get = (k: string) => adb(serial, 'shell', 'getprop', k).then((v) => v.trim()).catch(() => '');
    const [model, full, sdk] = await Promise.all([get('ro.product.model'), get('ro.build.version.sdk_full'), get('ro.build.version.sdk')]);
    p = { model, api: full || sdk };
    if (p.model) { propCache.set(serial, p); }
  }
  return p;
}

// Same naming as Android Studio: AVD display name, or "<model> API <level>" for physical devices.
async function friendlyName(d: Device): Promise<string> {
  if (d.avdName) {
    const avd = listAvds().find((a) => a.name === d.avdName);
    return avd?.config['avd.ini.displayname'] || d.avdName.replace(/_/g, ' ');
  }
  const p = await deviceProps(d.serial);
  const model = p.model || d.model?.replace(/_/g, ' ') || d.serial;
  return p.api ? `${model} API ${p.api}` : model;
}

// 列出 adb 的所有连接状态，命令失败携带实际路径向调用方报错；npm test SDK 回归断言在线/未授权/离线和失败。
export async function listDevices(): Promise<Device[]> {
  let out: string;
  try { out = await adb(undefined, 'devices', '-l'); }
  catch (error) { throw new Error('ADB discovery failed (' + adbPath() + '): ' + String(error)); }
  const devices: Device[] = [];
  for (const line of out.split('\n').slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(\S+)(.*)$/);
    if (!m) { continue; }
    const model = m[3].match(/model:(\S+)/)?.[1];
    const d: Device = { serial: m[1], state: m[2], model };
    if (d.serial.startsWith('emulator-') && d.state === 'device') {
      try {
        d.avdName = (await adb(d.serial, 'emu', 'avd', 'name')).split('\n')[0].trim();
      } catch { /* ignore */ }
    }
    if (d.state === 'device') { d.name = await friendlyName(d); }
    devices.push(d);
  }
  return devices;
}

export interface Avd { name: string; dir: string; config: Record<string, string>; }

export const avdHome = () => process.env.ANDROID_AVD_HOME ?? path.join(os.homedir(), '.android', 'avd');

export function readConfig(file: string): Record<string, string> {
  const cfg: Record<string, string> = {};
  if (!fs.existsSync(file)) { return cfg; }
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const i = l.indexOf('=');
    if (i > 0 && !l.startsWith('#')) { cfg[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  }
  return cfg;
}

export function writeConfigValues(file: string, values: Record<string, string>) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const remaining = { ...values };
  const out = lines.map((l) => {
    const k = l.split('=')[0].trim();
    if (k in remaining) { const v = remaining[k]; delete remaining[k]; return `${k}=${v}`; }
    return l;
  });
  for (const [k, v] of Object.entries(remaining)) { out.push(`${k}=${v}`); }
  fs.writeFileSync(file, out.join('\n'));
}

export function listAvds(): Avd[] {
  const home = avdHome();
  if (!fs.existsSync(home)) { return []; }
  return fs.readdirSync(home).filter((f) => f.endsWith('.ini')).map((f) => {
    const name = f.slice(0, -4);
    const ini = readConfig(path.join(home, f));
    const dir = ini['path'] && fs.existsSync(ini['path']) ? ini['path'] : path.join(home, `${name}.avd`);
    return { name, dir, config: readConfig(path.join(dir, 'config.ini')) };
  });
}

export function installedSystemImages(): { id: string; label: string }[] {
  const base = getRuntimeContext()?.dependencies.systemImagesRoot ?? path.join(sdkRoot(), 'system-images');
  const res: { id: string; label: string }[] = [];
  if (!fs.existsSync(base)) { return res; }
  for (const api of fs.readdirSync(base)) {
    const apiDir = path.join(base, api);
    if (!fs.statSync(apiDir).isDirectory()) { continue; }
    for (const tag of fs.readdirSync(apiDir)) {
      const tagDir = path.join(apiDir, tag);
      if (!fs.statSync(tagDir).isDirectory()) { continue; }
      for (const abi of fs.readdirSync(tagDir)) {
        res.push({ id: `system-images;${api};${tag};${abi}`, label: `${api} · ${tag} · ${abi}` });
      }
    }
  }
  return res;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function runningDirs(): string[] {
  return [
    path.join(os.homedir(), 'Library/Caches/TemporaryItems/avd/running'),
    path.join(process.env.XDG_RUNTIME_DIR ?? '', 'avd/running'),
    path.join(os.homedir(), '.android/avd/running'),
    path.join(os.tmpdir(), 'avd/running'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Temp/avd/running'),
  ];
}

/** Bearer token of an emulator started with -grpc-use-token (as Android Studio does). */
export function grpcTokenFor(serial: string): string | undefined {
  const consolePort = serial.replace('emulator-', '');
  for (const dir of runningDirs()) {
    if (!fs.existsSync(dir)) { continue; }
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ini'))) {
      const c = readConfig(path.join(dir, f));
      if (c['port.serial'] === consolePort) { return c['grpc.token'] || undefined; }
    }
  }
  return undefined;
}

/** gRPC port of a running emulator (only present when started with -grpc). */
export function grpcPortFor(serial: string): number | undefined {
  const consolePort = serial.replace('emulator-', '');
  for (const dir of runningDirs()) {
    if (!fs.existsSync(dir)) { continue; }
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ini'))) {
      const c = readConfig(path.join(dir, f));
      if (c['port.serial'] === consolePort && c['grpc.port']) { return Number(c['grpc.port']); }
    }
  }
  return undefined;
}
