import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

export const name = 'project-workflow-guard';
export const inject = ['systemPrompt', 'workingDirectory', 'agents'];
const skillDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 校验 skill 的必需章节结构，不允许通过零散标题绕过缺失检查。
 * 输入正文、允许的完整标题集合及错误标签；不匹配时抛错。
 * 测试:../test/guard.test.mjs 的章节完整性用例。
 */
function requireSections(text, variants, label) {
  const headings = new Set(text.split(/\r?\n/).map(line => line.trimEnd()));
  if (!variants.some(variant => variant.every(heading => headings.has(heading)))) {
    throw new Error('Missing ' + label + ' sections: no complete supported layout');
  }
}

/** 校验当前文件结构并生成本次读取的哈希与原文；仅证明结构和内容读取，不证明业务门禁。
 * 当前 skill 使用五项门禁，并在正文内包含独立评审规范。
 * 测试:../test/guard.test.mjs 全部用例（结构拒绝、原文哈希、宿主注册及异常传播）。
 */
export function loadWorkflow(root, sessionId, turn, bundle = path.join(root, '.agents/skills/project-workflow')) {
  const roots = ['AGENTS.md', 'CLAUDE.md'].filter(file => fs.existsSync(path.join(root,file)));
  if (!roots.length) throw new Error('No project rules; initialize the workflow first');
  const skillFile = path.relative(root, path.join(bundle, 'SKILL.md'));
  const files = [...roots, skillFile];
  const contents = files.map(file => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (!text.trim()) throw new Error('Empty workflow file: ' + file);
    if (Buffer.byteLength(text, 'utf8') > 128 * 1024) throw new Error('Workflow file too large: ' + file);
    return {file, text, sha256: createHash('sha256').update(text, 'utf8').digest('hex')};
  });
  const skill = contents[roots.length].text;
  const projectRules = contents.slice(0, roots.length).map(entry => '[' + entry.file + ']\n' + entry.text).join('\n');
  if (!/^---\r?\nname: project-workflow\r?\n/m.test(skill) || !/^description: .+/m.test(skill)) throw new Error('Invalid workflow skill metadata');
  requireSections(skill, [
    ['## 强制约束', '## 1. 分析门禁', '## 2. 代码实现门禁', '## 3. 测试与验证门禁', '## 4. 独立评审代码门禁', '## 5. 交付门禁'],
  ], 'workflow');
  const gates = [...skill.matchAll(/^## (\d+)\. ([^\r\n]+)门禁$/gm)]
    .map(match => `${match[1]}. ${match[2]}门禁`);
  const expectedGates = ['分析门禁', '代码实现门禁', '测试与验证门禁', '独立评审代码门禁', '交付门禁'];
  if (JSON.stringify(gates) !== JSON.stringify(expectedGates.map((name, index) => `${index + 1}. ${name}`))) {
    throw new Error('Workflow gates must match the current five-gate layout');
  }
  requireSections(skill, [
    ['### 强制性规则', '### 测试与验证设计强制性规则', '### 代码注释强制性规则', '### 内置评审规范'],
  ], 'workflow rules');
  for (const marker of ['### 内置评审规范', '判断是否为核心逻辑改动', '校验测试与验证结果', '严格遵循代码实现门禁']) {
    if (!skill.includes(marker)) throw new Error('Missing embedded reviewer rule: ' + marker);
  }
  const receipt = {source: 'harness:project-workflow-guard', status: 'checked-and-supplied', receiptId: randomUUID(), sessionId, turn, checkedAt: new Date().toISOString(), files: contents.map(({file, sha256}) => ({file, sha256}))};
  return {receipt, text: '[HOST_WORKFLOW_RECEIPT]\n' + JSON.stringify(receipt) + '\n此宿主回执与下列原文属于本次请求上下文,不证明模型遵从或业务门禁通过。\n[ROOT_RULES]\n' + projectRules + '\n[WORKFLOW_SKILL]\n' + skill};
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
