import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { RunnerCoreError } from './errors.js';
import { inferenceFetch } from './upstream-request.js';

export type CodexOfficialFetch=(url:string,options:RequestInit)=>Promise<Response>;
export type OfficialCodexCatalog={models:Array<Record<string,unknown>&{slug:string}>};
const unavailable=(message:string)=>new RunnerCoreError(message,{statusCode:409,code:'codex_coexist_unavailable'});
const catalogSchema=z.object({models:z.array(z.object({slug:z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/),display_name:z.string(),visibility:z.string(),truncation_policy:z.object({mode:z.string(),limit:z.number()}).passthrough()}).passthrough()).min(1).max(1000)});
const authSchema=z.object({auth_mode:z.literal('chatgpt').optional(),tokens:z.object({access_token:z.string().min(1).max(20000),account_id:z.string().min(1).max(300)})});
async function auth(configPath:string){try{return authSchema.parse(JSON.parse(await readFile(join(dirname(configPath),'auth.json'),'utf8'))).tokens;}catch{throw unavailable('请先在 Codex 登录 ChatGPT 账号，再启用官方模型与网关模型共存。');}}
export async function codexCoexistStatus(configPath:string){try{await auth(configPath);return {available:true};}catch{return {available:false,reason:'请先在 Codex 登录 ChatGPT 账号。'};}}

/** Fetch the account's complete official metadata without persisting or returning its credentials. */
export async function loadOfficialCodexCatalog(configPath:string,fetcher:CodexOfficialFetch=inferenceFetch):Promise<OfficialCodexCatalog>{
 return loadOfficialCodexCatalogForAuth(configPath,{tokens:await auth(configPath)},fetcher);
}
/** Identity changes discover permissions using the candidate login before replacing any active files. */
export async function loadOfficialCodexCatalogForAuth(configPath:string,authorization:unknown,fetcher:CodexOfficialFetch=inferenceFetch):Promise<OfficialCodexCatalog>{
 const parsed=authSchema.safeParse(authorization);if(!parsed.success)throw unavailable('原登录没有可用的 ChatGPT 授权，无法保留官方模型共存；请先停用共存或重新登录。');
 const tokens=parsed.data.tokens;let version='0.134.0';
 try{const cached=JSON.parse(await readFile(join(dirname(configPath),'models_cache.json'),'utf8'));if(typeof cached.client_version==='string'&&/^[\w.+-]{1,80}$/.test(cached.client_version))version=cached.client_version;}catch{/* Version is a discovery hint, never an auth or model fallback. */}
 try{
  const response=await fetcher(`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`,{headers:{authorization:`Bearer ${tokens.access_token}`,'chatgpt-account-id':tokens.account_id,'user-agent':`codex_cli_rs/${version}`},signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok){await response.body?.cancel();throw unavailable(response.status===401?'Codex 官方登录已失效，请在客户端重新登录后再应用共存模式。':'读取官方模型列表失败，请检查网络后重新应用。');}
  const reader=response.body?.getReader();if(!reader)throw unavailable('官方模型目录为空。');let bytes=0;const chunks:Uint8Array[]=[];
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>16*1024*1024)throw unavailable('官方模型目录超过可读取大小。');chunks.push(chunk.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const result=catalogSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));if(!result.success)throw unavailable('官方模型目录格式暂不兼容，尚未改动配置。');
  if(new Set(result.data.models.map(m=>m.slug)).size!==result.data.models.length)throw unavailable('官方模型目录包含重复 ID，尚未改动配置。');
  return result.data;
 }catch(error){if(error instanceof RunnerCoreError)throw error;throw unavailable('无法读取官方模型列表，请检查网络或 Codex 登录后重试。');}
}
export function mergeCodexCatalog<T extends {models:Array<{slug:string}>}>(gateway:T,official:OfficialCodexCatalog){
 const ids=new Set(official.models.map(m=>m.slug));if(gateway.models.some(m=>ids.has(m.slug)))throw unavailable('网关模型 ID 与官方模型重复，请为网关模型使用带来源的 ID。');
 return {...gateway,tokenflow_gateway_models:gateway.models.map(m=>m.slug),models:[...structuredClone(official.models),...gateway.models]};
}

/** ChatGPT authorization is passed only to the fixed official host. Never reuse it for a gateway model. */
export function officialCodexHeaders(headers:Record<string,string|string[]|undefined>){
 const auth=typeof headers.authorization==='string'?headers.authorization:'';
 if(!/^Bearer [^\r\n]+$/.test(auth))throw unavailable('官方模型需要 Codex 当前的 ChatGPT 登录。');
 const result:Record<string,string>={authorization:auth,'content-type':'application/json'};
 for(const name of ['chatgpt-account-id','openai-beta','user-agent','originator','version','session_id','session-id','conversation_id','x-codex-beta-features','x-codex-turn-metadata'])if(typeof headers[name]==='string')result[name]=headers[name] as string;
 return result;
}
export const officialCodexURL=(path:'responses'|'responses/compact')=>`https://chatgpt.com/backend-api/codex/${path}`;
