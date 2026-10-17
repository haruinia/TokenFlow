import {createHmac} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import type {UsageChannel} from './local-usage.js';
import {nativeIdentity} from './local-usage.js';

export type RouteEvidence={threadId:string;time:number;channel:UsageChannel|'gateway'};
/** A nearby inference endpoint in the same thread is evidence; model names and current logins aren't. */
export function routeChannel(routes:readonly RouteEvidence[],threadId:string,time:string):UsageChannel|'gateway'{
 const timestamp=Date.parse(time);const channels=new Set(routes.filter(r=>r.threadId===threadId&&Math.abs(r.time-timestamp)<=120_000).map(r=>r.channel));
 return channels.size===1?[...channels][0]:'unknown';
}
export async function codexRouteEvidence(home:string,gatewayPorts:number[]=[]):Promise<RouteEvidence[]>{
 let db:import('node:sqlite').DatabaseSync|undefined;
 try{
  const {DatabaseSync}=await import('node:sqlite');db=new DatabaseSync(join(home,'logs_2.sqlite'),{readOnly:true});
  const rows=db.prepare("SELECT ts,thread_id,feedback_log_body FROM logs WHERE thread_id IS NOT NULL AND target IN ('codex_http_client::client','codex_api::endpoint::responses_websocket') AND (feedback_log_body LIKE '%/responses%' OR feedback_log_body LIKE '%/chat/completions%') ORDER BY id DESC LIMIT 20000").all();
  const routes:RouteEvidence[]=[];
  for(const row of rows)for(const raw of String(row.feedback_log_body??'').match(/(?:https?|wss?):\/\/[^\s"<>]+/g)??[]){
   let url:URL;try{url=new URL(raw.replace(/[.,;)]+$/,''));}catch{continue;}
   let channel:UsageChannel|'gateway'='unknown';
   if(url.hostname==='chatgpt.com'&&url.pathname==='/backend-api/codex/responses')channel='official';
   if(url.hostname==='api.openai.com'&&/^\/v1\/(responses|chat\/completions)$/.test(url.pathname))channel='api';
   if(['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&gatewayPorts.includes(Number(url.port))&&/^\/v1\/(responses|chat\/completions)$/.test(url.pathname))channel='gateway';
   // Other endpoints are not evidence of authentication. Keep them as conflicts instead of guessing.
   if(/\/(responses|chat\/completions)$/.test(url.pathname))routes.push({threadId:String(row.thread_id),time:Number(row.ts)*1000,channel});
  }return routes;
 }catch{return [];}finally{db?.close();}
}
/** Desktop third-party logs don't name the endpoint; only the applied profile tells whether this gateway already counted them. */
export async function claudeDesktopViaGateway(directory:string,gatewayPorts:readonly number[]){
 try{
  const read=async(path:string)=>{if((await stat(path)).size>1024*1024)throw Error('large config');return JSON.parse(await readFile(path,'utf8'));};
  const meta=await read(join(directory,'configLibrary','_meta.json')),mode=await read(join(directory,'claude_desktop_config.json'));
  if(mode?.deploymentMode!=='3p'||meta?.hybridPointer||!/^[a-f0-9-]{36}$/.test(meta?.appliedId??''))return false;
  const profile=await read(join(directory,'configLibrary',`${meta.appliedId}.json`)),url=new URL(profile?.inferenceGatewayBaseUrl);
  return profile.inferenceProvider==='gateway'&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&gatewayPorts.includes(Number(url.port));
 }catch{return false;}
}
/** Old traces used a salted response reference. Match exactly without copying messages or response IDs. */
export async function gatewayResponseEvidence(root:string){
 try{
  const path=join(root,'gateway-traces.json');if((await stat(path)).size>32*1024*1024)throw Error('large trace file');
  const data=JSON.parse(await readFile(path,'utf8'));if(!/^[a-f0-9]{64}$/.test(data.salt))throw Error('invalid salt');
  const refs=new Map<string,Set<string>>();const hashes=new Set<string>();
  for(const row of (data.records??[]).slice(0,1000)){
   if(/^[a-f0-9]{64}$/.test(row.responseHash??''))hashes.add(row.responseHash);
   if(typeof row.keyId==='string'&&/^[a-f0-9]{64}$/.test(row.responseRef??'')){const set=refs.get(row.keyId)??new Set<string>();set.add(row.responseRef);refs.set(row.keyId,set);}
  }
  return {hashes,matches:(id:string)=>{if(hashes.has(nativeIdentity('response',id)))return true;for(const[key,set]of refs)if(set.has(createHmac('sha256',data.salt).update(`${key}\n${id}`).digest('hex')))return true;return false;}};
 }catch{return {hashes:new Set<string>(),matches:(_id:string)=>false};}
}
