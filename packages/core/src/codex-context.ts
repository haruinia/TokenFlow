import type {ReportSwitchStep} from './codex-switch-progress.js';
import {portableCodexItem,officialCodexItem} from './codex-history-items.js';
export {portableCodexItem} from './codex-history-items.js';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {GatewayContext,GatewayContextError,type ContextScope} from './gateway-context.js';
import {safePath} from './agent-connections.js';
import {CodexHistoryEditor,codexRolloutFiles,rolloutId} from './codex-history-editor.js';
import {replayCodexHistoryWindow} from './codex-rollout-history.js';

type Item=Record<string,any>;
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
export const codexContextScope:ContextScope={owner:'managed-agent:codex',source:'portable-context',model:'portable-context'};
// Older derived caches did not prove full history coverage. Authenticate new
// entries under a separate scope, rebuilding legacy caches from source on demand.
const cacheScope:ContextScope={...codexContextScope,source:'verified-history-v2'};
const failure=(detail='未找到对应的完整本机历史或可读摘要。')=>new GatewayContextError(`无法恢复这段压缩上下文。${detail}请在保留完整记录的本机继续，或提供可读交接摘要；原会话未被清空。`);
const object=(v:unknown):v is Item=>!!v&&typeof v==='object'&&!Array.isArray(v);
// This directory contains disposable derived data, never the sole history copy.
const cacheStorageUnavailable=(error:unknown)=>['ENOENT','ENOTDIR','EISDIR','EEXIST','EACCES','EPERM','ENOSPC','EDQUOT','EROFS'].includes((error as NodeJS.ErrnoException)?.code??'');
/** Replays only local Codex rollout data. No credentials, cloud lookup, or model
 * call occurs here. The service enables this exclusively for its managed Codex key. */
export class CodexContext {
 private cache:string;
 constructor(private root:string,private configPath:string,private context:GatewayContext,private report:ReportSwitchStep=()=>{}){this.cache=join(root,'codex-context-cache');}
 private files(){return codexRolloutFiles(dirname(this.configPath));}
 private async cached(token:string){
  try{return this.context.decodeCheckpoint(await readFile(join(this.cache,digest(token)),'utf8'),[cacheScope]);}
  catch(e){if(e instanceof GatewayContextError||cacheStorageUnavailable(e))return undefined;throw e;}
 }
 private async save(token:string,items:Item[]){
  await mkdir(this.cache,{recursive:true,mode:0o700});const path=join(this.cache,digest(token)),temp=path+'.'+randomUUID();
  try{await writeFile(temp,this.context.encodeCheckpoint(items,cacheScope),{mode:0o600,flag:'wx'});await rename(temp,path);}finally{await rm(temp,{force:true});}
 }
 async recover(item:Item,scopes:ContextScope[]):Promise<Item[]>{
  if(item.type==='previous_response')return (await this.context.readStoredHistory(item.id,[codexContextScope,...scopes])).flatMap(portableCodexItem);
  const token=item.encrypted_content;if(typeof token!=='string'||!token)throw failure();
  if(token.startsWith('tfctx1.'))return this.context.decodeCheckpoint(token,[codexContextScope,...scopes]).flatMap(portableCodexItem);
  const cached=await this.cached(token);if(cached)return cached.flatMap(portableCodexItem);
  const files=await this.files();
  const parseRows=(text:string)=>text.split('\n').filter(line=>line.trim()).map(line=>{try{return JSON.parse(line) as Item;}catch{throw failure();}});
  const locate=async(base:Item,currentPath:string,visited:Set<string>)=>{
   for(const {path} of files){
    if(rolloutId(path)!==base.thread_id||path===currentPath||visited.has(path))continue;
    await safePath(path);const raw=await readFile(path);
    if(base.end_byte_offset>raw.length)throw failure();
    const prefix=raw.subarray(0,base.end_byte_offset);if(prefix.length&&prefix.at(-1)!==10)continue;
    const rows=parseRows(prefix.toString('utf8'));
    const last=rows.at(-1)?.ordinal;
    if(Number.isSafeInteger(last)&&Number.isSafeInteger(base.end_ordinal_exclusive)&&last+1!==base.end_ordinal_exclusive)throw failure();
    return {path,rows};
   }
   throw failure('当前分支依赖的原始历史不在本机，且没有覆盖它的完整摘要。');
  };
  const ancestors=async(rows:Item[],currentPath:string,visited:Set<string>):Promise<Item[]>=>{
   const base=rows[0]?.type==='session_meta'?rows[0].payload?.history_base:undefined;
   if(!base)return rows;
   // A surviving complete checkpoint covers earlier ancestors. A rolled-back
   // checkpoint does not: use the same replay rules for this decision and output.
   if(replayCodexHistoryWindow(rows,replace,false).complete)return rows;
   if(typeof base.thread_id!=='string'||!Number.isSafeInteger(base.end_byte_offset)||base.end_byte_offset<0)throw failure();
   const next=new Set(visited);next.add(currentPath);
   const prior=await locate(base,currentPath,next);
   return [...(await ancestors(prior.rows,prior.path,next)).filter(row=>row.type!=='session_meta'),...rows];
  };
  const replace=(row:Item):Item[]|undefined=>{
   const value=row.type==='compacted'?row.payload?.replacement_history:row.type==='response_item'&&row.payload?.type==='compaction'?[row.payload]:undefined;
   if(!Array.isArray(value)||!value.every(object))return;
   // Earlier official opaque windows are not readable summaries. Keep their
   // original response items; a newer local/plaintext checkpoint can replace them.
   if(value.some(item=>item.type==='compaction'&&!String(item.encrypted_content).startsWith('tfctx1.')))return;
   const items:Item[]=[];
   for(const item of value){
    if(item.type==='compaction'){const saved=this.context.decodeCheckpointWindow(item.encrypted_content,[codexContextScope,...scopes]),replayed=this.context.replayCheckpoint(items,saved.input,saved.coveredUsers);items.length=0;items.push(...replayed);}
    else items.push(item);
   }
   return items;
  };
  for(const {path} of files){
   await safePath(path);const text=await readFile(path,'utf8');if(!text.includes(token))continue;
   const rows:Item[]=[];let complete=false;
   for(const line of text.split('\n')){
    if(!line.trim())continue;
    let row:Item;try{row=JSON.parse(line);}catch{throw failure();}
    const value=row.type==='compacted'?row.payload?.replacement_history:row.type==='response_item'?[row.payload]:[];
    if(Array.isArray(value)&&value.some(item=>item?.type==='compaction'&&item.encrypted_content===token)){complete=true;break;}
    rows.push(row);
   }
   if(!complete)continue;
   const replay=replayCodexHistoryWindow(await ancestors(rows,path,new Set()),replace);
   if(!replay.complete)throw failure('较早的压缩记录缺少可读历史，不能仅用最近几轮恢复。');
   const history=replay.history.flatMap(portableCodexItem);
   if(history.some(item=>item.role==='user')){
    // Exact source replay has already succeeded. A full/read-only cache must
    // not turn that success into a failed turn; unexpected errors still surface.
    try{await this.save(token,history);}catch(error){if(!cacheStorageUnavailable(error))throw error;}
    return history;
   }
  }
  throw failure();
 }
 /** Coexisting official routes understand native opaque state, but cannot
  * decrypt our local checkpoints or resolve gateway-owned response IDs. */
 async forOfficial<T extends Record<string,unknown>>(body:T,scopes:ContextScope[]):Promise<T>{
  const restored=await this.context.forOfficial(body,[codexContextScope,...scopes],item=>officialCodexItem(item,true));
  if(!Array.isArray(restored.input))return restored;
  let changed=false;
  const input=restored.input.flatMap((item:Item)=>{
   const converted=officialCodexItem(item);
   changed ||=converted.length!==1||converted[0]!==item;
   return converted;
  });
  return changed?{...restored,input}:restored;
 }
 /** Content conversion and protocol migration share only the transactional history editor. */
 async repairLineage(processes:()=>Promise<number[]>){return new CodexHistoryEditor(this.root,this.configPath,this.report).rewrite((_path,before)=>this.transform(before,[],false),processes);}
 async prepareOfficial(scopes:ContextScope[],processes:()=>Promise<number[]>){return new CodexHistoryEditor(this.root,this.configPath,this.report).rewrite((_path,before)=>this.transform(before,scopes,true),processes);}
 private async transform(before:string,scopes:ContextScope[],normalize:boolean){
  const lines=before.split('\n');let malformed=false;

   let gatewayTurn=false;const foreignReasoning=new Set<string>();
   const normalizeItem=(item:Item):Item[]=>{
    // Gateway item IDs identify records in that source, not persisted OpenAI
    // items. Replay complete inline items on return; call_id still binds every
    // tool result to its call. Keep native IDs outside gateway turns intact.
    if(gatewayTurn&&typeof item?.id==='string'&&['message','function_call','function_call_output','custom_tool_call','custom_tool_call_output'].includes(item.type)){
     const value={...item};delete value.id;return [value];
    }
    if(!normalize)return [item];
    // Chat-to-Responses translators emit synthetic reasoning IDs and sometimes
    // an empty ciphertext. Neither is an official encrypted reasoning item.
    if(item?.type!=='reasoning'||!(gatewayTurn||foreignReasoning.has(item.id)||/^rs_chatcmpl[-_]/.test(String(item.id))))return [item];
    if(typeof item.id==='string')foreignReasoning.add(item.id);
    return portableCodexItem(item);
   };
   for(let i=0;i<lines.length;i++){
    let row:Item;try{row=JSON.parse(lines[i]!);}catch{if(lines[i]!.trim())malformed=true;continue;}
    if(!object(row.payload))continue;
    if(row.type==='session_meta')gatewayTurn=row.payload.model_provider==='token_flow';
    if(row.type==='turn_context'&&typeof row.payload.model==='string')gatewayTurn=row.payload.model.includes('/');
    if(row.type==='response_item'){
     const normalized=normalizeItem(row.payload);
     if(normalized.length!==1||normalized[0]!==row.payload)lines[i]=(normalized.length?normalized:[{type:'message',role:'assistant',content:[{type:'output_text',text:''}]}]).map(payload=>JSON.stringify({...row,payload})).join('\n');
    }
    let event:Item|undefined;
    if(row.type==='compacted'){
     const history=row.payload.replacement_history;
     if(Array.isArray(history)){
      const normalized=history.flatMap(normalizeItem);
      if(JSON.stringify(normalized)!==JSON.stringify(history)){row.payload.replacement_history=normalized;delete row.payload.replacement_history_metadata;lines[i]=JSON.stringify(row);}
     }
     event=row;
    }else if(row.type==='response_item'&&row.payload.type==='compaction'){event={...row,type:'compacted',payload:{message:'',replacement_history:[row.payload]}};}
    // Any checkpoint can be the latest one in a frozen branch or after revert.
    // Materialize each in place, preserving event ordinals and all later turns.
    if(!normalize)continue;
    const history=event?.payload?.replacement_history;if(!Array.isArray(history))continue;
    const recoveredTokens=new Map<string,{input:Item[];coveredUsers:Set<string>}>();
    for(const item of history){
     if(item?.type!=='compaction'||typeof item.encrypted_content!=='string')continue;
     const token=item.encrypted_content;
     const cached=token.startsWith('tfctx1.')?undefined:await this.cached(token);
     const recovered=token.startsWith('tfctx1.')?this.context.decodeCheckpointWindow(token,[codexContextScope,...scopes]):cached?{input:cached,coveredUsers:new Set<string>()}:undefined;
     if(recovered)recoveredTokens.set(token,recovered);
    }
    if(!recoveredTokens.size)continue;
    let changed=false;const output:Item[]=[];
    for(const item of history){
     if(item?.type!=='compaction'){output.push(item);continue;}
     const recovered=recoveredTokens.get(item.encrypted_content);
     if(!recovered){output.push(item);continue;}
     // This checkpoint covers preceding retained user messages; use the full
     // restored window, not both copies of the same turns.
     const replayed=this.context.replayCheckpoint(output,recovered.input,recovered.coveredUsers);
     output.length=0;output.push(...replayed);changed=true;
    }
    if(changed){
     if(malformed)throw new GatewayContextError('会话记录不完整，迁移已停止；请先退出 Codex 后重试，原文件保留。',409);
     event!.payload.replacement_history=output.flatMap(item=>item.type==='compaction'?[item]:portableCodexItem(item));
     // This optional array is position-aligned with the OLD history. Keeping it
     // causes Codex to ignore the rewritten checkpoint on resume. The independent
     // guardian history and retained user/assistant records remain unchanged.
     delete event!.payload.replacement_history_metadata;
     lines[i]=JSON.stringify(event);
    }
   }
  const after=lines.join('\n');
  if(after!==before&&malformed)throw new GatewayContextError('会话记录不完整，迁移已停止；请先退出 Codex 后重试，原文件保留。',409);
  return after;
 }
}
