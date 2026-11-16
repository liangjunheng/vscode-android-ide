import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const bundle=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 模拟用户只复制skill再调用:Agent入口自动探测profile、项目及规则,无需用户填写命令参数。
test('skill bootstrap configures a fresh non-Rust project automatically', async () => {
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'generic workflow 中文 '));
  try {
    const project=path.join(fixture,'web project');
    const copied=path.join(project,'.agents/skills/project-workflow');
    const profile=path.join(fixture,'host profile');
    fs.cpSync(bundle,copied,{recursive:true});
    fs.mkdirSync(path.join(project,'.git'));
    fs.mkdirSync(path.join(project,'src'));
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile,'cordis.patch.yml'),'[]\n');
    const entry=path.join(copied,'harness/bootstrap.mjs');
    const env={...process.env,DSH_PROFILE_DIR:profile};
    const first=spawnSync(process.execPath,[entry],{cwd:path.join(project,'src'),env,encoding:'utf8'});
    assert.equal(first.status,0,first.stderr);
    const result=JSON.parse(first.stdout);
    assert.equal(result.rulesCreated,true);
    assert.equal(result.hostReceiptRequired,true);
    const rules=fs.readFileSync(path.join(project,'AGENTS.md'),'utf8');
    assert.ok(rules.includes('.agents/skills/project-workflow/SKILL.md'));
    assert.ok(!rules.includes('Rust'));
    assert.ok(!rules.includes('lib-core-'));
    const flow=fs.readFileSync(path.join(profile,'cordis.patch.yml'),'utf8').split('\n').find(line=>line.startsWith('- {'));
    const registration=JSON.parse(flow.slice(2)).insert[0];
    const plugin=await import(registration.name);
    let context;
    plugin.apply({systemPrompt:{context(value){context=value;}},workingDirectory:{get(){return project;}},agents:{turnBoundaryOf(){return {openTurnStartSeq:12};}}},registration.config);
    const injected=context.text({agent:{session:{id:'generic-project'}}});
    const receipt=JSON.parse(injected.split('\n')[1]);
    assert.equal(receipt.sessionId,'generic-project');
    assert.equal(receipt.turn,12);
    assert.equal(receipt.files.length,3);
    assert.ok(injected.includes(rules));
    const second=spawnSync(process.execPath,[entry],{cwd:project,env,encoding:'utf8'});
    assert.equal(second.status,0,second.stderr);
    assert.equal(JSON.parse(second.stdout).status,'already-configured');
    assert.equal(fs.readFileSync(path.join(project,'AGENTS.md'),'utf8'),rules);
    fs.writeFileSync(path.join(project,'CLAUDE.md'),'# My framework rules\nUse framework tests.\n');
    fs.unlinkSync(path.join(project,'AGENTS.md'));
    const third=spawnSync(process.execPath,[entry],{cwd:project,env,encoding:'utf8'});
    assert.equal(third.status,0,third.stderr);
    assert.equal(JSON.parse(third.stdout).rulesCreated,false);
    assert.equal(fs.existsSync(path.join(project,'AGENTS.md')),false);
    assert.equal(fs.readFileSync(path.join(project,'CLAUDE.md'),'utf8'),'# My framework rules\nUse framework tests.\n');
  } finally {fs.rmSync(fixture,{recursive:true,force:true});}
});

// 无宿主配置或权限时不能假装自动安装,也不能改写项目规则。
test('unknown host fails without creating files or asking user to run commands', () => {
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'no workflow host '));
  try {
    const env={...process.env};
    delete env.DSH_PROFILE_DIR;
    const result=spawnSync(process.execPath,[path.join(bundle,'harness/bootstrap.mjs')],{cwd:fixture,env,encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/profile is unknown/);
    assert.equal(fs.existsSync(path.join(fixture,'AGENTS.md')),false);
  } finally {fs.rmSync(fixture,{recursive:true,force:true});}
});
