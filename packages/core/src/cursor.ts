import {upstreamError} from './upstream-errors.js';
import {safeFailure} from './login/diagnostics.js';
import {retryOfficialRead,OfficialReadTransportError,refreshNetworkHint} from './official-refresh.js';
import {CredentialHistory} from './credential-history.js';
import {credentialEmail,credentialFingerprint,compareCredentials,credentialPreference} from './credential-identity.js';
import { createHash,randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { SDKModel,Run,SDKCustomTool,TokenUsage } from '@cursor/sdk';
import type { LocalAccount,LocalModel } from './cliproxy.js';
import type { AccountQuota } from './quota/types.js';
import type { LoginSession } from './login/types.js';
import {CursorUsage} from './cursor-usage.js';
import {CursorLocalModelCompatibility,cursorLocalAlternative,cursorRetryableModelRejection,cursorGeneratedUsage} from './cursor-model-compatibility.js';
import {localCursorSession} from './cursor-local.js';
import {rememberCursorGatewayConversation} from './cursor-conversations.js';
import type {CursorUsageReader} from './cursor-native-usage.js';

import {parseCursorInput,cursorResponse,cursorInputFields,type CursorToolCall} from './cursor-protocol.js';
export {parseCursorInput,cursorResponse} from './cursor-protocol.js';

const credentialSchema=z.object({apiKey:z.string().min(1),email:z.string().optional(),apiKeyExpiresAtMs:z.number().optional(),authorizedAt:z.number().optional(),disabled:z.boolean().default(false)});
type CursorLogin=Omit<LoginSession,'provider'>&{provider:'cursor'};
type Credential=z.infer<typeof credentialSchema>;
type Secrets={get:(name:string)=>Promise<string>;set:(name:string,value:string)=>Promise<void>};
const failure=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const errorResponse=(message:string,status=400,code?:string)=>Response.json({error:{message,type:'cursor_error',...(code?{code}:{})}},{status});
export const cursorCatalog={id:'cursor' as const,label:'Cursor',flow:'device' as const,hint:'官方 SDK 授权 · 支持文本、图片、客户端工具与官方用量查询'};

// Only client-declared tools are exposed. No local filesystem or shell tools.
class CursorAccount {
 private credential?:Credential;private loaded=false;private models:SDKModel[]=[];private login?:CursorLogin;
 private loginAbort?:AbortController;private loginTask?:Promise<void>;private refreshTask?:Promise<void>;
 private catalogCredential?:Credential;private refreshAbort=new AbortController();
 private localModelCompatibility=new CursorLocalModelCompatibility();
 private sdkBillingUnavailable?:{key:string;until:number};
 private billing?:{key:string;client:CursorUsage};private quota?:AccountQuota;private quotaCheckedAt=0;
 private usageIdentity?:{key:string;email:string};
 private usageClient(credential:Credential){if(this.billing?.key!==credential.apiKey)this.billing={key:credential.apiKey,client:new CursorUsage(credential.apiKey)};return this.billing.client;}
 private catalogCheckedAt=0;private catalogVerifiedAt=0;
 private observedAt=new Date().toISOString();private catalogStatus:'loading'|'ready'|'error'='loading';
 private active?:Run;private generating=false;private closed=false;private error?:string;
 constructor(private root:string,private secrets:Secrets,private openExternal?:(url:string)=>Promise<void>){}
 private async sdk(){
  if(process.env.CURSOR_BACKEND_URL)throw failure('Cursor SDK 后端覆盖未获支持，请移除 CURSOR_BACKEND_URL 后重试。');
  return import('@cursor/sdk');
 }
 get busy(){return this.generating||!!this.loginTask;}
 get id(){return this.credential?createHash('sha256').update(`cursor:${this.credential.email||this.credential.apiKey}`).digest('hex').slice(0,24):undefined;}
 owns(id:string){return !!this.id&&id===this.id;}
 nativeUsageEmail(){return credentialEmail(this.credential?.email)??(this.usageIdentity?.key===this.credential?.apiKey?this.usageIdentity?.email:undefined);}
 nativeUsageReader():CursorUsageReader|undefined{
  const c=this.credential,email=this.nativeUsageEmail();if(!c||!this.id||c.disabled||c.apiKeyExpiresAtMs&&c.apiKeyExpiresAtMs<=Date.now())return;
  return {id:this.id,email,revision:createHash('sha256').update(`${this.id}:${c.apiKey}`).digest('hex'),read:async(start,end,signal)=>{const result=await this.usageClient(c).events(start,end,signal);if(this.credential?.apiKey===c.apiKey&&(!email||result.email===email))this.usageIdentity={key:c.apiKey,email:result.email};return result;}};
 }
 async load(){if(this.loaded)return;const raw=await this.secrets.get('cursor-account');if(raw)this.credential=credentialSchema.parse(JSON.parse(raw));this.loaded=true;await this.refresh();}
 async refreshIfStale(){if(this.loaded&&!this.closed&&Date.now()-this.catalogCheckedAt>=300000)await this.refresh(false);}
 async refresh(forceQuota=true):Promise<void>{if(this.refreshTask){await this.refreshTask;if(this.catalogCredential!==this.credential)return this.refresh();return;}this.refreshTask=(async()=>{
  const credential=this.credential;if(!credential||credential.disabled)return;
  this.catalogCredential=credential;this.catalogStatus='loading';
  try{
   const {Cursor}=await this.sdk();
   const models=await retryOfficialRead(async attempt=>{
    if(this.closed||this.credential!==credential)throw new DOMException('Refresh cancelled','AbortError');
    if(attempt===1){
     try{const models=await bounded(Cursor.models.list({apiKey:credential.apiKey}),20000);if(!Array.isArray(models))throw new Error('Invalid catalog');return models;}
     catch(error){if(cursorFailure(error).blocked||['cursor_rate_limited','cursor_request_rejected'].includes(cursorFailure(error).code))throw error;throw new OfficialReadTransportError('SDK catalog unavailable');}
    }
    // Retry via the documented REST catalog when SDK bootstrap or discovery fails.
    const response=await fetch('https://api.cursor.com/v1/models',{headers:{Authorization:`Bearer ${credential.apiKey}`},redirect:'error',signal:AbortSignal.any([this.refreshAbort.signal,AbortSignal.timeout(15000)])});
    if(!response.ok){await response.body?.cancel();throw Object.assign(new Error('Catalog request failed'),{status:response.status});}
    return z.object({items:z.array(z.object({id:z.string(),displayName:z.string().default('')}).passthrough())}).parse(await response.json()).items as SDKModel[];
   },{signal:this.refreshAbort.signal});
   if(this.credential!==credential||this.closed)return;
   this.catalogVerifiedAt=Date.now();this.models=models.filter(m=>m.id&&m.id.length<280);this.error=this.models.length?undefined:'Cursor 未返回此账号可用的模型，请检查官方 API 权限后刷新。';this.catalogStatus=this.error?'error':'ready';
  }catch(error){if(this.credential===credential&&!this.closed){const cause=cursorFailure(error);if(cause.blocked||Date.now()-this.catalogVerifiedAt>=15*60000)this.models=[];this.error=`${cause.message} ${refreshNetworkHint}`;this.catalogStatus='error';}}
  finally{this.catalogCheckedAt=Date.now();this.observedAt=new Date().toISOString();}
  if(this.credential===credential&&!this.closed&&(forceQuota||Date.now()-this.quotaCheckedAt>=300000)){
   const previous=this.quota&&this.quota.accountId===this.id?this.quota:undefined;
   try{const report=await retryOfficialRead(()=>{if(this.closed||this.credential!==credential)throw new DOMException('Refresh cancelled','AbortError');return this.usageClient(credential).quota();},{signal:this.refreshAbort.signal});if(this.credential===credential&&!this.closed)this.quota={...report,accountId:this.id!,provider:'cursor',status:'ok',observedAt:new Date().toISOString(),lastSuccessfulAt:new Date().toISOString()};}
   catch{if(this.credential===credential&&!this.closed)this.quota={...previous,accountId:this.id!,provider:'cursor',status:'error',observedAt:new Date().toISOString(),windows:previous?.windows??[],error:'Cursor 官方用量查询暂不可用，可以切换网络后刷新试试。',note:'可在 Cursor 官方用量页核对；查询失败不代表额度为零。'};}
   finally{this.quotaCheckedAt=Date.now();}
  }
 })().finally(()=>{this.refreshTask=undefined;});return this.refreshTask;}
 snapshot():{accounts:LocalAccount[];models:LocalModel[];login?:CursorLogin;quotas:Record<string,AccountQuota>}{
  const c=this.credential;const expired=!!c?.apiKeyExpiresAtMs&&c.apiKeyExpiresAtMs<=Date.now();const enabled=!!c&&!c.disabled&&!expired;
  const models=enabled&&Date.now()-this.catalogVerifiedAt<15*60000?this.models.map(m=>({id:`cursor/${m.id}`,provider:'cursor' as const,displayName:m.displayName,capabilities:{text:true,tools:true,images:false}})):[];
  return {accounts:c?[{id:this.id!,provider:'cursor',label:c.email||`Cursor SDK 账号 ${this.id!.slice(0,8)}`,status:expired?'授权已过期':this.catalogStatus==='loading'?'模型同步中':this.error?(this.models.length?'使用上次模型目录':'模型同步失败'):'active',modelError:this.error,disabled:c.disabled,unavailable:expired,authenticationRequired:expired,models:models.map(m=>m.id)}]:[],models,login:this.login,
   quotas:c?{[this.id!]:this.quota&&this.quota.accountId===this.id?this.quota:{accountId:this.id!,provider:'cursor' as const,status:'ok' as const,observedAt:this.observedAt,windows:[],note:'正在查询 Cursor 官方用量与额度…'}}:{}};
 }
 assertSource(id:string,model:string){if(!this.owns(id)||!this.snapshot().models.some(m=>m.id===model))throw failure('Cursor 账号或模型当前不可用。',409);return `cursor:${id}`;}
 async beginLogin(){
  if(this.closed)throw failure('应用正在退出');
  if(this.loginTask)throw failure('Cursor 授权正在进行，请完成或取消。',409);
  if(this.generating)throw failure('Cursor 正在处理请求，请结束后再更换账号。',409);
  const controller=new AbortController();this.loginAbort=controller;
  const login:CursorLogin={id:randomUUID(),provider:'cursor',flow:'device',status:'starting',message:'正在准备 Cursor 官方授权…'};this.login=login;
  const timer=setTimeout(()=>controller.abort(),300000);
  this.loginTask=(async()=>{try{
   const {Cursor}=await this.sdk();const result=await Cursor.auth.login({store:null,backendUrl:'https://api2.cursor.sh',websiteUrl:'https://cursor.com',apiKeyName:'token-flow',signal:controller.signal,openBrowser:false,onLoginUrl:raw=>{
    const url=new URL(raw);if(url.protocol!=='https:'||url.hostname!=='cursor.com'||url.pathname!=='/loginDeepControl')throw failure('Cursor 授权地址不合法');
    login.url=url.href;login.status='waiting_for_browser';login.message='请在 Cursor 官方页面授权；此操作会创建独立 SDK Key。';
    void this.openExternal?.(url.href).catch(()=>{});
   }});
   if(controller.signal.aborted||this.closed)return;
   const next=credentialSchema.parse(result);await this.secrets.set('cursor-account',JSON.stringify(next));this.credential=next;this.models=[];this.quota=undefined;this.billing=undefined;await this.refresh();
   login.status='completed';login.message=this.error?'Cursor 已授权，模型同步未完成；可刷新重试，无需重复登录。':'Cursor 已连接，模型目录已刷新。';
  }catch{if(login.status!=='cancelled'){login.status=controller.signal.aborted?'expired':'failed';login.message=controller.signal.aborted?'Cursor 授权已超时，请重试。':'Cursor 授权未完成，请重试。';}}
  finally{clearTimeout(timer);this.loginTask=undefined;this.loginAbort=undefined;}})();
 }
 async openLogin(id:string){if(this.login?.id!==id||!this.login.url||this.login.status!=='waiting_for_browser')throw failure('授权会话已变更');await this.openExternal?.(this.login.url);}
 cancelLogin(id:string){if(this.login?.id!==id)throw failure('授权会话已变更');this.login.status='cancelled';this.login.message='已取消 Cursor 授权。';this.loginAbort?.abort();}
 async setEnabled(enabled:boolean){if(this.loginTask)throw failure('请先结束 Cursor 授权',409);if(!this.credential)throw failure('Cursor 尚未连接');const next={...this.credential,disabled:!enabled};await this.secrets.set('cursor-account',JSON.stringify(next));this.credential=next;if(!enabled)await this.active?.cancel();await this.refresh();}
 async remove(){if(this.loginTask)throw failure('请先结束 Cursor 授权',409);await this.secrets.set('cursor-account','');this.credential=undefined;this.models=[];this.quota=undefined;this.billing=undefined;await this.active?.cancel();}
 async close(){this.closed=true;this.refreshAbort.abort();this.loginAbort?.abort();await this.active?.cancel().catch(()=>{});await this.loginTask;await this.refreshTask?.catch(()=>{});}
 async response(path:string,body:unknown,signal:AbortSignal):Promise<Response>{
  let input:ReturnType<typeof parseCursorInput>;try{input=parseCursorInput(path,body);}catch(error){
   const fields=cursorInputFields(error),safeguards=fields.includes('safeguards');
   return Response.json({error:{type:'invalid_request_error',code:safeguards?'cursor_safeguards_unsupported':'cursor_invalid_request',fields,message:safeguards?'Claude 自动权限模式请求了服务端工具安全审查（safeguards），Cursor SDK 暂不支持。请在 Claude 中改用逐次询问工具权限的模式后重试；网关未删除审查要求。':'Cursor 请求格式不支持：请检查所标注的消息内容或工具格式；服务端工具和严格 JSON 输出暂不可用。'}},{status:400});
  }
  if(!this.id)return errorResponse('Cursor 尚未授权',503,'cursor_unavailable');
  this.assertSource(this.id,input.model);
  if(this.closed||signal.aborted)return errorResponse('请求已取消',499,'cursor_cancelled');
  if(this.generating)return errorResponse('Cursor 正在处理另一个请求，请稍后重试。',429,'cursor_busy');
  const credential=this.credential!;
  this.generating=true;let temp:string|undefined;let agent:Awaited<ReturnType<(typeof import('@cursor/sdk'))['Agent']['create']>>|undefined;
  const cancel=()=>{void this.active?.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  const releases:Array<()=>void>=[];
  let cleanupTask:Promise<boolean>|undefined;
  const cleanup=()=>cleanupTask??=(async()=>{
   let disposed=true;
   try{if(agent){if(agent[Symbol.asyncDispose])await agent[Symbol.asyncDispose]();else await agent.close();}}
   catch{disposed=false;try{await agent?.close();}catch{/* Best effort only; failed disposal still vetoes replay. */}}
   try{if(temp)await rm(temp,{recursive:true,force:true});}catch{disposed=false;}
   return disposed;
  })();

  try{
   const {Agent,JsonlLocalAgentStore}=await this.sdk();await mkdir(join(this.root,'cursor-runs'),{recursive:true,mode:0o700});temp=await mkdtemp(join(this.root,'cursor-runs','request-'));
   const model=this.models.find(m=>`cursor/${m.id}`===input.model)!;
   const defaults=model.variants?.find(v=>v.isDefault)?.params??[];
   const params=defaults.map(p=>({...p}));
   if(input.effort){const parameter=model.parameters?.find(p=>['reasoning_effort','effort'].includes(p.id)&&p.values.some(v=>v.value===input.effort));if(parameter){const existing=params.find(p=>p.id===parameter.id);if(existing)existing.value=input.effort;else params.push({id:parameter.id,value:input.effort});}}
   let selectedParams=this.localModelCompatibility.select(credential,model,params)??params;
   let unsafeToReplay=false,compatibilityRecovered=false;
   const calls:CursorToolCall[]=[];let handoff!:()=>void;const toolRequested=new Promise<'tool'>(resolve=>{handoff=()=>resolve('tool');});
   const customTools:Record<string,SDKCustomTool>=Object.fromEntries(input.tools.map((tool,index)=>[`client_${index}`,{
    description:`Client tool: ${tool.namespace?`${tool.namespace}.`:""}${tool.name}. ${tool.description??''}`,inputSchema:tool.parameters,
    execute:async(args:Record<string,import('@cursor/sdk').SDKJsonValue>)=>{
     unsafeToReplay=true;
     // The SDK publishes its own cwd as ambient context. It must never escape
     // into tools executed on a different client host (including older turns).
     if(containsTransportPath(args,join(this.root,'cursor-runs')))throw new Error('This path belongs to the SDK transport host, not the client workspace. Use the working directory from the client conversation; preserve relative paths if supported, otherwise ask for the client path.');
     if(tool.custom&&typeof args.input!=='string')throw new Error('Custom tool requires text input');
     calls.push({id:`call_${randomUUID().replaceAll('-','')}`,name:tool.name,namespace:tool.namespace,arguments:JSON.stringify(args),custom:tool.custom});handoff();
     // Hold the callback until cancellation stops the SDK loop. The caller, not
     // this process, executes the tool and submits its result on the next turn.
     return new Promise<string>(resolve=>releases.push(()=>resolve('Tool execution handed back to the client.')));
    }
   }]));
   let result!:Awaited<ReturnType<Run['wait']>>,startedAt=0;
   for(let attempt=0;attempt<2;attempt++){
    let rejection:unknown,failedStatus=true;
    try{
     agent=await Agent.create({apiKey:credential.apiKey,model:{id:model.id,...(selectedParams.length?{params:selectedParams}:{})},tools:input.tools.length?['mcp']:[],mcpServers:{},agents:{},local:{cwd:temp!,settingSources:[],customTools,store:new JsonlLocalAgentStore(join(temp!,'store'))}});
     if(signal.aborted||this.closed||this.credential?.disabled||this.credential!==credential)return errorResponse('请求已取消',499,'cursor_cancelled');
     startedAt=Date.now();
     if(agent.agentId)await rememberCursorGatewayConversation(this.root,agent.agentId,startedAt);
     this.active=await agent.send(input.images.length?{text:input.prompt,images:input.images}:input.prompt,{onDelta:({update})=>{
      // Local SDK forwards every generated text/thinking/tool update through
      // this accumulator before returning send()/wait() failures. Observe only
      // booleans; no model output is copied into diagnostic storage.
      if(['user-message-appended','step-started','step-completed'].includes(update.type))return;
      if(update.type==='turn-ended'){unsafeToReplay ||= cursorGeneratedUsage(update.usage);return;}
      if(update.type==='token-delta'){unsafeToReplay ||= update.tokens>0;return;}
      if(update.type==='text-delta'||update.type==='thinking-delta'){unsafeToReplay ||= update.text.length>0;return;}
      unsafeToReplay=true;
     }});if(signal.aborted)cancel();
     const wait=this.active.wait(),outcome=await Promise.race([wait,toolRequested]);
     if(outcome==='tool'){
      const stopping=this.active.cancel();for(const release of releases.splice(0))release();await stopping;result=await wait;
     }else result=outcome;
     if(signal.aborted||this.closed||this.credential?.disabled||this.credential?.apiKey!==credential.apiKey)return errorResponse('请求已取消',499,'cursor_cancelled');
     if(calls.length||result.status==='finished')break;
     rejection=result.error;failedStatus=result.status==='error';
    }catch(error){rejection=error;}
    if(signal.aborted||this.closed||this.credential?.disabled||this.credential?.apiKey!==credential.apiKey)return errorResponse('请求已取消',499,'cursor_cancelled');
    const cause=cursorFailure(rejection);
    const alternate=attempt===0&&failedStatus&&!unsafeToReplay&&!calls.length&&!result?.result&&!this.active?.result&&!cursorGeneratedUsage(result?.usage)&&!cursorGeneratedUsage(this.active?.usage)&&!cause.auth&&!cause.blocked&&cursorRetryableModelRejection(rejection)?cursorLocalAlternative(model,selectedParams):undefined;
    this.localModelCompatibility.forget(credential,model,params);
    if(!alternate)return errorResponse(cause.message,cause.status,cause.code);
    // Dispose the rejected run before preparing one fresh agent. A client tool
    // callback, disconnect or late generated delta vetoes replay even here.
    const disposed=await cleanup();this.active=undefined;agent=undefined;cleanupTask=undefined;
    if(signal.aborted||this.closed||this.credential!==credential)return errorResponse('请求已取消',499,'cursor_cancelled');
    if(!disposed||unsafeToReplay)return errorResponse(cause.message,cause.status,cause.code);
    temp=await mkdtemp(join(this.root,'cursor-runs','request-'));selectedParams=alternate;compatibilityRecovered=true;
   }
   if(!agent||!this.active)return errorResponse('Cursor 未返回有效运行结果',502,'cursor_upstream_error');
   if(compatibilityRecovered)this.localModelCompatibility.remember(credential,model,params,selectedParams);
   if(input.required&&!calls.length)return errorResponse('Cursor 未按要求生成工具调用，请重试或选择其他模型。',502,'cursor_tool_required');
   let tokens:TokenUsage|undefined=result.usage??this.active.usage;
   // Remember only the explicit unsupported-feature response, per credential.
   // The official per-agent ledger still settles every request before it returns.
   if(!tokens&&agent.getUsage&&!(this.sdkBillingUnavailable?.key===credential.apiKey&&this.sdkBillingUnavailable.until>Date.now())){
    try{const billed=await bounded(agent.getUsage(),5000);this.sdkBillingUnavailable=undefined;if(billed.runs.length)tokens=billed.usage;}
    catch(error){const unavailable=z.object({status:z.literal(403),code:z.literal('feature_unavailable')}).safeParse(error);if(unavailable.success)this.sdkBillingUnavailable={key:credential.apiKey,until:Date.now()+5*60000};}
   }
   const agentId=agent.agentId;
   // The run has stopped and SDK billing has completed. Disposal no longer
   // needs to delay the independent official ledger request.
   void cleanup();
   // SDK completion counters can differ from the bill (observed 5 versus 29 output tokens).
   // Settle this exact fresh agent even when the SDK already returned counters.
   if(agentId){try{tokens=await this.usageClient(credential).runUsage(agentId,startedAt,signal)??tokens;}catch{/* Retain SDK counters if official settlement is unavailable. */}}
   if(signal.aborted||this.closed||this.credential!==credential)return errorResponse('请求已取消',499,'cursor_cancelled');
   const usage=tokens?{input_tokens:tokens.inputTokens+tokens.cacheReadTokens+tokens.cacheWriteTokens,output_tokens:tokens.outputTokens,cached_tokens:tokens.cacheReadTokens,cache_write_tokens:tokens.cacheWriteTokens}:undefined;
   const response=cursorResponse(path,input.model,calls.length?'':result.result??'',usage,input.stream,calls);
   if(input.limit)response.headers.set('X-Token-Flow-Output-Limit','advisory; Cursor SDK does not expose a hard output token limit');
   return response;
  }catch(error){const cause=cursorFailure(error);return errorResponse(cause.message,signal.aborted?499:cause.status,signal.aborted?'cursor_cancelled':cause.code);}
  finally{signal.removeEventListener('abort',cancel);for(const release of releases)release();await cleanup();this.active=undefined;this.generating=false;}
 }
}
/** Per-account SDK state stays isolated; persisted legacy single-account records
 * migrate on the next explicit mutation. Keys always route to their bound account. */
export class CursorProvider {
 private accounts:CursorAccount[]=[];private values=new Map<CursorAccount,Credential>();
 private loading?:Promise<void>;private loaded=false;private loginAccount?:CursorAccount;
 private importing=false;private closed=false;private writes=Promise.resolve();
 private aliases:Record<string,string>={};private history:CredentialHistory;
 constructor(private root:string,private secrets:Secrets,private openExternal?:(url:string)=>Promise<void>,private localPath?:string){this.history=new CredentialHistory(root,secrets);}
 private identity(c:Credential){return credentialEmail(c.email)??c.email?.trim().toLowerCase()??credentialFingerprint(c);}
 get id(){return this.accounts.find(a=>a.id)?.id;}
 owns(id:string){return this.accounts.some(a=>a.owns(this.aliases[id]??id));}
 nativeUsageReaders(){return this.accounts.flatMap(a=>{const reader=a.nativeUsageReader();return reader?[reader]:[];});}
 nativeUsageAccounts(){const rows=this.accounts.flatMap(a=>{const email=a.nativeUsageEmail();return a.id&&email?[{id:a.id,provider:'cursor',accountId:email,email,organizationId:null,label:email}]:[];});return [...new Map(rows.map(row=>[row.email,row])).values()];}
 private account(id:string|undefined){const account=this.accounts.find(a=>a.owns(this.aliases[id??'']??id??''));if(!account)throw failure('Cursor 账号当前不可用。',409);return account;}
 private make(initial?:Credential){
  const account=new CursorAccount(this.root,{get:async()=>{const value=this.values.get(account);return value?JSON.stringify(value):'';},set:async(_name,raw)=>{
   const work=async()=>{const next=raw?credentialSchema.parse({...JSON.parse(raw),authorizedAt:Date.now()}):undefined;const values=new Map(this.values);values.delete(account);
    const duplicate=next?this.accounts.find(a=>a!==account&&!!this.values.get(a)&&this.identity(this.values.get(a)!)===this.identity(next)):undefined;
    if(duplicate?.busy)throw failure('此 Cursor 账号正在使用，请结束请求后再更新授权。',409);
    if(next&&credentialPreference(next)[0]===0)throw failure('新 Cursor 授权已过期，已保留原有可用授权。',409);
    if(next)await this.history.remember('cursor',[...this.values.values(),next]);
    else{const old=this.values.get(account);if(old)await this.history.forget('cursor',[old]);}
    if(duplicate)values.delete(duplicate);if(next)values.set(account,next);
    const aliases={...this.aliases};if(duplicate?.id&&next){const nextId=createHash('sha256').update(`cursor:${next.email||next.apiKey}`).digest('hex').slice(0,24);for(const [old,id] of Object.entries(aliases))if(id===duplicate.id)aliases[old]=nextId;aliases[duplicate.id]=nextId;}
    const records=[...values.values()];await this.secrets.set('cursor-account',records.length?JSON.stringify({version:1,accounts:records,aliases}):'');
    this.values=values;this.aliases=aliases;if(duplicate){this.accounts=this.accounts.filter(a=>a!==duplicate);await duplicate.close();}
   };const result=this.writes.then(work);this.writes=result.catch(()=>{});await result;
  }},this.openExternal);
  if(initial)this.values.set(account,initial);this.accounts.push(account);return account;
 }
 async load(){if(this.loaded)return;if(this.loading)return this.loading;this.loading=(async()=>{
  const raw=await this.secrets.get('cursor-account');
  if(raw){const value=JSON.parse(raw);const parsed=Array.isArray(value.accounts)?z.object({version:z.literal(1),accounts:z.array(credentialSchema).max(100),aliases:z.record(z.string()).default({})}).parse(value):{accounts:[credentialSchema.parse(value)],aliases:{}};
   this.aliases=parsed.aliases;const groups=new Map<string,Credential[]>();
   for(const entry of parsed.accounts){const identity=this.identity(entry),group=groups.get(identity)??[];group.unshift(entry);groups.set(identity,group);}
   for(const group of groups.values()){
    group.sort((a,b)=>Number(a.disabled)-Number(b.disabled)||compareCredentials({raw:a},{raw:b}));
    const selected=group[0];if(group.length>1)await this.history.remember('cursor',group);
    this.make(selected);for(const old of group){const id=createHash('sha256').update(`cursor:${old.email||old.apiKey}`).digest('hex').slice(0,24);this.aliases[id]=createHash('sha256').update(`cursor:${selected.email||selected.apiKey}`).digest('hex').slice(0,24);}
   }
  }
  this.loaded=true;await Promise.all(this.accounts.map(a=>a.load()));
 })().finally(()=>{this.loading=undefined;});return this.loading;}

 async refresh(forceQuota=true,id?:string){await this.load();await Promise.all(this.accounts.filter(a=>!id||a.snapshot().accounts.some(account=>account.id===(this.aliases[id]??id))).map(a=>a.refresh(forceQuota)));}
 async refreshIfStale(){if(this.loaded&&!this.closed)await Promise.all(this.accounts.map(a=>a.refreshIfStale()));}
 snapshot(){const snapshots=this.accounts.map(a=>a.snapshot());return {accounts:snapshots.flatMap(s=>s.accounts),models:[...new Map(snapshots.flatMap(s=>s.models).map(m=>[m.id,m])).values()],quotas:Object.assign({},...snapshots.map(s=>s.quotas)) as Record<string,AccountQuota>,login:this.loginAccount?.snapshot().login};}
 assertSource(id:string,model:string){const account=this.account(id);return account.assertSource(account.id!,model);}
 async beginLogin(){await this.load();if(this.closed)throw failure('应用正在退出');if(this.importing||this.accounts.some(a=>a.busy))throw failure('Cursor 正在处理请求或授权，请稍后重试。',409);this.loginAccount=this.make();await this.loginAccount.beginLogin();}
 async importLocal(){await this.load();if(this.closed)throw failure('应用正在退出');if(this.importing||this.accounts.some(a=>a.busy))throw failure('Cursor 正在处理请求或授权，请稍后重试。',409);this.importing=true;
  try{const session=await localCursorSession(this.localPath);const existing=this.accounts.find(a=>this.values.get(a)?.email?.toLowerCase()===session.email.toLowerCase());if(existing&&credentialPreference(this.values.get(existing)!)[0]>0){await existing.refresh();return;}
   if(existing){await this.history.remember('cursor',[this.values.get(existing)!]);}
   const credential=credentialSchema.parse({...await session.createCredential(),authorizedAt:Date.now()});await this.history.remember('cursor',[credential]);const entries=[...this.values.entries()].filter(([a])=>a!==existing).map(([,c])=>c).concat(credential);
   await this.secrets.set('cursor-account',JSON.stringify({version:1,accounts:entries,aliases:this.aliases}));if(existing){this.values.delete(existing);this.accounts=this.accounts.filter(a=>a!==existing);await existing.close();}
   const account=this.make(credential);await account.load();
  }finally{this.importing=false;}
 }
 async openLogin(id:string){if(!this.loginAccount)throw failure('授权会话已变更');await this.loginAccount.openLogin(id);}
 cancelLogin(id:string){if(!this.loginAccount)throw failure('授权会话已变更');this.loginAccount.cancelLogin(id);}
 async setEnabled(enabled:boolean,id=this.id){if(this.importing)throw failure('正在导入 Cursor 账号，请稍候。',409);await this.account(id).setEnabled(enabled);}
 async remove(id=this.id){if(this.importing)throw failure('正在导入 Cursor 账号，请稍候。',409);const account=this.account(id);await account.remove();this.accounts=this.accounts.filter(a=>a!==account);await account.close();}
 async response(path:string,body:unknown,signal:AbortSignal,sourceId?:string){
  const model=(body as {model?:string})?.model;const id=sourceId??this.accounts.find(a=>a.snapshot().models.some(m=>m.id===model))?.id;
  if(!id)return errorResponse('Cursor 尚未授权或模型不可用',503,'cursor_unavailable');
  return this.account(id).response(path,body,signal);
 }
 async close(){this.closed=true;await Promise.all(this.accounts.map(a=>a.close()));await this.writes;}
}
async function bounded<T>(promise:Promise<T>,ms:number):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Timeout'),{code:'deadline_exceeded'})),ms);})]);}finally{clearTimeout(timer);}
}
function cursorFailure(error:unknown){
 // RunError retains only code/message; SDK Error prototypes and HTTP status
 // are lost when a failed run crosses the SDK's event/storage boundary.
 const e=(typeof error==='string'?{message:error}:error??{}) as {name?:string;status?:number;code?:string;message?:string};
 const upstreamCode=e.code?.toLowerCase()??'';
 // The SDK can report a regional denial as a message-only RunError.
 // Match its explicit provider denial, not the ambiguous "Model not available".
 const regionUnsupported=/\b(?:this )?model provider is not supported in your region\b/i.test(e.message??'');
 const auth=e.status===401||e.name==='AuthenticationError'||['unauthenticated','unauthorized','not_logged_in','invalid_auth_id','agent_requires_login','auth_token_not_found','auth_token_expired'].includes(upstreamCode);
 const blocked=!regionUnsupported&&(auth||e.status===403||['plan_required','permission_denied','not_high_enough_permissions'].includes(upstreamCode));
 const network=safeFailure(error instanceof Error?error:e.message);
 const modelMissing=upstreamCode==='model_not_found'||/\bmodel (?:was |is )?not found\b/i.test(e.message??'');
 const code=regionUnsupported?'cursor_region_unsupported':modelMissing?'cursor_model_not_found':upstreamCode==='plan_required'?'cursor_plan_required':auth?'cursor_authentication_failed':blocked?'cursor_permission_denied':
  e.status===429||e.name==='RateLimitError'||['resource_exhausted','rate_limited','rate_limited_changeable','openai_rate_limit_exceeded','generic_rate_limit_exceeded','api_key_rate_limit'].includes(upstreamCode)?'cursor_rate_limited':
  ['invalid_argument','bad_request','bad_model_name'].includes(upstreamCode)||e.name==='ConfigurationError'?'cursor_request_rejected':
  ['deadline_exceeded','timeout'].includes(upstreamCode)||network.code==='timeout'?'cursor_timeout':
  network.code==='tls'?'cursor_tls_error':network.code==='dns'?'cursor_dns_error':
  ['connection_refused','connection_closed','proxy','proxy_auth'].includes(network.code)?'cursor_network_error':
  upstreamCode==='unavailable'?'cursor_upstream_unavailable':upstreamCode==='internal'?'cursor_upstream_internal':
  e.name==='TypeError'||e.name==='NetworkError'?'cursor_network_error':process.env.CURSOR_BACKEND_URL?'cursor_backend_override':'cursor_upstream_error';
 return {auth,blocked,code,status:regionUnsupported?403:modelMissing?400:502,message:upstreamError(regionUnsupported?403:502,JSON.stringify({error:{code}})).message};
}

function containsTransportPath(value:unknown,root:string):boolean {
 if(typeof value==='string')return value.replaceAll('\\','/').includes(root.replaceAll('\\','/'));
 if(Array.isArray(value))return value.some(item=>containsTransportPath(item,root));
 return !!value&&typeof value==='object'&&Object.values(value).some(item=>containsTransportPath(item,root));
}
