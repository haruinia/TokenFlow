import {join} from 'node:path';
import {readdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {codexRuntimeClient} from './codex-runtime.js';
import {GatewayContextError} from './gateway-context.js';
import {safePath} from './agent-connections.js';
export type CodexProjectionRepair={threadId:string;lastTurnId:string;ancestors:{id:string;ordinal:number;offset:number;boundaries:number[]}[]};
/** Codex prepare_fork(ThroughTurn) materializes every immutable ancestor before
 * looking up the boundary. An ephemeral fork creates no durable thread and no
 * turn is started. Use Codex's own projector rather than copying stale DB rows.
 * Source: openai/codex 970111f thread-store/src/local/paginated_fork.rs:52. */
export async function repairCodexProjectionLineages(home:string,repairs:CodexProjectionRepair[],processes:()=>Promise<number[]>,runtimeFactory:typeof codexRuntimeClient=codexRuntimeClient){
 const fail=()=>new GatewayContextError('Codex 历史祖先索引未确认完整恢复；原始历史和备份保留，请退出 Codex 后重试。',409);
 if((await processes()).length)throw fail();
 const runtime=await runtimeFactory(home);
 try{
  for(const repair of repairs){
   if((await processes()).some(pid=>pid!==runtime.pid))throw fail();
   const fork=await runtime.rpc('thread/fork',{threadId:repair.threadId,lastTurnId:repair.lastTurnId,ephemeral:true,excludeTurns:true,approvalPolicy:'never',sandbox:'read-only'});
   if(typeof fork.thread?.id!=='string'||fork.thread.id===repair.threadId||fork.thread.ephemeral!==true)throw fail();
   await runtime.rpc('thread/unsubscribe',{threadId:fork.thread.id});
  }
 }finally{await runtime.close();}
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
