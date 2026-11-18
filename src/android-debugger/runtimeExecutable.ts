import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 输入扩展自有宿主根与候选绝对路径，输出 canonical executable 或明确缺失时 undefined。
 * 前置：仅扩展/全局存储 tools/<host> 调用；禁止将配置、SDK、NDK、PATH 或 Android server 交入。
 * 校验 lexical/realpath containment、普通文件；Unix 只在无执行位时以 mode|0o111 补位，再检查 X_OK；其他 IO 错误原样传播。
 * 回归：node --test tests/android-runtime-executable.test.js tests/android-toolchain.test.js tests/android-native-toolchain.test.js，断言权限、越界、链接、错误及调用范围。
 */
export function runtimeExecutable(candidate: string, ownedRoot: string): string | undefined {
  if (!path.isAbsolute(candidate) || !path.isAbsolute(ownedRoot) || /[\x00-\x1f\x7f]/.test(candidate + ownedRoot)) throw new Error('Invalid bundled runtime absolute path');
  const relative = path.relative(ownedRoot, candidate);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Bundled runtime escapes owned root: ' + candidate);
  let root: string; let real: string; let info: fs.Stats;
  try {
    root = fs.realpathSync(ownedRoot);
    real = fs.realpathSync(candidate);
    const resolved = path.relative(root, real);
    if (!resolved || resolved === '..' || resolved.startsWith('..' + path.sep) || path.isAbsolute(resolved)) throw new Error('Bundled runtime symlink escapes owned root: ' + candidate);
    info = fs.statSync(real);
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw error;
  }
  if (!info.isFile()) throw new Error('Bundled runtime is not a regular file: ' + candidate);
  if (process.platform !== 'win32' && (info.mode & 0o111) === 0) fs.chmodSync(real, info.mode | 0o111);
  fs.accessSync(real, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
  return real;
}
