import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile,readFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
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
