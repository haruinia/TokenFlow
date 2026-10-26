import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {query,createSdkMcpServer,tool} from '@tencent-ai/agent-sdk';
import {z} from 'zod';
import {ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createClientSchemaCompiler} from './client-schema.js';

const modelTransportPrompt = 'Continue the caller conversation supplied in the user input. Follow the caller system instructions below. You provide model responses and client tool proposals only. The client owns task execution and executes every proposed tool. Do not act as a separate coding agent, access local files, or claim a tool executed before its result appears in the supplied history. Historical tool calls are not new requests. Output the continuation, not an explanation of the transcript.';

// Separate workspace dependency keeps the SDK's Zod 4 peer out of the app's Zod 3.
const require=createRequire(import.meta.url);
const cli=resolve(require.resolve('@tencent-ai/agent-sdk'),'../../cli/bin/codebuddy').replace(/\.asar([/\\])/g,'.asar.unpacked$1');

function sourceErrorCode(message){
 return /\b11128\b|unapproved channel/i.test(message)?'source_policy_blocked':/\b401\b|unauthorized|invalid.*token/i.test(message)?'authentication_error':/\b429\b|rate.limit/i.test(message)?'rate_limit_error':undefined;
}
const toolIssues=new Set(['unknown_name','unfinished_block','invalid_json','invalid_args','truncated_turn','parallel_limit','orphan_delta','input_limit']);

// Inspect errors in memory; diagnostic events contain only known labels,
// counters and a fingerprint, never arbitrary exception/request text.
function failureDiagnostic(value,origin){
 const details=[...new Set([value?.message,...(Array.isArray(value?.errors)?value.errors:[]),value?.error,value?.sdkCause].filter(v=>v!==undefined))];
 const detail=details.slice(0,32).map(v=>typeof v==='string'?v:[v?.message,v?.type,v?.code].filter(v=>typeof v==='string'||typeof v==='number').join(' ')).join('\n').slice(0,65536);
 const source=sourceErrorCode(detail);
 const toolIssue=toolIssues.has(value?.sdkToolIssue)?value.sdkToolIssue:undefined;
 const reason=source??(toolIssue?'tool_protocol':/text stream mismatch/.test(detail)?'text_mismatch':/model (?:mismatch|changed)/i.test(detail)?'model_mismatch':/context.{0,40}(?:length|window|limit|exceed)|(?:input|prompt).{0,30}(?:too long|too large)|too many tokens/i.test(detail)?'context_limit':/(?:max.?tokens|output.{0,20}(?:limit|budget)).{0,40}(?:exceed|invalid|maximum)/i.test(detail)?'output_limit':/(?:invalid|unsupported).{0,30}(?:tool|function).{0,20}schema|(?:tool|function).{0,20}schema.{0,30}(?:invalid|unsupported)/i.test(detail)?'tool_schema':/tool (?:delta|input|turn|proposal)|incomplete or unknown tool|single client tool limit/i.test(detail)?'tool_protocol':/max(?:imum)? turns|turns \(\d+\) exceeded/i.test(detail)?'turn_limit':/EOF|socket|ECONN|fetch failed|ENOTFOUND/i.test(detail)?'transport':/timeout|timed out/i.test(detail)?'timeout':value?.name==='CLIStartupError'?'sdk_startup':value?.name==='ExecutionError'?'sdk_execution':'unknown');
 const mismatch=detail.match(/text stream mismatch: partial=(\d+), complete=(\d+)/);
 const toolStats={};for(const [field,valueField] of [['toolBlocks','sdkToolBlocks'],['unfinishedToolBlocks','sdkUnfinishedToolBlocks']])if(Number.isSafeInteger(value?.[valueField])&&value[valueField]>=0&&value[valueField]<=1000000)toolStats[field]=value[valueField];
 const status=[value?.status,value?.statusCode].find(v=>Number.isInteger(v)&&v>=400&&v<=599)??(Number(detail.match(/\b(?:HTTP(?: status)?|status(?:Code)?|API Error)[: =]+(400|401|403|408|413|422|429|500|502|503|504)\b/i)?.[1])||undefined);
 return {origin,reason,...(toolIssue?{toolIssue,...toolStats}:{}),...(status?{status}:{}),...(details.length?{errorCount:details.length,fingerprint:createHash('sha256').update(detail).digest('hex')}:{}),...(mismatch?{partialChars:Number(mismatch[1]),completeChars:Number(mismatch[2])}:{}),...(['error_max_turns','error_during_execution','error_max_budget_usd'].includes(value?.subtype)?{subtype:value.subtype}:{})};
}

function reachedTurnLimit(value){
 if(value?.subtype==='error_max_turns')return true;
 const errors=value?.errors??[value?.message];
 return value?.subtype==='error_during_execution'&&Array.isArray(errors)&&errors.length>0&&errors.every(error=>typeof error==='string'&&/^Max(?:imum)? turns(?: \(\d+\))? (?:exceeded|reached)$/i.test(error));
}
function streamUsage(previous,next){
 const usage={...previous};
 for(const key of ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'])if(Number.isFinite(next?.[key])&&next[key]>=0)usage[key]=Math.max(usage[key]??0,next[key]);
 return usage;
}

export async function runOfficialSDK(input){
 const started=Date.now();
 const diagnostic=(event,details={})=>input.onDiagnostic?.({event,elapsedMs:Date.now()-started,...details});
 if(input.signal.aborted){diagnostic('closed');throw new Error('SDK request cancelled');}
 const calls=[];const names=new Map();const schemas=new Map();let accepting=true;
 const compileSchema=createClientSchemaCompiler();const listed=[];
 const definitions=input.tools.map((t,i)=>{
  const name=`client_${i}`;names.set(`mcp__token_flow__${name}`,t);
  let schema;try{schema=compileSchema(t.parameters);}catch{diagnostic('failure',{origin:'exception',reason:'tool_schema'});throw Error('SDK tool schema is invalid or unsupported');}
  schemas.set(`mcp__token_flow__${name}`,schema);
  const description=`Client tool ${t.name}. ${t.description??''}`;listed.push({name,description,inputSchema:schema.inputSchema});
  // Only the transport uses a loose object. Both callbacks and streamed
  // proposals validate the original schema without altering client arguments.
  return tool(name,description,z.looseObject({}),args=>{
   try{schema.parse(args);}catch{return {isError:true,content:[{type:'text',text:'Client tool arguments do not match the declared JSON Schema. The tool did not execute.'}]};}
   // These callbacks only propose client work. Reject additional proposals
   // before recording them when the caller requires sequential execution.
   if(!accepting||input.parallelToolCalls===false&&calls.length)return {isError:true,content:[{type:'text',text:'Only one client tool call is permitted this turn. This tool did not execute; wait for the client result before requesting it again.'}]};
   calls.push({name:t.name,arguments:JSON.stringify(args),custom:t.custom});
   // Never execute caller tools here. maxTurns=1 is a fallback limit;
   // the actual tool result arrives in the caller's next request.
   return {content:[{type:'text',text:'Deferred to the client. The tool has not executed yet.'}]};
  });
 });
 const mcp=definitions.length?createSdkMcpServer({name:'token_flow',tools:definitions}):undefined;
 // Expose the original declaration through the public low-level MCP handler;
 // the high-level SDK must not regenerate it from the transport's Zod schema.
 if(mcp)mcp.instance.server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:listed}));
 const env=Object.fromEntries(Object.keys(process.env).filter(k=>/^(CODEBUDDY|ANTHROPIC|OPENAI|WORKBUDDY|ACC_PRODUCT)_/.test(k)).map(k=>[k,undefined]));
 // CLI cloud discovery precedes the late --endpoint option. Set its early
 // authoritative endpoint too, so an overseas token never discovers another region.
 // SERVER__PORT=0: the CLI's embedded cell HTTP server otherwise binds 127.0.0.1:6201,
 // colliding with the WorkBuddy host daemon on the same machine; every SDK request
 // then dies with EADDRINUSE before any model event and the gateway reports a
 // misleading idle timeout. Port 0 picks a free ephemeral port instead.
 Object.assign(env,{ACC_PRODUCT_CONFIG_V3:JSON.stringify({endpoint:input.endpoint??(input.region==='china'?'https://copilot.tencent.com':'https://www.codebuddy.ai')}),CODEBUDDY_AUTH_TOKEN:input.token,CODEBUDDY_INTERNET_ENVIRONMENT:input.region==='china'?'internal':'public',CODEBUDDY_CONFIG_DIR:input.configDir,SERVER__PORT:'0',SERVER__HOST:'127.0.0.1',...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})});
 let q,child;
 const abortController=new AbortController();const cancel=()=>{abortController.abort();child??=q?.transport?.process;q?.transport?.close();};input.signal.addEventListener('abort',cancel,{once:true});if(input.signal.aborted)cancel();
 let text='',usage,result,actualModel=input.model;let streamed=false;let streamModel;let partial='';const blockTypes=new Map(),toolBlocks=new Map();let turnUsage={},handedOff=false,turnTruncated=false;
 const toolError=toolIssue=>Object.assign(new Error('SDK tool proposal rejected'),{sdkToolIssue:toolIssue,sdkToolBlocks:toolBlocks.size,sdkUnfinishedToolBlocks:[...toolBlocks.values()].filter(block=>!block.complete).length});
 const prompt=input.images?.length?(async function*(){yield {type:'user',session_id:'',parent_tool_use_id:null,message:{role:'user',content:[{type:'text',text:input.prompt},...input.images]}};})():input.prompt;
 try{
  q=query({prompt,options:{pathToCodebuddyCode:cli,executable:process.execPath,env,environment:input.region==='china'?'internal':'external',endpoint:input.endpoint,model:input.model,cwd:input.cwd,systemPrompt:[modelTransportPrompt,input.systemPrompt].filter(Boolean).join('\n\n'),includePartialMessages:true,settingSources:[],tools:[],mcpServers:mcp?{token_flow:mcp}:{},strictMcpConfig:true,persistSession:false,maxTurns:1,abortController,stderr:line=>{const value=String(line);if(/retry|retrying|429|timeout|ECONN|EOF/i.test(value))diagnostic('stderr',{category:/429/.test(value)?'rate_limit':/retry/i.test(value)?'retry':/timeout/i.test(value)?'timeout':'transport'});},canUseTool:async(name,args)=>names.has(name)?{behavior:'allow',updatedInput:args}:{behavior:'deny',message:'Only caller-provided tools are permitted'}}});
  // SDK 0.3.276 dispatches MCP requests without awaiting them. Its close()
  // rejects pending MCP work; the catch then tries to reply to the dead CLI,
  // creating an unhandled rejection that terminates the entire gateway.
  // Discard only replies to this request's closed transport. Live failures
  // remain errors, and no global rejection handler hides unrelated bugs.
  const transport=q.transport;
  // connect() awaits CLI version discovery before start(). Cancellation can close
  // the transport during that await; SDK 0.3.276 otherwise spawns a new child
  // on the closed transport and then waits for initialization/forced cleanup.
  const start=transport?.start;
  if(typeof start==='function')transport.start=function(...args){
   if(this.closed||input.signal.aborted)throw new Error('SDK request cancelled');
   return start.apply(this,args);
  };
  for(const method of ['sendControlResponse','sendControlErrorResponse']){
   const send=transport?.[method];
   if(typeof send==='function')transport[method]=function(...args){if(this.closed)return;return send.apply(this,args);};
  }
  if(input.signal.aborted)cancel();
  diagnostic('started');
  for await(const message of q){
   if(['system','assistant','result'].includes(message.type))diagnostic(message.type,{subtype:message.type==='result'?message.subtype:undefined});
   // SDK 0.3.276 closes asynchronously. Retain only its owned child handle so
   // temporary session files are removed after the CLI has finished flushing.
   child??=q.transport?.process;
   // Top-level CLI errors (e.g. listen EADDRINUSE on its embedded server) end the
   // stream without a result message. Fail fast with the real cause instead of
   // silently draining until the 60-second idle watchdog reports a fake timeout.
   if(message.type==='error')throw new Error(`SDK CLI error: ${typeof message.error==='string'?message.error:JSON.stringify(message.error??message)}`);
   if(message.type==='stream_event'){
    const event=message.event;
    if(event.type==='message_start'){streamModel=event.message.model;partial='';blockTypes.clear();toolBlocks.clear();turnUsage=streamUsage({},event.message.usage);turnTruncated=false;}
    if(event.type==='content_block_start'){
     blockTypes.set(event.index,event.content_block.type);
     if(event.content_block.type==='tool_use')toolBlocks.set(event.index,{name:event.content_block.name,input:event.content_block.input,json:'',complete:false});
    }
    if(event.type==='content_block_delta'&&event.delta.type==='input_json_delta'){
     const block=toolBlocks.get(event.index);if(!block)throw toolError('orphan_delta');
     block.json+=event.delta.partial_json;if(block.json.length>16*1024*1024)throw toolError('input_limit');
    }
    if(event.type==='content_block_stop'&&toolBlocks.has(event.index))toolBlocks.get(event.index).complete=true;
    if(event.type==='message_delta'){turnUsage=streamUsage(turnUsage,event.usage);if(['max_tokens','model_context_window_exceeded','refusal'].includes(event.delta?.stop_reason))turnTruncated=true;}
    if(event.type==='error')throw Object.assign(new Error('SDK model stream reported an error'),{sdkCause:event.error});
    // The CLI can continue inference after its deferred MCP callback and even
    // mislabel its one-turn limit as error_during_execution. The client owns
    // execution: hand off at the complete model turn, never at a partial block.
    if(event.type==='message_stop'&&toolBlocks.size){
     if(turnTruncated)throw toolError('truncated_turn');
     if(input.model!=='auto'&&streamModel!==input.model)throw new Error('SDK streaming model mismatch');
     const proposals=[...toolBlocks.values()].map(block=>{
      const tool=names.get(block.name),schema=schemas.get(block.name);
      if(!block.complete)throw toolError('unfinished_block');
      if(!tool||!schema)throw toolError('unknown_name');
      let raw;try{raw=block.json?JSON.parse(block.json):block.input;}catch{throw toolError('invalid_json');}
      let args;try{args=schema.parse(raw);}catch{throw toolError('invalid_args');}
      return {name:tool.name,arguments:JSON.stringify(args),custom:tool.custom};
     });
     if(input.parallelToolCalls===false&&proposals.length>1)throw toolError('parallel_limit');
     accepting=false;calls.splice(0,calls.length,...proposals);actualModel=streamModel;
     if(Number.isFinite(turnUsage.input_tokens)&&Number.isFinite(turnUsage.output_tokens))usage=turnUsage;
     text+=partial;partial='';handedOff=true;diagnostic('tool_handoff',{toolCalls:calls.length});break;
    }
    if(event.type==='content_block_delta'&&event.delta.type==='text_delta'&&blockTypes.get(event.index)==='text'){
     if(input.model!=='auto'&&streamModel!==input.model)throw new Error('SDK streaming model mismatch');
     const delta=event.delta.text;partial+=delta;streamed=true;input.onText?.(delta);
    }
   }
   if(message.type==='assistant'){
    actualModel=message.message.model;usage=message.message.usage??usage;
    const complete=message.message.content.filter(c=>c.type==='text').map(c=>c.text).join('');
    if(!message.message.content.some(c=>c.type==='text'))continue;
    if(partial&&complete!==partial)throw new Error(`SDK text stream mismatch: partial=${partial.length}, complete=${complete.length}, blocks=${message.message.content.map(c=>c.type).join(',')}`);
    if(!partial&&complete){if(input.model!=='auto'&&actualModel!==input.model)throw new Error('SDK model mismatch');input.onText?.(complete);}
    text+=complete;partial='';
   }
   if(message.type==='result'){result=message;usage=message.usage??usage;if(!text&&message.result){text=message.result;if(!streamed)input.onText?.(text);}}
  }
  if(input.signal.aborted)throw new Error('SDK request cancelled');
  // A deferred tool call intentionally reaches the one-turn limit.
  const failed=!handedOff&&(!result||result.is_error&&!(calls.length&&reachedTurnLimit(result)));
  const errors=JSON.stringify(result?.errors??[]);
  const errorCode=sourceErrorCode(errors);
  if(failed)diagnostic('failure',result?failureDiagnostic(result,'result'):{origin:'result',reason:'missing_result'});
  return {text,calls,usage,model:actualModel,failed,errorCode};
 }catch(error){
  const detail=String(error?.message??'');
  const failure=failureDiagnostic(error,error?.sdkCause?'stream':'exception');
  diagnostic('exception',{toolCalls:calls.length,kind:['ExecutionError','CLIStartupError','AbortError','Error'].includes(error?.name)?error.name:'other',subtype:['error_max_turns','error_during_execution'].includes(error?.subtype)?error.subtype:undefined,status:failure.status,category:/text stream mismatch/.test(detail)?'text_mismatch':/model mismatch/.test(detail)?'model_mismatch':/EOF|socket|ECONN|fetch failed/i.test(detail)?'transport':/timeout|timed out/i.test(detail)?'timeout':'other'});
  // The SDK throws ExecutionError for upstream HTTP failures instead of always
  // yielding a result.errors item. Both channels must retain source semantics.
  if(error?.name==='ExecutionError'&&reachedTurnLimit(error)&&calls.length&&!input.signal.aborted)return {text,calls,usage,model:actualModel,failed:false};
  if(!input.signal.aborted)diagnostic('failure',failure);
  const errorCode=(error?.name==='ExecutionError'||error?.sdkCause)?['source_policy_blocked','authentication_error','rate_limit_error'].find(code=>code===failure.reason):undefined;
  if(!errorCode||input.signal.aborted)throw error;
  return {text,calls:[],usage,model:actualModel,failed:true,errorCode};
 }finally{
  accepting=false;input.signal.removeEventListener('abort',cancel);child??=q?.transport?.process;
  // Iteration already closes the SDK transport. return() means interrupt in
  // SDK 0.3.276 and can wait for a control reply after shutdown.
  q?.transport?.close();
  if(child&&child.exitCode===null&&child.signalCode===null)await new Promise(done=>{
   const timer=setTimeout(()=>child.kill('SIGKILL'),8000);child.once('close',()=>{clearTimeout(timer);done();});
  });
  await mcp?.instance.close().catch(()=>{});diagnostic('closed');
 }
}
