import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadWorkflow, apply } from '../harness/guard.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const names = ['AGENTS.md','CLAUDE.md','.agents/skills/project-workflow/SKILL.md','.agents/skills/project-workflow/REVIEWER.md'];

// 检查回执哈希与同次原文一致,每次产生不同请求标识。
test('receipt is generated from current content and includes originals', () => {
  const first = loadWorkflow(root, 'test-session', 5);
  assert.equal(first.receipt.source, 'harness:project-workflow-guard');
  assert.equal(first.receipt.sessionId, 'test-session');
  assert.equal(first.receipt.turn, 5);
  assert.notEqual(first.receipt.receiptId, loadWorkflow(root,'test-session',5).receipt.receiptId);
  for (const entry of first.receipt.files) {
    const text = fs.readFileSync(path.join(root,entry.file),'utf8');
    assert.equal(entry.sha256,createHash('sha256').update(text).digest('hex'));
    assert.ok(first.text.includes(text));
  }
});

// 仅修改隔离夹具,验证缺失、损坏、规则不一致被拒绝,并确认更新后不沿用旧哈希。
test('missing or invalid rules fail and updates invalidate evidence', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(),'workflow guard '));
  try {
    for (const name of names) {
      fs.mkdirSync(path.dirname(path.join(fixture,name)),{recursive:true});
      fs.copyFileSync(path.join(root,name),path.join(fixture,name));
    }
    fs.writeFileSync(path.join(fixture,'AGENTS.md'),'# Project rules\nUse the Node test runner.\n');
    fs.writeFileSync(path.join(fixture,'CLAUDE.md'),'# Additional rules\nKeep public interfaces stable.\n');
    const generic=loadWorkflow(fixture,'s',1);
    assert.ok(generic.text.includes('Use the Node test runner.'));
    assert.ok(generic.text.includes('Keep public interfaces stable.'));
    assert.equal(generic.receipt.files.length,4);
    fs.unlinkSync(path.join(fixture,'CLAUDE.md'));
    assert.equal(loadWorkflow(fixture,'s',1).receipt.files.length,3);
    fs.writeFileSync(path.join(fixture,'CLAUDE.md'),'# Additional rules\nKeep public interfaces stable.\n');
    const previous = loadWorkflow(fixture,'s',1);
    const target = path.join(fixture,names[2]);
    const original = fs.readFileSync(target,'utf8');
    fs.writeFileSync(target,original+'\n规则说明更新\n');
    assert.notEqual(previous.receipt.files[2].sha256,loadWorkflow(fixture,'s',1).receipt.files[2].sha256);
    fs.writeFileSync(target,original.replace('9. **交付**','交付'));
    assert.throws(()=>loadWorkflow(fixture,'s',1),/gates/);
    fs.writeFileSync(target,'x'.repeat(128 * 1024 + 1));
    assert.throws(()=>loadWorkflow(fixture,'s',1),/too large/);
    fs.writeFileSync(target,'');
    assert.throws(()=>loadWorkflow(fixture,'s',1),/Empty/);
    fs.writeFileSync(target,original);
    fs.writeFileSync(path.join(fixture,'CLAUDE.md'),'different');
    assert.ok(loadWorkflow(fixture,'s',1).text.includes('different'));
    fs.copyFileSync(path.join(root,'CLAUDE.md'),path.join(fixture,'CLAUDE.md'));
    fs.unlinkSync(target);
    assert.throws(()=>loadWorkflow(fixture,'s',1),/ENOENT/);
  } finally { fs.rmSync(fixture,{recursive:true,force:true}); }
});

// 隔离正文夹具覆盖新旧完整结构和换行，仍验证原文哈希与九项门禁不可缺失、重复或乱序。
test('supported section layouts preserve receipts and require all nine gates', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow layouts '));
  try {
    for (const name of names) {
      fs.mkdirSync(path.dirname(path.join(fixture, name)), {recursive: true});
      fs.copyFileSync(path.join(root, name), path.join(fixture, name));
    }
    for (const legacy of [false, true]) {
      for (const newline of ['\n', '\r\n']) {
        const headings = legacy
          ? ['## 强制工作流', '### 门禁流程', '### 验证追踪']
          : ['## 自动初始化', '## 门禁', '## 验证追踪'];
        const gates = ['需求', '分析', '测试设计', '实现', '同步', '测试', '验证', '独立审查', '交付']
          .map((name, i) => `${i + 1}. **${name}**：保留对应要求。`);
        const skill = ['---', 'name: project-workflow', 'description: fixture', '---',
          '# 项目强制工作流', ...headings, ...gates, 'REVIEWER.md'].join(newline);
        const reviewer = (legacy
          ? ['## 角色', '## 输入', '## 必查项', '## 输出', '## 限制']
          : ['## 独立审查协议', '### 角色与输入', '### 必查', '### 输出']).join(newline);
        const target = path.join(fixture, names[2]);
        fs.writeFileSync(target, skill);
        fs.writeFileSync(path.join(fixture, names[3]), reviewer);
        const result = loadWorkflow(fixture, 'layout-session', 12);
        assert.ok(result.text.includes(skill));
        assert.ok(result.text.includes(reviewer));
        assert.equal(result.receipt.files[2].sha256, createHash('sha256').update(skill).digest('hex'));
        for (const gate of gates) {
          fs.writeFileSync(target, skill.replace(gate, ''));
          assert.throws(() => loadWorkflow(fixture, 's', 1), /gates/);
        }
        for (const broken of [
          skill + newline + gates[0],
          skill.replace(gates[0] + newline + gates[1], gates[1] + newline + gates[0]),
        ]) {
          fs.writeFileSync(target, broken);
          assert.throws(() => loadWorkflow(fixture, 's', 1), /gates/);
        }
        for (const heading of headings) {
          fs.writeFileSync(target, skill.replace(heading, ''));
          assert.throws(() => loadWorkflow(fixture, 's', 1), /workflow sections/);
        }
        fs.writeFileSync(target, skill);
        for (const heading of reviewer.split(newline)) {
          fs.writeFileSync(path.join(fixture, names[3]), reviewer.replace(heading, ''));
          assert.throws(() => loadWorkflow(fixture, 's', 1), /reviewer sections/);
        }
        fs.writeFileSync(path.join(fixture, names[3]), reviewer);
      }
    }
  } finally { fs.rmSync(fixture, {recursive: true, force: true}); }
});

// 完整章节缺任一项、伪装标题和新旧混搭都失败；不通过放宽匹配来解决兼容性。
test('incomplete layouts and non-heading text fail closed', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow missing sections '));
  try {
    for (const name of names) {
      fs.mkdirSync(path.dirname(path.join(fixture, name)), {recursive: true});
      fs.copyFileSync(path.join(root, name), path.join(fixture, name));
    }
    const skillPath = path.join(fixture, names[2]);
    const reviewerPath = path.join(fixture, names[3]);
    const skill = fs.readFileSync(skillPath, 'utf8');
    const reviewer = fs.readFileSync(reviewerPath, 'utf8');
    const layouts = [
      {target: skillPath, original: skill, headings: ['## 自动初始化', '## 门禁', '## 验证追踪'], label: /workflow sections/},
      {target: reviewerPath, original: reviewer, headings: ['## 独立审查协议', '### 角色与输入', '### 必查', '### 输出'], label: /reviewer sections/},
    ];
    for (const {target, original, headings, label} of layouts) {
      for (const heading of headings) {
        for (const replacement of ['', 'text mentions ' + heading]) {
          fs.writeFileSync(target, original.replace(heading, replacement));
          assert.throws(() => loadWorkflow(fixture, 's', 1), label);
        }
        fs.writeFileSync(target, original);
      }
    }
    fs.writeFileSync(skillPath, skill.replace('## 门禁', '### 门禁流程'));
    assert.throws(() => loadWorkflow(fixture, 's', 1), /workflow sections/);
    fs.writeFileSync(skillPath, skill);
    fs.writeFileSync(reviewerPath, reviewer.replace('### 必查', '## 必查项'));
    assert.throws(() => loadWorkflow(fixture, 's', 1), /reviewer sections/);
  } finally { fs.rmSync(fixture, {recursive: true, force: true}); }
});

// 原生注册约定检查:必需上下文不可被普通抑制,本项目外返回空内容。
test('plugin registers required host context scoped to the project', (t) => {
  let registered;
  const session = {id:'test-session'};
  let cwd = root;
  let directorySession;
  let boundarySession;
  let boundary = {openTurnStartSeq:7,lastTurn:1};
  apply({systemPrompt:{context(value){ registered=value; }},workingDirectory:{get(value){directorySession=value;return cwd;}},agents:{turnBoundaryOf(value){boundarySession=value;return boundary;}}});
  assert.equal(registered.required,true);
  assert.equal(registered.interpolate,false);
  const content = registered.text({agent:{session}});
  const receipt = JSON.parse(content.split('\n')[1]);
  assert.equal(directorySession,session);
  assert.equal(boundarySession,session);
  assert.equal(receipt.sessionId,session.id);
  assert.equal(receipt.turn,7);
  for (const entry of receipt.files) {
    const text=fs.readFileSync(path.join(root,entry.file),'utf8');
    assert.equal(entry.sha256,createHash('sha256').update(text).digest('hex'));
    assert.ok(content.includes(text));
  }
  boundary={openTurnStartSeq:null,lastTurn:3};
  assert.equal(JSON.parse(registered.text({agent:{session}}).split('\n')[1]).turn,3);
  const failure = t.mock.method(fs,'readFileSync',()=>{throw new Error('simulated missing workflow');});
  try { assert.throws(()=>registered.text({agent:{session}}),/simulated missing workflow/); }
  finally { failure.mock.restore(); }
  cwd=path.dirname(root);
  assert.equal(registered.text({agent:{session}}),'');
  assert.equal(registered.text({}),'');
});
