import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GatewayContext,type ContextMigration} from '../packages/core/src/gateway-context.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const answer=(text='checkpoint: preserve original goal')=>Response.json({id:'fixture',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}],usage:{input_tokens:20,output_tokens:8}});
async function setup(){const root=await mkdtemp(join(tmpdir(),'hybrid-history-'));roots.push(root);return {root,context:await GatewayContext.open(root)};}
const history=[{role:'user',content:'Preserve the original goal.'},{role:'assistant',content:'Historical evidence. '.repeat(20000)},{role:'user',content:'Continue here.'}];
const migration:ContextMigration={threadId:'hybrid-thread',scope:{owner:'managed-codex',model:'portable',source:'portable'},contextWindowTokens:32000,recover:async()=>[],prepareHybridHistory:true};
it('organizes inherited hybrid history without a migration journal, including previously initialized sessions, and reuses it across models/restarts',async()=>{
 const {root,context}=await setup();
 await context.response('responses',{model:'old',input:[{role:'user',content:'Earlier short turn'}]},'key','source',async()=>answer(),{...migration,prepareHybridHistory:false});
 let summaries=0;const forwarded:any[]=[];
 const send=async(_path:string,body:any)=>{if(body.instructions?.startsWith('Summarize')){summaries++;expect(JSON.stringify(body).length).toBeLessThan(150000);return answer();}forwarded.push(body);return answer('continued');};
 const input=structuredClone(history);
 await context.response('responses',{model:'gateway-a',input,store:false},'key','source',send,migration);
 expect(summaries).toBeGreaterThan(1);expect(JSON.stringify(forwarded[0]).length).toBeLessThan(150000);expect(JSON.stringify(forwarded[0])).toContain('Continue here.');expect(input).toEqual(history);
 const count=summaries,reopened=await GatewayContext.open(root);
 await reopened.response('responses',{model:'gateway-b',input:[...input,{role:'user',content:'Next turn'}],store:false},'another-key','another-source',send,migration);
 expect(summaries).toBe(count);expect(JSON.stringify(forwarded.at(-1))).toContain('Next turn');
});
it('does not summarize a brand new hybrid chat or automatically compact later gateway turns',async()=>{
 const {context}=await setup();let summaries=0;const send=async(_p:string,b:any)=>{if(b.instructions?.startsWith('Summarize'))summaries++;return answer();};
 await context.response('responses',{model:'gateway',input:[{role:'user',content:'New request '.repeat(30000)}]},'k','s',send,migration);
 await context.response('responses',{model:'gateway',input:history},'k','s',send,migration);
 expect(summaries).toBe(0);
});
it('does not mark failed hybrid preparation complete or mutate the retained history',async()=>{
 const {context}=await setup(),input=structuredClone(history);let failures=0;
 const failed=async()=>{failures++;return Response.json({error:{code:'qoder_resource_limit'}},{status:429});};
 for(let n=0;n<2;n++)await expect(context.response('responses',{model:'gateway',input},'k','s',failed,migration)).rejects.toMatchObject({code:'compaction_upstream_failed'});
 expect(failures).toBeGreaterThanOrEqual(2);expect(input).toEqual(history);
});
it('prepares a newly expanded official checkpoint after the hybrid thread has already been used',async()=>{
 const {context}=await setup();let summaries=0;
 const send=async(_p:string,b:any)=>{if(b.instructions?.startsWith('Summarize'))summaries++;return answer();};
 const m={...migration,recover:async()=>structuredClone(history)};
 await context.response('responses',{model:'gateway',input:[{role:'user',content:'Fresh chat'}]},'k','s',send,m);
 const input=[{type:'compaction',encrypted_content:'new-official-opaque-checkpoint'},{role:'user',content:'Continue after official compaction'}];
 await context.response('responses',{model:'gateway',input},'k','s',send,m);expect(summaries).toBeGreaterThan(0);
 const previous=summaries;await context.response('responses',{model:'gateway',input},'k','s',send,m);expect(summaries).toBe(previous);
});
