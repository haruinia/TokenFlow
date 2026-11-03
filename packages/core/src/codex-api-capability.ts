import {randomBytes} from 'node:crypto';
import {RunnerCoreError} from './errors.js';
import {providerUsage} from './gateway-observation.js';
import type {ProtocolProbeUsage} from './api-protocol.js';

export type CodexApiCapability={checkedAt:string;streaming:true;tools:true;multiTurn:true;localSummary:true;remoteCompaction:'unsupported'};
const failure=(message:string)=>new RunnerCoreError(message,{statusCode:400,code:'codex_api_incompatible'});

/** Native Responses checks are separate from generic protocol discovery. No user history is sent. */
export async function probeCodexApi(input:{baseURL:string;apiKey:string;model:string},signal:AbortSignal,onUsage?:(usage:ProtocolProbeUsage)=>void,fetcher:typeof fetch=fetch):Promise<CodexApiCapability>{
 const deadline=AbortSignal.timeout(90000),combined=AbortSignal.any([signal,deadline]);
 const nonce=randomBytes(6).toString('hex');
 const call=async(body:Record<string,unknown>)=>{
  const started=Date.now();let response:Response;
  try{response=await fetcher(`${input.baseURL.replace(/\/$/,'')}/responses`,{method:'POST',headers:{authorization:`Bearer ${input.apiKey}`,'content-type':'application/json'},body:JSON.stringify({model:input.model,stream:true,store:false,...body}),signal:combined,redirect:'error'});}
  catch{throw failure(signal.aborted?'已取消直连验证。':deadline.aborted?'直连验证超时。':'无法连接直连接口，请检查网络。');}
  if(!response.ok){await response.body?.cancel();const reason=response.status===402?'余额或额度不足':response.status===401||response.status===403?'认证或模型权限未通过':response.status===429?'接口限流，请稍后重试':'直连验证请求失败';throw failure(`${reason}（HTTP ${response.status}），未修改 Codex 配置。`);}
  if(!response.headers.get('content-type')?.includes('text/event-stream')||!response.body){await response.body?.cancel();throw failure('接口没有返回 Responses 流，暂不能用于 Codex 直连。');}
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',bytes=0,terminal:any;
  const frame=(value:string)=>{
   const data=value.split('\n').filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trimStart()).join('\n');if(!data||data==='[DONE]')return;
   let event:any;try{event=JSON.parse(data);}catch{throw failure('Responses 流包含无效数据。');}
   if(event.type==='error'||event.type==='response.failed'||event.type==='response.incomplete')throw failure('Responses 流未正常完成，暂不能用于 Codex 直连。');
   if(event.type==='response.completed'){
    if(terminal||event.response?.status!=='completed'||!Array.isArray(event.response?.output))throw failure('Responses 流结束状态无效。');
    terminal=event.response;
    onUsage?.({...providerUsage(terminal.usage),protocol:'responses',model:input.model,startedAt:new Date(started).toISOString(),durationMs:Date.now()-started,status:response.status});
   }
  };
  try{
   while(!terminal){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>1024*1024)throw failure('直连验证响应过大。');buffer+=decoder.decode(chunk.value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');let end:number;while((end=buffer.indexOf('\n\n'))>=0){frame(buffer.slice(0,end));buffer=buffer.slice(end+2);}}
   if(!terminal){buffer+=decoder.decode();if(buffer.trim())frame(buffer);}
  }catch(error){if(error instanceof RunnerCoreError)throw error;throw failure(signal.aborted?'已取消直连验证。':'Responses 流中断或超时，暂不能用于 Codex 直连。');}
  finally{await reader.cancel().catch(()=>{});}
  combined.throwIfAborted();
  if(!terminal)throw failure('Responses 流缺少 response.completed，暂不能用于 Codex 直连。');
  return terminal.output as Record<string,any>[];
 };
 const prompt={role:'user',content:`Call tokenflow_probe with value ${nonce}. This is a synthetic compatibility test.`};
 const tools=[{type:'function',name:'tokenflow_probe',description:'Return the supplied test value; no external actions.',strict:true,parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}];
 const output=await call({input:[prompt],tools,tool_choice:'auto'});
 const invocation=output.filter(item=>item.type==='function_call');
 if(invocation.length!==1||invocation[0].name!=='tokenflow_probe'||typeof invocation[0].call_id!=='string')throw failure('接口尚未通过 Codex 工具调用验证。');
 try{if(JSON.parse(invocation[0].arguments).value!==nonce)throw new Error();}catch{throw failure('工具参数验证失败，暂不能用于 Codex 直连。');}
 const history=[prompt,...output,{type:'function_call_output',call_id:invocation[0].call_id,output:nonce},{role:'user',content:`Reply with only the returned value ${nonce}.`}];
 const continuation=await call({input:history,tools,tool_choice:'auto'});
 const text=(items:Record<string,any>[])=>items.filter(i=>i.type==='message'&&i.role==='assistant').flatMap(i=>Array.isArray(i.content)?i.content:[]).filter(c=>c.type==='output_text').map(c=>c.text).join('');
 if(!text(continuation).includes(nonce))throw failure('工具结果和多轮续聊验证未通过。');
 const summary=await call({input:[...history,...continuation,{role:'user',content:'Summarize this test in one short sentence for a later continuation, including the exact returned value.'}]});
 if(!text(summary).includes(nonce))throw failure('可读摘要验证未通过，暂不能用于 Codex 直连。');
 combined.throwIfAborted();
 return {checkedAt:new Date().toISOString(),streaming:true,tools:true,multiTurn:true,localSummary:true,remoteCompaction:'unsupported'};
}
