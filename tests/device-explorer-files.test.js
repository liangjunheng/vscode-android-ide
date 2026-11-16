const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { transformSync } = require('esbuild');
const source = require('node:fs').readFileSync(path.join(__dirname,'../src/deviceExplorerFiles.ts'),'utf8');

// 7字段NUL响应与真实printf协议一致，保留中文/引号/换行，不把错误输出当空目录。
function metadata(remote,kind='file',size=3,target='',directoryLink=false) { return Buffer.from([remote,kind,kind==='directory'?'drwxr-xr-x':'-rw-r--r--',String(size),'1700000000',directoryLink?'1':'0',target,''].join('\0')); }
// 真实TS+原生流mock；每次spawn核对全部argv无NUL并记录stdin实际字节，磁盘仍用真实临时目录。
async function fixture(scenarios=[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'device-explorer-files-test-')), calls=[];
  const spawn = (executable,args,options) => {
    assert.equal(executable,'adb'); assert.equal(options.shell,false); assert.ok(args.every(a=>typeof a==='string'&&!a.includes('\0')));
    assert.deepEqual(Array.from(args.slice(0,4)),['-s','phone','shell','-T']);
    const scenario=scenarios[calls.length]; const child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.stdin=new PassThrough(); child.input=[]; child.stdin.on('data',b=>child.input.push(Buffer.from(b)));
    child.kill=()=>{child.killed=true;return true;}; const record={args,script:args.at(-1),child,scenario};calls.push(record);
    child.finish=()=>{let data=scenario?.data||Buffer.alloc(0);if(record.script.includes('if find / -maxdepth 0')&&!scenario?.rawListing)data=Buffer.concat([Buffer.from('B\0'),data]);child.stdout.end(data);child.stderr.end(scenario?.error||'');child.emit('close',scenario?.code??0);};
    child.stdin.once('finish',()=>{if(scenario?.hang)return;queueMicrotask(()=>{if(!scenario){child.stderr.end('Unexpected mock command');child.stdout.end();child.emit('close',9);}else child.finish();});});return child;
  };
  const module={exports:{}}; const deps={child_process:{spawn},'./sdk':{adbPath:()=> 'adb',sdkRoot:()=>''}};
  vm.runInNewContext(transformSync(source,{loader:'ts',format:'cjs'}).code,{module,exports:module.exports,require:id=>Object.hasOwn(deps,id)?deps[id]:require(id),Buffer,process,AbortController,console});
  const files=new module.exports.DeviceExplorerFiles('phone');
  return {files,calls,directory,Class:module.exports.DeviceExplorerFiles,async close(){for(const c of calls)if(c.scenario?.hang&&!c.child.stdout.writableEnded)c.child.finish();await fs.rm(directory,{recursive:true,force:true});}};
}

// 实际list/stat必须解码完整NUL字段、权限和epoch毫秒，命令中只有设备端printf会生成NUL。
test('stat and list retain special filenames permissions symlink metadata and empty directories',async()=>{
  const name='/sdcard/测试 "a\'\n.txt';const entries=Buffer.concat([metadata(name),metadata('/sdcard/link','symlink',4,'/data',true)]);
  const f=await fixture([{data:metadata(name)},{data:entries},{data:Buffer.alloc(0)}]);
  try {const one=await f.files.stat(name);assert.equal(one.path,name);assert.equal(one.modified,1700000000000);assert.equal(one.permissions,'-rw-r--r--');const list=await f.files.list('/sdcard');assert.equal(list.length,2);assert.equal(list[1].linkTarget,'/data');assert.equal(list[1].directoryLink,true);assert.equal((await f.files.list('/empty')).length,0);assert.match(f.calls[0].script,/printf/);assert.ok(f.calls[0].script.includes("'\"'\"'"));}
  finally{await f.close();}
});

// 不可调试权限、损坏元数据、创建冲突、包列表错误必须拒绝；删除只发送链接路径而非目标。
test('permission creation and malformed metadata errors propagate instead of empty success',async()=>{
  const f=await fixture([{code:1,error:'Permission denied'},{data:Buffer.from('broken')},{code:1,error:'File exists'},{},{code:1,error:'Permission denied'}]);
  try {await assert.rejects(f.files.list('/data/data'),/Permission denied/);await assert.rejects(f.files.stat('/bad'),/Malformed/);await assert.rejects(f.files.create('/existing',false),/File exists/);await f.files.remove('/sdcard/link');assert.ok(f.calls[3].script.endsWith("'/sdcard/link'"));assert.ok(!f.calls[3].script.includes('/data'));await assert.rejects(f.files.listPackages(),/Permission denied/);await assert.rejects(f.files.remove('/'),/root/);await assert.rejects(f.files.stat('/data/../secret'),/Invalid device path/);}
  finally{await f.close();}
});

// run-as与su脚本完整转义，不能将包名/文件名拼成本机命令；所有访问动作使用同一个固定serial。
test('run-as and su apply verified access identity to remote scripts',async()=>{
  const f=await fixture([{data:metadata('/data/data/com.example.app/a')},{data:metadata('/root/a')}]);
  try{await new f.Class('phone',{runAs:'com.example.app'}).stat('/data/data/com.example.app/a');await new f.Class('phone',{su:true}).stat('/root/a');assert.match(f.calls[0].script,/^run-as 'com.example.app' sh -c '/);assert.match(f.calls[1].script,/^su 0 sh -c '/);assert.throws(()=>new f.Class('phone',{runAs:'com.bad;id'}),/Invalid run-as/);}
  finally{await f.close();}
});

// 下载必须等待pipeline磁盘完成才提交，0字节/二进制内容不受编码影响，已有目标不隐式覆盖。
test('pull streams exact binary bytes into an atomic local result',async()=>{
  const content=Buffer.from([0,1,2,13,10,255,0]);const f=await fixture([{data:metadata('/sdcard/a','file',content.length)},{data:content}]);
  try{const target=path.join(f.directory,'binary');const bytes=[];await f.files.pull('/sdcard/a',target,{progress:n=>bytes.push(n)});assert.deepEqual(await fs.readFile(target),content);assert.equal(bytes.at(-1),content.length);assert.deepEqual(await fs.readdir(f.directory),['binary']);await assert.rejects(f.files.pull('/sdcard/a',target),/Destination exists/);assert.equal(f.calls.length,2);}
  finally{await f.close();}
});

// 目录预检发现深层Windows非法项时不写目标，空目录成功保留，不跟随会逃逸的symlink。
test('recursive pull preserves empty directories and rejects unsafe names before writing',async()=>{
  const f=await fixture([{data:metadata('/sdcard/dir','directory',0)},{data:metadata('/sdcard/dir/empty','directory',0)},{data:metadata('/sdcard/dir/empty','directory',0)},{data:Buffer.alloc(0)}]);
  try{const target=path.join(f.directory,'dir');await f.files.pull('/sdcard/dir',target);assert.ok((await fs.stat(path.join(target,'empty'))).isDirectory());assert.deepEqual(await fs.readdir(path.join(target,'empty')),[]);}
  finally{await f.close();}
  const bad=await fixture([{data:metadata('/sdcard/d','directory',0)},{data:metadata('/sdcard/d/CON')}]);
  try{await assert.rejects(bad.files.pull('/sdcard/d',path.join(bad.directory,'target')),/Unsafe local/);assert.deepEqual(await fs.readdir(bad.directory),[]);}
  finally{await bad.close();}
});

// 上传stdin真实二进制及同上下文临时stage，mv与清理成功后才完成；不能仅以adb启动视为成功。
test('push streams bytes and rejects remote overwrite without confirmation',async()=>{
  const f=await fixture([{},{},{},{},{}]);
  try{const content=Buffer.from([0,255,13,10]);const local=path.join(f.directory,'a');await fs.writeFile(local,content);const counts=[];await f.files.push(local,'/sdcard/a',{progress:n=>counts.push(n)});assert.deepEqual(Buffer.concat(f.calls[2].child.input),content);assert.equal(counts.at(-1),content.length);assert.match(f.calls[3].script,/mv -n -T/);assert.match(f.calls[4].script,/rm -rf --/);assert.ok(f.calls.every(c=>!c.script.includes('adb root')));}
  finally{await f.close();}
  const collision=await fixture([{code:1,error:'Destination exists'}]);
  try{const local=path.join(collision.directory,'a');await fs.writeFile(local,'a');await assert.rejects(collision.files.push(local,'/sdcard/a'),/Destination exists/);assert.equal(collision.calls.length,1);}
  finally{await collision.close();}
});

// 取消只发kill并等待close，既不提前resolve也不执行后续步骤；signal监听在所有出口释放。
test('abort waits for child close and never starts followup commands',async()=>{
  const f=await fixture([{hang:true}]);const controller=new AbortController();let settled=false;
  try{const pending=f.files.stat('/sdcard/a',controller.signal);const observed=pending.then(()=>{settled=true;},e=>{settled=true;return e;});controller.abort();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls[0].child.killed,true);assert.equal(settled,false);f.calls[0].child.finish();assert.match(String(await observed),/abort/i);assert.equal(f.calls.length,1);}
  finally{await f.close();}
});
// 目录规模增加不增加ADB往返，设备脚本只含一处批量stat并按128项切批，NUL解码仍完整保留500个名称。
test('directory metadata uses one ADB request and bounded stat batches',async()=>{
  const names=Array.from({length:500},(_,i)=>'/large/file '+i+(i===0?'\nquote\"':'')).map(name=>name.replace('\\n','\n'));
  const f=await fixture([{data:Buffer.concat(names.map(name=>metadata(name)))}]);
  try{const entries=await f.files.list('/large');assert.equal(entries.length,500);assert.equal(f.calls.length,1);assert.equal((f.calls[0].script.match(/stat -c /g)||[]).length,1);assert.ok(f.calls[0].script.includes('[ "$#" -eq 128 ]'));assert.ok(f.calls[0].script.includes('emit_metadata "$@"'));assert.deepEqual(Array.from(entries,e=>e.path),names);}
  finally{await f.close();}
});
// 显式只读真机验证：/system/etc超过128项，前后完整结果逐字段相等且新耗时低于两次旧基线较快值的一半；另断言/system/bin在5秒内完整读完。
// 旧实现/system/bin超过原30秒截止，故基线等价比较选同样跨批次但能在既定截止内结束的目录，不放宽时间/数据断言。
test('read-only device expansion preserves metadata and materially improves latency',{skip:!(process.env.EXPLORER_ADB&&process.env.EXPLORER_DEVICE&&process.env.EXPLORER_BASELINE),timeout:120000},async()=>{
  // 编译真实当前/基线后端，仅注入ADB可执行路径，不替换任何目录实现或输出。
  function backend(text){const module={exports:{}};vm.runInNewContext(transformSync(text,{loader:'ts',format:'cjs'}).code,{module,exports:module.exports,require:id=>id==='./sdk'?{adbPath:()=>process.env.EXPLORER_ADB,sdkRoot:()=>''}:require(id),Buffer,process,AbortController,console});return new module.exports.DeviceExplorerFiles(process.env.EXPLORER_DEVICE);}
  const baseline=backend(await fs.readFile(process.env.EXPLORER_BASELINE,'utf8')),current=backend(source),directory=process.env.EXPLORER_BENCH_DIRECTORY||'/system/etc';
  // 每次调用拥有独立取消截止时间；仅调用list，不创建/删除任何真机数据。
  async function timed(files){const start=performance.now();const entries=await files.list(directory,AbortSignal.timeout(30000));return {ms:performance.now()-start,entries:JSON.parse(JSON.stringify(entries))};}
  const before=await timed(baseline),after=await timed(current),again=await timed(baseline);
  assert.ok(after.entries.length>128);assert.deepEqual(after.entries,before.entries);assert.deepEqual(after.entries,again.entries);
  assert.ok(after.ms<Math.min(before.ms,again.ms)/2,JSON.stringify({before:before.ms,after:after.ms,again:again.ms}));
  console.log(JSON.stringify({directory,count:after.entries.length,beforeMs:Math.round(before.ms),afterMs:Math.round(after.ms),baselineRepeatMs:Math.round(again.ms),speedup:Number((Math.min(before.ms,again.ms)/after.ms).toFixed(1)),metadataEqual:true}));
  const start=performance.now(),large=await current.list('/system/bin',AbortSignal.timeout(5000));
  assert.ok(large.length>128);console.log(JSON.stringify({directory:'/system/bin',count:large.length,optimizedMs:Math.round(performance.now()-start),completedWithinMs:5000}));
  const oldStat=await baseline.stat('/system/bin/sh',AbortSignal.timeout(5000)),newStat=await current.stat('/system/bin/sh',AbortSignal.timeout(5000));
  assert.deepEqual(JSON.parse(JSON.stringify(newStat)),JSON.parse(JSON.stringify(oldStat)));
});

// 原生find协议完整保留任意名称与链接目标，严格检查独立目录链接集合及损坏输出。
test('native directory metadata preserves NUL fields and rejects malformed records',async()=>{
  const name='/dir/a\n\"%name',target='../target\n';
  const data=Buffer.from(['F',name,'-rw-r--r--','3','1700000000.123456789','', '/dir/link','lrwxrwxrwx','8','1700000000',target,'','/dir/link',''].join('\0'));
  const f=await fixture([{data,rawListing:true},{data:Buffer.from('F\0\0'),rawListing:true},{data:Buffer.from('F\0/dir/broken\0'),rawListing:true},{data:Buffer.from('X\0'),rawListing:true}]);
  try{const entries=await f.files.list('/dir');assert.equal(entries.length,2);assert.equal(entries[0].path,name);assert.equal(entries[0].modified,1700000000000);assert.equal(entries[1].linkTarget,target);assert.equal(entries[1].directoryLink,true);assert.equal((await f.files.list('/empty')).length,0);await assert.rejects(f.files.list('/dir'),/Malformed/);await assert.rejects(f.files.list('/dir'),/Invalid device listing format/);}
  finally{await f.close();}
});
