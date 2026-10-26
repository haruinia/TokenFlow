import {it,expect,vi} from 'vitest';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {WorkBuddySDKProvider,workbuddySDKCredential,parseCodeBuddyInput} from '../packages/core/src/codebuddy.js';
import {providerUsage} from '../packages/core/src/gateway-observation.js';

it('pins the credential region and rejects unknown domains or disabled credentials',()=>{
 expect(workbuddySDKCredential({type:'workbuddy',access_token:'local',domain:'www.codebuddy.cn'})).toEqual({token:'local',region:'china'});
 expect(workbuddySDKCredential({type:'workbuddy',access_token:'overseas',domain:'https://www.workbuddy.ai'})).toEqual({token:'overseas',region:'international',endpoint:'https://www.workbuddy.ai'});
 expect(()=>workbuddySDKCredential({type:'workbuddy',access_token:'secret',domain:'attacker.test'})).toThrow();
 expect(()=>workbuddySDKCredential({type:'workbuddy',access_token:'secret',disabled:true})).toThrow();
});
it('preserves old instructions, tool IDs/results and images without changing identity text',()=>{
 const original='You are Codex. Keep this instruction intact.';
 const parsed=parseCodeBuddyInput('responses',{model:'workbuddy/deepseek-v4.1-flash',instructions:original,input:[{role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,YWJj'}]},{type:'function_call',call_id:'old',name:'read_probe',arguments:'{}'},{type:'function_call_output',call_id:'old',output:'previous result'}]});
 expect(parsed.systemPrompt).toContain(original);expect(parsed.prompt).not.toContain(original);expect(parsed.prompt).toContain('previous result');expect(parsed.prompt).toContain('"call_id":"old"');
 expect(parsed.images).toEqual([{type:'image',source:{type:'base64',media_type:'image/png',data:'YWJj'}}]);expect(parsed.prompt).not.toContain('YWJj');
});
it.each(['responses','chat/completions','messages'])('preserves inclusive SDK input and cache breakdown once on %s',async path=>{
 const root=await mkdtemp(join(tmpdir(),'sdk-test-'));
 const sdk=new WorkBuddySDKProvider(root,async(id,model)=>{expect(id).toBe('chosen-account');expect(model).toBe('workbuddy/deepseek-v4.1-flash');return {type:'workbuddy',access_token:'private',domain:'www.workbuddy.ai'};},async input=>{
  expect(input.endpoint).toBe('https://www.workbuddy.ai');expect(input.region).toBe('international');expect(input.token).toBe('private');expect(input.tools[0].name).toBe('read_probe');
  return {model:input.model,text:'',calls:[{name:'read_probe',arguments:'{"file":"probe"}'}],failed:false,usage:{input_tokens:1000,cache_read_input_tokens:600,cache_creation_input_tokens:300,output_tokens:20}};
 });
 try{
  const response=await sdk.response('chosen-account',path,{model:'workbuddy/deepseek-v4.1-flash',...(path==='responses'?{input:'Read probe'}:{messages:[{role:'user',content:'Read probe'}]}),tools:[{type:'function',name:'read_probe',parameters:{type:'object',properties:{file:{type:'string'}}}}]},new AbortController().signal);
  const value=await response.json();expect(response.status).toBe(200);expect(response.headers.get('x-token-flow-transport')).toBe('codebuddy-agent-sdk');
  expect(providerUsage(value.usage)).toMatchObject({inputTokens:1000,cachedTokens:600,cacheWriteTokens:300,outputTokens:20});
  expect(JSON.stringify(value)).toContain('read_probe');expect(JSON.stringify(value)).not.toContain('private');
  expect(await readdir(join(root,'workbuddy-sdk-runs'))).toEqual([]);
 }finally{await sdk.close();await rm(root,{recursive:true,force:true});}
});
it('does not silently use a fallback model or another account on failure',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sdk-test-'));
 const sdk=new WorkBuddySDKProvider(root,async()=>({type:'workbuddy',access_token:'private'}),async()=>({text:'wrong model',model:'default-model',calls:[],failed:false}));
 try{expect((await sdk.response('chosen','responses',{model:'workbuddy/deepseek-v4.1-flash',input:'hello'},new AbortController().signal)).status).toBe(502);}finally{await rm(root,{recursive:true,force:true});}
});
it.each(['credential','sdk','output'] as const)('reports the %s failure stage without exposing credentials or internal errors',async stage=>{
 const root=await mkdtemp(join(tmpdir(),'sdk-stage-'));
 const sdk=new WorkBuddySDKProvider(root,async()=>{if(stage==='credential')throw new Error('secret-credential');return {type:'workbuddy',access_token:'private'};},async()=>{if(stage==='sdk')throw new Error('secret-sdk-token');return {text:'',model:'wrong-model',calls:[],failed:false};});
 try{
  const response=await sdk.response('chosen','responses',{model:'workbuddy/test',input:'hello'},new AbortController().signal);
  expect(response.status).toBe(502);const error=await response.json();
  expect(error.error.code).toBe(`workbuddy_${stage}_failed`);expect(JSON.stringify(error)).not.toMatch(/secret-|private/);
 }finally{await sdk.close();await rm(root,{recursive:true,force:true});}
});
it('keeps Codex namespace identity when flattening tools for the SDK',()=>{
 const value=parseCodeBuddyInput('responses',{model:'workbuddy/deepseek-v4.1-flash',input:'Read test',tools:[{type:'namespace',name:'functions',tools:[{type:'function',name:'read',parameters:{type:'object',properties:{}}}]}],tool_choice:{type:'function',namespace:'functions',name:'read'}});
 expect(value.tools[0].name).toBe('functions__read');expect(value.toolIdentities.get('functions__read')).toEqual({name:'read',namespace:'functions'});expect(value.required).toBe(true);
});
it('opens streaming promptly and waits for cancelled SDK cleanup before closing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sdk-stream-'));let started!:()=>void;
 const running=new Promise<void>(resolve=>{started=resolve;});let cleaned=false;
 const sdk=new WorkBuddySDKProvider(root,async()=>({type:'workbuddy',access_token:'private'}),async input=>{
  started();await new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>setTimeout(()=>{cleaned=true;resolve();},20),{once:true}));
  return {model:input.model,text:'',calls:[],failed:true};
 });
 try{
  const response=await sdk.response('chosen','responses',{model:'workbuddy/deepseek-v4.1-flash',input:'hello',stream:true},new AbortController().signal);
  const reader=response.body!.getReader();expect(new TextDecoder().decode((await reader.read()).value)).toContain(': codebuddy-sdk');
  await running;await reader.cancel();await sdk.close();expect(cleaned).toBe(true);expect(await readdir(join(root,'workbuddy-sdk-runs'))).toEqual([]);
 }finally{await sdk.close();await rm(root,{recursive:true,force:true});}
});

it('merges Responses Lite tools with top-level precedence and preserves the original history',()=>{
 const primary={type:'function',name:'read',description:'primary',parameters:{type:'object',properties:{}}};
 const history={type:'function_call_output',call_id:'previous-call',output:'client executed this'};
 const body={model:'workbuddy/test',input:[{role:'user',content:'continue'},{type:'additional_tools',tools:[{...primary,description:'duplicate'},{type:'namespace',name:'functions',tools:[{type:'custom',name:'patch',format:{type:'text'}}]}]},history],tools:[primary],parallel_tool_calls:false};
 const original=JSON.stringify(body);const parsed=parseCodeBuddyInput('responses',body);
 expect(parsed.tools).toHaveLength(2);expect(parsed.tools[0].description).toBe('primary');
 expect(parsed.toolIdentities.get('functions__patch')).toEqual({name:'patch',namespace:'functions'});
 expect(parsed.tools[1].custom).toBe(true);expect(parsed.parallel_tool_calls).toBe(false);
 expect(parsed.prompt).toContain('previous-call');expect(parsed.prompt).toContain('client executed this');expect(parsed.prompt).not.toContain('additional_tools');
 expect(JSON.stringify(body)).toBe(original);
});

it('round-trips colliding tool identities and custom results over the SDK boundary',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sdk-collisions-'));let turn=0;
 const tools=[{type:'function',name:'fs__read',parameters:{type:'object'}},{type:'namespace',name:'fs',tools:[{type:'custom',name:'read',format:{type:'text'}}]}];
 const original={model:'workbuddy/test',input:[{role:'user',content:'Read'}],tools,parallel_tool_calls:false,tool_choice:{type:'custom',namespace:'fs',name:'read'}};
 const both=parseCodeBuddyInput('responses',{...original,tool_choice:'auto'});
 expect(new Set(both.tools.map(t=>t.name)).size).toBe(2);
 const reversed=parseCodeBuddyInput('responses',{...original,tools:[...tools].reverse(),tool_choice:'auto'});
 expect([...both.toolIdentities].sort()).toEqual([...reversed.toolIdentities].sort());
 const sdk=new WorkBuddySDKProvider(root,async()=>({type:'workbuddy',access_token:'fixture'}),async input=>{
  expect(input.parallelToolCalls).toBe(false);expect(input.tools).toHaveLength(1);
  if(turn++===0)return {model:input.model,text:'',calls:[{name:input.tools[0].name,arguments:JSON.stringify({input:'client-file.txt'}),custom:true}],failed:false};
  expect(input.prompt).toContain('CLIENT_RESULT');expect(input.prompt).toContain('"namespace":"fs"');
  return {model:input.model,text:'Received CLIENT_RESULT',calls:[],failed:false};
 });
 try{
  const response=await sdk.response('source','responses',original,new AbortController().signal);expect(response.status).toBe(200);
  const first=await response.json();const call=first.output[0];
  expect(call.id).toMatch(/^ctc_/);expect(call).toMatchObject({type:'custom_tool_call',name:'read',namespace:'fs',input:'client-file.txt'});
  const second=await sdk.response('source','responses',{...original,tool_choice:'auto',tools:[tools[1]],input:[...original.input,...first.output,{type:'custom_tool_call_output',call_id:call.call_id,output:'CLIENT_RESULT'}]},new AbortController().signal);
  expect(second.status).toBe(200);expect(JSON.stringify(await second.json())).toContain('Received CLIENT_RESULT');
 }finally{await sdk.close();await rm(root,{recursive:true,force:true});}
});

it('rejects invalid streaming input before opening an apparently successful stream',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sdk-invalid-stream-'));let called=false;
 const sdk=new WorkBuddySDKProvider(root,async()=>({type:'workbuddy',access_token:'fixture'}),async input=>{called=true;return {model:input.model,text:'',calls:[],failed:false};});
 try{
  const result=await sdk.response('source','responses',{model:'workbuddy/test',stream:true,input:[{type:'unknown_item'}]},new AbortController().signal);
  expect(result.status).toBe(400);expect((await result.json()).error.type).toBe('invalid_request_error');expect(called).toBe(false);
 }finally{await sdk.close();await rm(root,{recursive:true,force:true});}
});
it('emits a Responses failure with an explicit reason instead of silently ending SDK failures',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sdk-failed-stream-'));
 const sdk=new WorkBuddySDKProvider(root,async()=>({type:'workbuddy',access_token:'fixture'}),async input=>({model:input.model,text:'',calls:[],failed:true,errorCode:'rate_limit_error'}));
 try{
  const result=await sdk.response('source','responses',{model:'workbuddy/test',stream:true,input:'hello'},new AbortController().signal);
  const stream=await result.text();expect(stream).toContain('event: response.failed');expect(stream).toContain('rate_limit_error');expect(stream).not.toContain('response.completed');
 }finally{await sdk.close();await rm(root,{recursive:true,force:true});}
});
it('accepts Codex Desktop namespace tool catalogs that flatten past 256 tools',()=>{
 const namespaces=Array.from({length:12},(_,ns)=>({
  type:'namespace',
  name:`mcp__codex_apps__service_${ns}`,
  description:`Connector ${ns}`,
  tools:Array.from({length:25},(_,idx)=>({type:'function',name:`action_${idx}`,description:'connector tool',parameters:{type:'object',properties:{id:{type:'string'}}}})),
 }));
 const parsed=parseCodeBuddyInput('responses',{
  model:'workbuddy/deepseek-v4.1-flash',
  input:[{type:'message',role:'user',content:[{type:'input_text',text:'hello'}]}],
  tools:[{type:'function',name:'exec_command',parameters:{type:'object',properties:{cmd:{type:'string'}}}},...namespaces],
 });
 expect(parsed.tools).toHaveLength(301);
 expect(parsed.toolIdentities.get('mcp__codex_apps__service_0__action_0')).toEqual({name:'action_0',namespace:'mcp__codex_apps__service_0'});
});


it('separates Messages system instructions from role-tagged tool history',()=>{
 const parsed=parseCodeBuddyInput('messages',{model:'workbuddy/test',system:[{type:'text',text:'CALLER_POLICY'}],messages:[{role:'user',content:'Read'},{role:'assistant',content:[{type:'tool_use',id:'call1',name:'read',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'call1',content:'CLIENT_RESULT'}]}]});
 expect(parsed.systemPrompt).toBe('CALLER_POLICY');expect(parsed.prompt).not.toContain('CALLER_POLICY');expect(parsed.prompt).toContain('call1');expect(parsed.prompt).toContain('CLIENT_RESULT');
});
it('continues a long Claude history containing prior-provider thinking through the WorkBuddy SDK',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sdk-claude-history-'));let called=0;
 const thinkingAt=new Set([149,151,153,157,159]);
 const messages=Array.from({length:161},(_,index)=>({role:index%2?'assistant':'user',content:thinkingAt.has(index)?[
  {type:'thinking',thinking:`PRIOR_PROVIDER_THINKING_${index}`,signature:'OPAQUE_PROVIDER_SIGNATURE'},
  {type:'text',text:`VISIBLE_HISTORY_${index}`},
 ]:[{type:'text',text:`VISIBLE_HISTORY_${index}`}]}));
 const body={model:'workbuddy/deepseek-v4.1-flash',messages,tools:[{name:'read',input_schema:{type:'object'}}]};
 const before=JSON.stringify(body);
 const sdk=new WorkBuddySDKProvider(root,async()=>({type:'workbuddy',access_token:'fixture'}),async input=>{
  called++;for(const index of thinkingAt)expect(input.prompt).toContain(`VISIBLE_HISTORY_${index}`);
  expect(input.prompt).not.toMatch(/PRIOR_PROVIDER_THINKING|OPAQUE_PROVIDER_SIGNATURE/);
  expect(input.tools[0].name).toBe('read');
  return {model:input.model,text:'continued',calls:[],failed:false};
 });
 try{
  const response=await sdk.response('chosen','messages',body,new AbortController().signal);
  const result=await response.json();
  expect(response.status,JSON.stringify(result)).toBe(200);expect(called).toBe(1);
  expect(result.content).toEqual([{type:'text',text:'continued'}]);expect(JSON.stringify(body)).toBe(before);
 }finally{await sdk.close();await rm(root,{recursive:true,force:true});}
});
it.each(['responses','chat/completions','messages'])('delivers live %s text before SDK completion without replaying it',async path=>{
 const root=await mkdtemp(join(tmpdir(),'sdk-live-stream-'));let finish!:()=>void;
 const gate=new Promise<void>(resolve=>{finish=resolve;});
 const sdk=new WorkBuddySDKProvider(root,async()=>({type:'workbuddy',access_token:'fixture'}),async input=>{
  input.onText?.('FIRST_CHUNK');await gate;
  input.onText?.('SECOND_CHUNK');
  return {model:input.model,text:'FIRST_CHUNKSECOND_CHUNK',calls:[],failed:false,usage:{input_tokens:9,output_tokens:2}};
 });
 try{
  const response=await sdk.response('source',path,{model:'workbuddy/test',stream:true,...(path==='responses'?{input:'hi'}:{messages:[{role:'user',content:'hi'}]})},new AbortController().signal);
  const reader=response.body!.getReader();const decode=new TextDecoder();let before='';
  while(!before.includes('FIRST_CHUNK'))before+=decode.decode((await reader.read()).value);
  expect(before).not.toContain('SECOND_CHUNK');expect(before).not.toContain('response.completed');finish();
  let rest='';for(;;){const next=await reader.read();if(next.done)break;rest+=decode.decode(next.value);}
  expect(rest).toContain('SECOND_CHUNK');
  const events=(before+rest).split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));
  const text=events.map(e=>path==='responses'&&e.type==='response.output_text.delta'?e.delta:path==='messages'&&e.type==='content_block_delta'&&e.delta.type==='text_delta'?e.delta.text:path==='chat/completions'?e.choices?.[0]?.delta?.content??'':'').join('');
  expect(text).toBe('FIRST_CHUNKSECOND_CHUNK');
 }finally{finish();await sdk.close();await rm(root,{recursive:true,force:true});}
});

it('honors Claude sequential-tool requests without requiring an OpenAI extension',()=>{
 const parsed=parseCodeBuddyInput('messages',{model:'workbuddy/test',messages:[{role:'user',content:'read'}],tools:[{name:'read',input_schema:{type:'object'}}],tool_choice:{type:'auto',disable_parallel_tool_use:true}});
 expect(parsed.parallel_tool_calls).toBe(false);
});

it('waits beyond the former SDK deadline and preserves a late source answer',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sdk-no-deadline-'));let started!:()=>void,finish!:()=>void;let observed:AbortSignal|undefined;
 const ready=new Promise<void>(resolve=>{started=resolve;}),release=new Promise<void>(resolve=>{finish=resolve;});
 const sdk=new WorkBuddySDKProvider(root,async()=>({type:'workbuddy',access_token:'private'}),async input=>{
  observed=input.signal;started();await release;
  return {model:input.model,text:'late complete answer',calls:[],failed:false};
 });
 vi.useFakeTimers();
 try{const pending=sdk.response('chosen','messages',{model:'workbuddy/test',messages:[{role:'user',content:'hello'}]},new AbortController().signal);await ready;await vi.advanceTimersByTimeAsync(24*60*60*1000);expect(observed!.aborted).toBe(false);finish();vi.useRealTimers();const response=await pending;expect(response.status).toBe(200);expect(await response.text()).toContain('late complete answer');}
 finally{finish();vi.useRealTimers();await sdk.close();await rm(root,{recursive:true,force:true});}
});

it.each(['text_mismatch','missing_result','context_limit','tool_schema','sdk_execution','timeout'] as const)('keeps the safe SDK %s reason through buffered and streaming failures',async reason=>{
 const root=await mkdtemp(join(tmpdir(),'sdk-diagnostic-'));
 const sdk=new WorkBuddySDKProvider(root,async()=>({type:'workbuddy',access_token:'private-token'}),async input=>{
  input.onDiagnostic?.({event:'failure',elapsedMs:1,reason,origin:'exception',fingerprint:'a'.repeat(64)});
  throw new Error('PRIVATE_PROMPT Bearer private-token');
 });
 try{
  for(const stream of [false,true]){
   const response=await sdk.response('chosen','messages',{model:'workbuddy/test',messages:[{role:'user',content:'PRIVATE_PROMPT'}],stream},new AbortController().signal);
   const wire=await response.text();
   expect(wire).toContain(`workbuddy_${reason}`);
   expect(wire).not.toMatch(/PRIVATE_PROMPT|private-token|fingerprint/);
   if(!stream)expect(response.status).toBe(reason==='timeout'?504:502);
  }
 }finally{await sdk.close();await rm(root,{recursive:true,force:true});}
});
it.each(['unknown_name','unfinished_block','invalid_json','invalid_args','truncated_turn','parallel_limit','orphan_delta','input_limit'] as const)('preserves stable tool code and fixed %s subtype in both protocols and transports',async toolIssue=>{
 const root=await mkdtemp(join(tmpdir(),'sdk-tool-issue-'));
 const sdk=new WorkBuddySDKProvider(root,async()=>({type:'workbuddy',access_token:'private-token'}),async input=>{
  input.onDiagnostic?.({event:'failure',elapsedMs:1,reason:'tool_protocol',toolIssue,origin:'exception',toolBlocks:1,unfinishedToolBlocks:0});throw Error('PRIVATE_TOOL_ARGUMENT');
 });
 try{for(const path of ['messages','responses'])for(const stream of [false,true]){
  const response=await sdk.response('chosen',path,{model:'workbuddy/test',...(path==='messages'?{messages:[{role:'user',content:'PRIVATE_PROMPT'}]}:{input:'PRIVATE_PROMPT'}),stream},new AbortController().signal);
  const wire=await response.text();expect(wire).toContain('workbuddy_tool_protocol');expect(wire).toContain(toolIssue);expect(wire).not.toMatch(/PRIVATE|private-token|toolBlocks/);if(!stream)expect(response.status).toBe(502);
 }}finally{await sdk.close();await rm(root,{recursive:true,force:true});}
});
