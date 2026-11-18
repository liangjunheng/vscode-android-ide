import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import type * as vscode from 'vscode';
import { SessionResourceLedger, type ResourceProof } from './sessionResources';

/** 将 VS Code 会话标识规范化为稳定 UUID，保证测试会话与实际会话使用同一账本目录。 */
function sessionUuid(value: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return value;
  const hex = createHash('sha256').update(value).digest('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-8' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}

/** 构造当前扩展宿主的完整身份；identityProbe 不把 PID 单独当作存活证明。 */
function currentIdentity() {
  const boot = Math.floor(Date.now() - os.uptime() * 1000).toString(36);
  const start = Math.floor(Date.now() - process.uptime() * 1000).toString(36);
  return { host: os.hostname(), bootId: boot, pid: process.pid, startIdentity: start };
}

/** 为每个调试会话打开账本；具体资源 handler 注册完成前不执行恢复，避免空 handler 产生假冲突。 */
export async function openAdapterLedger(context: vscode.ExtensionContext | undefined, session: vscode.DebugSession | undefined, mode: 'jvm' | 'native' | 'jvm-native'): Promise<SessionResourceLedger> {
  const root = context?.globalStorageUri?.fsPath;
  if (!root || !path.isAbsolute(root)) throw new Error('Android debugger ledger storage is unavailable');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const owner = currentIdentity();
  const ledger = await SessionResourceLedger.open({
    root,
    sessionId: sessionUuid(session?.id || 'anonymous-session'),
    mode,
    ownerIdentity: owner,
    identityProbe: async identity => {
      if (identity.host === owner.host && identity.bootId === owner.bootId && identity.pid === owner.pid && identity.startIdentity === owner.startIdentity) return 'alive';
      // 非当前宿主的 PID 没有可验证的启动身份；禁止以 PID 存活探测猜测所有权。
      return 'unknown';
    },
  });
  return ledger;
}

/** 在调用方完成本次模式的所有 proof handler 注册后恢复过期资源；冲突和错误必须显式阻止调试启动。 */
export async function reconcileAdapterLedger(ledger: SessionResourceLedger): Promise<void> {
  const reconciliation = await ledger.reconcile();
  if (reconciliation.conflicts.length || reconciliation.errors.length) {
    throw new Error('Android debugger ledger reconciliation is not provably clean');
  }
}

/** 创建仅用于本地目录的严格 proof handler；未登记 marker 时返回 conflict，确保未知所有权失败关闭。 */
export function localDirectoryProof(): { probe: (descriptor: any) => Promise<ResourceProof>; release: (descriptor: any) => Promise<void> } {
  return {
    async probe() { return 'conflict'; },
    async release() { throw new Error('Local directory proof handler is not configured'); },
  };
}
