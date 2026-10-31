import {AsyncLocalStorage} from 'node:async_hooks';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import lockfile from 'proper-lockfile';
import {safePath} from './agent-connections.js';
import {RunnerCoreError} from './errors.js';
type Lease={lost?:Error};
const leases=new AsyncLocalStorage<Map<string,Lease>>();
const busy=()=>new RunnerCoreError('另一个对话备份或迁移操作正在进行，请稍后重试。',{statusCode:409,code:'codex_backup_busy'});
export function assertCodexBackupLock(root:string){if(leases.getStore()?.get(resolve(root))?.lost)throw busy();}
/** One cross-process, heartbeat-backed lock covers publication and collection.
 * Reentrant only within the owning async operation, not another HTTP request. */
export async function withCodexBackupLock<T>(root:string,work:()=>Promise<T>):Promise<T>{
 const path=resolve(root),current=leases.getStore();
 if(current?.has(path)){assertCodexBackupLock(path);return work();}
 await safePath(path);await mkdir(path,{recursive:true,mode:0o700});
 const lease:Lease={};let release:()=>Promise<void>;
 try{release=await lockfile.lock(path,{realpath:false,lockfilePath:join(path,'.codex-backup.lock'),retries:0,stale:120000,update:10000,onCompromised:error=>{lease.lost=error;}});}
 catch(error){if((error as NodeJS.ErrnoException).code==='ELOCKED')throw busy();throw error;}
 const owned=new Map(current);owned.set(path,lease);
 try{return await leases.run(owned,async()=>{const result=await work();assertCodexBackupLock(path);return result;});}
 finally{if(!lease.lost)await release();}
}
