import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {FileCleanup,type FileCleanupOptions} from '../packages/core/src/file-cleanup.js';
import {registerFileCleanup} from '../packages/core/src/file-cleanup-routes.js';
import {cleanupCatalog} from '../packages/core/src/file-cleanup-catalog.js';
import {createServer} from '../packages/core/src/server.js';
import {createDesktopService} from '../packages/core/src/service.js';

const disposals:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const dispose of disposals.splice(0).reverse())await dispose();});
async function fixture(options:FileCleanupOptions={}){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'tf-cleanup-')));disposals.push(()=>rm(dir,{recursive:true,force:true}));
 const home=join(dir,'home');await mkdir(home);
 const cleanup=new FileCleanup(join(dir,'profile'),{home,platform:'darwin',env:{},applicationRoots:[],...options});disposals.push(()=>cleanup.close());
 const put=async(path:string,content='private-file-content')=>{const full=join(home,path);await mkdir(join(full,'..'),{recursive:true});await writeFile(full,content);return full;};
 const scan=async()=>{cleanup.start();await cleanup.settled();return cleanup.snapshot();};
 return {dir,home,cleanup,put,scan};
}

it('previews the actual platform and environment paths before scanning',async()=>{
 const {home,dir,put}=await fixture();
 const cleanup=new FileCleanup(join(dir,'preview'),{home,platform:'darwin',applicationRoots:[],env:{NPM_CONFIG_CACHE:join(home,'custom-npm')}});disposals.push(()=>cleanup.close());
 const before=cleanup.snapshot();expect(before.status).toBe('idle');expect(before.entries).toEqual([]);
 const npm=before.locations.find(location=>location.name==='npm 下载缓存')!;
 expect(npm).toEqual({name:'npm 下载缓存',path:join(home,'custom-npm','_cacache'),category:'package',risk:'rebuildable'});
 expect(before.locations.find(location=>location.name==='Codex 历史会话')?.risk).toBe('protected');
 await put('custom-npm/_cacache/blob','cache');cleanup.start();await cleanup.settled();
 expect(cleanup.snapshot().entries.find(entry=>entry.name===npm.name)).toMatchObject({path:npm.path,bytes:5});
});

it('reports actual sizes and risk classifications without reading file contents or treating profiles as caches',async()=>{
 const {put,scan}=await fixture();
 await put('.npm/_cacache/blob','12345');await put('.codex/sessions/session.jsonl');await put('Library/Application Support/Code/User/settings.json');await put('.openclaw-custom/memory');
 const state=await scan();expect(state.status).toBe('complete');
 expect(state.entries.find(e=>e.name==='npm 下载缓存')).toMatchObject({bytes:5,files:1,risk:'rebuildable',complete:true});
 for(const name of ['Codex 历史会话','Code 用户配置','.openclaw-custom'])expect(state.entries.find(e=>e.name===name)?.risk).toBe('protected');
 expect(state.locations.find(location=>location.name==='.openclaw-custom')?.path).toBe(state.entries.find(entry=>entry.name==='.openclaw-custom')?.path);
 expect(JSON.stringify(state)).not.toContain('private-file-content');
});

it.each(['win32','linux'] as const)('previews and scans the same overridden cache and redirected folders on %s',async platform=>{
 const {home,dir,put}=await fixture();
 const npm=await put('override/npm/_cacache/blob','npm'),pip=await put('override/pip/wheel','pip'),uv=await put('override/uv/wheel','uv'),go=await put('override/go/build','go');
 const downloads=join(dir,'redirected-downloads'),desktop=join(dir,'redirected-desktop');await mkdir(downloads);await mkdir(desktop);
 const installer=join(downloads,platform==='win32'?'Tool.msi':'Tool.deb');await writeFile(installer,'package');
 await put('Downloads/Excluded.msi','outside-the-selected-scope');
 const cleanup=new FileCleanup(join(dir,'profile'),{home,platform,applicationRoots:[],env:{NPM_CONFIG_CACHE:join(home,'override/npm'),PIP_CACHE_DIR:join(home,'override/pip'),UV_CACHE_DIR:join(home,'override/uv'),GOCACHE:join(home,'override/go')},userFolders:{downloads,desktop}});disposals.push(()=>cleanup.close());
 const before=cleanup.snapshot();expect(before.locations.some(location=>location.path===downloads)).toBe(true);
 expect(before.locations.some(location=>location.path===join(home,'Downloads'))).toBe(false);
 cleanup.start();await cleanup.settled();const after=cleanup.snapshot();
 for(const file of [npm,pip,uv,go])expect(after.entries.some(entry=>file.startsWith(entry.path+'/'))).toBe(true);
 expect(after.entries.find(entry=>entry.path===installer)).toMatchObject({complete:true,category:'artifact',risk:'review'});
 expect(after.entries.some(entry=>entry.path.endsWith('Excluded.msi'))).toBe(false);
 for(const entry of after.entries)expect(after.locations.some(location=>location.path===entry.path)).toBe(true);
});

it('trashes only selected scan candidates and rejects unconfirmed protected, unknown, stale and duplicate IDs',async()=>{
 const trashItem=vi.fn(async()=>{});const {cleanup,put,scan}=await fixture({trashItem});
 await put('.npm/_cacache/blob','12345');await put('.codex/sessions/history');
 const state=await scan(),cache=state.entries.find(e=>e.risk==='rebuildable')!,protectedEntry=state.entries.find(e=>e.risk==='protected')!;
 expect(()=>cleanup.clean(state.scanId!,[protectedEntry.id],false)).toThrow('受保护');
 expect(()=>cleanup.clean(randomUUID(),[cache.id],false)).toThrow('失效');
 expect(()=>cleanup.clean(state.scanId!,[randomUUID()],false)).toThrow('不存在');
 expect(()=>cleanup.clean(state.scanId!,[cache.id,cache.id],false)).toThrow('不重复');
 expect(trashItem).not.toHaveBeenCalled();
 cleanup.clean(state.scanId!,[cache.id],false);await cleanup.settled();
 expect(trashItem).toHaveBeenCalledExactlyOnceWith(cache.path);
 expect(cleanup.snapshot().result).toEqual({method:'trash',moved:1,deleted:0,bytes:5,failed:0});
 expect(()=>cleanup.clean(state.scanId!,[cache.id],false)).toThrow();
});

it('allows protected data only after its risk was confirmed, for trash and permanent deletion',async()=>{
 for(const method of ['trash','delete'] as const){
  const perform=vi.fn(async()=>{});
  const {cleanup,put,scan}=await fixture({trashItem:perform,deleteItem:perform});
  const history=await put('.codex/sessions/history','personal-history');await put('.claude/credentials','other-data');
  const state=await scan(),entry=state.entries.find(item=>item.name==='Codex 历史会话')!;
  expect(entry).toMatchObject({risk:'protected',complete:true});
  expect(()=>cleanup.clean(state.scanId!,[entry.id],false,method,method==='delete')).toThrow('受保护数据');
  expect(perform).not.toHaveBeenCalled();
  cleanup.clean(state.scanId!,[entry.id],false,method,method==='delete',true);await cleanup.settled();
  expect(perform).toHaveBeenCalledExactlyOnceWith(entry.path);expect(await readFile(history,'utf8')).toBe('personal-history');
  expect(cleanup.snapshot().entries.find(item=>item.id===entry.id)?.state).toBe(method==='delete'?'deleted':'trashed');
  expect(cleanup.snapshot().entries.find(item=>item.name==='Claude Code 数据')?.state).toBe('ready');
 }
});

it('allows incomplete protected data after its risk was confirmed',async()=>{
 const trashItem=vi.fn(async()=>{}),{cleanup,put,scan}=await fixture({trashItem,maxEntries:1});
 await put('.codex/sessions/history','personal-history');const state=await scan(),entry=state.entries.find(item=>item.name==='Codex 历史会话')!;
 expect(entry.complete).toBe(false);
 expect(()=>cleanup.clean(state.scanId!,[entry.id],false)).toThrow('受保护');
 expect(trashItem).not.toHaveBeenCalled();
 cleanup.clean(state.scanId!,[entry.id],false,'trash',false,true);await cleanup.settled();
 expect(trashItem).toHaveBeenCalledExactlyOnceWith(entry.path);
 expect(cleanup.snapshot().result).toMatchObject({moved:1,failed:0,bytesIncomplete:true});
});

it('requires explicit protected-data consent on both cleanup endpoints',async()=>{
 for(const route of ['trash','clean'] as const){
  const {home,dir,put}=await fixture();await put('.codex/sessions/history','history');
  const app=createServer(),trashItem=vi.fn(async()=>{});
  const cleanup=registerFileCleanup(app,join(dir,'api-profile'),{home,env:{},applicationRoots:[],trashItem});disposals.push(()=>app.close());
  cleanup.start();await cleanup.settled();const state=cleanup.snapshot(),entry=state.entries.find(item=>item.name==='Codex 历史会话')!;
  const payload={scanId:state.scanId,ids:[entry.id],...(route==='clean'?{method:'trash'}:{})};
  expect((await app.inject({method:'POST',url:`/api/file-cleanup/${route}`,payload})).statusCode).toBe(400);
  expect(trashItem).not.toHaveBeenCalled();
  expect((await app.inject({method:'POST',url:`/api/file-cleanup/${route}`,payload:{...payload,confirmProtected:true}})).statusCode).toBe(200);
  await cleanup.settled();expect(trashItem).toHaveBeenCalledExactlyOnceWith(entry.path);
 }
});

it('requires review consent for runtimes and project dependencies; shared pnpm storage stays protected',async()=>{
 const trashItem=vi.fn(async()=>{});const {dir,cleanup,put,scan}=await fixture({trashItem,pickDirectory:async()=>join(dir,'projects')});
 await put('.cache/puppeteer/chrome');await put('Library/pnpm/store/package');
 await mkdir(join(dir,'projects','old-project','node_modules'),{recursive:true});await writeFile(join(dir,'projects','old-project','node_modules','dependency'),'deps');
 await cleanup.addProjectRoot();const state=await scan();
 const runtime=state.entries.find(e=>e.name==='puppeteer 运行时')!,dependency=state.entries.find(e=>e.category==='project')!;
 expect(dependency.risk).toBe('review');expect(state.entries.find(e=>e.name==='pnpm 共享存储')?.risk).toBe('protected');
 expect(()=>cleanup.clean(state.scanId!,[runtime.id,dependency.id],false)).toThrow('人工判断');
 cleanup.clean(state.scanId!,[runtime.id,dependency.id],true);await cleanup.settled();expect(trashItem).toHaveBeenCalledTimes(2);
});

it('refuses roots or ancestors redirected through symlinks, and does not count symlink targets',async()=>{
 const trashItem=vi.fn(async()=>{});const {dir,home,cleanup,put,scan}=await fixture({trashItem});
 await put('.npm/_cacache/blob','real');await writeFile(join(dir,'outside'),'outside');
 await symlink(join(dir,'outside'),join(home,'.npm','_cacache','link'));
 let state=await scan();expect(state.entries.find(e=>e.name==='npm 下载缓存')?.bytes).toBe(4);
 const cache=state.entries.find(e=>e.name==='npm 下载缓存')!;
 await rename(join(home,'.npm'),join(home,'original-npm'));await symlink(join(home,'original-npm'),join(home,'.npm'));
 cleanup.clean(state.scanId!,[cache.id],false);await cleanup.settled();expect(trashItem).not.toHaveBeenCalled();expect(cleanup.snapshot().result?.failed).toBe(1);
 state=await scan();expect(state.entries.find(e=>e.name==='npm 下载缓存')).toMatchObject({complete:false});
 expect(await readFile(join(dir,'outside'),'utf8')).toBe('outside');
});

it('scans project packaging folders and requires review before removing individual artifacts',async()=>{
 const trashItem=vi.fn(async()=>{});
 const {dir,cleanup,put,scan}=await fixture({trashItem,pickDirectory:async()=>join(dir,'home','project')});
 const artifact=await put('project/release/v1/Tool.dmg','installer');await put('project/src/main.ts','source');
 await put('project/node_modules/dependency','deps');
 await cleanup.addProjectRoot();const state=await scan(),item=state.entries.find(entry=>entry.path===artifact)!;
 expect(item).toMatchObject({category:'artifact',risk:'review',bytes:9});
 expect(state.entries.some(entry=>entry.category==='project')).toBe(true);
 expect(state.entries.some(entry=>entry.path.endsWith('src')||entry.path.endsWith('release'))).toBe(false);
 expect(()=>cleanup.clean(state.scanId!,[item.id],false)).toThrow('人工判断');
 cleanup.clean(state.scanId!,[item.id],true);await cleanup.settled();expect(trashItem).toHaveBeenCalledExactlyOnceWith(artifact);
});

it('rechecks nested metadata and reports partial failures without falling back to permanent deletion',async()=>{
 const trashItem=vi.fn(async(path:string)=>{if(path.includes('_npx'))throw new Error('locked');});const {cleanup,put,scan}=await fixture({trashItem});
 const file=await put('.npm/_cacache/nested/blob','before');await put('.npm/_npx/tool');await put('Library/Caches/pip/wheel');
 const state=await scan();await writeFile(file,'changed-after-scan');
 cleanup.clean(state.scanId!,state.entries.filter(e=>e.risk==='rebuildable').map(e=>e.id),false);await cleanup.settled();
 expect(cleanup.snapshot().result).toMatchObject({moved:1,failed:2});expect(trashItem).toHaveBeenCalledTimes(2);
 expect(await readFile(file,'utf8')).toBe('changed-after-scan');
 expect(cleanup.snapshot().entries.find(e=>e.name==='npm 下载缓存')?.issue).toContain('文件已变化');
});

it('bounds scans without blocking measured candidates, while retaining cancellation and exclusive operations',async()=>{
 const trashItem=vi.fn(async()=>{});const {cleanup,put,scan}=await fixture({maxEntries:2,trashItem});
 for(let i=0;i<5;i++)await put(`.npm/_cacache/file-${i}`);
 const state=await scan(),entry=state.entries.find(e=>e.name==='npm 下载缓存')!;
 expect(entry.complete).toBe(false);cleanup.clean(state.scanId!,[entry.id],false);await cleanup.settled();
 expect(trashItem).toHaveBeenCalledExactlyOnceWith(entry.path);
 cleanup.start();expect(()=>cleanup.start()).toThrow('正在进行');cleanup.cancel();await cleanup.settled();
 expect(cleanup.snapshot().status).toBe('cancelled');expect(trashItem).toHaveBeenCalledTimes(1);
});

it('offers read-only scans without native capabilities and expires old scan permissions',async()=>{
 const {cleanup,put,scan}=await fixture();await put('.npm/_cacache/blob');let state=await scan();
 expect(state.capabilities).toEqual({trash:false,delete:false,pickDirectory:false,reveal:false});expect(()=>cleanup.clean(state.scanId!,[state.entries[0].id],false)).toThrow('只读');
 const other=await fixture({trashItem:async()=>{}});await other.put('.npm/_cacache/blob');state=await other.scan();
 const now=Date.now();const clock=vi.spyOn(Date,'now').mockReturnValue(now+31*60*1000);
 try{expect(()=>other.cleanup.clean(state.scanId!,[state.entries[0].id],false)).toThrow('失效');}finally{clock.mockRestore();}
});

it('rejects untrusted paths and commands at the API boundary',async()=>{
 const {home,dir}=await fixture();const app=createServer();const cleanup=registerFileCleanup(app,join(dir,'profile'),{home,env:{}});disposals.push(()=>app.close());
 for(const payload of [{path:'/tmp'},{command:'delete'},{roots:['/']}])expect((await app.inject({method:'POST',url:'/api/file-cleanup/scan',payload})).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url:'/api/file-cleanup/trash',payload:{scanId:randomUUID(),ids:[randomUUID()],path:'/tmp'}})).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url:'/api/file-cleanup/scan',payload:{}})).statusCode).toBe(200);await cleanup.settled();
 expect((await app.inject('/api/file-cleanup')).json().status).toBe('complete');
});

it('inherits administrator authentication and origin checks from the desktop service',async()=>{
 const {dir,home,put}=await fixture();await put('.npm/_cacache/blob');
 let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});
 const app=(await createDesktopService({root:join(dir,'service'),binary:'/missing',token:'fixture-admin',localKey:'fixture-key',secrets:{get:async()=>'',set:async()=>{}},fileCleanup:{home,env:{},applicationRoots:[],trashItem:async()=>gate}})).app;disposals.push(()=>app.close());
 const headers={host:'127.0.0.1:9527',authorization:'Bearer fixture-admin'};
 expect((await app.inject({url:'/api/file-cleanup',headers:{host:headers.host}})).statusCode).toBe(401);
 expect((await app.inject({url:'/api/file-cleanup',headers:{...headers,origin:'https://untrusted.test'}})).statusCode).toBe(403);
 expect((await app.inject({url:'/api/file-cleanup',headers})).statusCode).toBe(200);
 try{
  expect((await app.inject({method:'POST',url:'/api/file-cleanup/scan',headers,payload:{}})).statusCode).toBe(200);
  await vi.waitFor(async()=>expect((await app.inject({url:'/api/file-cleanup',headers})).json().status).toBe('complete'));
  const state=(await app.inject({url:'/api/file-cleanup',headers})).json();
  expect((await app.inject({method:'POST',url:'/api/file-cleanup/trash',headers,payload:{scanId:state.scanId,ids:[state.entries[0].id]}})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/api/local-agent/start',headers,payload:{}})).statusCode).toBe(409);
 }finally{release();}
});

it('uses platform cache locations without including whole app profiles in clearable rules',()=>{
 for(const platform of ['darwin','win32','linux'] as const){
  const rules=cleanupCatalog('/fixture-home',platform,'/fixture-profile',{});
  expect(rules.some(r=>r.name==='npm 下载缓存')).toBe(true);
  expect(rules.filter(r=>r.risk!=='protected').every(r=>!['Code','Cursor','Notion','Chromium','.codex','.claude','.gemini'].includes(r.path.split(/[\\/]/).at(-1)!))).toBe(true);
 }
});

it('permanently deletes selected Windows caches only after explicit consent, with no fallback from trash',async()=>{
 const trashItem=vi.fn(async()=>{throw new Error('recycle bin unavailable');});
 const deleteItem=vi.fn(async(path:string)=>rm(path,{recursive:true}));
 const {cleanup,put,scan}=await fixture({platform:'win32',deleteItem,trashItem});
 const file=await put('AppData/Local/npm-cache/_cacache/blob','cache'),history=await put('.codex/sessions/history','personal');
 let state=await scan();const cache=state.entries.find(e=>e.name==='npm 下载缓存')!,protectedEntry=state.entries.find(e=>e.risk==='protected')!;
 expect(state.platform).toBe('win32');expect(state.capabilities.delete).toBe(true);
 expect(()=>cleanup.clean(state.scanId!,[cache.id],false,'delete')).toThrow('人工确认');
 expect(()=>cleanup.clean(state.scanId!,[protectedEntry.id],true,'delete',true)).toThrow('受保护');
 expect(deleteItem).not.toHaveBeenCalled();
 cleanup.clean(state.scanId!,[cache.id],false);await cleanup.settled();expect(deleteItem).not.toHaveBeenCalled();expect(await readFile(file,'utf8')).toBe('cache');
 state=await scan();cleanup.clean(state.scanId!,[state.entries.find(e=>e.name==='npm 下载缓存')!.id],false,'delete',true);await cleanup.settled();
 expect(deleteItem).toHaveBeenCalledExactlyOnceWith(cache.path);await expect(readFile(file)).rejects.toMatchObject({code:'ENOENT'});
 expect(await readFile(history,'utf8')).toBe('personal');expect(cleanup.snapshot().result).toMatchObject({method:'delete',deleted:1,moved:0,failed:0});
});

it('uses per-platform browser locations and explicit environment overrides in scan guidance',()=>{
 const home='/fixture-home',profile='/fixture-profile';
 const rules=(platform:NodeJS.Platform,env:NodeJS.ProcessEnv={})=>cleanupCatalog(home,platform,profile,env);
 expect(rules('darwin').find(r=>r.name==='ms-playwright 运行时')?.path).toBe(join(home,'Library','Caches','ms-playwright'));
 expect(rules('win32',{LOCALAPPDATA:'/local-data'}).find(r=>r.name==='ms-playwright 运行时')?.path).toBe(join('/local-data','ms-playwright'));
 expect(rules('linux',{XDG_CACHE_HOME:'/xdg'}).find(r=>r.name==='ms-playwright 运行时')?.path).toBe(join('/xdg','ms-playwright'));
 expect(rules('linux',{PLAYWRIGHT_BROWSERS_PATH:'0'}).some(r=>r.name==='ms-playwright 运行时')).toBe(false);
 expect(rules('win32',{NPM_CONFIG_CACHE:'/custom-npm'}).find(r=>r.name==='npm 下载缓存')?.path).toBe(join('/custom-npm','_cacache'));
 const cleanup=new FileCleanup(profile,{home,platform:'win32',env:{LOCALAPPDATA:'/local-data'}});
 const report=cleanup.report();expect(report.guidance.platform).toBe('win32');expect(report.guidance.defaults.some(row=>row.tool==='Playwright')).toBe(true);
 expect(report.guidance.tools.find(tool=>tool.name==='pnpm')?.cleanup).toBe('pnpm store prune');expect(report.scan.status).toBe('idle');expect(report.scan.entries).toEqual([]);
});
