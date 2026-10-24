import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,realpath,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {GatewayContext} from '../packages/core/src/gateway-context.js';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const encode=(event:unknown)=>new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n');
const created={type:'response.created',response:{id:'upstream',status:'in_progress',output:[]}};
const completed={type:'response.completed',response:{id:'upstream',status:'completed',output:[],usage:{input_tokens:1,output_tokens:0}}};
async function setup(){const root=await mkdtemp(join(await realpath(tmpdir()),'stream-failure-'));roots.push(root);return {root,context:await GatewayContext.open(root)};}
async function collect(response:Response){const reader=response.body!.getReader();let text='',rejected=false;try{for(;;){const part=await reader.read();if(part.done)break;text+=new TextDecoder().decode(part.value);}}catch{rejected=true;}finally{reader.releaseLock();}return {text,rejected};}
it.each(['reset','invalid-json','eof','done-marker'])('ends %s failures with one typed error and no success history',async mode=>{
 const {root,context}=await setup();let count=0;const onError=vi.fn();const source=new ReadableStream<Uint8Array>({pull(controller){if(!count++)controller.enqueue(encode(created));else if(mode==='reset')controller.error(Error('PRIVATE_SOURCE_ERROR'));else{if(mode==='done-marker')controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));if(mode==='invalid-json')controller.enqueue(new TextEncoder().encode('data: {invalid-json}\n\n'));controller.close();}}},{highWaterMark:0});
 const response=await context.response('responses',{model:'qoder/test',input:'synthetic',stream:true},'key','source',async()=>new Response(source,{headers:{'content-type':'text/event-stream'}}),undefined,{onError});
 const result=await collect(response);expect(result.rejected).toBe(false);expect(result.text).toContain(mode==='invalid-json'?'invalid_stream_event':'incomplete_stream');expect(result.text).not.toContain('PRIVATE_SOURCE_ERROR');expect(result.text).not.toContain('[DONE]');expect(result.text).not.toContain('response.completed');expect(onError).toHaveBeenCalledTimes(1);expect(source.locked).toBe(false);
 expect((await readdir(join(root,'gateway-context'))).some(name=>name.startsWith('resp_tf_'))).toBe(false);
});
it('reports persistence failures before forwarding a completed event without exposing the local path',async()=>{
 const {root,context}=await setup(),onError=vi.fn();await rm(join(root,'gateway-context'),{recursive:true});await writeFile(join(root,'gateway-context'),'synthetic file blocking the private history directory');
 const response=await context.response('responses',{model:'qoder/test',input:'synthetic',stream:true},'key','source',async()=>new Response(encode(completed),{headers:{'content-type':'text/event-stream'}}),undefined,{onError});
 const result=await collect(response);expect(result.rejected).toBe(false);expect(result.text).toContain('context_persistence_failed');expect(result.text).not.toContain(root);expect(result.text).not.toContain('response.completed');expect(onError).toHaveBeenCalledTimes(1);
});
it('closes at a terminal event even if the source stays open and does not report trailing failures',async()=>{
 const {context}=await setup(),onError=vi.fn(),onCancel=vi.fn(),cancel=vi.fn();
 const source=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(encode(completed));},cancel});
 const response=await context.response('responses',{model:'qoder/test',input:'synthetic',stream:true},'key','source',async()=>new Response(source,{headers:{'content-type':'text/event-stream'}}),undefined,{onError,onCancel});
 const reader=response.body!.getReader();try{expect(new TextDecoder().decode((await reader.read()).value)).toContain('response.completed');const next=await Promise.race([reader.read(),new Promise<null>(resolve=>setTimeout(()=>resolve(null),100))]);expect(next?.done).toBe(true);expect(cancel).toHaveBeenCalledOnce();expect(onError).not.toHaveBeenCalled();expect(onCancel).not.toHaveBeenCalled();}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
});
it('honors consumer backpressure and cancellation without synthesizing a source failure',async()=>{
 const {root,context}=await setup(),onError=vi.fn(),onCancel=vi.fn(),cancel=vi.fn();let pulls=0;
 const source=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(encode({...created,sequence_number:pulls}));},cancel},{highWaterMark:0});
 const response=await context.response('responses',{model:'qoder/test',input:'synthetic',stream:true},'key','source',async()=>new Response(source,{headers:{'content-type':'text/event-stream'}}),undefined,{onError,onCancel});
 await new Promise(resolve=>setTimeout(resolve,0));expect(pulls).toBeLessThanOrEqual(1);
 const reader=response.body!.getReader();await reader.read();await reader.cancel('synthetic cancellation');reader.releaseLock();expect(cancel).toHaveBeenCalledOnce();expect(onCancel).toHaveBeenCalledOnce();expect(onError).not.toHaveBeenCalled();expect(source.locked).toBe(false);
 expect((await readdir(join(root,'gateway-context'))).some(name=>name.startsWith('resp_tf_'))).toBe(false);
});
it.each(['response.failed','error'])('reports one %s terminal failure and never forwards a later success',async type=>{
 const {root,context}=await setup(),onError=vi.fn();const error={code:'qoder_resource_limit',message:'private source text'};
 const failed=type==='error'?{type,error,sequence_number:11}:{type,sequence_number:11,response:{status:'failed',status_code:429,output:[],usage:{input_tokens:12,output_tokens:3},error}};
 const payload=new Uint8Array([...encode(created),...encode(failed),...encode(completed)]);
 const response=await context.response('responses',{model:'qoder/test',input:'synthetic',stream:true},'key','source',async()=>new Response(payload,{headers:{'content-type':'text/event-stream'}}),undefined,{onError});
 const result=await collect(response);expect(result.rejected).toBe(false);expect(onError).toHaveBeenCalledTimes(1);expect(onError.mock.calls[0][0]).toMatchObject({statusCode:429,code:'qoder_resource_limit'});expect(result.text).not.toContain('private source text');expect(result.text).toContain('qoder_resource_limit');if(type==='response.failed'){const event=JSON.parse(result.text.split('data: ').at(-1)!);expect(event.response).toMatchObject({status:'failed',status_code:429,usage:{input_tokens:12,output_tokens:3}});}expect(result.text).not.toContain('response.completed');expect((await readdir(join(root,'gateway-context'))).some(name=>name.startsWith('resp_tf_'))).toBe(false);
});
it('uses a generated failure sequence after the last source sequence',async()=>{
 const {context}=await setup();const response=await context.response('responses',{model:'qoder/test',input:'synthetic',stream:true},'key','source',async()=>new Response(encode({...created,sequence_number:29}),{headers:{'content-type':'text/event-stream'}}));
 const result=await collect(response),events=result.text.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5)));expect(events.map(event=>event.sequence_number)).toEqual([29,30]);
});
it('treats an aborted caller signal as cancellation, without a generated source failure',async()=>{
 const {context}=await setup(),onError=vi.fn(),onCancel=vi.fn(),cancel=vi.fn(),abort=new AbortController();
 const source=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(encode(created));},cancel});
 const response=await context.response('responses',{model:'qoder/test',input:'synthetic',stream:true},'key','source',async()=>new Response(source,{headers:{'content-type':'text/event-stream'}}),undefined,{signal:abort.signal,onError,onCancel});
 const reader=response.body!.getReader();await reader.read();abort.abort();expect((await reader.read()).done).toBe(true);reader.releaseLock();expect(onError).not.toHaveBeenCalled();expect(onCancel).not.toHaveBeenCalled();expect(cancel).toHaveBeenCalledOnce();expect(source.locked).toBe(false);
});
it.each(['flat','nested'])('keeps a %s Responses error typed, sequenced and metered after public safety mapping',async shape=>{
 const {context}=await setup(),onError=vi.fn();
 const response=await context.response('responses',{model:'qoder/test',input:'synthetic',stream:true},'key','source',async()=>new Response(encode({type:'error',...(shape==='flat'?{code:'workbuddy_invalid_request',message:'PRIVATE_TOP_LEVEL_ERROR'}:{error:{code:'workbuddy_invalid_request',message:'PRIVATE_TOP_LEVEL_ERROR'}}),sequence_number:37,status_code:409,usage:{input_tokens:8,output_tokens:2}}),{headers:{'content-type':'text/event-stream'}}),undefined,{onError});
 const text=(await collect(response)).text,event=JSON.parse(text.split('data: ')[1]!);
 expect(text).toContain('event: error\n');expect(text).not.toContain('PRIVATE_TOP_LEVEL_ERROR');expect(event).toMatchObject({type:'error',sequence_number:37,status_code:409,usage:{input_tokens:8,output_tokens:2}});expect(event.error??event).toMatchObject({code:'workbuddy_invalid_request'});expect(onError).toHaveBeenCalledOnce();expect(onError.mock.calls[0][0]).toMatchObject({statusCode:409,usage:{input_tokens:8,output_tokens:2}});
});
