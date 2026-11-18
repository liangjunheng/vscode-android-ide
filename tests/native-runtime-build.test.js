const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { transformSync } = require('esbuild');
const source = sync.readFileSync(path.join(__dirname, '../scripts/build-native-runtime.mjs'), 'utf8');
const base = path.resolve(__dirname, '../.test-artifacts/android-debugger/native-build/tests');

/** 以真实模块边界替换 fetch/spawn，不给生产增加测试 API；所有临时产物均在 E 工作区。 */
function load({ fetch: fetchMock, spawn: spawnMock, files: filesMock } = {}) {
  const module = { exports: {} };
  const code = transformSync(source.replaceAll('import.meta.url', JSON.stringify(require('node:url').pathToFileURL(path.resolve(__dirname, '../scripts/build-native-runtime.mjs')).href)), { format: 'cjs', platform: 'node', target: 'node22' }).code;
  vm.runInNewContext(code, { module, exports: module.exports, require(id) { if (id === 'node:fs/promises' && filesMock) return { ...require(id), ...filesMock }; return id === 'node:child_process' && spawnMock ? { spawn: spawnMock } : require(id); }, process: { ...process, argv: [] }, Buffer, URL, AbortSignal, fetch: fetchMock || fetch, console, setTimeout, clearTimeout });
  return module.exports;
}

/** 建立独立测试目录并总是清理；测试数据不作为真实 LLVM 产物发布。 */
async function fixture(fn) {
  await fs.mkdir(base, { recursive: true }); const dir = await fs.mkdtemp(path.join(base, 'case-'));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

// 映射 digest/acquire：已知 abc 摘要、跨块大文件摘要均严格匹配，错误 LLVM 哈希先于任何 tar/spawn。
test('archive hash gate verifies actual bytes before extraction', async () => fixture(async dir => {
  const calls = []; const api = load({ spawn() { calls.push(true); throw new Error('must not extract'); } });
  const file = path.join(dir, 'abc'); await fs.writeFile(file, 'abc');
  assert.equal(await api.digest(file), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const big = Buffer.alloc(1024 * 1024 + 43, 17); await fs.writeFile(file, big); assert.equal(await api.digest(file), crypto.createHash('sha256').update(big).digest('hex'));
  await fs.mkdir(path.join(dir, 'archives')); await fs.writeFile(path.join(dir, 'archives', 'llvm.tar.xz'), 'wrong');
  await assert.rejects(api.acquire({ name:'llvm', archive:'llvm.tar.xz', sha256:api.LLVM_SHA256 }, dir, {}, {tar:'tar'}), /mismatch before extraction/);
  assert.equal(calls.length, 0); assert.equal(sync.existsSync(path.join(dir, 'src')), false);
}));

// 映射 acquire：解包选择必需源树，拒绝不完整目录，保留 Android 与 formatter 源码。
test('verified extraction selects required projects and rejects partial directories', async()=>fixture(async dir=>{
 const calls=[];const api=load({spawn(command,args){calls.push(args);const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();queueMicrotask(()=>{if(args[0]==='-tf')child.stdout.write('llvm-project-20.1.8.src/llvm/CMakeLists.txt\n');child.emit('close',0,null);});return child;}});
 await fs.mkdir(path.join(dir,'archives'));await fs.writeFile(path.join(dir,'archives/source'),'abc');
 const pin={name:'llvm',archive:'source',sha256:'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'};
 const result=await api.acquire(pin,dir,{}, {tar:'tar'});const args=calls[1];
 for(const project of ['llvm','clang','lldb','cmake','third-party']) assert.ok(args.includes('llvm-project-20.1.8.src/'+project));
 assert.ok(args.includes('--exclude=*/test/*'));assert.ok(args.includes('--exclude=*/unittests/*'));assert.ok(!args.some(a=>/exclude=.*(?:Android|DataFormatters)/.test(a)));
 assert.ok(sync.existsSync(path.join(result.source,'.verified-extraction.json')));
 await fs.rm(path.join(result.source,'.verified-extraction.json'));await assert.rejects(api.acquire(pin,dir,{}, {tar:'tar'}),/incomplete source extraction/);assert.equal(calls.length,2);
}));

// 映射 acquire/download：302 可到 HTTPS，禁止降级 HTTP、无限重定向、HTTP 错误且不执行 tar。
test('download handles bounded validated HTTPS redirects', async () => fixture(async dir => {
  let urls = []; const api = load({ fetch: async url => { urls.push(url); return new Response(null, {status:302,headers:{location:'http://insecure.test/source'}}); }, spawn() { throw new Error('not reached'); } });
  await assert.rejects(api.acquire({name:'x',url:'https://official.test/a',archive:'a',sha256:'0'.repeat(64)}, dir, {}, {}), /requires HTTPS/);
  assert.equal(urls.length,1);
  urls=[]; const loop = load({ fetch: async url => {urls.push(url);return new Response(null,{status:302,headers:{location:'https://official.test/next'}});} });
  await assert.rejects(loop.acquire({name:'x',url:'https://official.test/a',archive:'a',sha256:'0'.repeat(64)}, dir, {}, {}), /excessive/); assert.equal(urls.length,6);
  const good = load({fetch:async url => url.endsWith('/a') ? new Response(null,{status:302,headers:{location:'https://assets.test/b'}}) : new Response('verified bytes')});
  await assert.rejects(good.acquire({name:'x',url:'https://official.test/a',archive:'good',sha256:'0'.repeat(64)}, dir, {}, {}), /mismatch before extraction/);
  assert.equal(await fs.readFile(path.join(dir,'archives/good'),'utf8'),'verified bytes');
}));

// 映射 assertScopedPath：精确父目录、同目录、其他卷及 NUL 失败，合法子目录成功。
test('safe directories reject exact parent root and outside paths', () => {
  const api=load(); const root=path.resolve(base,'dir');
  for(const p of [root,path.dirname(root),path.join(root,'../outside'),'C:/outside',root+'\0']) assert.throws(()=>api.assertScopedPath(p,'path',root));
  assert.equal(api.assertScopedPath(path.join(root,'inside'),'path',root),path.join(root,'inside'));
});

// 映射 configureArgs：固定禁用所有解释器/网络依赖，不误禁用 liblldb、Android plugin、formatter，强制静态压缩和资源限额。
test('configure argv preserves static compression and no Python runtime deterministically', () => {
  const api=load(), deps={zlib:{include:'E:/z/include',library:'E:/z/zs.lib'},zstd:{include:'E:/s/include',library:'E:/s/zstd_static.lib'},lzma:{include:'E:/l/include',library:'E:/l/lzma.lib'}};
  const args=api.configureArgs('E:/src/llvm','E:/build','E:/install',deps);
  assert.deepEqual(Array.from(args),Array.from(api.configureArgs('E:/src/llvm','E:/build','E:/install',deps)));
  for(const flag of ['-DLLDB_ENABLE_PYTHON=OFF','-DLLDB_ENABLE_LUA=OFF','-DLLDB_ENABLE_SWIG=OFF','-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded','-DLLVM_ENABLE_ZLIB=FORCE_ON','-DLLVM_ENABLE_ZSTD=FORCE_ON','-DLLDB_ENABLE_LZMA=ON','-DLLVM_PARALLEL_COMPILE_JOBS=2','-DLLVM_PARALLEL_LINK_JOBS=1','-DZLIB_LIBRARY=E:/z/zs.lib','-Dzstd_STATIC_LIBRARY=E:/s/zstd_static.lib','-DLIBLZMA_LIBRARY=E:/l/lzma.lib']) assert.ok(args.includes(flag),flag);
  assert.ok(!args.some(a=>/DISABLE.*(?:ANDROID|FORMATTER)|LIBLLDB.*OFF/.test(a))); assert.ok(args.includes('-DCMAKE_CXX_FLAGS=/utf-8 -DLZMA_API_STATIC')); assert.ok(args.includes('-DCMAKE_C_FLAGS=/utf-8 -DLZMA_API_STATIC'));
  const windows=api.configureArgs('E:\\src\\llvm','E:\\build','E:\\install',{zlib:{include:'E:\\z',library:'E:\\z\\zs.lib'},zstd:{include:'E:\\s',library:'E:\\s\\zstd.lib'},lzma:{include:'E:\\l',library:'E:\\l\\lzma.lib'}}); assert.ok(windows.every(arg=>!arg.includes('\\')));
  assert.equal(api.SOURCES[0].sha256,api.LLVM_SHA256); assert.ok(api.SOURCES.slice(1).every(s=>/^[a-f0-9]{128}$/.test(s.sha512)));
});

// 映射 run：通过 spawn 替身核验无 shell 和原始 argv，失败状态/NUL 不会被吞。
test('process argv is safe and exit failures propagate', async () => {
  const calls=[]; const api=load({spawn(command,args,options){calls.push({command,args,options});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();queueMicrotask(()=>child.emit('close',command==='fail'?1:0,null));return child;}});
  await api.run(['tool','a b','semi;colon']); assert.equal(calls[0].options.shell,false);assert.deepEqual(Array.from(calls[0].args),['a b','semi;colon']);
  await assert.rejects(api.run(['tool','bad\0arg']),/unsafe/);assert.equal(calls.length,1);await assert.rejects(api.run(['fail']),/exited 1/);
});

// 映射 toolPaths：缺失工具和未显式指定的 build-only Python 必须拒绝，不使用用户硬编码路径。
test('explicit tools validate executable files and Python input',()=>{
 const api=load(); assert.throws(()=>api.toolPaths({NATIVE_CMAKE:'C:/not-a-tool.exe'}),/required tool missing/);
 assert.ok(!source.includes('C:/Users/')); assert.ok(source.includes('install-lldb-dap'));assert.ok(source.includes('install-liblldb'));assert.ok(source.includes('install-clang-resource-headers'));
});

/** 为 scanPayload 建立明确测试夹具，二进制导入由 readobj 替身返回，不称为真实运行时证据。 */
async function payloadFixture(dir) {
  await fs.mkdir(path.join(dir,'llvm/bin'),{recursive:true});await fs.mkdir(path.join(dir,'llvm/lib/clang/20/include'),{recursive:true});
  for(const f of ['llvm/bin/lldb-dap.exe','llvm/bin/liblldb.dll','llvm/lib/clang/20/include/stddef.h']) await fs.writeFile(path.join(dir,f),'test fixture only');
}

// 映射 scanPayload：liblldb.dll 是必需共享依赖，Windows 系统库放行，所有随包 PE 递归检查。
test('payload resources and import closure allow liblldb and OS baseline', async()=>fixture(async dir=>{
  await payloadFixture(dir);const api=load(),calls=[];
  const result=await api.scanPayload(dir,async file=>{calls.push(file);return {stdout:path.basename(file)==='lldb-dap.exe'?'Import {\n Name: liblldb.dll\n}\nImport {\n Name: KERNEL32.dll\n}':'Import {\n Name: WS2_32.dll\n}\nImport {\n Name: api-ms-win-crt-runtime-l1-1-0.dll\n}'};});
  assert.equal(calls.length,2);assert.equal(Object.keys(result).length,2);
  await fs.rm(path.join(dir,'llvm/lib/clang/20/include/stddef.h'));await assert.rejects(api.scanPayload(dir,()=>{}),/resource headers/);
}));

// 映射 scanPayload：Python/Lua/VC/压缩 DLL、未知未捆绑 DLL 和空导入输出都必须失败。
test('payload scanner rejects interpreter runtime compression and unbundled DLLs',async()=>fixture(async dir=>{
 await payloadFixture(dir);const api=load();for(const dll of ['python313.dll','lua54.dll','vcruntime140.dll','msvcp140.dll','zlib1.dll','libzstd.dll','lzma.dll','unknown.dll']) await assert.rejects(api.scanPayload(dir,async()=>({stdout:'Import {\n Name: '+dll+'\n}'})),/dependency/);
 await assert.rejects(api.scanPayload(dir,async()=>({stdout:'File: fixture'})),/no PE import data/);
 await fs.writeFile(path.join(dir,'llvm/bin/python313.dll'),'test fixture only');await assert.rejects(api.scanPayload(dir,async()=>{}),/forbidden staged/);
}));

// 映射 portableProvenance：来源/版本和选项保留，源目录和机器用户名不进入 provenance。
test('provenance redaction removes build paths and retains source pins',()=>{
 const api=load();const record=api.portableProvenance([{name:'llvm',source:'E:/private/source',url:'https://official.test',sha256:api.LLVM_SHA256}],{compiler:'MSVC19.44'},['-SE:/work/src/llvm'],'E:/work');const text=JSON.stringify(record);
 assert.ok(!text.includes('E:/private'));assert.ok(!text.includes('E:/work'));assert.ok(text.includes('$WORK'));assert.ok(text.includes(api.LLVM_SHA256));assert.equal(record.validationHost,'win32-x64 only');assert.ok(record.sourceIdentity.includes('Pinned source archive hashes are authoritative'));assert.ok(record.sourceIdentity.includes('not an LLVM upstream commit'));
});

// 映射 initializeDap：真实 DAP 帧边界替身验证分片响应、失败传播、最小环境及始终等待进程 close；不伪称真实二进制证据。
test('DAP initialize frames survive chunks and process ownership always closes',async()=>{
 for(const success of [true,false]){
  let call,killed=0,closed=false,request;
  const api=load({spawn(command,args,options){
   call={command,args,options};const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
   child.stdin.once('data',bytes=>{request=bytes.toString();const body=JSON.stringify({seq:1,type:'response',request_seq:1,command:'initialize',success,body:{supportsConfigurationDoneRequest:true}});const frame='Content-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body;queueMicrotask(()=>{child.stdout.write(frame.slice(0,11));child.stdout.write(frame.slice(11));});});
   child.kill=()=>{killed++;queueMicrotask(()=>{closed=true;child.emit('close',0,null);});return true;};return child;
  }});
  if(success){const result=await api.initializeDap('E:/candidate/llvm/bin/lldb-dap.exe');assert.equal(result.messages[0].success,true);}else await assert.rejects(api.initializeDap('E:/candidate/llvm/bin/lldb-dap.exe'),/initialize failed/);
  assert.equal(killed,1);assert.equal(closed,true);assert.equal(call.options.shell,false);assert.equal(call.options.env.PYTHONHOME,undefined);assert.equal(call.options.env.PYTHONPATH,undefined);assert.equal(call.options.env.PATH,path.dirname(call.command)+';'+path.join(process.env.SystemRoot||'C:/Windows','System32'));
  const parts=request.split('\r\n\r\n');assert.equal(Number(parts[0].slice('Content-Length: '.length)),Buffer.byteLength(parts[1]));assert.equal(JSON.parse(parts[1]).command,'initialize');
 }
});

// 映射 shortBuildAlias：同树短工作目录解决 MSVC MAX_PATH，不移动/删除对象或创建全局盘符。
test('short build alias preserves real target and rejects unrelated directory',async()=>fixture(async dir=>{
 const api=load();const build=path.join(dir,'build-llvm');await fs.mkdir(build);await fs.writeFile(path.join(build,'object.obj'),'existing compiled output');
 const alias=await api.shortBuildAlias(dir,build);assert.equal((await fs.realpath(alias)).toLowerCase(),(await fs.realpath(build)).toLowerCase());assert.equal(await fs.readFile(path.join(alias,'object.obj'),'utf8'),'existing compiled output');assert.equal(await api.shortBuildAlias(dir,build),alias);
 await fs.unlink(alias);await fs.mkdir(alias);await assert.rejects(api.shortBuildAlias(dir,build),/different real target/);await assert.rejects(api.shortBuildAlias(dir,path.dirname(dir)),/inside workspace/);
}));

/** 创建四个专属 native 发布条目，预置 ADB/NOTICE；仅测试发布所有权，不称为真实 LLVM 产物。 */
async function publicationFixture(dir) {
 const candidate=path.join(dir,'candidate'),payload=path.join(dir,'payload');await fs.mkdir(path.join(candidate,'llvm'),{recursive:true});await fs.mkdir(payload);await fs.writeFile(path.join(candidate,'llvm/liblldb.dll'),'native fixture');
 for(const name of ['LLVM-NOTICE.txt','native-provenance.json','native-SHA256SUMS'])await fs.writeFile(path.join(candidate,name),'native '+name);
 await fs.writeFile(path.join(payload,'adb.exe'),'parent adb bytes');await fs.writeFile(path.join(payload,'NOTICE.txt'),'parent notice bytes');return {candidate,payload};
}

// 映射 publishNative：与已存在 ADB 共存、精确冲突零移动、权限错误回滚且不吞错。
test('coexist publication preserves parent ADB and refuses native conflicts',async()=>fixture(async dir=>{
 const {candidate,payload}=await publicationFixture(dir),api=load();await api.publishNative(candidate,payload);
 assert.equal(await fs.readFile(path.join(payload,'adb.exe'),'utf8'),'parent adb bytes');assert.equal(await fs.readFile(path.join(payload,'NOTICE.txt'),'utf8'),'parent notice bytes');assert.equal(await fs.readFile(path.join(payload,'llvm/liblldb.dll'),'utf8'),'native fixture');
 const second=path.join(dir,'second');await fs.mkdir(second);for(const name of ['llvm','LLVM-NOTICE.txt','native-provenance.json','native-SHA256SUMS'])await fs.cp(path.join(payload,name),path.join(second,name),{recursive:true});
 await assert.rejects(api.publishNative(second,payload),/conflict/);assert.equal((await fs.readdir(second)).length,4);assert.equal(await fs.readFile(path.join(payload,'NOTICE.txt'),'utf8'),'parent notice bytes');
}));

test('publication permission errors rollback owned moves and propagate',async()=>fixture(async dir=>{
 const {candidate,payload}=await publicationFixture(dir);let calls=0;const api=load({files:{async rename(from,to){calls++;if(calls===2){const error=new Error('permission denied');error.code='EACCES';throw error;}return fs.rename(from,to);}}});
 await assert.rejects(api.publishNative(candidate,payload),/permission denied/);assert.equal(calls,3);assert.equal((await fs.readdir(candidate)).length,4);assert.equal(sync.existsSync(path.join(payload,'llvm')),false);assert.equal(await fs.readFile(path.join(payload,'adb.exe'),'utf8'),'parent adb bytes');assert.equal(await fs.readFile(path.join(payload,'NOTICE.txt'),'utf8'),'parent notice bytes');
}));

// 映射 verifyInstalledBuild：stage-only 不配置/不编译前必须核验同一来源与运行时/压缩/CRT/并发缓存，错误值不能放行。
test('installed build gate rejects incompatible or incomplete caches',()=>{
 const api=load(),entries={CMAKE_BUILD_TYPE:'Release',LLDB_ENABLE_PYTHON:'OFF',LLDB_ENABLE_LUA:'OFF',LLDB_ENABLE_SWIG:'OFF',LLDB_ENABLE_LZMA:'ON',LLVM_ENABLE_ZLIB:'FORCE_ON',LLVM_ENABLE_ZSTD:'FORCE_ON',LLVM_TARGETS_TO_BUILD:'AArch64;ARM;X86',LLVM_PARALLEL_COMPILE_JOBS:'2',LLVM_PARALLEL_LINK_JOBS:'1',LLVM_EXTERNAL_LLDB_SOURCE_DIR:'E:/verified/src/lldb'};
 const cache=Object.entries(entries).map(([key,value])=>key+':STRING='+value).join('\n');assert.equal(api.verifyInstalledBuild(cache,'E:/verified/src/llvm','cl.exe /nologo -MT /c a.cpp /Foa.obj').LLDB_ENABLE_PYTHON,'OFF');
 for(const [key,value] of Object.entries(entries)){const wrong=cache.replace(key+':STRING='+value,key+':STRING=wrong');assert.throws(()=>api.verifyInstalledBuild(wrong,'E:/verified/src/llvm','cl.exe /nologo -MT /c a.cpp /Foa.obj'),/mismatch/);}
 assert.throws(()=>api.verifyInstalledBuild('','E:/verified/src/llvm'),/mismatch/);assert.throws(()=>api.verifyInstalledBuild(cache,'E:/verified/src/llvm'),/static MSVC runtime/); assert.throws(()=>api.verifyInstalledBuild(cache,'E:/verified/src/llvm','cl.exe /nologo -MD /c a.cpp /Foa.obj'),/static MSVC runtime/); assert.ok(source.includes('--stage-only'));assert.ok(source.includes('if (!stageOnly)'));
});

// 映射 installedDependencies：必须读取同一工作区的唯一静态库，缺失/重复库均失败，不调用全局 find。
test('stage-only resolves only existing static dependencies',async()=>fixture(async dir=>{
 const api=load();for(const name of ['zlib','zstd','lzma']){await fs.mkdir(path.join(dir,'deps',name,'lib'),{recursive:true});await fs.mkdir(path.join(dir,'deps',name,'include'));await fs.writeFile(path.join(dir,'deps',name,'lib',name+'.lib'),'static fixture');}
 const deps=await api.installedDependencies(dir);assert.equal(deps.zlib.library,path.join(dir,'deps/zlib/lib/zlib.lib'));await fs.writeFile(path.join(dir,'deps/zstd/lib/extra.lib'),'fixture');await assert.rejects(api.installedDependencies(dir),/one installed static library/);
}));

// 映射 packageInstalledTree：使用标准 CMake tar，不配置/编译；拒绝文件数量缺失和透明封装字节，保持错误可见。
test('portable install package checks exact standard tool argv and protected bytes',async()=>fixture(async dir=>{
 const install=path.join(dir,'install');await fs.mkdir(path.join(install,'bin'),{recursive:true});await fs.mkdir(path.join(install,'lib/clang/20/include'),{recursive:true});await fs.writeFile(path.join(install,'bin/lldb-dap.exe'),'MZ fixture');await fs.writeFile(path.join(install,'lib/clang/20/include/stddef.h'),'/* resource fixture */');
 const calls=[];const api=load({spawn(command,args,options){calls.push({command,args,options});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();queueMicrotask(async()=>{try{if(command==='tar'){await fs.cp(install,args[3],{recursive:true});}child.emit('close',0,null);}catch(error){child.stderr.write(String(error));child.emit('close',1,null);}});return child;}});
 const candidate=path.join(dir,'candidate');await api.packageInstalledTree(install,candidate,dir,{cmake:'cmake',tar:'tar'},{});assert.deepEqual(Array.from(calls[0].args),['-E','tar','cf',path.join(dir,'installed-runtime.tar'),'--format=gnutar','bin','lib']);assert.equal(calls[0].options.cwd,install);assert.ok(!calls.some(c=>c.args.includes('--build')||c.args.includes('-S')));assert.equal(await fs.readFile(path.join(candidate,'llvm/lib/clang/20/include/stddef.h'),'utf8'),'/* resource fixture */');
 await fs.writeFile(path.join(install,'lib/clang/20/include/stddef.h'),'%TSD-Header-###%protected');await assert.rejects(api.packageInstalledTree(install,path.join(dir,'rejected'),dir,{cmake:'cmake',tar:'tar'},{}),/nonportable protected file/);
}));
