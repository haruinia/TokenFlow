import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,realpath,symlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {FileCleanup} from '../packages/core/src/file-cleanup.js';
import {inspectArtifactEvidence} from '../packages/core/src/file-cleanup-evidence.js';
import type {CleanupEntry} from '../apps/shared/file-cleanup.js';
import {cleanupGroups} from '../apps/shared/file-cleanup-groups.js';
const dispose:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const done of dispose.splice(0).reverse())await done();});
async function setup(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'tf-clean-evidence-')));dispose.push(()=>rm(root,{recursive:true,force:true}));
 const home=join(root,'home');await mkdir(home);
 const put=async(path:string,data:string)=>{const file=join(home,path);await mkdir(dirname(file),{recursive:true});await writeFile(file,data);return file;};
 const options={home,env:{},platform:'darwin' as const,applicationRoots:[join(home,'Applications')],executablePath:join(root,'running'),pickDirectory:async()=>join(home,'project')};
 const cleanup=new FileCleanup(join(root,'profile'),options);dispose.push(()=>cleanup.close());return {root,home,put,options,cleanup};
}
const plist=(id:string,version:string,build=version)=>`<plist><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${build}</string></dict></plist>`;
it('compares actual bundle metadata numerically across build folders but never calls apps identical',async()=>{
 const {put,cleanup}=await setup();
 await put('project/package.json','{}');
 await put('project/release/v9/Tool.app/Contents/Info.plist',plist('com.example.tool','1.9'));
 const newer=dirname(dirname(await put('project/release/v10/Tool.app/Contents/Info.plist',plist('com.example.tool','1.10'))));
 await put('project/release/copy/Tool.app/Contents/Info.plist',plist('com.example.tool','1.10'));
 await put('project/release/different/Tool.app/Contents/Info.plist',plist('com.different.tool','9.0'));
 await cleanup.addProjectRoot();cleanup.start();await cleanup.settled();const entries=cleanup.snapshot().entries;
 expect(entries.find(e=>e.path.includes('/v9/'))).toMatchObject({risk:'review',artifact:{basis:'bundle-metadata',version:'1.9',newerPath:newer}});
 expect(entries.find(e=>e.path.includes('/v10/'))?.artifact?.newerPath).toBeUndefined();
 expect(entries.every(e=>!e.artifact?.duplicateOf)).toBe(true);
 const groups=cleanupGroups(entries);
 expect(groups).toHaveLength(2);const tool=groups.find(g=>g.id==='app:com.example.tool')!;
 expect(tool).toMatchObject({older:1,sameVersion:1,duplicates:0});expect(tool.entries).toHaveLength(3);
 expect(tool.entries.map(e=>e.artifact?.version)).toEqual(['1.10','1.10','1.9']);
 expect(cleanupGroups(tool.entries.filter(e=>e.artifact?.version==='1.9'))[0]).toMatchObject({older:1,sameVersion:0});
});
it('compares eligible package contents, not version suffixes or equal file sizes',async()=>{
 const {put,cleanup}=await setup();
 await put('Downloads/Tool-1.0.zip','same bytes');await put('Downloads/Tool-2.0.zip','same bytes');await put('Downloads/Tool-3.0.zip','other data');
 await put('Downloads/notes-v1.md','keep');await put('Downloads/notes-v2.md','keep');
 cleanup.start();await cleanup.settled();const entries=cleanup.snapshot().entries;
 expect(entries).toHaveLength(3);expect(entries.filter(e=>e.artifact?.duplicateOf)).toHaveLength(1);
 expect(entries.find(e=>e.path.endsWith('Tool-3.0.zip'))?.artifact).toMatchObject({basis:'filename',version:'3.0'});
 expect(entries.find(e=>e.path.endsWith('Tool-3.0.zip'))?.artifact?.duplicateOf).toBeUndefined();
 expect(entries.every(e=>e.risk==='review')).toBe(true);
});
it('finds local installation backups and known test outputs, leaving generic output/source directories alone',async()=>{
 const {put,cleanup}=await setup();
 await put('Applications/.tokenflow-before-88-fixture/TokenFlow.app/Contents/Info.plist',plist('tf','1.0'));
 await put('project/package.json','{}');await put('project/test-results/.last-run.json','{}');await put('project/playwright-report/index.html','report');await put('project/coverage/lcov.info','coverage');
 await put('project/.pytest_cache/README.md','cache');await put('project/__pycache__/a.pyc','cache');
 await put('project/output/notes-v1.md','source');await put('project/screenshots/keep.png','image');
 await cleanup.addProjectRoot();cleanup.start();await cleanup.settled();const entries=cleanup.snapshot().entries;
 for(const suffix of ['TokenFlow.app','test-results','playwright-report','coverage','.pytest_cache','__pycache__'])expect(entries.some(e=>e.path.endsWith(suffix))).toBe(true);
 expect(entries.some(e=>e.path.includes('/output')||e.path.includes('/screenshots'))).toBe(false);
});
it('blocks running applications even with protected confirmation, and rechecks processes before cleanup',async()=>{
 const {root,put,options}=await setup();const executable=await put('Downloads/Tool.app/Contents/MacOS/Tool','binary');
 let running=[executable];const trash=vi.fn(async()=>{}),cleanup=new FileCleanup(join(root,'profile-2'),{...options,trashItem:trash,runningExecutables:async()=>running});dispose.push(()=>cleanup.close());
 cleanup.start();await cleanup.settled();let state=cleanup.snapshot();expect(state.entries[0].blockedReason).toContain('正在运行');
 expect(()=>cleanup.clean(state.scanId!,[state.entries[0].id],true,'trash',false,true)).toThrow('正在运行');
 running=[];cleanup.start();await cleanup.settled();state=cleanup.snapshot();running=[executable];cleanup.clean(state.scanId!,[state.entries[0].id],true);await cleanup.settled();
 expect(trash).not.toHaveBeenCalled();expect(cleanup.snapshot().entries[0].state).toBe('failed');
});
it('does not follow linked app metadata and reports bounded package comparison',async()=>{
 const {root,put}=await setup();const external=await put('outside.plist',plist('private','9.0')),app=dirname(dirname(await put('Downloads/App.app/Contents/MacOS','stub')));
 await symlink(external,join(app,'Contents','Info.plist'));
 const make=(path:string):CleanupEntry=>({id:path,path,name:path,category:'artifact',risk:'review',description:'fixture',impact:'fixture',bytes:10,files:1,complete:true,state:'ready'});
 const entries=[make(app),make(await put('Downloads/Tool-1.0.zip','same bytes')),make(await put('Downloads/Tool-2.0.zip','same bytes'))];
 const warnings=await inspectArtifactEvidence(entries,{platform:'darwin',signal:new AbortController().signal,deadline:Date.now()+10000,maxHashBytes:1});
 expect(entries.every(e=>!e.artifact?.bundleId&&!e.artifact?.duplicateOf)).toBe(true);expect(warnings.join(' ')).toContain('预算');
});
it('rejects a replacement app swapped in while process discovery is waiting',async()=>{
 const {root,put,options}=await setup();const executable=await put('Downloads/Swap.app/Contents/MacOS/Tool','original'),app=dirname(dirname(dirname(executable)));
 let reads=0;const trash=vi.fn(async()=>{});
 const cleanup=new FileCleanup(join(root,'profile-swap'),{...options,trashItem:trash,runningExecutables:async()=>{if(++reads===2){await rename(app,app+'.saved');await mkdir(join(app,'Contents','MacOS'),{recursive:true});await writeFile(join(app,'Contents','MacOS','Tool'),'replacement');}return [];}});dispose.push(()=>cleanup.close());
 cleanup.start();await cleanup.settled();const state=cleanup.snapshot();cleanup.clean(state.scanId!,[state.entries[0].id],true);await cleanup.settled();
 expect(trash).not.toHaveBeenCalled();expect(cleanup.snapshot().entries[0].issue).toContain('文件已变化');
});
