import { apiBaseCandidates, normalizeApiBaseURL, protocolFromURL } from '../../../apps/shared/api-endpoint.js';
import { providerSchema } from './providers.js';
import { RunnerCoreError } from './errors.js';
import {providerUsage} from './gateway-observation.js';

export type SourceProtocol='responses'|'chat'|'messages';
const PATHS:Record<SourceProtocol,string>={responses:'responses',chat:'chat/completions',messages:'messages'};
const bad=(message:string,code='api_source_invalid')=>new RunnerCoreError(message,{statusCode:400,code});

/** Cheap shape checks that never touch the network. */
export function validateQuickSource(input:{baseURL:string;apiKey?:string;model:string}){
 const trimmed=normalizeApiBaseURL(input.baseURL);
 const url=providerSchema.shape.baseURL.safeParse(trimmed);
 if(!url.success)throw bad(url.error.issues[0]?.message??'请输入完整的 API 地址，例如 https://api.example.com/v1。');
 const key=input.apiKey?.trim();
 if(key!==undefined&&(!key||key.length>4096||/\s/.test(key)))throw bad('API Key 格式不正确：不能为空、包含空白或换行。');
 const models=[...new Set(input.model.split(/[\n,，]/).map(m=>m.trim()).filter(Boolean))];
 if(!models.length)throw bad('请填写模型名称。');
 if(models.length>50||models.some(m=>m.length>200||/[\x00-\x1f\x7f]/.test(m)))throw bad('模型名称格式不正确：每个最多 200 个字符，且不能含控制字符。');
 return {baseURL:url.data,models};
}

type Probe={ok:boolean;status:number|null;message:string};
export type ProtocolProbeUsage=ReturnType<typeof providerUsage>&{protocol:SourceProtocol;model:string;startedAt:string;durationMs:number;status:number};
const clip=(value:string,key:string)=>(key?value.split(key).join('***'):value).replace(/\s+/g,' ').slice(0,160);
async function readLimited(response:Response,limit=256*1024){
 const reader=response.body?.getReader();if(!reader)return '';
 const chunks:Uint8Array[]=[];let size=0;
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();break;}chunks.push(value);}
 return Buffer.concat(chunks).toString('utf8');
}
const shapes:Record<SourceProtocol,(json:Record<string,unknown>)=>boolean>={
 responses:json=>json.object==='response'||Array.isArray(json.output),
 chat:json=>Array.isArray(json.choices),
 messages:json=>json.type==='message'||Array.isArray(json.content),
};
function request(protocol:SourceProtocol,model:string,key:string,tokenField='max_tokens'):{headers:Record<string,string>;body:Record<string,unknown>}{
 const prompt='Reply OK only.';
 if(protocol==='responses')return {headers:{Authorization:`Bearer ${key}`},body:{model,input:prompt,max_output_tokens:16,store:false}};
 if(protocol==='chat')return {headers:{Authorization:`Bearer ${key}`},body:{model,messages:[{role:'user',content:prompt}],[tokenField]:16}};
 return {headers:{'x-api-key':key,'anthropic-version':'2023-06-01'},body:{model,max_tokens:16,messages:[{role:'user',content:prompt}]}};
}
async function probe(protocol:SourceProtocol,base:string,key:string,model:string,signal:AbortSignal,onUsage?:(usage:ProtocolProbeUsage)=>void):Promise<Probe>{
 for(const tokenField of protocol==='chat'?['max_tokens','max_completion_tokens']:['']){
  const {headers,body}=request(protocol,model,key,tokenField||undefined);
  let response:Response;
  const started=Date.now();
  try{response=await fetch(`${base}/${PATHS[protocol]}`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),redirect:'error'});}
  catch{return {ok:false,status:null,message:signal.aborted?'已取消验证。':'无法连接或超时，请检查网络和 API 地址。'};}
  const text=await readLimited(response).catch(()=> '');
  let json:Record<string,unknown>={};try{json=JSON.parse(text);}catch{/* Non-JSON bodies are a mismatch, not a crash. */}
  const usage=providerUsage(json.usage);
  // Successful calls without usage remain unmeasured; rejected protocol attempts
  // are counted only when the upstream actually reports token consumption.
  if(response.ok||usage.inputTokens!==null||usage.outputTokens!==null)onUsage?.({...usage,protocol,model,startedAt:new Date(started).toISOString(),durationMs:Date.now()-started,status:response.status});
  if(response.ok)return shapes[protocol](json)?{ok:true,status:response.status,message:''}:{ok:false,status:response.status,message:'返回内容不是该协议的格式。'};
  const error=json.error as {message?:unknown}|string|undefined;
  const rawMessage=typeof error==='string'?error:typeof error?.message==='string'?error.message:typeof json.message==='string'?json.message:'';
  const message=clip(rawMessage,key);
  // Some newer models only accept the other token-limit field; try it once before giving up on Chat.
  if(protocol==='chat'&&response.status===400&&tokenField==='max_tokens'&&/max_completion_tokens|max_tokens/.test(rawMessage))continue;
  return {ok:false,status:response.status,message};
 }
 return {ok:false,status:400,message:''};
}

/** Sends one tiny request per candidate protocol until one answers in the expected shape. */
export async function detectProtocol(input:{baseURL:string;apiKey:string;model:string},signal:AbortSignal=new AbortController().signal,onUsage?:(usage:ProtocolProbeUsage)=>void):Promise<{protocol:SourceProtocol;baseURL:string}>{
 const {baseURL,models}=validateQuickSource(input);const model=models[0];
 const explicit=protocolFromURL(input.baseURL);
 const hinted=/anthropic|claude/i.test(`${baseURL} ${model}`);
 const order:SourceProtocol[]=hinted?['messages','chat','responses']:['responses','chat','messages'];
 if(explicit){order.splice(order.indexOf(explicit),1);order.unshift(explicit);}
 // The supplied address wins; only bounded same-origin alternatives follow.
 const bases=apiBaseCandidates(baseURL,hinted);
 const deadline=AbortSignal.timeout(30000),requestSignal=AbortSignal.any([signal,deadline]);
 const failures:Probe[]=[];
 for(const base of bases)for(const protocol of order){
  if(signal.aborted)throw bad('已取消验证。','api_source_cancelled');
  const result=await probe(protocol,base,input.apiKey.trim(),model,requestSignal,onUsage);
  if(signal.aborted)throw bad('已取消验证。','api_source_cancelled');
  if(deadline.aborted)throw bad('模型协议验证超时，请稍后重试。','api_source_timeout');
  if(result.ok)return {protocol,baseURL:base};
  if(result.status===null)throw bad(result.message,'api_source_unreachable');
  if(result.status===401||result.status===403)throw bad(`API Key 无效或没有权限（HTTP ${result.status}）。${result.message}`,'api_source_auth');
  if(result.status===429)throw bad('接口限流（HTTP 429），请稍后重试。','api_source_rate_limited');
  if(result.status===402)throw bad('接口额度不足（HTTP 402），请检查余额。','api_source_quota');
  if((result.status===400||result.status===422)&&/insufficient.{0,20}(?:quota|balance|credit)|quota.{0,20}exceeded|余额不足|额度不足/i.test(result.message))throw bad('接口额度不足，请检查余额。','api_source_quota');
  if(result.status>=500)throw bad(`上游服务暂不可用（HTTP ${result.status}），请稍后重试。`,'api_source_unavailable');
  if(![200,201,400,404,405,415,422].includes(result.status))throw bad(`接口拒绝了请求（HTTP ${result.status}），请检查服务配置。`,'api_source_rejected');
  failures.push(result);
 }
 if(failures.every(f=>f.status===null))throw bad('无法连接或超时，请检查网络和 API 地址。','api_source_unreachable');
 const auth=failures.find(f=>f.status===401||f.status===403);
 if(auth)throw bad(`API Key 无效或没有权限（HTTP ${auth.status}）。${auth.message}`,'api_source_auth');
 const limited=failures.find(f=>f.status===429);
 if(limited)throw bad('接口限流（HTTP 429），暂时无法确认此模型的协议，请稍后重试。','api_source_rate_limited');
 const rejected=failures.find(f=>f.status===400||f.status===422);
 if(rejected)throw bad(`接口已响应但拒绝了请求，请检查模型名称。${rejected.message}`,'api_source_rejected');
 const detail=failures.map((f,i)=>`${bases[Math.floor(i/order.length)]}/${PATHS[order[i%order.length]]}：${f.status===null?'连接失败或超时':`HTTP ${f.status}${f.message?`（${f.message}）`:''}`}`).join('；');
 throw bad(`未找到可用接口。已尝试 Responses、Chat Completions 和 Anthropic Messages，并保留自定义路径尝试 /v1。请核对服务文档中的地址与模型支持的协议。${detail}`,'api_source_not_found');
}

export function sourceNameFromURL(baseURL:string){
 const url=new URL(baseURL);
 if(['127.0.0.1','localhost','[::1]'].includes(url.hostname))return `本机 ${url.port||'服务'}`.slice(0,80);
 return url.hostname.replace(/^(?:api|www)\./,'').slice(0,80);
}
