import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { loadWorkflow } from './guard.mjs';

/** 将本目录插件注册到指定本机profile,只管理带自身标记的一行JSON/YAML项;不覆盖其他配置。测试:../test/install.test.mjs。 */
export function install(profile, root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')) {
  if (!profile) throw new Error('Specify --profile or DSH_PROFILE_DIR; no global profile is guessed');
  const bundle = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  root = fs.realpathSync(path.resolve(root));
  loadWorkflow(root, 'install-validation', 0, bundle);
  profile = path.resolve(profile);
  const filename = path.join(profile, 'cordis.patch.yml');
  if (!fs.lstatSync(filename).isFile()) throw new Error('Profile patch must be a regular file');
  const before = fs.readFileSync(filename, 'utf8');
  const significant = before.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#'));
  if (significant[0]?.trim() !== '[]' && !significant[0]?.startsWith('- ')) throw new Error('Profile must be a YAML patch array; existing config was not changed');
  if (/^(---|\.\.\.)\s*$/m.test(before)) throw new Error('Multi-document YAML is unsupported; existing config was not changed');
  const id = 'project-workflow-' + createHash('sha256').update(root).digest('hex').slice(0, 16);
  const marker = '# managed:' + id;
  const modulePath=path.join(bundle,'harness/guard.mjs');
  const moduleUrl=pathToFileURL(modulePath);
  moduleUrl.searchParams.set('revision',createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex'));
  const entry = '- ' + JSON.stringify({insert:[{id, name:moduleUrl.href, config:{projectRoot:root}}]});
  const lines = before.split(/\r?\n/);
  const indexes = lines.flatMap((line,index) => line === marker ? [index] : []);
  if (indexes.length > 1) throw new Error('Duplicate workflow markers; existing config was not changed');
  let after;
  if (indexes.length) {
    const index = indexes[0];
    const old = JSON.parse(lines[index + 1]?.slice(2));
    if (old.insert?.length !== 1 || old.insert[0].id !== id) throw new Error('Invalid managed entry; existing config was not changed');
    if (lines[index + 1] === entry) return {status:'already-configured', filename, id};
    lines[index + 1] = entry;
    after = lines.join(before.includes('\r\n') ? '\r\n' : '\n');
  } else {
    if (significant[0]?.trim() === '[]' && significant.length !== 1) throw new Error('Invalid empty patch array');
    const prefix = significant[0]?.trim() === '[]' ? before.replace(/^[ \t]*\[\][ \t]*(?=\r?$)/m, '') : before;
    after = prefix + (prefix.endsWith('\n') ? '' : '\n') + marker + '\n' + entry + '\n';
  }
  // 先保留原配置,再用同目录临时文件替换;成功注册不等于宿主已加载。
  const backup = filename + '.workflow-backup-' + randomUUID();
  fs.writeFileSync(backup, before, {flag:'wx'});
  const temporary = filename + '.workflow-tmp-' + randomUUID();
  try {
    fs.writeFileSync(temporary, after, {flag:'wx', mode:fs.statSync(filename).mode});
    if (fs.readFileSync(filename, 'utf8') !== before) throw new Error('Profile changed during installation; retry after checking it');
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return {status:'configured-awaiting-host-receipt', filename, id, backup};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      if (!['--profile','--project'].includes(args[index]) || !args[index + 1]) throw new Error('Usage: node harness/install.mjs [--profile DIR] [--project DIR]');
      options[args[index]] = args[index + 1];
    }
    console.log(JSON.stringify(install(options['--profile'] ?? process.env.DSH_PROFILE_DIR, options['--project'])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
