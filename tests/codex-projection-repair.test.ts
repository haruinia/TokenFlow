import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile,readFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {CodexRuntimeRPCError} from '../packages/core/src/codex-runtime.js';
import {repairCodexProjectionLineages} from '../packages/core/src/codex-projection-repair.js';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const home=await mkdtemp(join(await realpath(tmpdir()),'projection-lineage-'));roots.push(home);const db=new DatabaseSync(join(home,'thread_history_1.sqlite'));db.exec('CREATE TABLE thread_history_projection_state(thread_id text primary key,next_rollout_byte_offset integer,next_rollout_ordinal integer)');return {home,db,repair:{threadId:'logical',lastTurnId:'completed-turn',ancestors:[{id:'immutable-ancestor',ordinal:2,offset:120,boundaries:[0,50,120,180]}]}};}
it('uses only an ephemeral ThroughTurn fork and confirms native ancestor byte/ordinal coverage',async()=>{
 const {home,db,repair}=await fixture();await writeFile(join(home,'durable.jsonl'),'original durable history');const close=vi.fn(async()=>{}),rpc=vi.fn(async(method:string,_params:unknown)=>{if(method==='thread/fork'){db.prepare('insert into thread_history_projection_state values (?,?,?)').run('immutable-ancestor',180,3);return {thread:{id:'ephemeral',ephemeral:true}};}return {};});
 try{await repairCodexProjectionLineages(home,[repair],async()=>[123],async()=>{throw Error('must not create runtime while Codex is open');}).then(()=>{throw Error('expected live-process rejection');},error=>expect(error.statusCode).toBe(409));
 await repairCodexProjectionLineages(home,[repair],async()=>[],async()=>({pid:123,close,rpc}));
 expect(rpc.mock.calls).toEqual([['thread/fork',{threadId:'logical',lastTurnId:'completed-turn',ephemeral:true,excludeTurns:true,approvalPolicy:'never',sandbox:'read-only'}],['thread/unsubscribe',{threadId:'ephemeral'}]]);expect(close).toHaveBeenCalledOnce();expect(await readFile(join(home,'durable.jsonl'),'utf8')).toBe('original durable history');
 }finally{db.close();}
});
it.each(['missing','misaligned','incomplete'])('fails closed if native repair leaves %s ancestor projection',async mode=>{
 const {home,db,repair}=await fixture(),close=vi.fn(async()=>{});
 const rpc=async(method:string)=>{if(method==='thread/fork'){if(mode!=='missing')db.prepare('insert into thread_history_projection_state values (?,?,?)').run('immutable-ancestor',mode==='misaligned'?119:50,mode==='misaligned'?2:1);return {thread:{id:'ephemeral',ephemeral:true}};}return {};};
 try{await expect(repairCodexProjectionLineages(home,[repair],async()=>[],async()=>({pid:123,close,rpc}))).rejects.toMatchObject({statusCode:409,message:expect.stringContaining('祖先索引')});expect(close).toHaveBeenCalledOnce();}finally{db.close();}
});

it('recovers an invisible aborted leaf boundary using a visible terminal turn from the same thread',async()=>{
 const {home,db,repair}=await fixture();repair.lastTurnId='aborted-context-only';const close=vi.fn(async()=>{});let forks=0;
 const rpc=vi.fn(async(method:string,params:any)=>{
  if(method==='thread/fork'&&++forks===1)throw new CodexRuntimeRPCError(method,{code:-32600,message:'turn not found: synthetic-aborted'});
  if(method==='thread/turns/list')return {data:params.cursor?[{id:'visible-completed',status:'completed'}]:[{id:'live-turn',status:'inProgress'}],nextCursor:params.cursor?null:'next'};
  if(method==='thread/fork'){expect(params.lastTurnId).toBe('visible-completed');db.prepare('insert into thread_history_projection_state values (?,?,?)').run('immutable-ancestor',180,3);return {thread:{id:'ephemeral',ephemeral:true}};}return {};
 });
 try{await repairCodexProjectionLineages(home,[repair],async()=>[],async()=>({pid:123,close,rpc}));expect(forks).toBe(2);expect(rpc.mock.calls.filter(([method])=>method==='thread/turns/list')).toHaveLength(2);expect(rpc.mock.calls.every(([method])=>method!=='turn/start')).toBe(true);expect(close).toHaveBeenCalledOnce();}finally{db.close();}
});

it.each(['unknown-error','no-visible-turn','cursor-loop','new-process','retry-failed','unverified-projection'])('does not turn %s into a successful index repair',async mode=>{
 const {home,db,repair}=await fixture();const close=vi.fn(async()=>{});let forks=0,listed=false;
 const rpc=vi.fn(async(method:string)=>{
  if(method==='thread/fork'){
   if(++forks===1)throw new CodexRuntimeRPCError(method,{code:-32600,message:mode==='unknown-error'?'synthetic unknown error':'turn not found: synthetic-aborted'});
   if(mode==='retry-failed')throw Error('retry failed');return {thread:{id:'ephemeral',ephemeral:true}};
  }
  if(method==='thread/turns/list'){listed=true;return {data:mode==='no-visible-turn'||mode==='cursor-loop'?[]:[{id:'visible',status:'completed'}],nextCursor:mode==='cursor-loop'?'repeated':null};}return {};
 });
 try{await expect(repairCodexProjectionLineages(home,[repair],async()=>mode==='new-process'&&listed?[999]:[],async()=>({pid:123,close,rpc}))).rejects.toBeInstanceOf(Error);if(mode==='unknown-error')expect(listed).toBe(false);expect(forks).toBeLessThanOrEqual(2);expect(close).toHaveBeenCalledOnce();}finally{db.close();}
});

it.each(['success','fork-failed'])('preserves archived state after %s and journals restoration before unarchive',async mode=>{
 const {home,db,repair}=await fixture(),close=vi.fn(async()=>{});let forks=0;
 const rpc=vi.fn(async(method:string)=>{
  if(method==='thread/fork'){
   if(++forks===1)throw new CodexRuntimeRPCError(method,{code:-32600,message:'session 11111111-1111-1111-1111-111111111111 is archived. Run codex unarchive'});
   if(mode==='fork-failed')throw Error('synthetic fork failed');
   db.prepare('insert into thread_history_projection_state values (?,?,?)').run('immutable-ancestor',180,3);return {thread:{id:'ephemeral',ephemeral:true}};
  }
  if(method==='thread/unarchive')expect(JSON.parse(await readFile(join(home,'tokenflow-projection-archives.json'),'utf8'))).toEqual(['logical']);return {};
 });
 try{const result=repairCodexProjectionLineages(home,[repair],async()=>[],async()=>({pid:123,close,rpc}));if(mode==='fork-failed')await expect(result).rejects.toThrow('synthetic fork failed');else await result;
 expect(rpc.mock.calls.map(([method])=>method)).toEqual(mode==='success'?['thread/fork','thread/unarchive','thread/fork','thread/unsubscribe','thread/archive']:['thread/fork','thread/unarchive','thread/fork','thread/archive']);await expect(readFile(join(home,'tokenflow-projection-archives.json'))).rejects.toMatchObject({code:'ENOENT'});expect(close).toHaveBeenCalledOnce();}finally{db.close();}
});
it('retains failed archive restoration for a later invocation even when no repair remains',async()=>{
 const {home,db,repair}=await fixture();let forks=0;const close=vi.fn(async()=>{});
 const rpc=async(method:string)=>{if(method==='thread/fork'){if(++forks===1)throw new CodexRuntimeRPCError(method,{code:-32600,message:'session abc is archived.'});return {thread:{id:'ephemeral',ephemeral:true}};}if(method==='thread/archive')throw Error('archive temporarily failed');return {};};
 try{await expect(repairCodexProjectionLineages(home,[repair],async()=>[],async()=>({pid:123,close,rpc}))).rejects.toThrow('archive temporarily failed');expect(JSON.parse(await readFile(join(home,'tokenflow-projection-archives.json'),'utf8'))).toEqual(['logical']);
 const recovered=vi.fn(async()=>({}));await repairCodexProjectionLineages(home,[],async()=>[],async()=>({pid:123,close,rpc:recovered}));expect(recovered.mock.calls).toEqual([['thread/archive',{threadId:'logical'}]]);await expect(readFile(join(home,'tokenflow-projection-archives.json'))).rejects.toMatchObject({code:'ENOENT'});}finally{db.close();}
});
