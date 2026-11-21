import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadWorkflow, apply } from '../harness/guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const names = ['AGENTS.md', 'CLAUDE.md', '.agents/skills/project-workflow/SKILL.md'];

function copyFixture(fixture) {
  for (const name of names) {
    const target = path.join(fixture, name);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(path.join(root, name), target);
  }
}

test('receipt contains current rules and skill content', () => {
  const result = loadWorkflow(root, 'test-session', 5);
  assert.equal(result.receipt.source, 'harness:project-workflow-guard');
  assert.equal(result.receipt.sessionId, 'test-session');
  assert.equal(result.receipt.turn, 5);
  assert.equal(result.receipt.files.length, 3);
  for (const entry of result.receipt.files) {
    const text = fs.readFileSync(path.join(root, entry.file), 'utf8');
    assert.equal(entry.sha256, createHash('sha256').update(text).digest('hex'));
    assert.ok(result.text.includes(text));
  }
});

test('missing or invalid current workflow sections fail closed', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow guard '));
  try {
    copyFixture(fixture);
    const skillPath = path.join(fixture, names[2]);
    const original = fs.readFileSync(skillPath, 'utf8');
    for (const heading of [
      '## 强制约束',
      '## 1. 分析门禁',
      '## 2. 代码实现门禁',
      '## 3. 测试与验证门禁',
      '## 4. 独立评审代码门禁',
      '## 5. 交付门禁',
      '### 强制性规则',
      '### 测试与验证设计强制性规则',
      '### 代码注释强制性规则',
      '### 内置评审规范',
    ]) {
      fs.writeFileSync(skillPath, original.replace(heading, ''));
      assert.throws(() => loadWorkflow(fixture, 's', 1));
      fs.writeFileSync(skillPath, original);
    }
    fs.writeFileSync(skillPath, original.replace('## 1. 分析门禁', '## 2. 分析门禁'));
    assert.throws(() => loadWorkflow(fixture, 's', 1), /workflow sections|gates/);
    fs.writeFileSync(skillPath, original);
    const previous = loadWorkflow(fixture, 's', 1).receipt.files[2].sha256;
    fs.writeFileSync(skillPath, original + '\n当前规则已更新\n');
    assert.notEqual(previous, loadWorkflow(fixture, 's', 1).receipt.files[2].sha256);
  } finally {
    fs.rmSync(fixture, {recursive: true, force: true});
  }
});

test('plugin registers required host context scoped to the project', () => {
  let registered;
  const session = {id: 'test-session'};
  let directorySession;
  let boundarySession;
  const boundary = {openTurnStartSeq: 7, lastTurn: 1};
  apply({
    systemPrompt: {context(value) { registered = value; }},
    workingDirectory: {get(value) { directorySession = value; return root; }},
    agents: {turnBoundaryOf(value) { boundarySession = value; return boundary; }},
  });
  assert.equal(registered.required, true);
  assert.equal(registered.interpolate, false);
  const content = registered.text({agent: {session}});
  const receipt = JSON.parse(content.split('\n')[1]);
  assert.equal(directorySession, session);
  assert.equal(boundarySession, session);
  assert.equal(receipt.sessionId, session.id);
  assert.equal(receipt.turn, 7);
  assert.ok(content.includes('## 5. 交付门禁'));
});
