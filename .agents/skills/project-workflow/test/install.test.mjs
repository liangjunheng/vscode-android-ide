import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(bundle, '../../..');

// 只复制skill目录到含空格和中文的新位置;目标根规则作为已有项目输入,不依赖旧.dsh/.claude目录。
test('copied skill installs, loads and re-installs without old checkout paths', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(),'portable skill 中文 '));
  try {
    const project = path.join(fixture,'new project');
    const copied = path.join(project,'.agents/skills/project-workflow');
    const profile = path.join(fixture,'new profile');
    fs.mkdirSync(profile,{recursive:true});
    fs.cpSync(bundle,copied,{recursive:true});
    for (const name of ['AGENTS.md','CLAUDE.md']) fs.copyFileSync(path.join(root,name),path.join(project,name));
    const patch = path.join(profile,'cordis.patch.yml');
    const original='# existing configuration\n- id: existing\n  name: existing-plugin\n  config:\n    keep: true\n';
    fs.writeFileSync(patch,original);
    const installer = path.join(copied,'harness/install.mjs');
    const first = spawnSync(process.execPath,[installer,'--profile',profile],{cwd:os.tmpdir(),encoding:'utf8'});
    assert.equal(first.status,0,first.stderr);
    const result=JSON.parse(first.stdout);
    assert.equal(result.status,'configured-awaiting-host-receipt');
    assert.equal(fs.readFileSync(result.backup,'utf8'),original);
    const configured=fs.readFileSync(patch,'utf8');
    assert.ok(configured.startsWith(original));
    const flow=configured.split('\n').find(line=>line.startsWith('- {'));
    const entry=JSON.parse(flow.slice(2)).insert[0];
    const expectedUrl=pathToFileURL(path.join(copied,'harness/guard.mjs'));
    expectedUrl.searchParams.set('revision',createHash('sha256').update(fs.readFileSync(path.join(copied,'harness/guard.mjs'))).digest('hex'));
    assert.equal(entry.name,expectedUrl.href);
    assert.equal(entry.config.projectRoot,fs.realpathSync(project));
    assert.ok(!configured.includes(pathToFileURL(path.join(bundle,'harness/guard.mjs')).href));
    const module=await import(entry.name);
    let context;
    const session={id:'portable-session'};
    module.apply({systemPrompt:{context(value){context=value;}},workingDirectory:{get(value){assert.equal(value,session);return project;}},agents:{turnBoundaryOf(){return {openTurnStartSeq:11};}}},entry.config);
    const text=context.text({agent:{session}});
    const receipt=JSON.parse(text.split('\n')[1]);
    assert.equal(receipt.turn,11);
    assert.equal(receipt.sessionId,session.id);
    assert.ok(text.includes(fs.readFileSync(path.join(copied,'SKILL.md'),'utf8')));
    assert.equal(fs.existsSync(path.join(project,'.dsh')),false);
    assert.equal(fs.existsSync(path.join(project,'.claude')),false);
    const second=spawnSync(process.execPath,[installer,'--profile',profile],{encoding:'utf8'});
    assert.equal(second.status,0,second.stderr);
    assert.equal(JSON.parse(second.stdout).status,'already-configured');
    assert.equal(fs.readFileSync(patch,'utf8'),configured);
    fs.unlinkSync(path.join(project,'AGENTS.md'));
    fs.unlinkSync(path.join(project,'CLAUDE.md'));
    const failure=spawnSync(process.execPath,[installer,'--profile',profile],{encoding:'utf8'});
    assert.notEqual(failure.status,0);
    assert.equal(fs.readFileSync(patch,'utf8'),configured);
  } finally { fs.rmSync(fixture,{recursive:true,force:true}); }
});

// 空profile数组可安装;非数组配置拒绝,不得覆盖用户配置。
test('supports empty profiles and refuses unsupported configurations', () => {
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'workflow profile '));
  try {
    const patch=path.join(fixture,'cordis.patch.yml');
    const installer=path.join(bundle,'harness/install.mjs');
    for(const original of ['mapping: true\n','---\n[]\n','[]\ninvalid: true\n']) {
      fs.writeFileSync(patch,original);
      const result=spawnSync(process.execPath,[installer,'--profile',fixture,'--project',root],{encoding:'utf8'});
      assert.notEqual(result.status,0);
      assert.equal(fs.readFileSync(patch,'utf8'),original);
    }
    fs.writeFileSync(patch,'# empty [] example\n[]\n');
    const result=spawnSync(process.execPath,[installer,'--profile',fixture,'--project',root],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.match(fs.readFileSync(patch,'utf8'),/# managed:project-workflow-/);
  } finally { fs.rmSync(fixture,{recursive:true,force:true}); }
});
