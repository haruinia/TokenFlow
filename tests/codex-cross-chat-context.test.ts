import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GatewayContext} from '../packages/core/src/gateway-context.js';
import {codexContextScope,portableCodexItem} from '../packages/core/src/codex-context.js';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it('represents standalone native outputs as attributed data without changing paired results',()=>{
 const paired={type:'function_call_output',call_id:'actual-call',output:'Result'};
 expect(portableCodexItem(paired)).toEqual([paired]);
 const notice={type:'function_call_output',call_id:null,name:'notification',namespace:'external',output:[{type:'text',text:'Keep all notification content.'}]};
 expect(portableCodexItem(notice)).toEqual([{type:'message',role:'user',content:[{type:'input_text',text:'External tool notification from external.notification:'},{type:'input_text',text:'Keep all notification content.'}]}]);
 expect(notice.output[0].type).toBe('text');
});
it('still rejects a real unmatched tool result at the Codex boundary',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tf-cross-chat-'));roots.push(root);const context=await GatewayContext.open(root);
 await expect(context.response('responses/compact',{model:'deepseek-fixture',input:[{type:'function_call_output',call_id:'missing-call',output:'Result'}]},'key','source',async()=>{throw Error('Must not call upstream');},{scope:codexContextScope,normalize:portableCodexItem,recover:async()=>[]})).rejects.toThrow('Tool result has no matching call');
});
it('compacts and resumes Codex cross-chat delivery without inventing a tool call',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tf-cross-chat-'));roots.push(root);
 const context=await GatewayContext.open(root);
 // Shape observed in installed Codex rollouts; the task text is synthetic.
 const delivery={type:'function_call_output',id:'delivery-fixture',name:'send_message_to_thread',namespace:'codex_app',output:'Read-only task: remember DELIVERY_MARKER_731.',internal_chat_message_metadata_passthrough:{turn_id:'turn-fixture',create_time:1793088542}};
 const input=[{role:'user',content:'Remember OLD_MARKER.'},{role:'assistant',content:'Earlier work. '.repeat(1500)},...Array.from({length:8},()=>({role:'assistant',content:'Completed a step.'})),delivery];
 const migration={scope:codexContextScope,normalize:portableCodexItem,recover:async()=>[]};
 const response=await context.response('responses',{model:'deepseek-fixture',input:[...input,{type:'compaction_trigger'}]},'key','source',async()=>Response.json({id:'summary',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Remember OLD_MARKER.'}]}]}),migration);
 const compact=await response.json();expect(compact.output.at(-1).type).toBe('compaction');
 let forwarded:any;
 await context.response('responses',{model:'deepseek-fixture',input:[...compact.output,{role:'user',content:'Continue.'}]},'key','source',async(_path,body)=>{forwarded=body.input;return Response.json({id:'answer',status:'completed',output:[]});},migration);
 expect(JSON.stringify(forwarded)).toContain('DELIVERY_MARKER_731');
 expect(forwarded.some((item:any)=>item.type==='function_call_output')).toBe(false);
 expect(forwarded.some((item:any)=>item.type==='function_call')).toBe(false);
});
