import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable, Writable, Transform } from 'stream';
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

// 原始输入按3字节跨块编码，只保留不足3字节尾部；进度回调接收编码前字节，流错误交由run回收。
// 编解码共享回归：tests/device-explorer-files.test.js，Node>=22 VM+原生流/CLI文本转换替身，node --test tests/device-explorer-files.test.js。
// binary shell transport preserves all byte values across arbitrary chunks and text-mode CLI验证单向字节/跨块/计数；strict base64 output rejects invalid padding truncated and noncanonical data验证非法输入拒绝。
function encodeBase64(count: (data: Buffer) => void): Transform {
  let tail = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        count(chunk);
        const data = Buffer.concat([tail, chunk]), end = data.length - data.length % 3;
        tail = Buffer.from(data.subarray(end));
        callback(null, data.subarray(0, end).toString('base64'));
      } catch (error) { callback(error instanceof Error ? error : new Error(String(error))); }
    },
    flush(callback) { callback(null, tail.toString('base64')); }
  });
}

// 输出只接受标准base64和CR/LF折行，跨块保留不足4字符尾部并验证规范padding位；禁止Buffer.from的宽松容错，回归见编解码共享映射。
function decodeBase64(count: (data: Buffer) => void): Transform {
  let tail = '', padded = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        const text = chunk.toString('latin1').replace(/[\r\n]/g, '');
        if (/[^A-Za-z0-9+/=]/.test(text) || (padded && text.length)) { throw new Error('Invalid device base64 output'); }
        const data = tail + text, end = data.length - data.length % 4, complete = data.slice(0, end);
        const padding = complete.indexOf('='), last = complete.slice(-4);
        if (padding !== -1 && (padding < complete.length - 2 || !/^[A-Za-z0-9+/]{2}(?:[A-Za-z0-9+/]=|==)$/.test(last) || end !== data.length)) { throw new Error('Invalid device base64 padding'); }
        if (padding !== -1 && Buffer.from(last, 'base64').toString('base64') !== last) { throw new Error('Noncanonical device base64 padding'); }
        const decoded = Buffer.from(complete, 'base64');
        tail = data.slice(end); padded ||= complete.endsWith('=');
        count(decoded); callback(null, decoded);
      } catch (error) { callback(error instanceof Error ? error : new Error(String(error))); }
    },
    flush(callback) { callback(tail.length ? new Error('Truncated device base64 output') : undefined); }
  });
}

// 设备文件操作由实例固定串号和访问身份，所有命令流/子进程/临时项都有明确所有权。
// 全部经run的stat/list/create/remove/listPackages/pull/push调用共享其编码/错误/回收回归映射；Node>=22，node --test tests/device-explorer-files.test.js。
export class DeviceExplorerFiles {
  // 不自动root或绕过权限；run-as只接受合法包名，回归验证访问上下文和拒绝注入。
  constructor(readonly serial: string, readonly access: Access = {}) {
    if (!serial || serial.includes('\0')) { throw new Error('Invalid device serial'); }
    if (access.runAs && !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(access.runAs)) { throw new Error('Invalid run-as package'); }
  }

  // 把完整base64管线放入固定run-as/su身份，shell -T仅保证无PTY，二进制由run编码边界保护；run-as and su apply verified access identity to remote scripts及run共享回归验证身份/错误语义。
  private script(script: string): string {
    return this.access.runAs ? 'run-as ' + quote(this.access.runAs) + ' sh -c ' + quote(script) : this.access.su ? 'su 0 sh -c ' + quote(script) : script;
  }

  // 输入远端脚本及流，统一ASCII base64边界消除ADB文本转换；pipefail保留shell v2退出码/独立stderr，身份包裹整个管线。
  // run共享回归：编解码共享映射；shell transport preserves remote errors metadata limits and cancellation验证错误/16MiB解码上限/取消等待close及流回收。
  // large binary streams honor backpressure and failed transfers clean staging without replacing targets验证1MiB跨块慢写/原字节计数、下载损坏不覆盖原目标、上传失败清stage不执行mv。
  // opt-in device toolbar transfers preserve independent byte counts hashes and refresh results在EXPLORER_ADB/EXPLORER_DEVICE可用时验证独立单向哈希、已知下载字节、list/remove及隔离目录清理。
  private async run(script: string, options: { signal?: AbortSignal; input?: Readable; output?: Writable; progress?: (bytes: number) => void } = {}): Promise<Buffer> {
    options.signal?.throwIfAborted();
    const command = this.script('set -o pipefail; ' + (options.input ? 'base64 -d | ' : '') + '{\n' + script + '\n} | base64');
    if (command.includes('\0')) { throw new Error('NUL is not permitted in adb arguments'); }
    const child = spawn(adbPath(), ['-s', this.serial, 'shell', '-T', command], { env: { ...process.env, ANDROID_HOME: sdkRoot(), ANDROID_SDK_ROOT: sdkRoot() }, shell: false, windowsHide: true });
    let failure: Error | undefined, stderr = '', bytes = 0, size = 0; const chunks: Buffer[] = [];
    const closed = new Promise<number | null>(resolve => child.once('close', resolve));
    const stopStreams = () => { options.input?.destroy(); options.output?.destroy(); child.stdin.destroy(); child.stdout.destroy(); };
    const failed = (error: Error) => { failure ??= error; child.kill(); stopStreams(); };
    child.once('error', error => { failure ??= error; });
    const abort = () => { child.kill(); stopStreams(); }; options.signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-65536); });
    const count = (data: Buffer) => { bytes += data.length; options.progress?.(bytes); };
    const decoded = decodeBase64(data => { if (!options.input) { count(data); } });
    const destination = options.output || new Writable({ write(data: Buffer, _encoding, callback) {
      size += data.length;
      if (size > 16 * 1024 * 1024) { callback(new Error('Device metadata exceeds output limit')); }
      else { chunks.push(Buffer.from(data)); callback(); }
    } });
    const output = pipeline(child.stdout, decoded, destination).catch(failed);
    const input = options.input ? pipeline(options.input, encodeBase64(count), child.stdin).catch(failed) : undefined;
    if (!options.input) { child.stdin.end(); }
    if (options.signal?.aborted) { abort(); }
    try {
      const code = await closed;
      if (code !== 0) { failure ??= new Error(stderr.trim() || 'ADB shell exited ' + code); }
      if (code !== 0 || options.signal?.aborted || failure) { stopStreams(); }
      await Promise.all([input, output]);
      options.signal?.throwIfAborted();
      if (code !== 0 && stderr.trim()) { throw new Error(stderr.trim()); }
      if (failure) { throw failure; }
      return Buffer.concat(chunks);
    } finally { options.signal?.removeEventListener('abort', abort); }
  }

  // 单一目录项协议按参数顺序解码纯数字/权限并保留链接信息；文件回归验证完整字段。
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
  // 单一FileEntry协议解析目录项，不兼容旧列表格式。
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


  // 单项stat复用批处理编码但只传一个路径，不接受空响应；files回归验证文件/目录/链接和权限拒绝，真机对比字段等价。
  async stat(value: string, signal?: AbortSignal): Promise<ExplorerEntry> {
    const file = remote(value), entries = this.parse(await this.run(this.metadata() + '; emit_metadata ' + quote(file), { signal }));
    if (entries.length !== 1 || entries[0].path !== file) { throw new Error('Invalid stat response'); } return entries[0];
  }

  // 单目录异步枚举只用shell glob，不递归进入子目录；每项独立stat，权限失败保留可识别条目；回归覆盖权限噪声、缓存和结构化元数据。
  async list(value: string, signal?: AbortSignal): Promise<ExplorerEntry[]> {
    const directory = remote(value), base = quote(directory === '/' ? '' : directory);
    const check = '[ -d ' + quote(directory) + ' ] && [ -r ' + quote(directory) + ' ] && [ -x ' + quote(directory) + ' ] || { printf ' + quote('Permission denied or not a directory: ' + directory) + ' >&2; exit 1; }; ';
    const glob = 'printf ' + quote(String.raw`F\0`) + '; for p in ' + base + '/* ' + base + '/.[!.]* ' + base + '/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; kind=other; perm=??????????; size=0; modified=0; target=; link=0; if [ -L "$p" ]; then kind=symlink; perm=lrwxrwxrwx; [ -d "$p" ] && link=1; target=$(readlink -n -- "$p" 2>/dev/null || true); elif [ -d "$p" ]; then kind=directory; perm=drwxr-xr-x; else kind=file; perm=-rw-r--r--; fi; if values=$(stat -c "%A %s %Y" -- "$p" 2>/dev/null); then IFS=" " read -r perm size modified <<__ANDROID_LIST_STAT__\n$values\n__ANDROID_LIST_STAT__\nfi; printf "%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0" "$p" "$kind" "$perm" "$size" "$modified" "$link" "$target"; done';
    const script = check + glob;
    const data = await this.run(script, { signal });
    if (data[1] !== 0 || data[0] !== 70) { throw new Error('Invalid device directory listing'); }
    const entries = this.parse(data.subarray(2));
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

  // 解析包列表，允许单段系统包名且拒绝非法响应；Node>=22运行 npm test，tests/device-explorer-files.test.js 的 package listing 回归，断言完整列表、错误及取消。
  async listPackages(signal?: AbortSignal): Promise<string[]> {
    const text = (await this.run('pm list packages', { signal })).toString('utf8');
    const lines = text.split(/\r?\n/).filter(Boolean); if (lines.some(line => !/^package:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(line))) { throw new Error('Invalid package manager response'); }
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

  // 解码后的原字节先写拥有的本地stage，全部完成才提交目标，取消/错误清理；字节/背压/保留原目标及真机单向断言见run共享回归映射。
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

  // 编码流在远端同一身份解码到唯一stage，mv完成且stage消失才报成功；原字节进度、错误清理及独立remote stat/wc/sha256见run共享回归映射。
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
