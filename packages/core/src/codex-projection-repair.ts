import {join} from 'node:path';
import {readdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {codexRuntimeClient,CodexRuntimeRPCError} from './codex-runtime.js';
import {GatewayContextError} from './gateway-context.js';
import {safePath} from './agent-connections.js';
export type CodexProjectionRepair={threadId:string;lastTurnId:string;ancestors:{id:string;ordinal:number;offset:number;boundaries:number[]}[]};

const archiveJournal=(home:string)=>join(home,'tokenflow-projection-archives.json');
export async function pendingProjectionArchives(home:string):Promise<string[]>{
 const path=archiveJournal(home);await safePath(path);
 try{const value=JSON.parse(await readFile(path,'utf8'));if(!Array.isArray(value)||value.some(id=>typeof id!=='string'||!id.length||id.length>200))throw Error('invalid archive journal');return value;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw new GatewayContextError('历史索引归档恢复记录无法读取，原记录和备份保留。',409);}
}

/** Codex prepare_fork(ThroughTurn) materializes every immutable ancestor before
 * looking up the boundary. An ephemeral fork creates no durable thread and no
 * turn is started. Use Codex's own projector rather than copying stale DB rows.
 * Source: openai/codex 970111f thread-store/src/local/paginated_fork.rs:52. */
export async function repairCodexProjectionLineages(home:string,repairs:CodexProjectionRepair[],processes:()=>Promise<number[]>,runtimeFactory:typeof codexRuntimeClient=codexRuntimeClient){
 const fail=()=>new GatewayContextError('Codex 历史祖先索引未确认完整恢复；原始历史和备份保留，请退出 Codex 后重试。',409);
 if((await processes()).length)throw fail();
 const pending=new Set(await pendingProjectionArchives(home));
 const saveArchives=async()=>{const path=archiveJournal(home);await safePath(path);if(!pending.size){await rm(path,{force:true});return;}const temp=path+'.'+randomUUID();try{await writeFile(temp,JSON.stringify([...pending]),{mode:0o600,flag:'wx'});await rename(temp,path);}finally{await rm(temp,{force:true});}};
 const runtime=await runtimeFactory(home);
 const idle=async()=>{if((await processes()).some(pid=>pid!==runtime.pid))throw fail();};
 const restoreArchive=async(id:string)=>{await idle();await runtime.rpc('thread/archive',{threadId:id});pending.delete(id);await saveArchives();};
 try{
  for(const id of [...pending])await restoreArchive(id);
  for(const repair of repairs){
   if((await processes()).some(pid=>pid!==runtime.pid))throw fail();
   const forkAt=async(lastTurnId:string)=>{
    const params={threadId:repair.threadId,lastTurnId,ephemeral:true,excludeTurns:true,approvalPolicy:'never',sandbox:'read-only'};
    try{return await runtime.rpc('thread/fork',params);}catch(error){
     if(!(error instanceof CodexRuntimeRPCError)||error.rpcReason!=='thread_archived')throw error;
     await idle();pending.add(repair.threadId);await saveArchives();
     await runtime.rpc('thread/unarchive',{threadId:repair.threadId});await idle();
     return await runtime.rpc('thread/fork',params);
    }
   };
   let fork;
   try{
   try{fork=await forkAt(repair.lastTurnId);}catch(error){
    // A persisted turn_context may belong to an aborted draft and have no
    // visible turn. ThroughTurn has already materialized the ancestors before
    // checking this boundary. Ask Codex for a real terminal turn from this same
    // lineage, then retry once; never guess another ID or skip this thread.
    if(!(error instanceof CodexRuntimeRPCError)||error.rpcMethod!=='thread/fork'||error.rpcReason!=='turn_not_found')throw error;
    let cursor:string|undefined,boundary:string|undefined;const seen=new Set<string>();
    for(let page=0;page<8&&!boundary;page++){
     await idle();const result=await runtime.rpc('thread/turns/list',{threadId:repair.threadId,limit:100,sortDirection:'desc',...(cursor?{cursor}:{})});
     if(!Array.isArray(result.data))throw fail();
     boundary=result.data.find((turn:{id?:unknown;status?:unknown})=>typeof turn.id==='string'&&turn.id.length>0&&turn.id.length<=200&&turn.id!==repair.lastTurnId&&['completed','failed','interrupted'].includes(String(turn.status)))?.id;
     if(boundary)break;
     if(!result.nextCursor)break;
     if(typeof result.nextCursor!=='string'||seen.has(result.nextCursor))throw fail();seen.add(result.nextCursor);cursor=result.nextCursor;
    }
    if(!boundary)throw fail();await idle();fork=await forkAt(boundary);
   }
   if(typeof fork.thread?.id!=='string'||fork.thread.id===repair.threadId||fork.thread.ephemeral!==true)throw fail();
   await runtime.rpc('thread/unsubscribe',{threadId:fork.thread.id});
   }finally{if(pending.has(repair.threadId))await restoreArchive(repair.threadId);}
  }
 }finally{await runtime.close();}
 if(!repairs.length)return;
 const name=(await readdir(home)).filter(name=>/^thread_history_\d+\.sqlite$/.test(name)).sort((a,b)=>Number(b.match(/\d+/)![0])-Number(a.match(/\d+/)![0]))[0];
 if(!name)throw fail();
 {
  const path=join(home,name);await safePath(path);const db=new DatabaseSync(path,{readOnly:true});
  try{
   const lookup=db.prepare('SELECT next_rollout_byte_offset AS offset,next_rollout_ordinal AS ordinal FROM thread_history_projection_state WHERE thread_id=?');
   for(const {ancestors} of repairs)for(const ancestor of ancestors){
    const state=lookup.get(ancestor.id);if(!state)throw fail();
    const ordinal=Number(state.ordinal),offset=Number(state.offset);
    if(!Number.isSafeInteger(ordinal)||!Number.isSafeInteger(offset)||ordinal<ancestor.ordinal||offset<ancestor.offset||ancestor.boundaries[ordinal]!==offset)throw fail();
   }
  }finally{db.close();}
 }
}
