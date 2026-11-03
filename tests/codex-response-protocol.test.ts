import {it,expect} from 'vitest';
import {codexGatewayResponse,isGatewayCodexItem} from '../packages/core/src/codex-response-protocol.js';
const msg=(id:string,phase?:string)=>({type:'message',id,role:'assistant',...(phase?{phase}:{}),content:[{type:'output_text',text:'visible answer'}]});
const call={type:'function_call',id:'fc_source',call_id:'pair_must_stay',name:'read',arguments:'{}'};
async function stream(output:any[],status='completed'){
 const events=[{type:'response.created',response:{status:'in_progress',output:[]}},...output.flatMap((item,output_index)=>[{type:'response.output_item.added',output_index,item:{...item,content:[]}},{type:'response.output_text.delta',output_index,item_id:item.id,delta:'visible answer'},{type:'response.output_item.done',output_index,item}]),{type:status==='completed'?'response.completed':'response.incomplete',response:{status,output}}];
 const response=new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 return (await codexGatewayResponse(response).text()).split('\n').filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5)));
}
it('marks tool preambles commentary and the later answer final, keeping stream item identities and tool pairs',async()=>{
 const first=await stream([msg('msg_one'),call]);
 expect(first.find(e=>e.type==='response.output_item.done').item.phase).toBe('commentary');
 expect(first.at(-1).response.output[1].call_id).toBe('pair_must_stay');
 const final=await stream([msg('msg_last')]);
 const added=final.find(e=>e.type==='response.output_item.added').item,done=final.find(e=>e.type==='response.output_item.done').item;
 expect(isGatewayCodexItem(done)).toBe(true);expect(added.id).toBe(done.id);expect(final.find(e=>e.type==='response.output_text.delta').item_id).toBe(done.id);
 expect(done.phase).toBe('final_answer');expect(final.at(-1).response.output[0]).toEqual(done);
 expect(final.map(e=>e.sequence_number)).toEqual(final.map((_,i)=>i));
});
it('preserves explicit native phases and never labels an incomplete answer as final',async()=>{
 expect((await stream([msg('a','commentary')])).at(-1).response.output[0].phase).toBe('commentary');
 expect((await stream([msg('a')],'incomplete')).find(e=>e.type==='response.output_item.done').item.phase).toBe('commentary');
});
it('applies the same boundary to JSON, with stable provenance and no fake successful terminal on disconnect',async()=>{
 const result=await codexGatewayResponse(Response.json({status:'completed',output:[msg('a'),call]})).json();
 expect(result.output[0].phase).toBe('commentary');expect(result.output[1].call_id).toBe(call.call_id);
 const partial=new Response('data: '+JSON.stringify({type:'response.output_item.done',item:msg('a')})+'\n\n',{headers:{'content-type':'text/event-stream'}});
 const text=await codexGatewayResponse(partial).text();expect(text).toContain('incomplete_stream');expect(text).not.toContain('final_answer');
});
it('keeps text streaming before the terminal decision and propagates cancellation upstream',async()=>{
 let cancelled=false;const encoder=new TextEncoder();
 const source=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(encoder.encode('data: '+JSON.stringify({type:'response.output_text.delta',item_id:'msg_live',delta:'live text'})+'\n\n'));},cancel(){cancelled=true;}});
 const response=codexGatewayResponse(new Response(source,{headers:{'content-type':'text/event-stream'}}));const reader=response.body!.getReader();
 expect(new TextDecoder().decode((await reader.read()).value)).toContain('live text');await reader.cancel();expect(cancelled).toBe(true);
});
it('honors an explicit terminal-output phase even when the source omitted it on item done',async()=>{
 const item=msg('late_phase');const events=[{type:'response.output_item.done',item,output_index:0},{type:'response.completed',response:{status:'completed',output:[{...item,phase:'commentary'}]}}];
 const response=new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 const parsed=(await codexGatewayResponse(response).text()).split('\n').filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5)));
 expect(parsed[0].item.phase).toBe('commentary');expect(parsed[1].response.output[0].phase).toBe('commentary');
});
it('allows a completed server search to end with a final answer',async()=>{
 const output=[{type:'web_search_call',id:'search',status:'completed'},msg('answer')];
 expect((await codexGatewayResponse(Response.json({status:'completed',output})).json()).output[1].phase).toBe('final_answer');
 expect((await stream(output)).at(-1).response.output[1].phase).toBe('final_answer');
});
it('retains an explicit item-done phase when terminal output omits it',async()=>{
 const item=msg('earlier','commentary'),terminal=msg('earlier');
 const response=new Response([{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{status:'completed',output:[terminal]}}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 const events=(await codexGatewayResponse(response).text()).split('\n').filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5)));
 expect(events.at(-1).response.output[0].phase).toBe('commentary');
});
it('marks ID-less gateway reasoning with consistent index-based identity',async()=>{
 const reasoning={type:'reasoning',encrypted_content:'foreign-ciphertext',summary:[]};
 const events=[{type:'response.output_item.added',output_index:0,item:reasoning},{type:'response.output_item.done',output_index:0,item:reasoning},{type:'response.completed',response:{status:'completed',output:[reasoning]}}];
 const response=new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 const values=(await codexGatewayResponse(response).text()).split('\n').filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5)));
 expect(isGatewayCodexItem(values[0].item)).toBe(true);expect(values[1].item.id).toBe(values[0].item.id);expect(values[2].response.output[0].id).toBe(values[0].item.id);
 expect(isGatewayCodexItem((await codexGatewayResponse(Response.json({status:'completed',output:[reasoning]})).json()).output[0])).toBe(true);
});
it('propagates cancellation while an unfinished JSON response is being read',async()=>{
 let cancelled=false;const source=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}});
 const response=codexGatewayResponse(new Response(source,{headers:{'content-type':'application/json'}}));const reader=response.body!.getReader();const pending=reader.read();await reader.cancel();await pending;expect(cancelled).toBe(true);
});
it('does not freeze a nonterminal snapshot fallback as an explicit commentary phase',async()=>{
 const item=msg('snapshot');
 const events=[{type:'response.in_progress',response:{status:'in_progress',output:[item]}},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{status:'completed',output:[item]}}];
 const response=new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 const parsed=(await codexGatewayResponse(response).text()).split('\n').filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5)));
 expect(parsed.find(e=>e.type==='response.output_item.done').item.phase).toBe('final_answer');expect(parsed.at(-1).response.output[0].phase).toBe('final_answer');
});
