import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {GatewayContext} from '../packages/core/src/gateway-context.js';import {codexContextScope} from '../packages/core/src/codex-context.js';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const input=[{role:'user',content:'SYNTHETIC_OLD_TASK'},{role:'assistant',content:'completed work '.repeat(2000)},...Array.from({length:8},()=>({role:'assistant',content:'tail'}))];
const success=()=>Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'HEALTHY_SUMMARY'}]}],usage:{input_tokens:1,output_tokens:1}});
const migration={scope:codexContextScope,recover:async()=>[]};
function gate(){let release!:()=>void;return {wait:new Promise<void>(resolve=>release=resolve),release:()=>release()};}
it.each(['same','source','model','owner'])('separates active attempt scope by %s while completed managed summaries stay portable',async difference=>{
 const root=await mkdtemp(join(tmpdir(),'summary-scope-'));roots.push(root);const context=await GatewayContext.open(root),started=gate(),finish=gate();let callsA=0,callsB=0;
 const first=context.response('responses/compact',{model:'qoder/A',input},'owner-A','source-A',async()=>{callsA++;started.release();await finish.wait;return difference==='same'?success():Response.json({error:{code:'qoder_resource_limit'}},{status:429});},migration).then(response=>({ok:response.ok}),error=>({code:error.code,status:error.statusCode}));
 await started.wait;
 // Observe the second lookup itself, so the owner cannot finish before this
 // request has reached the concurrency boundary. No sleep or timing race.
 const lookup=gate(),pending=(context as unknown as {pending:Map<string,Promise<string>>}).pending,original=pending.get.bind(pending);
 const spy=vi.spyOn(pending,'get').mockImplementation(key=>{lookup.release();return original(key);});
 const second=context.response('responses/compact',{model:difference==='model'?'qoder/B':'qoder/A',input},difference==='owner'?'owner-B':'owner-A',difference==='source'?'source-B':'source-A',async()=>{callsB++;return success();},migration);
 await lookup.wait;finish.release();
 if(difference==='same'){expect(await first).toEqual({ok:true});expect((await second).ok).toBe(true);expect(callsB).toBe(0);}
 else{expect(await first).toEqual({code:'compaction_upstream_failed',status:429});expect((await second).ok).toBe(true);expect(callsB).toBe(1);}
 spy.mockRestore();expect(callsA).toBe(1);
 const restarted=await GatewayContext.open(root);let extra=0;
 expect((await restarted.response('responses/compact',{model:'another/C',input},'owner-C','source-C',async()=>{extra++;return success();},migration)).ok).toBe(true);expect(extra).toBe(0);
});
