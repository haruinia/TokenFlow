import {afterEach,expect,it,vi} from 'vitest';
import {mkdir,mkdtemp,readFile,realpath,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileCleanup,type FileCleanupOptions} from '../packages/core/src/file-cleanup.js';

const disposals:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const dispose of disposals.splice(0).reverse())await dispose();});
async function fixture(options:FileCleanupOptions={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'tf-cleanup-partial-')));disposals.push(()=>rm(root,{recursive:true,force:true}));
 const home=join(root,'home'),app=join(home,'Applications','.tokenflow-before-89-fixture','TokenFlow.app');
 await mkdir(join(app,'Contents','MacOS'),{recursive:true});await writeFile(join(app,'Contents','MacOS','TokenFlow'),'old-app');
 const cleanup=new FileCleanup(join(root,'profile'),{home,env:{},platform:'darwin',applicationRoots:[join(home,'Applications')],maxEntries:2,executablePath:join(root,'current-app'),...options});
 disposals.push(()=>cleanup.close());cleanup.start();await cleanup.settled();
 const state=cleanup.snapshot(),entry=state.entries.find(item=>item.path===app)!;
 expect(entry).toMatchObject({complete:false,state:'ready'});
 return {root,app,cleanup,state,entry};
}

it.each(['trash','delete'] as const)('allows an incompletely measured app backup to be confirmed for %s',async method=>{
 const perform=vi.fn(async(path:string)=>method==='delete'?rm(path,{recursive:true}):rename(path,path+'.trashed'));
 const {app,cleanup,state,entry}=await fixture({trashItem:perform,deleteItem:perform});
 cleanup.clean(state.scanId!,[entry.id],true,method,method==='delete');await cleanup.settled();
 expect(perform).toHaveBeenCalledExactlyOnceWith(app);
 expect(cleanup.snapshot().entries.find(item=>item.id===entry.id)?.state).toBe(method==='delete'?'deleted':'trashed');
 expect(cleanup.snapshot().result).toMatchObject({failed:0,[method==='delete'?'deleted':'moved']:1});
 await expect(readFile(join(app,'Contents','MacOS','TokenFlow'))).rejects.toMatchObject({code:'ENOENT'});
});

it.each(['directory','symlink'] as const)('rejects an incomplete candidate replaced by a different %s after scanning',async replacement=>{
 const perform=vi.fn(async()=>{}),{root,app,cleanup,state,entry}=await fixture({deleteItem:perform});
 await rename(app,app+'.saved');const outside=join(root,'outside');await mkdir(outside);await writeFile(join(outside,'keep'),'keep');
 if(replacement==='directory')await mkdir(app);else await symlink(outside,app);
 cleanup.clean(state.scanId!,[entry.id],true,'delete',true);await cleanup.settled();
 expect(perform).not.toHaveBeenCalled();expect(cleanup.snapshot().result).toMatchObject({failed:1,deleted:0});
 expect(await readFile(join(outside,'keep'),'utf8')).toBe('keep');
});

it('attempts incomplete cleanup and reports a real permission failure without counting it as deleted',async()=>{
 const perform=vi.fn(async()=>{throw Object.assign(new Error('permission denied'),{code:'EACCES'});});
 const {cleanup,state,entry}=await fixture({deleteItem:perform});
 cleanup.clean(state.scanId!,[entry.id],true,'delete',true);await cleanup.settled();
 expect(perform).toHaveBeenCalledOnce();expect(cleanup.snapshot().result).toMatchObject({deleted:0,failed:1});
 expect(cleanup.snapshot().entries.find(item=>item.id===entry.id)).toMatchObject({state:'failed',issue:expect.stringContaining('权限')});
});
