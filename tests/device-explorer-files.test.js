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
// Node>=22 VM+原生流mock，执行node --test tests/device-explorer-files.test.js；核对argv无NUL、编码后的线路字节及CLI文本转换后的远端解码字节，磁盘使用真实隔离目录。
async function fixture(scenarios=[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'device-explorer-files-test-')), calls=[];
  const spawn = (executable,args,options) => {
    assert.equal(executable,'adb'); assert.equal(options.shell,false); assert.ok(args.every(a=>typeof a==='string'&&!a.includes('\0')));
    assert.deepEqual(Array.from(args.slice(0,4)),['-s','phone','shell','-T']);
    const scenario=scenarios[calls.length]; const child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.stdin=new PassThrough(); child.input=[]; child.stdin.on('data',b=>child.input.push(Buffer.from(b)));
    child.kill=()=>{child.killed=true;return true;}; const record={args,script:args.at(-1),child,scenario};calls.push(record);
    child.finish=()=>{
      let data=scenario?.data||Buffer.alloc(0);
      if(!scenario?.rawListing&&record.script.includes("printf 'F\\0'"))data=Buffer.concat([Buffer.from('F\0'),data]);
      const encoded=data.toString('base64').match(/.{1,76}/g)?.join('\n')||'';
      const wire=scenario?.wire===undefined?Buffer.from(encoded.replace(/\n/g,'\r\n')):Buffer.from(scenario.wire);
      const chunks=scenario?.wireChunks||[wire];
      for(const chunk of chunks)child.stdout.write(chunk);
      child.stdout.end();child.stderr.end(scenario?.error||'');child.emit('close',scenario?.code??0);
    };
    child.stdin.once('finish',()=>{
      const text=Buffer.concat(child.input).toString('latin1').replace(/\r\n/g,'\n').split('\x1a')[0];
      record.remoteInput=record.script.includes('base64 -d |')?Buffer.from(text,'base64'):Buffer.from(text,'latin1');
      if(scenario?.hang)return;
      queueMicrotask(()=>{if(!scenario){child.stderr.end('Unexpected mock command');child.stdout.end();child.emit('close',9);}else child.finish();});
    });return child;
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
  try {const one=await f.files.stat(name);assert.equal(one.path,name);assert.equal(one.modified,1700000000000);assert.equal(one.permissions,'-rw-r--r--');const list=await f.files.list('/sdcard');assert.equal(list.length,2);assert.equal(list[1].linkTarget,'/data');assert.equal(list[1].directoryLink,true);assert.equal((await f.files.list('/empty')).length,0);assert.match(f.calls[0].script,/printf/);assert.ok(f.calls[0].script.includes("'\"'\"'"));assert.match(f.calls[1].script,/printf 'F\\0'/);assert.equal(f.calls[2].script.includes('find -H'),false);}
  finally{await f.close();}
});

// 不可调试权限、损坏元数据、创建冲突、包列表错误必须拒绝；删除只发送链接路径而非目标。
test('permission creation and malformed metadata errors propagate instead of empty success',async()=>{
  const f=await fixture([{code:1,error:'Permission denied'},{data:Buffer.from('broken')},{code:1,error:'File exists'},{},{code:1,error:'Permission denied'}]);
  try {await assert.rejects(f.files.list('/data/data'),/Permission denied/);await assert.rejects(f.files.stat('/bad'),/Malformed/);await assert.rejects(f.files.create('/existing',false),/File exists/);await f.files.remove('/sdcard/link');assert.ok(f.calls[3].script.includes("rm -rf -- '/sdcard/link'"));assert.ok(!f.calls[3].script.includes('/data'));await assert.rejects(f.files.listPackages(),/Permission denied/);await assert.rejects(f.files.remove('/'),/root/);await assert.rejects(f.files.stat('/data/../secret'),/Invalid device path/);}
  finally{await f.close();}
});

// Node>=22模拟包列表响应，核验单段/多段及空列表；非法内容、权限失败和取消必须拒绝，取消不得启动ADB。
test('package listing accepts single segment system packages and rejects malformed output', async () => {
  const invalid = ['package:', 'package:com..app', 'package:com.example;id', 'Permission denied', 'package:com.example app'];
  const f = await fixture([{ data: Buffer.from('package:android\r\npackage:com.example.app\r\npackage:com.mediatek\r\n') }, {}, ...invalid.map(text => ({ data: Buffer.from(text + '\n') })), { code: 1, error: 'Permission denied' }]);
  try {
    assert.deepEqual(Array.from(await f.files.listPackages()), ['android', 'com.example.app', 'com.mediatek']);
    assert.deepEqual(Array.from(await f.files.listPackages()), []);
    for (const text of invalid) { await assert.rejects(f.files.listPackages(), /Invalid package manager response/, text); }
    await assert.rejects(f.files.listPackages(), /Permission denied/);
    const cancelled = new AbortController(); cancelled.abort();
    const count = f.calls.length; await assert.rejects(f.files.listPackages(cancelled.signal), /abort/i); assert.equal(f.calls.length, count);
  } finally { await f.close(); }
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
  try{const content=Buffer.from([0,255,13,10]);const local=path.join(f.directory,'a');await fs.writeFile(local,content);const counts=[];await f.files.push(local,'/sdcard/a',{progress:n=>counts.push(n)});assert.deepEqual(f.calls[2].remoteInput,content);assert.equal(Buffer.concat(f.calls[2].child.input).toString(),content.toString('base64'));assert.equal(counts.at(-1),content.length);assert.match(f.calls[3].script,/mv -n -T/);assert.match(f.calls[4].script,/rm -rf --/);assert.ok(f.calls.every(c=>!c.script.includes('adb root')));}
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
// 目录规模增加不增加ADB往返，设备脚本用当前层glob和批量stat，NUL解码仍完整保留500个名称且不递归find。
// 当前层glob即使设备stderr报告受限路径，也不把已返回的直接子项伪装成空目录；Node>=22回归断言非递归协议和完整解析。
test('directory listing ignores unrelated find permission noise', async () => {
  const f = await fixture([{ data: metadata('/system/bin/sh'), error: "find: '/cache': Permission denied\nfind: '/data_mirror': Permission denied" }]);
  try { const entries = await f.files.list('/system/bin'); assert.deepEqual(Array.from(entries, entry => entry.path), ['/system/bin/sh']); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].script.includes('find -H'), false); }
  finally { await f.close(); }
});

test('directory metadata uses one ADB request and bounded stat batches',async()=>{
  const names=Array.from({length:500},(_,i)=>'/large/file '+i+(i===0?'\nquote\"':'')).map(name=>name.replace('\\n','\n'));
  const f=await fixture([{data:Buffer.concat(names.map(name=>metadata(name)))}]);
  try{const entries=await f.files.list('/large');assert.equal(entries.length,500);assert.equal(f.calls.length,1);assert.ok((f.calls[0].script.match(/stat -c /g)||[]).length>=1);assert.ok(f.calls[0].script.includes('for p in'));assert.equal(f.calls[0].script.includes('find -H'),false);assert.deepEqual(Array.from(entries,e=>e.path),names);}
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


// Node>=22 VM+原生流/CLI文本转换：输入跨3字节、输出跨4字符边界分别断言，不用roundtrip互相抵消CRLF损坏。
test('binary shell transport preserves all byte values across arbitrary chunks and text-mode CLI',async()=>{
  const {Readable,Writable}=require('node:stream');
  const content=Buffer.concat([Buffer.from(Array.from({length:256},(_,i)=>i)),Buffer.from([0,255,13,10,13,10,26,0,13,65,10])]);
  const wire=Buffer.from(content.toString('base64').match(/.{1,76}/g).join('\r\n'));
  for(const width of [1,2,3,4,5,17,79]){
    const wireChunks=[];for(let i=0;i<wire.length;i+=width)wireChunks.push(wire.subarray(i,i+width));
    const f=await fixture([{wireChunks},{}]);
    try{
      const counts=[],chunks=[];
      await f.files.run('printf binary',{output:new Writable({highWaterMark:1,write(chunk,encoding,callback){chunks.push(Buffer.from(chunk));setImmediate(callback);}}),progress:n=>counts.push(n)});
      assert.deepEqual(Buffer.concat(chunks),content);assert.equal(counts.at(-1),content.length);assert.ok(counts.every((n,i)=>i===0||n>=counts[i-1]));
      const inputChunks=[];for(let i=0;i<content.length;i+=width)inputChunks.push(content.subarray(i,i+width));
      const sent=[];await f.files.run('cat > isolated-stage',{input:Readable.from(inputChunks),progress:n=>sent.push(n)});
      assert.deepEqual(f.calls[1].remoteInput,content);assert.equal(sent.at(-1),content.length);
      assert.equal(Buffer.concat(f.calls[1].child.input).toString(),content.toString('base64'));
      assert.match(f.calls[1].script,/^set -o pipefail; base64 -d \| \{/);assert.match(f.calls[0].script,/\} \| base64$/);
    }finally{await f.close();}
  }
});

// 非ASCII、截断、缺padding、错误位置、非零padding位与padding后新数据都必须拒绝；空输出及合法折行可接受。
test('strict base64 output rejects invalid padding truncated and noncanonical data',async()=>{
  const invalid=['A','AA','AAA','A===','AA=A','AA==AA==','AB==','AAB=','AAAA=','AA==A','AA==\r\nAAAA','AA== ','!AAA',Buffer.from([0xc1,65,65,65])];
  for(const wire of invalid){const f=await fixture([{wire}]);try{await assert.rejects(f.files.run('printf bad'),/base64/i);assert.equal(f.calls[0].child.stdout.destroyed,true);}finally{await f.close();}}
  const f=await fixture([{wireChunks:[Buffer.from('AA=='),Buffer.from('\r\n'),Buffer.from('AAAA')]},{wire:'AA==\r\n'},{wire:''}]);
  try{await assert.rejects(f.files.run('printf bad'),/base64/);assert.deepEqual(await f.files.run('printf nul'),Buffer.from([0]));assert.equal((await f.files.run(':')).length,0);}finally{await f.close();}
});

// 远端各管线失败保持独立stderr；16MiB按解码后字节计；挂起输入取消后等close、销毁双方流并释放AbortSignal监听。
test('shell transport preserves remote errors metadata limits and cancellation',async()=>{
  const {Readable,Writable}=require('node:stream'),{getEventListeners}=require('node:events');
  for(const part of ['decoder','script','encoder']){const f=await fixture([{code:37,error:part+' failed'}]);try{await assert.rejects(f.files.run('false'),new RegExp(part+' failed'));assert.match(f.calls[0].script,/set -o pipefail/);}finally{await f.close();}}
  const limit=16*1024*1024;const f=await fixture([{data:Buffer.alloc(limit)},{data:Buffer.alloc(limit+1)}]);
  try{assert.equal((await f.files.run('printf large')).length,limit);await assert.rejects(f.files.run('printf overflow'),/metadata exceeds output limit/);}finally{await f.close();}
  const hanging=await fixture([{hang:true}]),controller=new AbortController(),input=new PassThrough(),output=new PassThrough();let settled=false;
  try{
    const pending=hanging.files.run('cat',{signal:controller.signal,input,output}).then(()=>{settled=true;},error=>{settled=true;return error;});
    input.write(Buffer.from([0,255,13,10]));controller.abort();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false);assert.equal(hanging.calls[0].child.killed,true);assert.equal(input.destroyed,true);assert.equal(output.destroyed,true);
    hanging.calls[0].child.finish();assert.match(String(await pending),/abort/i);assert.equal(getEventListeners(controller.signal,'abort').length,0);
  }finally{await hanging.close();}
  const failed=await fixture([{data:Buffer.from('a')}]);try{await assert.rejects(failed.files.run('printf a',{output:new Writable({write(chunk,encoding,callback){callback(new Error('disk full'));}})}),/disk full/);}finally{await failed.close();}
});

// 大块输出经慢Writable形成背压；传输/解码失败清理拥有stage，已存在目标不会被部分结果覆盖。
test('large binary streams honor backpressure and failed transfers clean staging without replacing targets',async()=>{
  const {Readable,Writable}=require('node:stream');
  const content=Buffer.alloc(1024*1024+5);for(let i=0;i<content.length;i++)content[i]=i%256;
  const wire=Buffer.from(content.toString('base64')),wireChunks=[];for(let i=0;i<wire.length;i+=65537)wireChunks.push(wire.subarray(i,i+65537));
  const f=await fixture([{wireChunks},{}]);
  try{const chunks=[],counts=[];let completed=false;const sink=new Writable({highWaterMark:17,write(chunk,encoding,callback){chunks.push(Buffer.from(chunk));setImmediate(callback);},final(callback){completed=true;callback();}});
    await f.files.run('cat large',{output:sink,progress:n=>counts.push(n)});assert.equal(completed,true);assert.deepEqual(Buffer.concat(chunks),content);assert.equal(counts.at(-1),content.length);
    const parts=[];for(let i=0;i<content.length;i+=65535)parts.push(content.subarray(i,i+65535));await f.files.run('cat > stage',{input:Readable.from(parts)});assert.deepEqual(f.calls[1].remoteInput,content);
  }finally{await f.close();}
  const pull=await fixture([{data:metadata('/remote/a')},{wire:'AB=='}]);
  try{const target=path.join(pull.directory,'target');await fs.writeFile(target,'original');await assert.rejects(pull.files.pull('/remote/a',target,{overwrite:true}),/base64/);assert.equal(await fs.readFile(target,'utf8'),'original');assert.deepEqual(await fs.readdir(pull.directory),['target']);}finally{await pull.close();}
  const push=await fixture([{},{},{code:31,error:'decoder failed'},{}]);
  try{const input=path.join(push.directory,'input');await fs.writeFile(input,content);await assert.rejects(push.files.push(input,'/remote/result'),/decoder failed/);assert.equal(push.calls.length,4);assert.match(push.calls[3].script,/rm -rf --/);assert.equal(push.calls.some(c=>c.script.includes('mv -')),false);}finally{await push.close();}
  const emptyError=await fixture([{code:37}]);try{await assert.rejects(emptyError.files.run('exit 37'),/ADB shell exited 37/);}finally{await emptyError.close();}
});

// Node>=22显式真机回归：设置EXPLORER_ADB为adb可执行路径、EXPLORER_DEVICE为设备串号后执行node --test tests/device-explorer-files.test.js；未设置时按现有opt-in模式跳过。
// mkdir拥有的UUID目录，上传全字节后独立wc/stat/sha256核对，下载远端printf生成已知数据，再list/remove/refresh；清理前严格核对绝对路径归属。
test('opt-in device toolbar transfers preserve independent byte counts hashes and refresh results',{skip:!(process.env.EXPLORER_ADB&&process.env.EXPLORER_DEVICE),timeout:60000},async()=>{
  const {randomUUID,createHash}=require('node:crypto'),{promisify}=require('node:util'),execFile=promisify(require('node:child_process').execFile);
  const module={exports:{}};vm.runInNewContext(transformSync(source,{loader:'ts',format:'cjs'}).code,{module,exports:module.exports,require:id=>id==='./sdk'?{adbPath:()=>process.env.EXPLORER_ADB,sdkRoot:()=>''}:require(id),Buffer,process,AbortController,console});
  const files=new module.exports.DeviceExplorerFiles(process.env.EXPLORER_DEVICE),id=randomUUID(),root='/data/local/tmp/explorer-toolbar-'+id;
  const local=await fs.mkdtemp(path.join(os.tmpdir(),'explorer-toolbar-'+id+'-'));let owned=false;
  // 独立文本控制命令不经过push/pull，避免同一传输错误在往返中抵消。
  async function control(script){const result=await execFile(process.env.EXPLORER_ADB,['-s',process.env.EXPLORER_DEVICE,'shell','-T',script],{timeout:10000,windowsHide:true});return result.stdout.trim();}
  try{
    await files.create(root,true,AbortSignal.timeout(10000));owned=true;
    await files.create(root+'/empty',true,AbortSignal.timeout(10000));
    const content=Buffer.concat([Buffer.from(Array.from({length:256},(_,i)=>i)),Buffer.from([0,255,13,10,13,65,10,26,0])]);
    const input=path.join(local,'input.bin');await fs.writeFile(input,content);const progress=[];
    await files.push(input,root+'/uploaded.bin',{signal:AbortSignal.timeout(10000),progress:n=>progress.push(n)});
    assert.equal(progress.at(-1),content.length);assert.equal((await files.stat(root+'/uploaded.bin',AbortSignal.timeout(10000))).size,content.length);
    assert.equal(Number(await control("wc -c < '"+root+"/uploaded.bin'")),content.length);
    const expectedHash=createHash('sha256').update(content).digest('hex');
    assert.equal((await control("sha256sum '"+root+"/uploaded.bin'")).split(/\s+/)[0],expectedHash);
    const known=Buffer.from([0,255,13,10,65,66,0,100]);
    await control("printf '\\000\\377\\015\\012AB\\000d' > '"+root+"/known.bin'");
    const output=path.join(local,'output.bin'),received=[];await files.pull(root+'/known.bin',output,{signal:AbortSignal.timeout(10000),progress:n=>received.push(n)});
    assert.deepEqual(await fs.readFile(output),known);assert.equal(received.at(-1),known.length);
    assert.deepEqual(Array.from(await files.list(root,AbortSignal.timeout(10000)),entry=>entry.name).sort(),['empty','known.bin','uploaded.bin']);
    await files.remove(root+'/uploaded.bin',AbortSignal.timeout(10000));
    assert.deepEqual(Array.from(await files.list(root,AbortSignal.timeout(10000)),entry=>entry.name).sort(),['empty','known.bin']);
    console.log(JSON.stringify({device:process.env.EXPLORER_DEVICE,uploadedBytes:content.length,remoteSha256:expectedHash,independentDownloadBytes:known.length,refreshedAfterDelete:true}));
  }finally{
    try{if(owned){assert.equal(root,'/data/local/tmp/explorer-toolbar-'+id);assert.equal(path.posix.dirname(root),'/data/local/tmp');assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);await files.remove(root,AbortSignal.timeout(10000));assert.equal(await control("if [ -e '"+root+"' ] || [ -L '"+root+"' ]; then exit 1; fi"),'');}}
    finally{assert.equal(path.dirname(local),os.tmpdir());assert.ok(path.basename(local).startsWith('explorer-toolbar-'+id+'-'));await fs.rm(local,{recursive:true,force:true});}
  }
});

// 每次目录读取都执行权限检查；不存在目录失败不污染后续合法目录读取，统一协议不含能力探测。
test('directory listing preserves permission checks and failures',async()=>{
  const f=await fixture([{data:metadata('/ok/file')},{code:1,error:'Permission denied'},{data:metadata('/ok2/file')}]);
  try{await f.files.list('/ok');await assert.rejects(f.files.list('/missing'),/Permission denied/);await f.files.list('/ok2');assert.equal(f.calls.length,3);assert.ok(f.calls[1].script.includes('[ -d'));assert.ok(f.calls[2].script.includes('[ -d'));assert.equal(f.calls[1].script.includes('find -H'),false);}
  finally{await f.close();}
});

// 统一FileEntry协议严格拒绝残缺字段并保留任意文件名、符号链接目标和目录链接标记。
test('directory entry protocol preserves NUL fields and rejects malformed records',async()=>{
  const name='/dir/a\n\"%name',target='../target\n';
  const data=Buffer.from([name,'file','-rw-r--r--','3','1700000000','0','', '/dir/link','symlink','lrwxrwxrwx','8','1700000000','1',target,''].join('\0'));
  const f=await fixture([{data},{data:Buffer.from('')},{data:Buffer.from('/dir/broken\0file')},{data:Buffer.from('X\0')}]);
  try{const entries=await f.files.list('/dir');assert.equal(entries.length,2);assert.equal(entries[0].path,name);assert.equal(entries[0].modified,1700000000000);assert.equal(entries[1].linkTarget,target);assert.equal(entries[1].directoryLink,true);assert.equal((await f.files.list('/empty')).length,0);await assert.rejects(f.files.list('/dir'),/Malformed/);await assert.rejects(f.files.list('/dir'),/Malformed/);}
  finally{await f.close();}
});
