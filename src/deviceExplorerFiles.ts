import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable, Writable } from 'stream';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { adbPath, sdkRoot } from './sdk';

export interface ExplorerEntry { path: string; name: string; kind: 'directory' | 'file' | 'symlink' | 'other'; permissions: string; size: number; modified: number; linkTarget?: string; directoryLink?: boolean; }
export interface TransferOptions { signal?: AbortSignal; overwrite?: boolean; progress?: (bytes: number) => void; }
type Access = { runAs?: string; su?: boolean };

// 单一POSIX参数转义，不能交给本机shell解释；device-explorer-files.test.js断言引号/空格/注入和argv无NUL。
function quote(value: string): string { return "'" + value.replace(/'/g, "'\"'\"'") + "'"; }
// 远端只接受绝对非穿越路径，拒绝根目录破坏操作由具体方法检查；文件后端回归断言路径边界。
function remote(value: string): string { if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || value.split('/').includes('..')) { throw new Error('Invalid device path'); } return path.posix.normalize(value); }
// 本地目标名必须可表示且不逃出父目录；回归覆盖Windows保留名、大小写冲突和深层穿越。
function safeName(value: string): void { if (!value || value === '.' || value === '..' || /[<>:"\/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) { throw new Error('Unsafe local filename: ' + JSON.stringify(value)); } }
// 结构化本地存在检查只将ENOENT当缺失，权限失败必须传播；文件回归断言拒绝覆盖及只读目录。
async function exists(value: string): Promise<boolean> { try { await fs.lstat(value); return true; } catch (error: any) { if (error.code === 'ENOENT') { return false; } throw error; } }

// 设备文件操作由实例固定串号和访问身份，所有命令流/子进程/临时项都有明确所有权。
// 回归：npm test tests/device-explorer-files.test.js 与隔离目录真机二进制传输核对。
export class DeviceExplorerFiles {
  // 不自动root或绕过权限；run-as只接受合法包名，回归验证访问上下文和拒绝注入。
  constructor(readonly serial: string, readonly access: Access = {}) {
    if (!serial || serial.includes('\0')) { throw new Error('Invalid device serial'); }
    if (access.runAs && !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(access.runAs)) { throw new Error('Invalid run-as package'); }
  }

  // ADB shell -T保持二进制及shell v2退出码，脚本作为唯一远端参数；回归断言正确身份与shell边界。
  private script(script: string): string {
    return this.access.runAs ? 'run-as ' + quote(this.access.runAs) + ' sh -c ' + quote(script) : this.access.su ? 'su 0 sh -c ' + quote(script) : script;
  }

  // 先注册close/error再输送流，取消等待close及pipeline完成；回归断言磁盘写完前不返回和错误清理。
  private async run(script: string, options: { signal?: AbortSignal; input?: Readable; output?: Writable; progress?: (bytes: number) => void } = {}): Promise<Buffer> {
    options.signal?.throwIfAborted();
    const command = this.script(script); if (command.includes('\0')) { throw new Error('NUL is not permitted in adb arguments'); }
    const child = spawn(adbPath(), ['-s', this.serial, 'shell', '-T', command], { env: { ...process.env, ANDROID_HOME: sdkRoot(), ANDROID_SDK_ROOT: sdkRoot() }, shell: false, windowsHide: true });
    let failure: Error | undefined, stderr = '', bytes = 0, size = 0; const chunks: Buffer[] = [];
    const closed = new Promise<number | null>(resolve => child.once('close', resolve));
    const failed = (error: Error) => { failure ??= error; child.kill(); };
    child.once('error', error => { failure ??= error; });
    const abort = () => child.kill(); options.signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-65536); });
    // 进度来自实际流字节，metadata正文有界保留；回归断言二进制零字节及大块背压。
    const count = (data: Buffer) => { bytes += data.length; try { options.progress?.(bytes); } catch (error) { failed(error instanceof Error ? error : new Error(String(error))); } };
    if (!options.input) { child.stdout.on('data', count); }
    let output: Promise<void> | undefined, input: Promise<void> | undefined;
    if (options.output) { output = pipeline(child.stdout, options.output).catch(error => failed(error)); }
    else { child.stdout.on('data', data => { size += data.length; if (size > 16 * 1024 * 1024) { failed(new Error('Device metadata exceeds output limit')); } else { chunks.push(Buffer.from(data)); } }); }
    if (options.input) { options.input.on('data', count); input = pipeline(options.input, child.stdin).catch(error => failed(error)); } else { child.stdin.end(); }
    if (options.signal?.aborted) { abort(); }
    try {
      const code = await closed;
      if (code !== 0 || options.signal?.aborted || failure) { options.input?.destroy(); options.output?.destroy(); }
      await Promise.all([input, output]);
      options.signal?.throwIfAborted();
      if (failure) { throw failure; }
      if (code !== 0) { throw new Error(stderr.trim() || 'ADB shell exited ' + code); }
      return Buffer.concat(chunks);
    } finally { options.signal?.removeEventListener('abort', abort); options.input?.off('data', count); child.stdout.off('data', count); }
  }

  // 兼容分支每128路径一次stat，按参数顺序解码纯数字/权限并整批printf，链接后缀标记保留末尾换行；files与真机回归验证完整字段。
  // Toybox stat -c不解析反斜线转义，不能直接拿它输出NUL：https://github.com/landley/toybox/blob/master/toys/other/stat.c
  private metadata(): string {
    return String.raw`emit_metadata() {
  values=$(stat -c '%A %s %Y' -- "$@") || return
  remaining=$#
  while IFS=' ' read -r perm size modified; do
    [ "$remaining" -gt 0 ] || { printf 'Unexpected stat row' >&2; return 1; }
    p=$1; shift; remaining=$((remaining - 1)); kind=other; link=0; target=
    case "$perm" in d*) kind=directory ;; -*) kind=file ;; l*) kind=symlink; [ ! -d "$p" ] || link=1 ;; esac
    if [ "$kind" = symlink ]; then target=$(readlink -n -- "$p" && printf '.') || return; target=${'$'}{target%.}; fi
    set -- "$@" "$p" "$kind" "$perm" "$size" "$modified" "$link" "$target"
  done <<__ANDROID_STAT_FIELDS__
$values
__ANDROID_STAT_FIELDS__
  [ "$remaining" -eq 0 ] || { printf 'Missing stat row' >&2; return 1; }
  printf '%s\0' "$@"
}`;
  }

  // 7字段NUL记录严格校验，损坏/半条输出不伪装空目录；回归断言特殊名、权限与毫秒时间。
  private parse(data: Buffer): ExplorerEntry[] {
    if (!data.length) { return []; }
    const fields = data.toString('utf8').split('\0'); if (fields.pop() !== '' || fields.length % 7 !== 0) { throw new Error('Malformed device metadata'); }
    const entries: ExplorerEntry[] = [];
    for (let i = 0; i < fields.length; i += 7) {
      const [file, kind, permissions, size, modified, directoryLink, target] = fields.slice(i, i + 7);
      if (!['directory', 'file', 'symlink', 'other'].includes(kind) || !/^\d+$/.test(size) || !/^-?\d+$/.test(modified) || !['0', '1'].includes(directoryLink)) { throw new Error('Invalid device metadata fields'); }
      const bytes = Number(size), time = Number(modified) * 1000; if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(time)) { throw new Error('Device metadata numeric overflow'); }
      entries.push({ path: remote(file), name: path.posix.basename(file) || '/', kind: kind as ExplorerEntry['kind'], permissions, size: bytes, modified: time, ...(kind === 'symlink' ? { linkTarget: target, directoryLink: directoryLink === '1' } : {}) });
    }
    return entries;
  }

  // find原生NUL字段不按行拆文件名，目录链接另附路径集合；files回归覆盖特殊名/损坏记录/链接，真机逐字段对比旧实现。
  private parseListing(data: Buffer): ExplorerEntry[] {
    const fields = data.toString('utf8').split('\0');
    if (fields.pop() !== '') { throw new Error('Malformed device listing'); }
    const entries: ExplorerEntry[] = []; let index = 0;
    for (; index < fields.length && fields[index] !== ''; index += 5) {
      if (index + 5 > fields.length) { throw new Error('Malformed device listing'); }
      const [file, permissions, size, modified, target] = fields.slice(index, index + 5);
      if (!/^\d+$/.test(size) || !/^-?\d+(?:\.\d+)?$/.test(modified) || !permissions) { throw new Error('Invalid device listing fields'); }
      const bytes = Number(size), time = Math.floor(Number(modified)) * 1000;
      if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(time)) { throw new Error('Device metadata numeric overflow'); }
      const kind = permissions[0] === 'd' ? 'directory' : permissions[0] === '-' ? 'file' : permissions[0] === 'l' ? 'symlink' : 'other';
      entries.push({ path: remote(file), name: path.posix.basename(file) || '/', kind, permissions, size: bytes, modified: time, ...(kind === 'symlink' ? { linkTarget: target, directoryLink: false } : {}) });
    }
    if (fields[index] !== '') { throw new Error('Missing device listing separator'); }
    const links = new Map(entries.filter(entry => entry.kind === 'symlink').map(entry => [entry.path, entry]));
    for (const file of fields.slice(index + 1)) {
      const link = links.get(file); if (!link) { throw new Error('Unknown directory link in listing'); } link.directoryLink = true;
    }
    return entries;
  }

  // 单项stat复用批处理编码但只传一个路径，不接受空响应；files回归验证文件/目录/链接和权限拒绝，真机对比字段等价。
  async stat(value: string, signal?: AbortSignal): Promise<ExplorerEntry> {
    const file = remote(value), entries = this.parse(await this.run(this.metadata() + '; emit_metadata ' + quote(file), { signal }));
    if (entries.length !== 1 || entries[0].path !== file) { throw new Error('Invalid stat response'); } return entries[0];
  }

  // 支持find -printf时原生批量读取直接子项和链接，否则用128项stat兼容分支；同一ADB命令检测能力，不重试真实失败；files/真机回归验证完整字段与耗时。
  async list(value: string, signal?: AbortSignal): Promise<ExplorerEntry[]> {
    const directory = remote(value), base = quote(directory === '/' ? '' : directory);
    const check = '[ -d ' + quote(directory) + ' ] && [ -r ' + quote(directory) + ' ] && [ -x ' + quote(directory) + ' ] || { printf ' + quote('Permission denied or not a directory: ' + directory) + ' >&2; exit 1; }; ';
    const batch = this.metadata() + '; set --; for p in ' + base + '/* ' + base + '/.[!.]* ' + base + '/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; set -- "$@" "$p"; if [ "$#" -eq 128 ]; then emit_metadata "$@" || exit; set --; fi; done; if [ "$#" -gt 0 ]; then emit_metadata "$@"; fi';
    const fast = 'printf ' + quote(String.raw`F\0`) + '; find -H ' + quote(directory) + ' -mindepth 1 -maxdepth 1 -printf ' + quote(String.raw`%p\0%M\0%s\0%T@\0%l\0`) + ' || exit; set --; for p in ' + base + '/* ' + base + '/.[!.]* ' + base + '/..?*; do if [ -L "$p" ] && [ -d "$p" ]; then set -- "$@" "$p"; fi; done; printf ' + quote(String.raw`\0`) + '; if [ "$#" -gt 0 ]; then printf ' + quote(String.raw`%s\0`) + ' "$@"; fi';
    const script = check + "if find / -maxdepth 0 -printf '' >/dev/null 2>&1; then " + fast + '; else printf ' + quote(String.raw`B\0`) + '; ' + batch + '; fi';
    const data = await this.run(script, { signal });
    if (data[1] !== 0 || (data[0] !== 70 && data[0] !== 66)) { throw new Error('Invalid device listing format'); }
    const entries = data[0] === 70 ? this.parseListing(data.subarray(2)) : this.parse(data.subarray(2));
    if (entries.some(entry => path.posix.dirname(entry.path) !== directory)) { throw new Error('Device listing escaped parent directory'); }
    return entries;
  }

  // 新建不覆盖文件或链接，目录已存在也报告失败；回归验证创建错误和安全引用。
  async create(value: string, directory: boolean, signal?: AbortSignal): Promise<void> {
    const file = remote(value); if (file === '/') { throw new Error('Cannot create device root'); }
    await this.run(directory ? 'mkdir -- ' + quote(file) : 'set -C; : > ' + quote(file), { signal });
  }

  // 删除链接本身而非链接目标，根目录拒绝；回归验证符号链接和根保护。
  async remove(value: string, signal?: AbortSignal): Promise<void> { const file = remote(value); if (file === '/') { throw new Error('Cannot delete device root'); } await this.run('rm -rf -- ' + quote(file), { signal }); }

  // 包名输出逐行校验，权限/断开不能替换成空集；回归覆盖真实错误和取消。
  async listPackages(signal?: AbortSignal): Promise<string[]> {
    const text = (await this.run('pm list packages', { signal })).toString('utf8');
    const lines = text.split(/\r?\n/).filter(Boolean); if (lines.some(line => !/^package:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(line))) { throw new Error('Invalid package manager response'); }
    return lines.map(line => line.slice(8));
  }

  // 下载前递归预检整个树，非法名称/链接不会先写部分目标；回归断言深层穿越、冲突和空目录。
  private async planPull(value: string, signal?: AbortSignal): Promise<{ source: string; relative: string; directory: boolean }[]> {
    const plan: { source: string; relative: string; directory: boolean }[] = [];
    const walk = async (source: string, relative: string): Promise<void> => {
      signal?.throwIfAborted(); const entry = await this.stat(source, signal);
      if (entry.kind !== 'directory' && entry.kind !== 'file') { throw new Error('Transferring device symlinks and special files is not supported'); }
      plan.push({ source, relative, directory: entry.kind === 'directory' });
      if (entry.kind === 'directory') {
        const children = await this.list(source, signal), names = new Set<string>();
        for (const child of children) { safeName(child.name); const folded = child.name.toLowerCase(); if (names.has(folded)) { throw new Error('Local case-insensitive filename conflict'); } names.add(folded); await walk(child.path, relative ? relative + '/' + child.name : child.name); }
      }
    };
    await walk(remote(value), ''); return plan;
  }

  // 二进制流先写拥有的本地stage，全部完成才提交目标，取消/错误清理；回归及真机哈希验证避免截断伪成功。
  async pull(value: string, local: string, options: TransferOptions = {}): Promise<void> {
    options.signal?.throwIfAborted(); const destination = path.resolve(local); safeName(path.basename(destination));
    if (await exists(destination) && !options.overwrite) { throw new Error('Destination exists; overwrite confirmation required'); }
    const plan = await this.planPull(value, options.signal);
    if (await exists(destination) && plan[0].directory) { throw new Error('Merging an existing local directory is not supported'); }
    const staging = await fs.mkdtemp(path.join(path.dirname(destination), '.device-explorer-'));
    const root = path.join(staging, 'entry'); let total = 0;
    try {
      for (const entry of plan) {
        options.signal?.throwIfAborted(); const target = entry.relative ? path.join(root, ...entry.relative.split('/')) : root;
        if (entry.directory) { await fs.mkdir(target); }
        else { const initial = total; await this.run('cat -- ' + quote(entry.source), { signal: options.signal, output: createWriteStream(target, { flags: 'wx' }), progress: bytes => { total = initial + bytes; options.progress?.(total); } }); }
      }
      options.signal?.throwIfAborted();
      if (!options.overwrite && await exists(destination)) { throw new Error('Destination exists; overwrite confirmation required'); }
      await fs.rename(root, destination);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }

  // 本地递归枚举不跟随符号链接，避免上传选中树之外文件；回归覆盖空目录、二进制及取消。
  private async planPush(local: string): Promise<{ source: string; relative: string; directory: boolean }[]> {
    const plan: { source: string; relative: string; directory: boolean }[] = [];
    const walk = async (source: string, relative: string): Promise<void> => {
      const info = await fs.lstat(source); if (!info.isDirectory() && !info.isFile()) { throw new Error('Uploading local symlinks and special files is not supported'); }
      plan.push({ source, relative, directory: info.isDirectory() });
      if (info.isDirectory()) { for (const child of await fs.readdir(source)) { await walk(path.join(source, child), relative ? relative + '/' + child : child); } }
    };
    await walk(path.resolve(local), ''); return plan;
  }

  // 上传流进入同目录唯一远端stage，mv完成且stage消失才报成功；回归覆盖run-as身份、覆盖、失败清理和真实字节。
  async push(local: string, value: string, options: TransferOptions = {}): Promise<void> {
    options.signal?.throwIfAborted(); const destination = remote(value); if (destination === '/') { throw new Error('Cannot replace device root'); }
    const plan = await this.planPush(local), staging = path.posix.join(path.posix.dirname(destination), '.device-explorer-' + randomUUID());
    let created = false, total = 0, operationError: unknown;
    try {
      if (!options.overwrite) { await this.run('if [ -e ' + quote(destination) + ' ] || [ -L ' + quote(destination) + ' ]; then printf "Destination exists" >&2; exit 1; fi', { signal: options.signal }); }
      await this.create(staging, true, options.signal); created = true;
      const root = staging + '/entry';
      for (const entry of plan) {
        options.signal?.throwIfAborted(); const target = root + (entry.relative ? '/' + entry.relative : '');
        if (entry.directory) { await this.create(target, true, options.signal); }
        else { const initial = total; await this.run('set -C; cat > ' + quote(target), { signal: options.signal, input: createReadStream(entry.source), progress: bytes => { total = initial + bytes; options.progress?.(total); } }); }
      }
      options.signal?.throwIfAborted();
      const conflict = options.overwrite && !plan[0].directory ? 'if [ -d ' + quote(destination) + ' ] || [ -L ' + quote(destination) + ' ]; then printf "Destination is not a regular file" >&2; exit 1; fi; mv -f -T -- ' : 'mv -n -T -- ';
      await this.run(conflict + quote(root) + ' ' + quote(destination) + '; [ ! -e ' + quote(root) + ' ] || { printf "Destination exists" >&2; exit 1; }', { signal: options.signal });
    } catch (error) { operationError = error; throw error; }
    finally {
      if (created) { try { await this.remove(staging); } catch (error) { if (operationError) { throw new AggregateError([operationError, error], 'Upload and remote temporary cleanup failed'); } throw error; } }
    }
  }
}
