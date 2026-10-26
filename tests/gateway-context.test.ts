import OpenAI from 'openai';
import {toResponseInputItems} from 'openai/lib/responses/ResponseInputItems';
import {afterEach, expect, it} from 'vitest';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GatewayContext} from '../packages/core/src/gateway-context.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function setup(){const root=await mkdtemp(join(tmpdir(),'gateway-context-'));roots.push(root);return {root,context:await GatewayContext.open(root)};}
const usage={input_tokens:30,output_tokens:10,total_tokens:40};
const answer=(text='done',status='completed')=>({id:'upstream-id',object:'response',status,output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}],usage});
const longInput=[
 {role:'system',content:'Never overwrite user files.'},
 {role:'user',content:'Fix /app/main.ts. Keep API compatibility.'},
 {type:'function_call',call_id:'old',name:'read',arguments:'{"path":"/app/main.ts"}'},
 {type:'function_call_output',call_id:'old',output:'historical file content '.repeat(500)},
 {role:'assistant',content:'First implementation complete.'},
 {role:'user',content:'Run tests.'},
 {role:'assistant',content:'Tests passed.'},
 {role:'user',content:'Now inspect deployment.'},
 {type:'function_call',call_id:'pending',name:'inspect',arguments:'{}'}
] satisfies OpenAI.Responses.ResponseInputItem[];
it('reports Qoder resource limits from summary calls without changing history or hiding them as generic failures',async()=>{
 const {context}=await setup();const input=structuredClone(longInput);
 const failure=await context.response('responses/compact',{model:'qoder/dfmodel',input},'a','s',async()=>Response.json({error:{code:'qoder_resource_limit',message:'PRIVATE_UPSTREAM_BODY'}},{status:429})).catch(error=>error);
 expect(failure).toMatchObject({statusCode:429,code:'compaction_upstream_failed'});
 expect(failure.message).toContain('资源限流');expect(failure.message).not.toContain('PRIVATE');expect(input).toEqual(longInput);
});
it.each(['flat','nested','failed'])('reports Qoder summary %s SSE errors safely without persisting failed summaries',async shape=>{
 const {root,context}=await setup();const input=structuredClone(longInput);let report:any;
 const error={code:'qoder_resource_limit',message:'PRIVATE_UPSTREAM_BODY',type:'rate_limit_error'};
 const event=shape==='flat'?{...error,type:'error'}:shape==='nested'?{type:'error',error}:{type:'response.failed',response:{status:'failed',output:[],error}};
 const failure=await context.response('responses/compact',{model:'qoder/dfmodel',input},'a','s',async()=>new Response('data: '+JSON.stringify(event)+'\n\n',{headers:{'content-type':'text/event-stream'}}),undefined,{onCompaction:value=>{report=value;}}).catch(error=>error);
 expect(failure).toMatchObject({statusCode:429,code:'compaction_upstream_failed',unmetered:true});
 expect(failure.message).toContain('资源限流');expect(failure.message).not.toContain('PRIVATE');expect(input).toEqual(longInput);
 expect(report).toMatchObject({failed:true,unmetered:true});
 expect((await readdir(join(root,'gateway-context'))).filter(name=>name.startsWith('summary-'))).toEqual([]);
});
it('preserves known usage on a classified failed summary',async()=>{
 const {context}=await setup();let report:any;
 const event={type:'response.failed',response:{status:'failed',output:[],usage,error:{code:'qoder_resource_limit',message:'PRIVATE_UPSTREAM_BODY'}}};
 const failure=await context.response('responses/compact',{model:'qoder/dfmodel',input:longInput},'a','s',async()=>new Response('data: '+JSON.stringify(event)+'\n\n',{headers:{'content-type':'text/event-stream'}}),undefined,{onCompaction:value=>{report=value;}}).catch(error=>error);
 expect(failure).toMatchObject({code:'compaction_upstream_failed',usage,unmetered:false});
 expect(report).toMatchObject({failed:true,unmetered:false,inputTokens:30,outputTokens:10});
});
it.each(['qoder/model','workbuddy/model'])('compacts %s with the same model and resumes exact recent tool context after restart',async model=>{
 const {root,context}=await setup();const requests:Record<string,unknown>[]=[];
 const send=async(path:string,body:Record<string,unknown>)=>{expect(path).toBe('responses');requests.push(body);return Response.json(answer('Changed /app/main.ts; preserve API. Tests passed. Deployment inspection pending.'));};
 const original=structuredClone(longInput);
 const compact=await context.response('responses/compact',{model,input:longInput},'key-a','account-a',send);
 const result=await compact.json();expect(result.object).toBe('response.compaction');expect(result.usage).toEqual(usage);
 expect(requests[0]).toMatchObject({model,stream:true,store:false});expect(requests[0]).not.toHaveProperty('tools');
 expect(result.output.filter((item:{role?:string})=>item.role==='user')).toHaveLength(2);
 expect(result.output.at(-1)).toMatchObject({type:'compaction'});expect(result.output.at(-1).encrypted_content).not.toContain('main.ts');
 expect(longInput).toEqual(original);
 const restarted=await GatewayContext.open(root);
 await restarted.response('responses',{model,input:[...result.output,{type:'function_call_output',call_id:'pending',output:'ready'}],store:false},'key-a','account-a',send);
 const forwarded=requests[1]!.input as Record<string,unknown>[];
 expect(forwarded).toContainEqual(original[0]);expect(forwarded).not.toContainEqual(original[1]);
 expect(forwarded.slice(-5)).toEqual([...original.slice(5),{type:'function_call_output',call_id:'pending',output:'ready'}]);
 expect(forwarded.filter(item=>item.role==='user')).toHaveLength(2);
 expect(JSON.stringify(forwarded)).not.toContain('historical file content');
 expect((await readdir(join(root,'gateway-context'))).filter(name=>!name.startsWith('summary-'))).toEqual(['key']);
});
it('persists encrypted previous responses, forks without mixing turns, scopes by key/source/model and honors store:false',async()=>{
 const {root,context}=await setup();let seen:Record<string,unknown>={};const send=async(_path:string,body:Record<string,unknown>)=>{seen=body;return Response.json(answer());};
 const first=await (await context.response('responses',{model:'qoder/m',input:'private-user-message'},'a','source',send)).json();
 const disk=await readFile(join(root,'gateway-context',first.id),'utf8');expect(disk).not.toContain('private-user-message');
 const restarted=await GatewayContext.open(root);
 for(const input of ['branch-a','branch-b']){
  await restarted.response('responses',{model:'qoder/m',previous_response_id:first.id,input,store:false},'a','source',send);
  expect(seen).not.toHaveProperty('previous_response_id');expect(seen.input).toEqual([{role:'user',content:'private-user-message'},...answer().output,{role:'user',content:input}]);
 }
 for(const [owner,source,model] of [['b','source','qoder/m'],['a','other','qoder/m'],['a','source','qoder/other']]){
  await expect(restarted.response('responses',{model:model!,previous_response_id:first.id,input:'hi'},owner!,source!,send)).rejects.toThrow(/another API key/);
 }
 const unstored=await (await context.response('responses',{model:'qoder/m',input:'do not store',store:false},'a','source',send)).json();
 await expect(context.response('responses',{model:'qoder/m',previous_response_id:unstored.id,input:'hi'},'a','source',send)).rejects.toThrow(/not stored/);
});
it('rejects tampered or cross-key compaction tokens without upstream calls',async()=>{
 const {context}=await setup();const send=async()=>Response.json(answer());
 const compact=await (await context.response('responses/compact',{model:'qoder/m',input:longInput},'a','s',send)).json();
 for(const owner of ['b','a']){
  const input=structuredClone(compact.output);if(owner==='a')input.at(-1).encrypted_content=input.at(-1).encrypted_content.slice(0,20)+'broken';
  await expect(context.response('responses',{model:'qoder/m',input},owner,'s',async()=>{throw new Error('must not invoke upstream');})).rejects.toThrow(/Context is invalid/);
 }
});
it('does not turn incomplete, empty or tool-calling summaries into success',async()=>{
 const {context}=await setup();
 for(const result of [answer('partial','incomplete'),answer(''),{...answer(),output:[{type:'function_call',name:'write',call_id:'bad',arguments:'{}'}]}]){
  const input=structuredClone(longInput);
  await expect(context.response('responses/compact',{model:'workbuddy/m',input},'a','s',async()=>Response.json(result))).rejects.toThrow(/original history is unchanged/);
  expect(input).toEqual(longInput);
 }
});
it('streaming IDs remain stable, completed history is saved before terminal delivery and truncated streams create no history',async()=>{
 const {root,context}=await setup();
 const wire=(complete:boolean)=>[{type:'response.created',response:{...answer(),status:'in_progress',output:[]}},{type:'response.output_text.delta',delta:'你好'},...(complete?[{type:'response.completed',response:answer('你好')}]:[])].map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join('');
 const send=(complete:boolean)=>async()=>{
  const bytes=new TextEncoder().encode(wire(complete));let offset=0;
  return new Response(new ReadableStream({pull(c){if(offset===bytes.length)c.close();else{c.enqueue(bytes.slice(offset,offset+7));offset=Math.min(offset+7,bytes.length);}}}),{headers:{'content-type':'text/event-stream'}});
 };
 const response=await context.response('responses',{model:'workbuddy/m',input:'hello',stream:true},'a','s',send(true));
 const text=await response.text();const events=text.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5)));
 const id=events[0].response.id;expect(events.at(-1).response.id).toBe(id);expect(text).toContain('你好');expect(await readdir(join(root,'gateway-context'))).toContain(id);
 let next:Record<string,unknown>={};await context.response('responses',{model:'workbuddy/m',previous_response_id:id,input:'next',store:false},'a','s',async(_p,b)=>{next=b;return Response.json(answer());});
 expect(JSON.stringify(next.input)).toContain('你好');
 const before=await readdir(join(root,'gateway-context'));
 const truncated=await context.response('responses',{model:'workbuddy/m',input:'hello',stream:true},'a','s',send(false));
 expect(await truncated.text()).toContain('incomplete_stream');expect(await readdir(join(root,'gateway-context'))).toEqual(before);
});
it('compacts a long single-user agent loop without splitting tool pairs or losing pending calls',async()=>{
 const {context}=await setup();const input:Record<string,unknown>[]=[{role:'user',content:'Finish the task.'}];
 for(let i=0;i<12;i++)input.push({type:'function_call',call_id:'call-'+i,name:'read',arguments:'{}'},{type:'function_call_output',call_id:'call-'+i,output:'data '.repeat(1000)});
 input.push({type:'function_call',call_id:'pending',name:'write',arguments:'{}'});
 let calls=0;let resumed:Record<string,unknown>[]=[];
 const compact=await (await context.response('responses/compact',{model:'qoder/m',input},'a','s',async()=>{calls++;return Response.json(answer('Read files. Continue the pending write.'));})).json();
 expect(calls).toBe(1);
 await context.response('responses',{model:'qoder/m',input:compact.output,store:false},'a','s',async(_p,b)=>{resumed=b.input as Record<string,unknown>[];return Response.json(answer());});
 expect(resumed.at(-1)).toEqual(input.at(-1));expect(resumed[0]).toEqual(input[0]);expect(JSON.stringify(resumed).length).toBeLessThan(JSON.stringify(input).length);
 for(const item of resumed.filter(item=>item.type==='function_call_output'))expect(resumed.some(call=>call.type==='function_call'&&call.call_id===item.call_id)).toBe(true);
});
it.each([false,true])('supports automatic compaction with stream=%s and bills both model calls',async stream=>{
 const {context}=await setup();const sent:Record<string,unknown>[]=[];let billed:unknown;
 const response=await context.response('responses',{model:'qoder/m',input:longInput,store:false,stream,context_management:[{type:'compaction',compact_threshold:100}]},'a','s',async(_p,body)=>{
  sent.push(body);
  if(sent.length===1||!stream)return Response.json(answer('Checkpoint: tests passed. Continue inspection.'));
  const events=[{type:'response.created',response:{...answer(),status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{id:'msg',...answer().output[0]}},{type:'response.output_text.delta',output_index:0,content_index:0,delta:'done'},{type:'response.output_item.done',output_index:0,item:{id:'msg',...answer().output[0]}},{type:'response.completed',response:answer()}];
  return new Response(events.map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 },undefined,{onBillingUsage:value=>{billed=value;}});
 let result;
 if(stream){const events=(await response.text()).split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5)));expect(events.map(e=>e.sequence_number)).toEqual(events.map((_,i)=>i));expect(events.filter(e=>e.type==='response.output_item.added').map(e=>[e.output_index,e.item.type])).toEqual([[0,'compaction'],[1,'message']]);result=events.at(-1).response;}
 else result=await response.json();
 expect(sent).toHaveLength(2);expect(sent[1]).not.toHaveProperty('context_management');expect(result.usage).toMatchObject({input_tokens:30,output_tokens:10,total_tokens:40});expect(billed).toMatchObject({input_tokens:60,output_tokens:20,total_tokens:80});expect(result.output[0].type).toBe('compaction');
 let resumed:unknown;
 await context.response('responses',{model:'qoder/m',store:false,input:[...longInput,...result.output,{type:'function_call_output',call_id:'pending',output:'okay'}]},'a','s',async(_p,body)=>{resumed=body.input;return Response.json(answer());});
 expect(JSON.stringify(resumed)).not.toContain('historical file content');expect(JSON.stringify(resumed)).toContain('okay');
});

it('round-trips compaction through the OpenAI SDK used by Responses clients',async()=>{
 const {context}=await setup();let received:unknown;
 const client=new OpenAI({apiKey:'synthetic',baseURL:'http://gateway.test/v1',maxRetries:0,fetch:async(url,init)=>{
  const body=JSON.parse(String(init?.body));
  return context.response(String(url).endsWith('/compact')?'responses/compact':'responses',body,'a','s',async(_p,request)=>{received=request.input;return Response.json(answer('Checkpoint: API kept compatible, tests passed.'));});
 }});
 const compact=await client.responses.compact({model:'qoder/m',input:longInput});
 const response=await client.responses.create({model:'qoder/m',input:[...toResponseInputItems(compact.output),{role:'user',content:'Continue from that checkpoint.'}],store:false});
 expect(response.output_text).toContain('tests passed');expect(JSON.stringify(received)).toContain('Continue from that checkpoint.');expect(JSON.stringify(received)).not.toContain('historical file content');
});
it('returns a sole compaction item for Codex v2 and preserves newly prepended instructions on continuation',async()=>{
 const {context}=await setup();const original=[...longInput,{type:'compaction_trigger'}];
 const response=await context.response('responses',{model:'qoder/m',input:original,stream:true,store:false},'a','s',async()=>Response.json(answer('Earlier changes verified. Continue inspection.')));
 const events=(await response.text()).split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5)));
 const output=events.at(-1).response.output;expect(output).toHaveLength(1);expect(output[0].type).toBe('compaction');expect(events.at(-1).type).toBe('response.completed');
 const fresh={role:'developer',content:'The user changed the working directory. Use /new/project now.'};let forwarded:unknown;
 await context.response('responses',{model:'qoder/m',input:[fresh,...output],store:false},'a','s',async(_p,b)=>{forwarded=b.input;return Response.json(answer());});
 expect(forwarded).toContainEqual(fresh);expect(JSON.stringify(forwarded)).not.toContain('compaction_trigger');expect(original.at(-1)?.type).toBe('compaction_trigger');
});
it.each(['custom_tool_call','function_call'])('keeps interleaved %s calls/results together across compaction and restart',async type=>{
 const {root,context}=await setup();
 const input=[{role:'user',content:'Fix and test.'},{role:'assistant',content:'old trace '.repeat(1500)},
  {type,call_id:'a',name:'patch',input:'patch',arguments:'{}'},
  {type:'function_call',call_id:'b',name:'read',arguments:'{}'},
  {type:type+'_output',call_id:'a',output:'failed: permission denied'},
  {type:'function_call_output',call_id:'b',output:'file'},
  ...Array.from({length:6},()=>({role:'assistant',content:'progress'}))];
 const compact=await (await context.response('responses/compact',{model:'qoder/m',input},'a','s',async()=>Response.json(answer('Old trace summarized.')))).json();
 const restarted=await GatewayContext.open(root);let forwarded:Record<string,unknown>[]=[];
 await restarted.response('responses',{model:'qoder/m',input:compact.output,store:false},'a','s',async(_p,b)=>{forwarded=b.input as Record<string,unknown>[];return Response.json(answer());});
 expect(forwarded.slice(-10)).toEqual(input.slice(2));
 expect(forwarded).toContainEqual(input[4]);
});
it('rejects orphaned tool results before summarization and preserves unfinished custom calls',async()=>{
 const {context}=await setup();const send=async()=>Response.json(answer());
 await expect(context.response('responses/compact',{model:'qoder/m',input:[{type:'custom_tool_call_output',call_id:'missing',output:'done'}]},'a','s',send)).rejects.toThrow(/no matching call/);
 const input=[{role:'user',content:'Task'},{role:'assistant',content:'history '.repeat(1000)},{type:'custom_tool_call',call_id:'pending',name:'patch',input:'patch'},...Array.from({length:10},()=>({role:'assistant',content:'progress'}))];
 const compact=await (await context.response('responses/compact',{model:'qoder/m',input},'a','s',send)).json();let seen:unknown;
 await context.response('responses',{model:'qoder/m',input:compact.output,store:false},'a','s',async(_p,b)=>{seen=b.input;return Response.json(answer());});
 expect(seen).toContainEqual(input[2]);
});
it.each([20,100])('compacts a single tool loop with a %i KiB latest result without rejecting its fixed prefix',async kib=>{
 const {context}=await setup();const model='codex/model';const scope={owner:'a',source:'s',model};
 const input:Record<string,unknown>[]=[{role:'developer',content:'Project rules '.repeat(10000)},{role:'user',content:'Continue the task, preserve my constraints.'}];
 for(let i=0;i<6;i++)input.push({type:'function_call',call_id:`call-${i}`,name:'read',arguments:'{}'},{type:'function_call_output',call_id:`call-${i}`,output:String(i).repeat(kib*1024)});
 const original=structuredClone(input);let forwarded:Record<string,unknown>[]=[];let summaries=0;
 const response=await context.response('responses',{context_management:[{type:'compaction',compact_threshold:65536}],model,input,tools:[{type:'function',name:'read',parameters:{type:'object'}}]},'a','s',async(_path,body)=>{
  if(!body.tools){summaries++;expect(JSON.stringify(body.input)).not.toContain('Project rules');return Response.json(answer('Completed earlier reads; continue using the latest tool result.'));}
  forwarded=body.input as Record<string,unknown>[];return Response.json(answer());
 },{scope,threadId:'fixture-thread',recover:async()=>[]});
 expect(response.ok).toBe(true);expect(summaries).toBeGreaterThan(0);
 expect(forwarded).toContainEqual(original[0]);expect(forwarded).toContainEqual(original[1]);
 expect(forwarded.slice(-2)).toEqual(original.slice(-2));
 const checkpoint=forwarded.find(item=>item.role==='assistant');
 expect(checkpoint).toMatchObject({type:'message',content:[{type:'output_text'}]});
 expect(JSON.stringify(forwarded).length).toBeLessThan(JSON.stringify(original).length);
 const calls=new Set(forwarded.filter(item=>item.type==='function_call').map(item=>item.call_id));
 for(const item of forwarded.filter(item=>item.type==='function_call_output'))expect(calls.has(item.call_id)).toBe(true);
 expect(input).toEqual(original);
});

it.each(['flat','nested','failed'])('normalizes real context overflow %s SSE into the Codex terminal error without triggering compaction',async shape=>{
 const {context}=await setup();let calls=0,compactions=0;
 const error={code:'context_too_large',message:'Too large'};
 const event=shape==='flat'?{type:'error',...error}:shape==='nested'?{type:'error',error}:{type:'response.failed',response:{error,status:'failed',usage}};
 const response=await context.response('responses',{model:'codex/m',input:longInput},'a','s',async()=>{calls++;return new Response('event: error\ndata: '+JSON.stringify(event)+'\n\n',{headers:{'content-type':'text/event-stream'}});},{scope:{owner:'codex',source:'portable',model:'portable'},threadId:'thread',recover:async()=>[]},{onCompaction:()=>{compactions++;}});
 const wire=await response.text(),result=JSON.parse(wire.split('\n').find(line=>line.startsWith('data:'))!.slice(5));
 expect(wire).toContain('event: response.failed');expect(wire).not.toContain('incomplete_stream');
 expect(result).toMatchObject({type:'response.failed',response:{status:'failed',error:{code:'context_length_exceeded'}}});
 if(shape==='failed')expect(result.response.usage).toEqual(usage);
 expect(calls).toBe(1);expect(compactions).toBe(0);
});
it('normalizes an HTTP context overflow but does not relabel unrelated payload or rate errors',async()=>{
 const {context}=await setup();
 for(const code of ['context_too_large','invalid_request','rate_limit_exceeded']){
  const response=await context.response('responses',{model:'codex/m',input:'hello'},'a','s',async()=>Response.json({error:{code,message:'source message'}},{status:413}));
  expect((await response.json()).error.code).toBe(code==='context_too_large'?'context_length_exceeded':code);
  expect(response.status).toBe(code==='context_too_large'?400:413);
 }
});
it('forwards long first and later managed histories without gateway-owned automatic compaction',async()=>{
 const {context}=await setup();const input=[{role:'user',content:'Keep my task'},...Array.from({length:30},()=>({role:'assistant',content:'x'.repeat(40000)}))];let calls=0,compactions=0;
 const migration={scope:{owner:'codex',source:'portable',model:'portable'},threadId:'thread',recover:async()=>input};
 for(const history of [input,[{type:'compaction',encrypted_content:'foreign'}],input]){
  await context.response('responses',{model:'codex/m',input:history,store:false},'a','s',async(_path,body)=>{calls++;expect(body.input).toEqual(input);expect(body.instructions).toBeUndefined();return Response.json(answer());},migration,{onCompaction:()=>{compactions++;}});
 }
 expect(calls).toBe(3);expect(compactions).toBe(0);
});

it.each([undefined,null,{status:'completed'}, {status:'completed',output:[null]}, {status:'in_progress',output:[]}])('delivers a typed terminal error for malformed upstream SSE without saving success: %j',async terminal=>{
 const {root,context}=await setup();let failure:unknown;const before=await readdir(join(root,'gateway-context'));
 const response=await context.response('responses',{model:'api/test',input:'synthetic requirement',stream:true},'a','s',async()=>new Response('data: '+JSON.stringify({type:'response.completed',response:terminal})+'\n\n',{headers:{'content-type':'text/event-stream'}}),undefined,{onError:error=>{failure=error;}});
 const wire=await response.text();expect(wire).toContain('invalid_terminal_response');expect(wire).not.toContain('response.completed');expect(failure).toMatchObject({code:'invalid_terminal_response',statusCode:502});expect(await readdir(join(root,'gateway-context'))).toEqual(before);
});
