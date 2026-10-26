import { apiModelRoute } from '../../../apps/shared/api-endpoint.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { providerSchema, type ProviderConfig } from './providers.js';
import { RunnerCoreError } from './errors.js';
import { upstreamRequest, inferenceFetch } from './upstream-request.js';
import {readUpstreamError,upstreamError} from './upstream-errors.js';
import type { Secrets } from './service.js';

const modelID=z.string().trim().min(1).max(200).refine(v=>!/[\x00-\x1f\x7f]/.test(v));
export const apiSourceInput=z.object({name:z.string().trim().min(1,'请填写来源名称。').max(80,'来源名称不能超过 80 个字符。'),baseURL:providerSchema.shape.baseURL,
 protocol:z.enum(['responses','chat','messages']),modelRoutes:z.record(modelID,z.object({protocol:z.enum(['responses','chat','messages']),baseURL:providerSchema.shape.baseURL}).strict()).optional(),enabled:z.boolean().default(true),models:z.array(modelID).max(2000).transform(v=>[...new Set(v)]),
 apiKey:z.string().trim().min(1,'请填写 API Key。').max(4096,'API Key 不能超过 4096 个字符。').refine(v=>!/[\r\n]/.test(v),'API Key 不能包含换行。').optional(),acknowledge:z.boolean().optional()}).strict();
export function parseApiSourceInput(input:unknown){
 const result=apiSourceInput.safeParse(input);if(result.success)return result.data;
 const issue=result.error.issues[0],field=String(issue.path[0]??'');
 const fallback:Record<string,string>={name:'请填写有效的来源名称。',baseURL:'请填写有效的 API 地址。',protocol:'请选择来源明确支持的协议。',models:'请填写有效的模型 ID，最多 2000 个。',apiKey:'请填写有效的 API Key。',enabled:'来源启用状态无效。',acknowledge:'请确认来源修改影响。'};
 throw new RunnerCoreError(field&&/[\u3400-\u9fff]/.test(issue.message)?issue.message:fallback[field]??'API 来源配置无效，请检查填写内容。',{statusCode:400,code:'api_source_invalid',hint:field?`请检查${({name:'来源名称',baseURL:'API 地址',protocol:'协议',models:'模型 ID',apiKey:'API Key'} as Record<string,string>)[field]??'填写内容'}。`:undefined});
}
const evidence=z.object({status:z.enum(['passed','failed']),checkedAt:z.string(),message:z.string()});
const storedSource=apiSourceInput.omit({apiKey:true,acknowledge:true}).extend({id:z.string().regex(/^[a-f0-9]{24}$/),credentialRef:z.string().regex(/^source-[a-f0-9]{24}-[a-f0-9]{16}$/),createdAt:z.string(),checks:z.record(evidence).default({})});
type StoredSource=z.infer<typeof storedSource>;
export type ApiSource=Omit<StoredSource,'credentialRef'> & {hasKey:boolean};
export const apiModelID=(sourceId:string,upstream:string)=>`api-${sourceId}/${upstream}`;
const conflict=(message:string)=>new RunnerCoreError(message,{statusCode:409,code:'api_source_conflict'});
const MODEL_LIST_BYTES=16*1024*1024;
const nativeHeader='x-token-flow-native';
function safeSourceStream(body:ReadableStream<Uint8Array>){
 const decoder=new TextDecoder(),encoder=new TextEncoder();let buffer='';
 const safe=(frame:string)=>{
  const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
  if(!data||data==='[DONE]')return frame+'\n\n';
  let failed=false,detail:ReturnType<typeof upstreamError>|undefined;
  try{const value=JSON.parse(data);failed=value?.type==='error'||value?.type==='response.failed'||!!value?.error||!!value?.response?.error;if(failed)detail=upstreamError(502,data);}catch{failed=true;}
  const error=detail?.code?detail:{code:'api_source_error',type:'api_error',message:'API source stream failed'};
  return failed?'event: error\ndata: '+JSON.stringify({...error,type:'error',error})+'\n\n':frame+'\n\n';
 };
 return body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
  transform(chunk,out){buffer+=decoder.decode(chunk,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');let end:number;while((end=buffer.indexOf('\n\n'))!==-1){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);out.enqueue(encoder.encode(safe(frame)));}},
  flush(out){buffer+=decoder.decode();if(buffer.trim())out.enqueue(encoder.encode(safe(buffer)));}
 }));
}

/** The sidecar talks to every Responses source as if it were the ChatGPT Codex backend: it adds an
 * image tool and encrypted-reasoning include that generic Responses APIs often reject. The second
 * body is a retry for upstreams that also refuse `include` or `prompt_cache_key`. */
export function genericResponsesBodies(body:Record<string,unknown>):Record<string,unknown>[]{
 const {tools,tool_choice:choice,...rest}=body;
 const kept=Array.isArray(tools)?tools.filter(tool=>(tool as {type?:unknown})?.type!=='image_generation'):[];
 const imageChoice=(choice as {type?:unknown}|undefined)?.type==='image_generation';
 const cleaned:Record<string,unknown>={...rest,...(kept.length?{tools:kept}:{}),...(kept.length&&choice!==undefined&&!imageChoice?{tool_choice:choice}:{})};
 if(!('include' in cleaned)&&!('prompt_cache_key' in cleaned))return [cleaned];
 const {include:_include,prompt_cache_key:_cache,...plain}=cleaned;
 return [cleaned,plain];
}

/** Replayed Responses history may contain placeholder text blocks. Anthropic
 * rejects whitespace-only text even when the next block has a valid answer. */
export function genericMessagesBody(body:Record<string,unknown>):Record<string,unknown>{
 const clean=(content:unknown)=>Array.isArray(content)?content.filter(part=>!(part&&typeof part==='object'&&part.type==='text'&&typeof part.text==='string'&&!part.text.trim())):content;
 const result={...body};
 if(Array.isArray(body.messages))result.messages=body.messages.map(message=>message&&typeof message==='object'?{...message,content:clean(message.content)}:message);
 if(Array.isArray(body.system)){
  const system=clean(body.system) as unknown[];
  if(system.length)result.system=system;else delete result.system;
 }
 return result;
}

/** The sidecar sees only a loopback relay credential, never an upstream API key.
 * Its existing translators still handle Responses, Chat and Messages. */
export class ApiSources {
 private entries:StoredSource[]=[];
 private server?:Server;
 private relayURL='';
 private relayKey=randomBytes(32).toString('hex');
 private requests=new Set<ReturnType<typeof upstreamRequest>>();
 private migration?:string;
 private migrationWarning?:string;
 warnings(){return this.migrationWarning?[this.migrationWarning]:[];}
 private constructor(private root:string,private secrets:Secrets){}
 static async open(root:string,secrets:Secrets,legacy:ProviderConfig){
  const store=new ApiSources(root,secrets);
  try{const data=z.object({version:z.literal(1),sources:z.array(storedSource),migration:z.string().optional()}).strict().parse(JSON.parse(await readFile(join(root,'api-sources.json'),'utf8')));if(new Set(data.sources.map(s=>s.id)).size!==data.sources.length||data.sources.some(s=>!s.credentialRef.startsWith(`source-${s.id}-`)))throw new Error('Invalid source identity');store.entries=data.sources;store.migration=data.migration;}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('API 来源文件无法读取；已保留原文件，请检查 api-sources.json。');}
  if(secrets.persistent!==false&&!store.migration&&legacy.kind!=='cliproxy'){
   const key=await secrets.get(legacy.kind);
   if(key)try{
    const backup=join(root,'backups','api-sources-migration');await mkdir(backup,{recursive:true,mode:0o700});
    await copyFile(join(root,'settings.json'),join(backup,'settings.json'));
    try{await copyFile(join(root,'api-sources.json'),join(backup,'api-sources.json'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    // Copy ciphertext only; the legacy slot remains usable for rollback.
    try{await copyFile(join(root,'secrets',`${legacy.kind}.bin`),join(backup,`${legacy.kind}.bin`));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    store.migration=legacy.kind;
    await store.save({name:'迁移的 API 来源',baseURL:legacy.baseURL,protocol:'responses',models:legacy.model?[legacy.model]:[],apiKey:key});
   }catch{store.migration=undefined;store.migrationWarning='旧 API 配置尚未迁移到模型来源，原配置和密钥已保留。请解锁系统安全存储后重启，或在模型来源手动添加。';}
  }
  await store.listen();return store;
 }
 private persist(){const path=join(this.root,'api-sources.json');return writeFile(`${path}.tmp`,JSON.stringify({version:1,sources:this.entries,migration:this.migration},null,2),{mode:0o600}).then(()=>rename(`${path}.tmp`,path));}
 async list():Promise<ApiSource[]>{return Promise.all(this.entries.map(async({credentialRef,...s})=>({...structuredClone(s),hasKey:!!await this.secrets.get(credentialRef)})));}
 has(id:string){return this.entries.some(s=>s.id===id);}
 async keyFor(id:string){const s=this.entries.find(s=>s.id===id);return s?this.secrets.get(s.credentialRef):'';}
 sourceFor(model:string){return this.entries.find(s=>s.models.some(m=>apiModelID(s.id,m)===model));}
 assert(id:string,model:string){const s=this.entries.find(s=>s.id===id);if(!s?.enabled||!s.models.some(m=>apiModelID(id,m)===model))throw conflict('API 来源已停用、删除或未保存此模型；不会切换到其他来源。');return s;}
 /** Keep native API fields (including output limits) when no translation is needed. */
 async response(id:string,path:string,body:{model:string},signal:AbortSignal,headers:Record<string,string>={}){
  const s=this.assert(id,body.model);const model=s.models.find(m=>apiModelID(id,m)===body.model)!;
  return inferenceFetch(`${this.relayURL}/${id}/v1/${path}`,{method:'POST',headers:{...headers,authorization:`Bearer ${this.relayKey}`,'content-type':'application/json',[nativeHeader]:'1'},body:JSON.stringify({...body,model}),signal,redirect:'error'});
 }
 async save(input:z.input<typeof apiSourceInput>,id?:string){
  const value=parseApiSourceInput(input);const old=id?this.entries.find(s=>s.id===id):undefined;if(id&&!old)throw conflict('API 来源已变更，请刷新。');
  const {apiKey,acknowledge:_ack,...fields}=value;if(apiKey&&this.secrets.persistent===false)throw new RunnerCoreError('此服务没有持久化安全密钥存储，请在桌面版添加 API 来源。',{statusCode:400,code:'credential_storage_unavailable'});const sourceId=old?.id??randomBytes(12).toString('hex');
  if(!old&&!apiKey)throw conflict('新来源需要 API Key。');
  const ref=apiKey?`source-${sourceId}-${randomBytes(8).toString('hex')}`:old!.credentialRef;
  if(apiKey)try{await this.secrets.set(ref,apiKey);}catch{throw new RunnerCoreError('API 密钥无法写入系统加密存储，请解锁安全存储后重试。原来源已保留。',{statusCode:400,code:'credential_storage_unavailable'});}
  const sameRoute=old?.baseURL===value.baseURL&&old?.protocol===value.protocol;
  const routes=value.modelRoutes??(sameRoute&&!apiKey?old?.modelRoutes:undefined);
  fields.modelRoutes=routes?Object.fromEntries(Object.entries(routes).filter(([model])=>fields.models.includes(model))):undefined;
  const changed=apiKey||!sameRoute||JSON.stringify(old?.modelRoutes)!==JSON.stringify(fields.modelRoutes);
  const source:StoredSource={...fields,id:sourceId,credentialRef:ref,createdAt:old?.createdAt??new Date().toISOString(),checks:changed?{}:Object.fromEntries(Object.entries(old?.checks??{}).filter(([m])=>fields.models.includes(m)))};
  const previous=this.entries;this.entries=[...previous.filter(s=>s.id!==sourceId),source];
  try{await this.persist();}catch(e){this.entries=previous;if(apiKey)await this.secrets.remove?.(ref);throw e;}
  // Old encrypted revisions are retained so an interrupted migration/edit is recoverable.
  return (await this.list()).find(s=>s.id===sourceId)!;
 }
 /** Import all selected sources in one metadata transaction; no partial batch on storage failure. */
 async importBatch(inputs:z.input<typeof apiSourceInput>[]){
  const values=inputs.map(parseApiSourceInput);if(!values.length)return;
  if(this.secrets.persistent===false||values.some(v=>!v.apiKey))throw new RunnerCoreError('导入需要可用的加密密钥存储和 API Key。',{statusCode:400,code:'credential_storage_unavailable'});
  const refs:string[]=[],added:StoredSource[]=[],previous=this.entries;
  try{
   for(const value of values){const {apiKey,acknowledge:_ack,...fields}=value,id=randomBytes(12).toString('hex'),credentialRef=`source-${id}-${randomBytes(8).toString('hex')}`;
    refs.push(credentialRef);await this.secrets.set(credentialRef,apiKey!);added.push({...fields,id,credentialRef,createdAt:new Date().toISOString(),checks:{}});
   }
   this.entries=[...previous,...added];await this.persist();
  }catch{this.entries=previous;await Promise.allSettled(refs.map(ref=>this.secrets.remove?.(ref)));throw new RunnerCoreError('供应商未导入，已保留原有配置。请检查加密存储与目录权限后重试。',{statusCode:400,code:'supplier_import_storage'});}
 }
 async remove(id:string){const old=this.entries;this.entries=old.filter(s=>s.id!==id);try{await this.persist();}catch(e){this.entries=old;throw e;}const s=old.find(s=>s.id===id);if(s)await this.secrets.remove?.(s.credentialRef);}
 async record(id:string,model:string,passed:boolean,message:string){const s=this.assert(id,model);const upstream=s.models.find(m=>apiModelID(id,m)===model)!;const old=this.entries;this.entries=old.map(entry=>entry.id===id?{...entry,checks:{...entry.checks,[upstream]:{status:passed?'passed':'failed',checkedAt:new Date().toISOString(),message}}}:entry);try{await this.persist();}catch(e){this.entries=old;throw e;}}
 async models(id:string,signal?:AbortSignal){const s=this.entries.find(s=>s.id===id);if(!s)throw conflict('来源不存在');const key=await this.secrets.get(s.credentialRef);if(!key)throw conflict('API 密钥暂不可读取，请解锁系统安全存储或重新填写。');
  const timeout=AbortSignal.timeout(15000),requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;
  const failure=(code:string,message:string)=>new RunnerCoreError(message,{statusCode:400,code});
  try{
   const r=await fetch(`${s.baseURL.replace(/\/$/,'')}/models`,{headers:s.protocol==='messages'?{'x-api-key':key,'anthropic-version':'2023-06-01'}:{Authorization:`Bearer ${key}`},signal:requestSignal,redirect:'error'});
   if(!r.ok){await r.body?.cancel();if(r.status===401||r.status===403)throw failure('api_models_auth',`模型列表认证未通过（HTTP ${r.status}），请检查 API Key 和模型列表读取权限。`);throw failure('api_models_http',`读取模型列表失败（HTTP ${r.status}），请检查 API 地址和服务状态，或手动添加模型 ID。`);}
   try{const data=await this.boundedJSON(r);return z.object({data:z.array(z.object({id:modelID})).max(2000)}).parse(data).data.map(m=>m.id);}
   catch{throw failure('api_models_response','模型列表响应格式不符合预期，请检查 API 地址和服务文档，或手动添加模型 ID。');}
  }catch(error){
   if(signal?.aborted)throw failure('api_models_cancelled','已取消读取模型列表，已保存的来源配置和模型仍保留。');
   if(timeout.aborted)throw failure('api_models_timeout','读取模型列表超过 15 秒，请检查网络或服务状态后重试；已保存的来源配置和模型仍保留。');
   if(error instanceof RunnerCoreError)throw error;
   throw failure('api_models_unavailable','无法连接模型列表接口，请检查网络和 API 地址后重试，或手动添加模型 ID。');
  }
 }
 private async boundedJSON(r:Response){let bytes=0;const chunks:Uint8Array[]=[];for await(const c of Readable.fromWeb(r.body as never)){bytes+=c.length;if(bytes>MODEL_LIST_BYTES)throw new Error('Response too large');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString());}
 sidecarModelIDs(){return this.entries.filter(s=>s.enabled).flatMap(s=>s.models.map(model=>apiModelID(s.id,model)));}
 sidecarConfig(){
  const chat:unknown[]=[],responses:unknown[]=[],messages:unknown[]=[];
  for(const s of this.entries.filter(s=>s.enabled&&s.models.length))for(const protocol of ['responses','chat','messages'] as const){
   const models=s.models.filter(model=>apiModelRoute(s,model).protocol===protocol);
   if(!models.length)continue;
   const common={'base-url':`${this.relayURL}/${s.id}${protocol==='messages'?'':'/v1'}`,models:models.map(name=>({name,alias:apiModelID(s.id,name),'force-mapping':true})),'request-retry':0,'disable-cooling':true};
   if(protocol==='chat')chat.push({...common,name:`api-${s.id}`,'api-key-entries':[{'api-key':this.relayKey}]});
   else (protocol==='responses'?responses:messages).push({...common,'api-key':this.relayKey});
  }
  return `openai-compatibility: ${JSON.stringify(chat)}\ncodex-api-key: ${JSON.stringify(responses)}\nclaude-api-key: ${JSON.stringify(messages)}\n`;
 }
 private async listen(){
  this.server=createServer(async(req,res)=>{
   const idle=upstreamRequest();this.requests.add(idle);res.once('close',()=>{idle.abort();this.requests.delete(idle);});
   const fail=(status:number,message:string)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message,type:'api_source_error'}}));};
   try{
    const token=req.headers.authorization?.replace(/^Bearer /,'')??(typeof req.headers['x-api-key']==='string'?req.headers['x-api-key']:'');
    const a=Buffer.from(token),b=Buffer.from(this.relayKey);
    if(a.length!==b.length||!timingSafeEqual(a,b)||req.headers.origin){fail(401,'Private source relay');return;}
    const requestURL=new URL(req.url??'',this.relayURL);
    if(requestURL.search&&requestURL.search!=='?beta=true'){fail(400,'Source query unsupported');return;}
    const match=/^\/([a-f0-9]{24})\/(?:v1\/)?(chat\/completions|responses(?:\/compact)?|messages(?:\/count_tokens)?)$/.exec(requestURL.pathname);
    const s=match&&this.entries.find(s=>s.id===match[1]);
    if(!s?.enabled||req.method!=='POST'){fail(503,'Source unavailable');return;}
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);
    const body=JSON.parse(Buffer.concat(chunks).toString());if(!s.models.includes(body.model)){fail(403,'Source model mismatch');return;}
    const {protocol,baseURL}=apiModelRoute(s,body.model);
    // Chat streaming APIs commonly omit token usage unless explicitly requested.
    // Apply at the relay so native and translated calls share the same accounting.
    if(protocol==='chat'&&body.stream===true)body.stream_options={...(body.stream_options&&typeof body.stream_options==='object'&&!Array.isArray(body.stream_options)?body.stream_options:{}),include_usage:true};
    const allowed=protocol==='chat'?['chat/completions']:protocol==='responses'?['responses','responses/compact']:['messages','messages/count_tokens'];
    if(!allowed.includes(match![2])){fail(400,'Source protocol mismatch');return;}
    const key=await this.secrets.get(s.credentialRef);if(!key){fail(503,'Encrypted API credential unavailable');return;}
    const headers:Record<string,string>={'content-type':'application/json',...(protocol==='messages'?{'x-api-key':key,'anthropic-version':typeof req.headers['anthropic-version']==='string'?req.headers['anthropic-version']:'2023-06-01'}:{Authorization:`Bearer ${key}`})};
    // Forward only protocol headers, never local routing or administrator credentials.
    if(protocol==='messages'&&typeof req.headers['anthropic-beta']==='string')headers['anthropic-beta']=req.headers['anthropic-beta'];
    // Same-protocol calls arrive from the gateway untouched; only sidecar-translated Responses bodies need cleaning.
    const bodies=protocol==='messages'?[genericMessagesBody(body)]:protocol==='responses'&&req.headers[nativeHeader]!=='1'?genericResponsesBodies(body):[body];
    let r!:Response;
    for(const [index,attempt] of bodies.entries()){
     r=idle.watch(await inferenceFetch(`${baseURL.replace(/\/$/,'')}/${match![2]}${protocol==='messages'?requestURL.search:''}`,{method:'POST',headers,body:JSON.stringify(attempt),redirect:'error',signal:idle.signal}));
     if(r.ok||r.status!==400||index===bodies.length-1)break;
     await r.body?.cancel();
    }
    if(!r.ok){
     const error=upstreamError(r.status,await readUpstreamError(r));
     res.writeHead(r.status,{'content-type':'application/json'});res.end(JSON.stringify({error}));return;
    }
    res.writeHead(r.status,{'content-type':r.headers.get('content-type')??'application/json','cache-control':'no-store'});
    if(!r.body){res.end();return;}
    const stream=Readable.fromWeb(((r.headers.get('content-type')??'').includes('text/event-stream')?safeSourceStream(r.body):r.body) as never);stream.once('error',()=>res.destroy());stream.pipe(res);
   }catch{if(res.headersSent)res.destroy();else fail(502,'API source unavailable or timed out');}
  });
  this.server.requestTimeout=0;this.server.headersTimeout=15000;
  await new Promise<void>((ok,bad)=>{this.server!.once('error',bad);this.server!.listen(0,'127.0.0.1',ok);});
  this.relayURL=`http://127.0.0.1:${(this.server.address() as {port:number}).port}`;
 }
 async close(){for(const r of this.requests)r.abort();this.server?.closeAllConnections();if(this.server)await new Promise<void>(r=>this.server!.close(()=>r()));}
}
