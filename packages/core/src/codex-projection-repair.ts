import {join} from 'node:path';
import {readdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {codexRuntimeClient,CodexRuntimeRPCError} from './codex-runtime.js';
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
   const idle=async()=>{if((await processes()).some(pid=>pid!==runtime.pid))throw fail();};
   const forkAt=(lastTurnId:string)=>runtime.rpc('thread/fork',{threadId:repair.threadId,lastTurnId,ephemeral:true,excludeTurns:true,approvalPolicy:'never',sandbox:'read-only'});
   let fork;
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
