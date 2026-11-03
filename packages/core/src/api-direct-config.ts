import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,rename,rm,open} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {readConfig,safePath,agentProcesses,type Target} from './agent-connections.js';
import {RunnerCoreError} from './errors.js';
import type {ModelCapabilities} from './model-capabilities.js';

export type DirectApiSelection={sourceId:string;model:string;baseURL:string;apiKey:string;name:string;capabilities?:ModelCapabilities;models?:{id:string;capabilities?:ModelCapabilities}[]};
export const directConfigRevision=(value:string|null)=>createHash('sha256').update(value===null?'missing':`file:${value}`).digest('hex');
const journalSchema=z.object({id:z.string().uuid(),sourceId:z.string(),model:z.string(),models:z.array(z.string()).optional(),baseURL:z.string(),name:z.string(),before:z.string().nullable(),after:z.string(),state:z.enum(['prepared','applied','restored'])});
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function undo(before:unknown,after:unknown,current:unknown,conflict:()=>Error):unknown{
 if(isDeepStrictEqual(before,after)||isDeepStrictEqual(before,current))return current;
 if(isDeepStrictEqual(after,current))return before;
 if(object(after)&&object(current)&&(object(before)||before===undefined)){
  const result={...current};for(const key of new Set([...Object.keys(before??{}),...Object.keys(after)])){
   const value=undo(before?.[key],after[key],current[key],conflict);if(value===undefined)delete result[key];else result[key]=value;
  }return Object.keys(result).length||before!==undefined?result:undefined;
 }
 throw conflict();
}

/** Local configuration transaction only. Protocol discovery stays with saved API sources. */
export abstract class ApiDirectConfig {
 protected directory:string;
 constructor(root:string,readonly configPath:string,private target:'codex'|'claude',private codec:{parse:(raw:string)=>Record<string,any>;stringify:(value:Record<string,any>)=>string},private processes:(target:Target)=>Promise<number[]>=agentProcesses){this.directory=join(root,`${target}-api-direct`);}
 protected fail(message:string){return new RunnerCoreError(message,{statusCode:409,code:`${this.target}_api_direct_conflict`});}
 private get label(){return this.target==='codex'?'Codex':'Claude Code';}
 protected async write(path:string,value:unknown){await safePath(path);await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=`${path}.${randomUUID()}.tmp`;try{await writeFile(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});await rename(temp,path);}finally{await rm(temp,{force:true});}}
 private async journal(){const text=await readConfig(join(this.directory,'active.json'));return text===null?null:journalSchema.parse(JSON.parse(text));}
 async revision(){return directConfigRevision(await readConfig(this.configPath));}
 private selected(entry:z.infer<typeof journalSchema>,current:string|null){
  const actual=this.codec.parse(current??''),after=this.codec.parse(entry.after),allowed=entry.models??[entry.model];
  if(typeof actual.model==='string'&&allowed.includes(actual.model)){
   actual.model=after.model;
   if(this.target==='codex'&&['none','minimal','low','medium','high','xhigh','max'].includes(actual.model_reasoning_effort)){
    if(after.model_reasoning_effort===undefined)delete actual.model_reasoning_effort;else actual.model_reasoning_effort=after.model_reasoning_effort;
   }
  }
  return actual;
 }
 async status(){const entry=await this.journal();if(!entry||entry.state==='restored')return null;const current=await readConfig(this.configPath);let configured=current===entry.after;try{configured||=isDeepStrictEqual(this.selected(entry,current),this.codec.parse(entry.after));}catch{/* Invalid configuration remains visible as drift. */}return {sourceId:entry.sourceId,model:entry.model,baseURL:entry.baseURL,name:entry.name,state:entry.state,configured,revision:directConfigRevision(current)};}
 private async locked<T>(revision:string,work:(current:string|null)=>Promise<T>,allowRunning=false){
  await safePath(this.configPath);await mkdir(dirname(this.configPath),{recursive:true,mode:0o700});const path=`${this.configPath}.token-flow.lock`;let lock;
  try{lock=await open(path,'wx',0o600);}catch{throw this.fail(`另一个操作正在修改 ${this.label} 配置，请稍后重试。`);}
  try{
   await lock.writeFile(String(process.pid));
   // Claude settings can be saved for the next invocation without terminating terminal sessions.
   if(this.target==='codex'&&!allowRunning&&(await this.processes('codex')).length)throw this.fail('请先退出 Codex 再切换接入方式。');
   const current=await readConfig(this.configPath);if(directConfigRevision(current)!==revision)throw this.fail(`${this.label} 配置已变化，请刷新后重试。`);
   return await work(current);
  }finally{await lock.close();await rm(path,{force:true});}
 }
 private async replace(current:string|null,next:string|null){
  if(await readConfig(this.configPath)!==current)throw this.fail(`${this.label} 配置发生并发修改，已停止写入。`);
  if(next===null){await rm(this.configPath,{force:true});return;}
  const temp=`${this.configPath}.${randomUUID()}.tmp`;try{await writeFile(temp,next,{mode:0o600,flag:'wx'});if(await readConfig(this.configPath)!==current)throw this.fail(`${this.label} 配置发生并发修改，已停止写入。`);await rename(temp,this.configPath);}finally{await rm(temp,{force:true});}
 }
 protected restoredConfig(restored:string|null,_applied:string):string|null{return restored;}
 protected restorationState(current:Record<string,any>,_before:Record<string,any>,_after:Record<string,any>){return current;}
 protected abstract configure(current:string|null,selection:DirectApiSelection,id:string):Promise<string>;
 async apply(selection:DirectApiSelection,revision:string,allowRunning=false){return this.locked(revision,async current=>{
  const active=await this.journal();if(active&&active.state!=='restored')throw this.fail('请先恢复当前直连配置，再选择新的 API。');
  const id=randomUUID(),after=await this.configure(current,selection,id);
  const entry={id,sourceId:selection.sourceId,model:selection.model,models:selection.models?.map(item=>item.id),baseURL:selection.baseURL,name:selection.name,before:current,after,state:'prepared' as const};
  await this.write(join(this.directory,'active.json'),entry);await this.replace(current,after);await this.write(join(this.directory,'active.json'),{...entry,state:'applied'});return this.status();
 },allowRunning);}
 private restored(entry:z.infer<typeof journalSchema>,current:string|null){
  const before=this.codec.parse(entry.before??''),after=this.codec.parse(entry.after),actual=this.restorationState(this.selected(entry,current),before,after);
  // A prepared transaction may not have written its configuration at all.
  if(entry.state==='prepared'&&isDeepStrictEqual(actual,before))return entry.before;
  const completed=this.restoredConfig(entry.before,entry.after);
  if(isDeepStrictEqual(actual,this.codec.parse(completed??'')))return current;
  const restored=isDeepStrictEqual(actual,before)?before:undo(before,after,actual,()=>this.fail(`${this.label} 直连设置已被其他操作修改，请先核对配置；原配置备份保留。`));
  return this.restoredConfig(isDeepStrictEqual(restored,before)?entry.before:this.codec.stringify(restored as Record<string,any>),entry.after);
 }
 async restoration(){const current=await readConfig(this.configPath),entry=await this.journal();return entry&&entry.state!=='restored'?this.restored(entry,current):current;}
 async restore(revision:string,allowRunning=false){return this.locked(revision,async current=>{
  const entry=await this.journal();if(!entry||entry.state==='restored')return;
  await this.replace(current,this.restored(entry,current));
  await this.write(join(this.directory,`restored-${entry.id}.json`),{...entry,state:'restored'});await this.write(join(this.directory,'active.json'),{...entry,state:'restored'});
 },allowRunning);}
}
