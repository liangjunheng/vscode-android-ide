import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

export const name = 'project-workflow-guard';
export const inject = ['systemPrompt', 'workingDirectory', 'agents'];
const skillDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 按完整的新旧章节结构校验正文，不允许用零散标题拼接绕过缺失检查。
 * 输入正文、允许的完整标题集合及错误标签；不匹配时抛错。
 * 测试:../test/guard.test.mjs 的 supported section layouts 与 incomplete layouts。
 */
function requireSections(text, variants, label) {
  const headings = new Set(text.split(/\r?\n/).map(line => line.trimEnd()));
  if (!variants.some(variant => variant.every(heading => headings.has(heading)))) {
    throw new Error('Missing ' + label + ' sections: no complete supported layout');
  }
}

/** 校验当前文件结构并生成本次读取的哈希与原文;仅证明结构和内容读取,不证明业务门禁。
 * 接受完整的新旧章节命名，仍要求九项门禁、有效元数据和独审引用。
 * 测试:../test/guard.test.mjs 全部用例（结构拒绝、原文哈希、宿主注册及异常传播）。
 */
export function loadWorkflow(root, sessionId, turn, bundle = path.join(root, '.agents/skills/project-workflow')) {
  const roots = ['AGENTS.md', 'CLAUDE.md'].filter(file => fs.existsSync(path.join(root,file)));
  if (!roots.length) throw new Error('No project rules; initialize the workflow first');
  const files = [...roots, path.relative(root, path.join(bundle, 'SKILL.md')), path.relative(root, path.join(bundle, 'REVIEWER.md'))];
  const contents = files.map(file => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (!text.trim()) throw new Error('Empty workflow file: ' + file);
    if (Buffer.byteLength(text, 'utf8') > 128 * 1024) throw new Error('Workflow file too large: ' + file);
    return {file, text, sha256: createHash('sha256').update(text, 'utf8').digest('hex')};
  });
  const skill = contents[roots.length].text;
  const reviewer = contents[roots.length + 1].text;
  const projectRules = contents.slice(0, roots.length).map(entry => '[' + entry.file + ']\n' + entry.text).join('\n');
  if (!/^---\r?\nname: project-workflow\r?\n/m.test(skill) || !/^description: .+/m.test(skill)) throw new Error('Invalid workflow skill metadata');
  requireSections(skill, [
    ['## 强制工作流', '### 门禁流程', '### 验证追踪'],
    ['## 自动初始化', '## 门禁', '## 验证追踪'],
  ], 'workflow');
  const gates = [...skill.matchAll(/^(\d)\. \*\*/gm)].map(match => Number(match[1]));
  if (JSON.stringify(gates) !== JSON.stringify([1,2,3,4,5,6,7,8,9])) throw new Error('Workflow gates must be 1..9');
  if (!skill.includes('REVIEWER.md') || skill.includes('.agent-reviewer.md')) throw new Error('Invalid reviewer reference');
  requireSections(reviewer, [
    ['## 角色', '## 输入', '## 必查项', '## 输出', '## 限制'],
    ['## 独立审查协议', '### 角色与输入', '### 必查', '### 输出'],
  ], 'reviewer');
  const receipt = {source: 'harness:project-workflow-guard', status: 'checked-and-supplied', receiptId: randomUUID(), sessionId, turn, checkedAt: new Date().toISOString(), files: contents.map(({file, sha256}) => ({file, sha256}))};
  return {receipt, text: '[HOST_WORKFLOW_RECEIPT]\n' + JSON.stringify(receipt) + '\n此宿主回执与下列原文属于本次请求上下文,不证明模型遵从或业务门禁通过。\n[ROOT_RULES]\n' + projectRules + '\n[WORKFLOW_SKILL]\n' + skill + '\n[REVIEWER_PROTOCOL]\n' + reviewer};
}

/** 注册必需的宿主上下文;只约束本项目及子目录,读取失败抛错而非返回成功。测试:../test/guard.test.mjs。 */
export function apply(ctx, config = {}) {
  const projectRoot = path.resolve(config.projectRoot ?? path.resolve(skillDirectory, '../../..'));
  const identity = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
  ctx.systemPrompt.context({
    name: 'project-workflow:receipt:' + identity, order: 220, required: true, interpolate: false,
    // 宿主每次准备/刷新请求时调用,不沿用可被AI改写的成功文件或历史回执。
    text(context) {
      if (!context.agent) return '';
      const cwd = ctx.workingDirectory.get(context.agent.session);
      const relative = path.relative(projectRoot, path.resolve(cwd));
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return '';
      const boundary = ctx.agents.turnBoundaryOf(context.agent.session);
      return loadWorkflow(projectRoot, context.agent.session.id, boundary.openTurnStartSeq ?? boundary.lastTurn, skillDirectory).text;
    }
  });
}
