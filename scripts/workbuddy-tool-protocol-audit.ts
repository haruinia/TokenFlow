// Explicit bounded live diagnostic. Reads only the selected saved source and
// uses synthetic history/tools. Reports structural enums/counters only.
import {readFile,readdir,mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {WorkBuddySDKProvider} from '../packages/core/src/codebuddy.js';
import {runOfficialSDK,type SDKInput} from '../packages/codebuddy-runtime/index.js';
if(process.argv[2]!=='--live')throw Error('Explicit --live required');
const profile=join(homedir(),'Library/Application Support/desktop-browser-agent');
const trace=JSON.parse(await readFile(join(profile,'gateway-traces.json'),'utf8'));
const complex=process.argv.includes('--complex');
const schemaCases=process.argv.includes('--schema-cases');
const sourceId=process.argv.slice(3).find(value=>/^[a-f0-9]{24}$/.test(value))??trace.records.find((r:any)=>r.model==='workbuddy/deepseek-v4.1-flash'&&r.status===502)?.sourceId;
const file=(await readdir(join(profile,'cliproxy/auth'))).find(name=>name.endsWith('.json')&&createHash('sha256').update(name).digest('hex').slice(0,24)===sourceId);
if(!file)throw Error('Selected source is unavailable');
const credential=JSON.parse(await readFile(join(profile,'cliproxy/auth',file),'utf8'));
if(credential.type!=='workbuddy'||credential.disabled)throw Error('Selected source is unavailable');
const require=createRequire(resolve('packages/codebuddy-runtime/index.js'));
const {ProcessTransport}=require(resolve(require.resolve('@tencent-ai/agent-sdk'),'../transport/process-transport.js'));
const originalMessages=ProcessTransport.prototype.messages;
let capture:any,toolNames:string[]=[];
const nameKind=(name:unknown)=>{
 if(typeof name!=='string')return 'missing';
 const mapped=/^mcp__token_flow__client_(\d+)$/.exec(name);
 if(mapped&&Number(mapped[1])<toolNames.length)return 'registered';
 if(toolNames.includes(name))return 'original_client';
 if(/^client_\d+$/.test(name))return 'wrapper_shorthand';
 if(name.startsWith('mcp__'))return 'other_mcp';
 return 'other';
};
ProcessTransport.prototype.messages=async function*(){
 for await(const message of originalMessages.call(this)){
  const event=message.type==='stream_event'?message.event:undefined;
  if(event?.type==='message_start'){capture.modelMatched=event.message?.model==='deepseek-v4.1-flash';capture.blocks=new Map();capture.stopReasons=[];}
  if(event?.type==='content_block_start'&&event.content_block?.type==='tool_use')capture.blocks.set(event.index,{nameKind:nameKind(event.content_block.name),complete:false,json:'',initial:event.content_block.input});
  if(event?.type==='content_block_delta'&&event.delta?.type==='input_json_delta'){const block=capture.blocks.get(event.index);if(block)block.json+=event.delta.partial_json;else capture.orphanDeltas++;}
  if(event?.type==='content_block_stop'&&capture.blocks.has(event.index))capture.blocks.get(event.index).complete=true;
  if(event?.type==='message_delta'&&event.delta?.stop_reason)capture.stopReasons.push(['tool_use','end_turn','max_tokens','model_context_window_exceeded','refusal'].includes(event.delta.stop_reason)?event.delta.stop_reason:'other');
  if(event?.type==='message_stop'){
   capture.turns.push({modelMatched:capture.modelMatched,stopReasons:capture.stopReasons,toolBlocks:[...capture.blocks.values()].map((block:any)=>{
    let jsonValid=true,argKind='missing';try{const args=block.json?JSON.parse(block.json):block.initial;argKind=Array.isArray(args)?'array':args===null?'null':typeof args;}catch{jsonValid=false;}
    return {nameKind:block.nameKind,complete:block.complete,jsonChars:block.json.length,jsonValid,argKind};
   })});
  }
  yield message;
 }
};
const root=await mkdtemp(join(tmpdir(),'tf-workbuddy-protocol-'));const report:any={at:new Date().toISOString(),source:sourceId,model:'workbuddy/deepseek-v4.1-flash',toolCount:schemaCases?1:complex?115:12,historyTurns:complex?100:1,...(schemaCases?{schemaCase:'oneOf_required_only'}:{}),requests:[]};
const provider=new WorkBuddySDKProvider(root,async()=>credential,async(input:SDKInput)=>{
 toolNames=input.tools.map(tool=>tool.name);
 try{return await runOfficialSDK({...input,onDiagnostic:event=>{input.onDiagnostic?.(event);capture.diagnostics.push(event);}});}
 catch(error){capture.failure=capture.diagnostics.find((event:any)=>event.event==='failure'&&event.toolIssue)?.toolIssue??(/incomplete or unknown tool proposal/.test(String((error as Error)?.message))?'incomplete_or_unknown':/tool turn did not finish/.test(String((error as Error)?.message))?'truncated_turn':/single client tool limit/.test(String((error as Error)?.message))?'parallel_limit':/tool delta without/.test(String((error as Error)?.message))?'orphan_delta':(error as Error)?.name==='ZodError'?'schema_validation':'other');throw error;}
});
try{
 const names=Array.from({length:report.toolCount},(_,i)=>complex&&i<2?['Bash','Read'][i]:`mcp__diagnostic${complex&&i%2?'.fixture':'_fixture'}__lookup_${i}`);
 const schema=schemaCases?{type:'object',properties:{selection:{type:'object',properties:{id:{type:'string'},name:{type:'string'}},oneOf:[{required:['id']},{required:['name']}]}},required:['selection'],additionalProperties:false}:{type:'object',properties:{key:{type:'string'}},required:['key'],additionalProperties:false};
 for(const protocol of ['messages','responses'] as const){
  const history:any[]=protocol==='messages'?[{role:'user',content:'Use the diagnostic lookup tool.'},{role:'assistant',content:[{type:'tool_use',id:'fixture_previous',name:names[0],input:{key:'previous'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'fixture_previous',content:'SYNTHETIC_RESULT_PREVIOUS'}]}]:[{role:'user',content:'Use the diagnostic lookup tool.'},{type:'function_call',call_id:'fixture_previous',name:names[0],arguments:'{"key":"previous"}'},{type:'function_call_output',call_id:'fixture_previous',output:'SYNTHETIC_RESULT_PREVIOUS'}];
  if(complex)for(let step=1;step<100;step++){
   const name=names[step%names.length],id=`fixture_history_${step}`;
   if(protocol==='messages')history.push({role:'assistant',content:[{type:'tool_use',id,name,input:{key:`historical_${step}`}}]},{role:'user',content:[{type:'tool_result',tool_use_id:id,content:`SYNTHETIC_RESULT_${step}`} ]});
   else history.push({type:'function_call',call_id:id,name,arguments:JSON.stringify({key:`historical_${step}`})},{type:'function_call_output',call_id:id,output:`SYNTHETIC_RESULT_${step}`});
  }
  for(let turn=0;turn<(schemaCases?1:2);turn++){
   capture={diagnostics:[],turns:[],blocks:new Map(),stopReasons:[],orphanDeltas:0};const begin=Date.now();
   const tools=names.map(name=>protocol==='messages'?{name,description:'Synthetic lookup. Only the caller executes it.',input_schema:schema}:{type:'function',name,description:'Synthetic lookup. Only the caller executes it.',parameters:schema});
   history.push({role:'user',content:schemaCases?`Call ${names[0]} once with selection containing only id equal to synthetic_next. Do not provide a name. Only propose this client tool; do not report invented results.`:`Call ${names[0]} once with key next_${turn}. Only propose this client tool; do not report invented results.`});
   const body={model:report.model,tools,parallel_tool_calls:false,stream:false,...(protocol==='messages'?{messages:history,max_tokens:512}:{input:history,max_output_tokens:512})};
   const response=await provider.response(String(sourceId),protocol,body,AbortSignal.timeout(70000));const data=await response.json();
   const calls=protocol==='messages'?(data.content??[]).filter((block:any)=>block.type==='tool_use'):(data.output??[]).filter((block:any)=>block.type==='function_call');
   const args=schemaCases&&calls.length===1?(protocol==='messages'?calls[0].input:JSON.parse(calls[0].arguments)):undefined;
   const item={protocol,turn,httpStatus:response.status,durationMs:Date.now()-begin,calls:calls.length,...(schemaCases?{schemaCaseMatched:args?.selection?.id==='synthetic_next'&&!Object.hasOwn(args.selection,'name')}:{}),errorCode:data.error?.code??data.error?.type,issue:capture.failure,orphanDeltas:capture.orphanDeltas,turns:capture.turns,diagnostics:capture.diagnostics};report.requests.push(item);console.log(JSON.stringify(item));
   if(response.status!==200||calls.length!==1)break;
   if(protocol==='messages'){history.push({role:'assistant',content:data.content});history.push({role:'user',content:calls.map((call:any)=>({type:'tool_result',tool_use_id:call.id,content:'SYNTHETIC_RESULT_NEXT'}))});}
   else {history.push(...data.output);history.push(...calls.map((call:any)=>({type:'function_call_output',call_id:call.call_id,output:'SYNTHETIC_RESULT_NEXT'})));}
  }
 }
}catch{report.scriptFailure='diagnostic_request_failed';console.log(JSON.stringify({scriptFailure:report.scriptFailure}));process.exitCode=1;}
finally{await provider.close();ProcessTransport.prototype.messages=originalMessages;await rm(root,{recursive:true,force:true});await mkdir('artifacts',{recursive:true});await writeFile(`artifacts/workbuddy-tool-protocol-audit${schemaCases?'-schema-cases':complex?'-complex':''}.json`,JSON.stringify(report,null,2));}
