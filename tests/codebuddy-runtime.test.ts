import {it,expect,vi,beforeEach} from 'vitest';
const sdk=vi.hoisted(()=>({query:vi.fn(),descriptions:[] as string[],callbacks:[] as Array<(args:Record<string,unknown>)=>unknown>,listTools:undefined as undefined|(()=>Promise<any>)}));
vi.mock('../packages/codebuddy-runtime/node_modules/@tencent-ai/agent-sdk/lib/index.js',()=>({
 query:sdk.query,
 tool:(_name:unknown,description:string,schema:{parse:(value:unknown)=>Record<string,unknown>},callback:(args:Record<string,unknown>)=>unknown)=>{sdk.descriptions.push(description);sdk.callbacks.push(args=>callback(schema.parse(args)));return {};},
 createSdkMcpServer:()=>({instance:{close:async()=>{},server:{setRequestHandler:(_schema:unknown,handler:()=>Promise<any>)=>{sdk.listTools=handler;}}}}),
}));
import {runOfficialSDK} from '../packages/codebuddy-runtime/index.js';
beforeEach(()=>{sdk.callbacks.length=0;sdk.descriptions.length=0;sdk.query.mockReset();sdk.listTools=undefined;});

it.each([false,true,undefined])('hands back client proposals with parallelToolCalls=%s without running commands',async parallelToolCalls=>{
 const command='printf should-only-run-on-client';let options:Record<string,any>={};
 sdk.query.mockImplementation((request:{options:Record<string,any>})=>{
  options=request.options;
  return (async function*(){
   const results=await Promise.all(sdk.callbacks.map(callback=>callback({command})));
   expect(results[0]).toMatchObject({content:[{text:expect.stringContaining('has not executed')}]});
   if(parallelToolCalls===false)expect(results[1]).toMatchObject({isError:true});
   yield {type:'assistant',message:{model:'test',content:[]}};
   yield {type:'result',is_error:true,subtype:'error_max_turns'};
  })();
 });
 const result=await runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'Use client tools',tools:['first','second'].map(name=>({name,parameters:{type:'object',properties:{command:{type:'string'}},required:['command']}})),parallelToolCalls,signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'});
 expect(options).toMatchObject({tools:[],strictMcpConfig:true,settingSources:[],maxTurns:1});
 expect(await options.canUseTool('Bash',{command})).toMatchObject({behavior:'deny'});
 expect(result.failed).toBe(false);expect(result.calls).toHaveLength(parallelToolCalls===false?1:2);
 expect(result.calls[0]).toMatchObject({name:'first',arguments:JSON.stringify({command})});
});

it('accepts client tools whose schema is not a plain object',async()=>{
 const args={threadId:'t1'};
 sdk.query.mockImplementation(()=>(async function*(){
  for(const callback of sdk.callbacks)await callback(args);
  yield {type:'assistant',message:{model:'test',content:[]}};
  yield {type:'result',is_error:true,subtype:'error_max_turns'};
 })());
 const union={anyOf:[{type:'object',properties:{threadId:{type:'string'}},required:['threadId']},{type:'object',properties:{projectId:{type:'string'}},required:['projectId']}]};
 const result=await runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'Use client tools',tools:[{name:'union',parameters:union},{name:'conditional',parameters:{type:'object',if:{required:['threadId']},then:{properties:{threadId:{type:'string'}}}}}],signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'});
 expect(result.failed).toBe(false);
 expect((await sdk.listTools!()).tools[0].inputSchema).toEqual({...union,type:'object'});
 expect(result.calls.map(call=>call.name)).toEqual(['union','conditional']);
 expect(result.calls[0]!.arguments).toBe(JSON.stringify(args));
});

it('overrides the coding preset and emits partial text once before completion',async()=>{
 let complete!:()=>void;const gate=new Promise<void>(resolve=>{complete=resolve;});const deltas:string[]=[];
 sdk.query.mockImplementation((request:{options:Record<string,any>})=>{
  expect(request.options.systemPrompt).toContain('CALLER_SYSTEM');
  expect(request.options.systemPrompt).toContain('client owns task execution');
  expect(request.options.includePartialMessages).toBe(true);
  return (async function*(){
   yield {type:'stream_event',event:{type:'message_start',message:{model:'test'}}};
   yield {type:'stream_event',event:{type:'content_block_start',index:1,content_block:{type:'text'}}};
   yield {type:'stream_event',event:{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'Live'}}};
   yield {type:'assistant',message:{model:'test',content:[{type:'thinking',thinking:'not output'}]}};
   await gate;
   yield {type:'assistant',message:{model:'test',content:[{type:'text',text:'Live'}]}};
   yield {type:'result',subtype:'success',is_error:false,result:'Live'};
  })();
 });
 const pending=runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'hello',systemPrompt:'CALLER_SYSTEM',onText:text=>{deltas.push(text);complete();},tools:[],signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'});
 const result=await pending;expect(deltas).toEqual(['Live']);expect(result.text).toBe('Live');expect(result.failed).toBe(false);
});
it.each([['429 您的使用量已超出频率限制，将在稍后重置 (private-request-id)','rate_limit_error'],['401 Unauthorized Bearer secret','authentication_error'],['403 unapproved channel (11128)','source_policy_blocked']])('preserves SDK thrown upstream failures without leaking their messages: %s',async(message,errorCode)=>{
 sdk.query.mockImplementation(()=>(async function*(){throw Object.assign(new Error(message),{name:'ExecutionError'});})());
 const result=await runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'Use tools',tools:[],signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'});
 expect(result).toMatchObject({failed:true,errorCode,calls:[]});expect(JSON.stringify(result)).not.toMatch(/private-request|secret|频率限制/);
});

it('preserves a deferred client tool when the real SDK throws the max-turn result',async()=>{
 sdk.query.mockImplementation(()=>(async function*(){
  await sdk.callbacks[0]!({step:1});
  yield {type:'assistant',message:{model:'test',content:[],usage:{input_tokens:5,output_tokens:2}}};
  throw Object.assign(new Error('Maximum turns reached'),{name:'ExecutionError',subtype:'error_max_turns',errors:['Maximum turns reached']});
 })());
 const result=await runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'Read fixture',tools:[{name:'read_fixture',parameters:{type:'object',properties:{step:{type:'integer'}},required:['step']}}],signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'});
 expect(result).toMatchObject({failed:false,calls:[{name:'read_fixture',arguments:'{"step":1}'}],usage:{input_tokens:5,output_tokens:2}});
});
it('does not accept a max-turn failure without a deferred client proposal',async()=>{
 sdk.query.mockImplementation(()=>(async function*(){throw Object.assign(new Error('Maximum turns reached'),{name:'ExecutionError',subtype:'error_max_turns'});})());
 await expect(runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'hello',tools:[],signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'})).rejects.toThrow('Maximum turns reached');
});

it('closes a silent SDK transport on cancellation without waiting for another model event',async()=>{
 let unblock!:()=>void;const idle=new Promise<void>(resolve=>{unblock=resolve;});const close=vi.fn(unblock);
 sdk.query.mockImplementation(()=>Object.assign((async function*(){await idle;})(),{transport:{close}}));
 const controller=new AbortController();
 const pending=runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'hello',tools:[],signal:controller.signal,cwd:'/tmp',configDir:'/tmp'});
 const outcome=pending.then(()=> 'resolved',()=> 'cancelled');
 try{controller.abort();expect(close).toHaveBeenCalled();expect(await Promise.race([outcome,new Promise(r=>setTimeout(()=>r('hung'),100))])).toBe('cancelled');}
 finally{unblock();await outcome;}
});

it('ignores SDK control replies only after their own transport closes',async()=>{
 const {ProcessTransport}=await import('../packages/codebuddy-runtime/node_modules/@tencent-ai/agent-sdk/lib/transport/process-transport.js');
 const transport=new ProcessTransport({});
 sdk.query.mockImplementation(()=>Object.assign((async function*(){yield {type:'result',subtype:'success',is_error:false,result:'OK'};})(),{transport}));
 // A live transport error must still be visible.
 expect(()=>transport.sendControlResponse('live',{})).toThrow('Transport not started');
 await runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'hello',tools:[],signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'});
 expect(()=>transport.sendControlResponse('late',{})).not.toThrow();
 expect(()=>transport.sendControlErrorResponse('late','closed')).not.toThrow();
});

it('does not create a CLI query for an already cancelled request',async()=>{
 const controller=new AbortController();controller.abort();
 sdk.query.mockImplementation(()=>(async function*(){})());
 await expect(runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'hello',tools:[],signal:controller.signal,cwd:'/tmp',configDir:'/tmp'})).rejects.toThrow();
 expect(sdk.query).not.toHaveBeenCalled();
});
it('prevents SDK delayed startup from resurrecting a closed request',async()=>{
 const {ProcessTransport}=await import('../packages/codebuddy-runtime/node_modules/@tencent-ai/agent-sdk/lib/transport/process-transport.js');
 const transport=new ProcessTransport({});const spawn=vi.spyOn(transport,'start').mockImplementation(()=>{});
 let ready!:()=>void;const gate=new Promise<void>(resolve=>{ready=resolve;});
 sdk.query.mockImplementation(()=>Object.assign((async function*(){await gate;transport.start();})(),{transport}));
 const controller=new AbortController();
 const pending=runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'hello',tools:[],signal:controller.signal,cwd:'/tmp',configDir:'/tmp'});
 controller.abort();ready();
 await expect(pending).rejects.toThrow();expect(spawn).not.toHaveBeenCalled();
});

it('preserves proposals when CLI reports its turn limit as error_during_execution',async()=>{
 sdk.query.mockImplementation(()=>(async function*(){
  await sdk.callbacks[0]!({step:7});
  yield {type:'assistant',message:{model:'test',content:[],usage:{input_tokens:7,output_tokens:3}}};
  throw Object.assign(new Error('Max turns (1) exceeded'),{name:'ExecutionError',subtype:'error_during_execution',errors:['Max turns (1) exceeded']});
 })());
 const result=await runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'Read fixture',tools:[{name:'read_fixture',parameters:{type:'object',properties:{step:{type:'integer'}},required:['step']}}],signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'});
 expect(result).toMatchObject({failed:false,calls:[{name:'read_fixture',arguments:'{"step":7}'}]});
});

const completeToolTurn=(names=['mcp__token_flow__client_0'])=>[
 {type:'stream_event',event:{type:'message_start',message:{model:'test',usage:{input_tokens:20,output_tokens:0,cache_read_input_tokens:5}}}},
 ...names.flatMap((name,index)=>[
  {type:'stream_event',event:{type:'content_block_start',index,content_block:{type:'tool_use',id:`use_${index}`,name,input:{}}}},
  {type:'stream_event',event:{type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:'{"step":'}}},
  {type:'stream_event',event:{type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:'7}'}}},
  {type:'stream_event',event:{type:'content_block_stop',index}},
 ]),
 {type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:8}}},
 {type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{input_tokens:0,output_tokens:0}}},
 {type:'stream_event',event:{type:'message_stop'}},
];
const schemaCases=[
 {label:'oneOf required-only branches',parameters:{type:'object',properties:{selection:{type:'object',properties:{id:{type:'string'},name:{type:'string'}},oneOf:[{required:['id']},{required:['name']}]}},required:['selection']},args:{selection:{id:'synthetic'}}},
 {label:'tuple permits additional unspecified items',parameters:{type:'object',properties:{items:{type:'array',prefixItems:[{type:'string'}]}},required:['items']},args:{items:['synthetic',7]}},
 {label:'tuple permits fewer prefix items absent minItems',parameters:{type:'object',properties:{items:{type:'array',prefixItems:[{type:'string'}]}},required:['items']},args:{items:[]}},
 {label:'RFC3339 offset datetime',parameters:{type:'object',properties:{at:{type:'string',format:'date-time'}},required:['at']},args:{at:'2026-10-24T01:58:40-07:00'}},
 {label:'relative URI reference',parameters:{type:'object',properties:{uri:{type:'string',format:'uri-reference'}},required:['uri']},args:{uri:'../synthetic'}},
 {label:'default annotation does not insert missing args',parameters:{type:'object',properties:{optional:{type:'integer',default:7}}},args:{}},
];
it.each(schemaCases)('preserves original JSON Schema semantics: $label',async({parameters,args})=>{
 const events:any[]=completeToolTurn();const deltas=events.filter(m=>m.event.delta?.type==='input_json_delta');deltas[0].event.delta.partial_json=JSON.stringify(args);deltas[1].event.delta.partial_json='';
 sdk.query.mockImplementation(()=>(async function*(){for(const event of events)yield event;})());
 const result=await runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'Use the synthetic tool',tools:[{name:'fixture',parameters}],signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'});
 expect(result.failed).toBe(false);expect(JSON.parse(result.calls[0]!.arguments)).toEqual(args);
});
it('hands off the whole validated streamed tool turn before SDK follow-up inference',async()=>{
 let followup=false,closed=false;
 sdk.query.mockImplementation(()=> (async function*(){try{
  for(const message of completeToolTurn(['mcp__token_flow__client_0','mcp__token_flow__client_1']))yield message;
  followup=true;throw new Error('SDK entered follow-up inference');
 }finally{closed=true;}})());
 const result=await runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'Read fixtures',tools:['first','second'].map(name=>({name,parameters:{type:'object',properties:{step:{type:'integer'}},required:['step']}})),signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'});
 expect(followup).toBe(false);expect(closed).toBe(true);expect(result).toMatchObject({failed:false,calls:[{name:'first',arguments:'{"step":7}'},{name:'second',arguments:'{"step":7}'}],usage:{input_tokens:20,output_tokens:8,cache_read_input_tokens:5}});
});

it.each(['unknown','invalid_args','unfinished','wrong_model','parallel','stream_error','truncated'] as const)('rejects %s streamed tools instead of declaring a completed handoff',async fault=>{
 const events:any[]=completeToolTurn(fault==='parallel'?['mcp__token_flow__client_0','mcp__token_flow__client_0']:fault==='unknown'?['Bash']:undefined);
 if(fault==='invalid_args')events.find(m=>m.event.delta?.partial_json==='7}').event.delta.partial_json='"not-an-integer"}';
 if(fault==='unfinished')events.splice(events.findIndex(m=>m.event.type==='content_block_stop'),1);
 if(fault==='wrong_model')events[0].event.message.model='wrong';
 if(fault==='truncated')events.find(m=>m.event.delta?.stop_reason==='tool_use').event.delta.stop_reason='max_tokens';
 if(fault==='stream_error')events.splice(events.length-1,0,{type:'stream_event',event:{type:'error',error:{message:'synthetic'}}});
 sdk.query.mockImplementation(()=>(async function*(){for(const event of events)yield event;})());
 await expect(runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'Read fixture',tools:[{name:'read_fixture',parameters:{type:'object',properties:{step:{type:'integer'}},required:['step']}}],parallelToolCalls:fault==='parallel'?false:undefined,signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'})).rejects.toThrow();
});
it.each(['unknown_name','unfinished_block','invalid_json','invalid_args','truncated_turn','parallel_limit','orphan_delta'] as const)('reports safe %s tool diagnostics while still rejecting the proposal',async toolIssue=>{
 const events:any[]=completeToolTurn(toolIssue==='parallel_limit'?['mcp__token_flow__client_0','mcp__token_flow__client_0']:toolIssue==='unknown_name'?['private_tool_name']:undefined);
 if(toolIssue==='unfinished_block')events.splice(events.findIndex(m=>m.event.type==='content_block_stop'),1);
 if(toolIssue==='invalid_json')events.find(m=>m.event.delta?.partial_json==='7}').event.delta.partial_json=']';
 if(toolIssue==='invalid_args')events.find(m=>m.event.delta?.partial_json==='7}').event.delta.partial_json='"private_argument"}';
 if(toolIssue==='truncated_turn')events.find(m=>m.event.delta?.stop_reason==='tool_use').event.delta.stop_reason='max_tokens';
 if(toolIssue==='orphan_delta')events.splice(1,0,{type:'stream_event',event:{type:'content_block_delta',index:99,delta:{type:'input_json_delta',partial_json:'private_argument'}}});
 sdk.query.mockImplementation(()=>(async function*(){for(const event of events)yield event;})());const diagnostics:unknown[]=[];
 await expect(runOfficialSDK({token:'private_token',region:'china',model:'test',prompt:'private_prompt',tools:[{name:'fixture',parameters:{type:'object',properties:{step:{type:'integer'}},required:['step']}}],parallelToolCalls:toolIssue==='parallel_limit'?false:undefined,onDiagnostic:event=>diagnostics.push(event),signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'})).rejects.toThrow();
 expect(diagnostics).toContainEqual(expect.objectContaining({event:'failure',reason:'tool_protocol',toolIssue}));expect(JSON.stringify(diagnostics)).not.toMatch(/private_/);
});
it('does not return a streamed proposal twice when the MCP callback was already delivered',async()=>{
 sdk.query.mockImplementation(()=>(async function*(){await sdk.callbacks[0]!({step:7});for(const event of completeToolTurn())yield event;})());
 const result=await runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'Read fixture',tools:[{name:'read_fixture',parameters:{type:'object',properties:{step:{type:'integer'}},required:['step']}}],signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'});
 expect(result.calls).toHaveLength(1);expect(result.failed).toBe(false);
 // A late callback during shutdown cannot append to the handed-off result.
 await sdk.callbacks[0]!({step:8});expect(result.calls).toHaveLength(1);
});
it('rejects arbitrary tool diagnostic counters even when the error supplies a known issue',async()=>{
 const diagnostics:unknown[]=[];sdk.query.mockImplementation(()=>(async function*(){throw Object.assign(Error('private_error'),{sdkToolIssue:'unknown_name',sdkToolBlocks:'private_counter',sdkUnfinishedToolBlocks:-1});})());
 await expect(runOfficialSDK({token:'private_token',region:'china',model:'test',prompt:'private_prompt',tools:[],onDiagnostic:event=>diagnostics.push(event),signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'})).rejects.toThrow();
 const failure=diagnostics.find((event:any)=>event.event==='failure');expect(failure).toMatchObject({toolIssue:'unknown_name'});expect(failure).not.toHaveProperty('toolBlocks');expect(failure).not.toHaveProperty('unfinishedToolBlocks');expect(JSON.stringify(diagnostics)).not.toMatch(/private_/);
});
it('does not hide unrelated errors mixed with an incorrectly tagged turn limit',async()=>{
 sdk.query.mockImplementation(()=>(async function*(){await sdk.callbacks[0]!({step:7});throw Object.assign(new Error('Max turns (1) exceeded'),{name:'ExecutionError',subtype:'error_during_execution',errors:['Max turns (1) exceeded','upstream disconnected']});})());
 await expect(runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'Read fixture',tools:[{name:'read_fixture',parameters:{type:'object',properties:{step:{type:'integer'}},required:['step']}}],signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'})).rejects.toThrow();
});

const idleInput=(controller:AbortController)=>({token:'fixture',region:'china' as const,model:'test',prompt:'same history',tools:[{name:'read_fixture',parameters:{type:'object',properties:{step:{type:'integer'}},required:['step']}}],signal:controller.signal,cwd:'/tmp',configDir:'/tmp'});
function silentQuery(events:any[]){
 let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
 return Object.assign((async function*(){for(const event of events)yield event;await wait;})(),{transport:{close:()=>release()}});
}
const thinkingStart=[
 {type:'stream_event',event:{type:'message_start',message:{model:'test',usage:{input_tokens:10,output_tokens:0}}}},
 {type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}}},
 {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'fixture'}}},
];
it.each(['thinking','text','tool'] as const)('waits through a long silent %s turn without cancelling or replaying it',async phase=>{
 vi.useFakeTimers();const controller=new AbortController();let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});let settled=false;
 const extra=phase==='text'?[{type:'stream_event',event:{type:'content_block_start',index:1,content_block:{type:'text'}}},{type:'stream_event',event:{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'FIRST'}}}]:phase==='tool'?[{type:'stream_event',event:{type:'content_block_start',index:1,content_block:{type:'tool_use',name:'mcp__token_flow__client_0',input:{}}}}]:[];
 sdk.query.mockImplementation(()=>Object.assign((async function*(){for(const event of [...thinkingStart,...extra])yield event;await wait;
  if(controller.signal.aborted)return;
  if(phase==='tool'){for(const event of completeToolTurn())yield event;}
  else {yield {type:'assistant',message:{model:'test',content:[{type:'text',text:phase==='text'?'FIRST':'late complete answer'}]}};yield {type:'result',subtype:'success',is_error:false};}
 })(),{transport:{close:release}}));
 const outcome=runOfficialSDK(idleInput(controller)).then(value=>{settled=true;return value;},error=>{settled=true;throw error;});
 try{await vi.advanceTimersByTimeAsync(24*60*60*1000);expect(settled).toBe(false);expect(sdk.query).toHaveBeenCalledTimes(1);release();expect((await outcome).failed).toBe(false);expect(sdk.query).toHaveBeenCalledTimes(1);}
 finally{controller.abort();release();await outcome.catch(()=>{});vi.useRealTimers();}
});
it('does not retry when the caller cancels the thinking turn',async()=>{
 vi.useFakeTimers();const controller=new AbortController();sdk.query.mockImplementation(()=>silentQuery(thinkingStart));
 const outcome=runOfficialSDK(idleInput(controller)).then(()=>null,error=>error);
 try{await vi.advanceTimersByTimeAsync(30000);controller.abort();await outcome;await vi.advanceTimersByTimeAsync(60001);expect(sdk.query).toHaveBeenCalledTimes(1);}
 finally{controller.abort();await outcome;vi.useRealTimers();}
});

it('passes the account endpoint to CLI initialization instead of relying on the international default',async()=>{
 sdk.query.mockImplementation(()=>(async function*(){yield {type:'result',subtype:'success',is_error:false,result:'ok'};})());
 await runOfficialSDK({token:'fixture',region:'international',endpoint:'https://www.workbuddy.ai',model:'test',prompt:'Reply ok',tools:[],signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'});
 expect(sdk.query.mock.calls[0]![0].options).toMatchObject({environment:'external',endpoint:'https://www.workbuddy.ai'});
 // The CLI CLOUD provider runs before its OPTIONS provider. This early identity
 // is required for the first remote config request, not just later inference.
 expect(JSON.parse(sdk.query.mock.calls[0]![0].options.env.ACC_PRODUCT_CONFIG_V3)).toEqual({endpoint:'https://www.workbuddy.ai'});
});

it('classifies policy rejection from the full SDK error list rather than its first message',async()=>{
 sdk.query.mockImplementation(()=>(async function*(){throw Object.assign(new Error('Execution failed'),{name:'ExecutionError',errors:['Execution failed','403 unapproved channel (11128) Bearer private-token']});})());
 const result=await runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'hello',tools:[],signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'});
 expect(result).toMatchObject({failed:true,errorCode:'source_policy_blocked'});
 expect(JSON.stringify(result)).not.toContain('private-token');
});
it('retains source semantics and safe diagnostics for an error inside a model stream',async()=>{
 const diagnostics:unknown[]=[];
 sdk.query.mockImplementation(()=>(async function*(){yield {type:'stream_event',event:{type:'error',error:{type:'invalid_request_error',message:'403 unapproved channel (11128) Bearer private-token'}}};})());
 const result=await runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'private-prompt',tools:[],onDiagnostic:event=>diagnostics.push(event),signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'});
 expect(result).toMatchObject({failed:true,errorCode:'source_policy_blocked'});
 expect(diagnostics).toContainEqual(expect.objectContaining({event:'failure',reason:'source_policy_blocked',origin:'stream'}));
 expect(JSON.stringify({result,diagnostics})).not.toMatch(/private-token|private-prompt/);
});
it('reports structural text-mismatch evidence without copying model text into diagnostics',async()=>{
 const diagnostics:unknown[]=[];
 sdk.query.mockImplementation(()=>(async function*(){
  yield {type:'stream_event',event:{type:'message_start',message:{model:'test'}}};
  yield {type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text'}}};
  yield {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'private-partial'}}};
  yield {type:'assistant',message:{model:'test',content:[{type:'text',text:'private-complete'}]}};
 })());
 await expect(runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'hello',tools:[],onDiagnostic:event=>diagnostics.push(event),signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'})).rejects.toThrow('text stream mismatch');
 expect(diagnostics).toContainEqual(expect.objectContaining({event:'failure',reason:'text_mismatch',origin:'exception',partialChars:15,completeChars:16}));
 expect(JSON.stringify(diagnostics)).not.toMatch(/private-|hello/);
});
it('reports a missing SDK result separately from a generic failed result',async()=>{
 const diagnostics:unknown[]=[];
 sdk.query.mockImplementation(()=>(async function*(){})());
 const result=await runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'hello',tools:[],onDiagnostic:event=>diagnostics.push(event),signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'});
 expect(result.failed).toBe(true);
 expect(diagnostics).toContainEqual(expect.objectContaining({event:'failure',reason:'missing_result',origin:'result'}));
});

it('counts the real SDK errors array without duplicating its first-message alias',async()=>{
 const diagnostics:unknown[]=[];
 sdk.query.mockImplementation(()=>(async function*(){throw Object.assign(new Error('Execution failed'),{name:'ExecutionError',errors:['Execution failed','context_length_exceeded private-prompt']});})());
 await expect(runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'private-prompt',tools:[],onDiagnostic:event=>diagnostics.push(event),signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'})).rejects.toThrow();
 expect(diagnostics).toContainEqual(expect.objectContaining({event:'failure',reason:'context_limit',errorCount:2}));
 expect(JSON.stringify(diagnostics)).not.toContain('private-prompt');
});
it('does not diagnose an intentional SDK turn-limit handoff as a failed request',async()=>{
 const diagnostics:unknown[]=[];
 sdk.query.mockImplementation(()=>(async function*(){await sdk.callbacks[0]!({});throw Object.assign(new Error('Maximum turns reached'),{name:'ExecutionError',subtype:'error_max_turns',errors:['Maximum turns reached']});})());
 const result=await runOfficialSDK({token:'fixture',region:'china',model:'test',prompt:'hello',tools:[{name:'read',parameters:{type:'object'}}],onDiagnostic:event=>diagnostics.push(event),signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'});
 expect(result.failed).toBe(false);expect(diagnostics).not.toContainEqual(expect.objectContaining({event:'failure'}));
});
