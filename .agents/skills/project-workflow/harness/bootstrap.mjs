import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from './install.mjs';

/** 从当前目录定位项目;不依赖语言或源项目名字。测试:../test/bootstrap.test.mjs。 */
export function findProjectRoot(cwd) {
  let current=path.resolve(cwd);
  while (true) {
    if (['.git','AGENTS.md','CLAUDE.md'].some(file=>fs.existsSync(path.join(current,file)))) return current;
    const parent=path.dirname(current);
    if (parent===current) return path.resolve(cwd);
    current=parent;
  }
}

/** 调用skill后由Agent执行的初始化入口:探测本机profile,保留项目规则,缺规则时仅创建通用入口。测试:../test/bootstrap.test.mjs。 */
export function bootstrap(profile = process.env.DSH_PROFILE_DIR, root = findProjectRoot(process.cwd())) {
  if (!profile) throw new Error('Current host profile is unknown; Agent must detect the supported host, not report success');
  if (!fs.existsSync(path.join(profile,'cordis.patch.yml'))) throw new Error('Harness profile is unavailable; Agent must report setup blocked');
  root=fs.realpathSync(path.resolve(root));
  const bundle=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let rulesCreated=false;
  if (!['AGENTS.md','CLAUDE.md'].some(file=>fs.existsSync(path.join(root,file)))) {
    const relative=path.relative(root,path.join(bundle,'SKILL.md')).split(path.sep).join('/');
    fs.writeFileSync(path.join(root,'AGENTS.md'),'# 项目规则\n\n- 每轮调用并遵守 \u0060'+relative+'\u0060 中的通用工作流。\n- 项目专属约束在本文件维护,不得从其他项目自动植入。\n',{flag:'wx'});
    rulesCreated=true;
  }
  try { return {...install(profile,root), rulesCreated, hostReceiptRequired:true}; }
  catch (error) {
    throw new Error(error.message + (rulesCreated ? '; a generic AGENTS.md entry was created and preserved' : ''));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options={};
    const args=process.argv.slice(2);
    for(let index=0;index<args.length;index+=2) {
      if(!['--profile','--project'].includes(args[index]) || !args[index+1]) throw new Error('Invalid bootstrap options');
      options[args[index]]=args[index+1];
    }
    console.log(JSON.stringify(bootstrap(options['--profile'] ?? process.env.DSH_PROFILE_DIR,options['--project'])));
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
