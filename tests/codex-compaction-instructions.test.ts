import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GatewayContext,type ContextMigration} from '../packages/core/src/gateway-context.js';
import {codexContextScope,portableCodexItem} from '../packages/core/src/codex-context.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const message=(role:string,text:string)=>({type:'message',role,content:[{type:role==='assistant'?'output_text':'input_text',text}]});
const oldRules=Array.from({length:12},(_,i)=>message('developer',`<skills_instructions>OLD_ENVIRONMENT_${i}: preserve public API. ${'old tool catalog '.repeat(1500)}</skills_instructions>`));
const current=message('developer','<app-context>CURRENT_ENVIRONMENT: sandbox read-only; use current tools.</app-context>');
const work=Array.from({length:12},(_,i)=>message('assistant',`Completed work ${i}. ${'verified '.repeat(400)}`));
const scope=codexContextScope;
async function setup(){
 const root=await mkdtemp(join(tmpdir(),'codex-compact-rules-'));roots.push(root);
 const context=await GatewayContext.open(root),sent:Record<string,any>[]=[];
 const send=async(_path:string,body:Record<string,any>)=>{sent.push(body);return Response.json({status:'completed',output:[message('assistant','CHECKPOINT: preserve public API; work verified; continue current task.')],usage:{input_tokens:100,output_tokens:20,total_tokens:120}});};
 const checkpoint={type:'compaction',encrypted_content:context.encodeCheckpoint([...oldRules,message('user','Keep API compatible.'),...work],scope)};
 const migration:ContextMigration={scope,rebuildsInstructions:true,normalize:portableCodexItem,recover:async()=>{throw Error('unexpected recovery');}};
 return {root,context,sent,send,checkpoint,migration};
}
it('does not carry every historical environment snapshot as fixed overhead after managed Codex compaction',async()=>{
 const f=await setup();const tools=[{type:'function',name:'exec',description:'fixed tool declarations '.repeat(28000),parameters:{type:'object'}}];
 const before=JSON.stringify(f.checkpoint);
 const compact=await(await f.context.response('responses',{model:'deepseek',input:[current,f.checkpoint,...work,{type:'compaction_trigger'}],tools,store:false},'k','s',f.send,f.migration)).json();
 const restored=f.context.decodeCheckpoint(compact.output[0].encrypted_content,[scope]);
 // The source receives historical constraints for summarization, never silently discards them.
 expect(JSON.stringify(f.sent.map(b=>b.input)).includes('OLD_ENVIRONMENT_0')).toBe(true);
 expect(restored.filter(item=>item.role==='developer')).toEqual([current]);
 expect(JSON.stringify(restored)).toContain('preserve public API');
 const restarted=await GatewayContext.open(f.root);
 await restarted.response('responses',{model:'deepseek',input:[current,...compact.output],tools,store:false},'k','s',f.send,f.migration);
 const next=f.sent.at(-1)!;
 expect(next.tools).toEqual(tools);expect(next.input.filter((item:any)=>item.role==='developer')).toEqual([current]);
 // Structural budget regression: historical snapshots must not consume the
 // headroom again. This byte bound is not a claim about a provider tokenizer.
 expect(Buffer.byteLength(JSON.stringify(next.input))).toBeLessThan(48*1024);
 expect(JSON.stringify(f.checkpoint)).toBe(before);
 const official=await restarted.forOfficial({model:'official',input:[current,...compact.output]},[scope],portableCodexItem);
 expect(official.input.filter(item=>item.role==='developer')).toEqual([current]);
});
it.each([false,true])('retains checkpoint rules when no current native replacement is supplied (managed=%s)',async managed=>{
 const f=await setup();
 const compact=await(await f.context.response('responses/compact',{model:'deepseek',input:[f.checkpoint,...work],store:false},'k','s',f.send,managed?f.migration:{scope, recover:async()=>{throw Error('unexpected');}})).json();
 const restored=f.context.decodeCheckpoint(compact.output.at(-1).encrypted_content,[scope]);
 expect(restored.filter(item=>item.role==='developer')).toEqual(oldRules);
});
it('keeps unknown developer rules and system instructions verbatim, including after model changes',async()=>{
 const f=await setup(),custom=message('developer','CUSTOM_CONSTRAINT: never change the billing currency.'),system=message('system','Keep tenant isolation.');
 const checkpoint={type:'compaction',encrypted_content:f.context.encodeCheckpoint([...oldRules,custom,system,...work],scope)};
 const compact=await(await f.context.response('responses/compact',{model:'deepseek',input:[current,checkpoint,...work],store:false},'k','s',f.send,f.migration)).json();
 const restored=f.context.decodeCheckpoint(compact.output.at(-1).encrypted_content,[scope]);
 expect(restored).toContainEqual(custom);expect(restored).toContainEqual(system);
 expect(restored.filter(item=>item.role==='developer')).toEqual([custom,current]);
 const resumed=await GatewayContext.open(f.root);
 await resumed.response('responses',{model:'another-gateway',input:[current,...compact.output],store:false},'other-key','other-source',f.send,f.migration);
 expect(f.sent.at(-1)!.input).toContainEqual(custom);expect(f.sent.at(-1)!.input).toContainEqual(system);
});
it('does not interpret a timestamp update or ordinary API developer message as a rebuilt native environment',async()=>{
 const f=await setup();
 for(const [rules,migration] of [[message('developer','<codex_apps_client_time_context>today</codex_apps_client_time_context>'),f.migration],[current,{...f.migration,rebuildsInstructions:false}]] as const){
  const result=await(await f.context.response('responses/compact',{model:'deepseek',input:[rules,f.checkpoint,...work],store:false},'k','s',f.send,migration)).json();
  expect(f.context.decodeCheckpoint(result.output.at(-1).encrypted_content,[scope]).filter(i=>i.role==='developer')).toHaveLength(oldRules.length+1);
 }
});
it('leaves the original checkpoint usable after a failed consolidation and retains unknown history',async()=>{
 const f=await setup(),before=JSON.stringify(f.checkpoint);let calls=0;
 await expect(f.context.response('responses/compact',{model:'deepseek',input:[current,f.checkpoint,...work],store:false},'k','s',async(p,b)=>++calls===2?Response.json({error:{message:'Unavailable'}},{status:503}):f.send(p,b),f.migration)).rejects.toMatchObject({code:'compaction_upstream_failed'});
 expect(JSON.stringify(f.checkpoint)).toBe(before);
 const resumed=await GatewayContext.open(f.root);
 await resumed.response('responses',{model:'deepseek',input:[current,f.checkpoint],store:false},'k','s',f.send,f.migration);
 expect(f.sent.at(-1)!.input.filter((i:any)=>i.role==='developer')).toHaveLength(oldRules.length+1);
});
it('does not accumulate old environments over repeated compaction and model switches',async()=>{
 const f=await setup();let checkpoint=f.checkpoint;
 for(let round=0;round<3;round++){
  const active=message('developer',`<app-context>Current environment ${round}; read-only.</app-context>`);
  const compact=await(await f.context.response('responses/compact',{model:`gateway-${round}`,input:[active,checkpoint,...work],store:false},'k','s',f.send,f.migration)).json();
  checkpoint=compact.output.at(-1);
  const restored=f.context.decodeCheckpoint(checkpoint.encrypted_content,[scope]);
  expect(restored.filter(item=>item.role==='developer')).toEqual([active]);
  expect(Buffer.byteLength(JSON.stringify(restored))).toBeLessThan(48*1024);
 }
});
