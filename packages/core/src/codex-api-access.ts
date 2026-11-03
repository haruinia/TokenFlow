import {createHash,randomUUID} from 'node:crypto';
import {mkdir,rename,rm,writeFile} from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import {join} from 'node:path';
import {CodexApiDirect} from './codex-api-direct.js';
import {readConfig,safePath,agentProcesses,type Target} from './agent-connections.js';
import type {DirectApiSelection} from './api-direct-config.js';
import {RunnerCoreError} from './errors.js';

/** Shared-home API switching is a configuration-only transaction. Legacy .97
 * workspace selection remains readable until an explicit switch; its files stay intact. */
export class CodexApiAccess {
 readonly directory:string;
 private readonly configuration:CodexApiDirect;
 constructor(private root:string,readonly configPath:string,private processes:(target:Target)=>Promise<number[]>=agentProcesses){
  this.directory=join(root,'codex-api-workspaces');this.configuration=new CodexApiDirect(root,configPath,processes);
 }
 private fail(message:string){return new RunnerCoreError(message,{statusCode:409,code:'codex_api_direct_conflict'});}
 private async selected(){const raw=await readConfig(join(this.directory,'active.json'));if(!raw)return null;const value=JSON.parse(raw);if(value.sourceId===null)return null;if(!/^[a-f0-9]{24}$/.test(value.sourceId))throw this.fail('API 接入记录无效，原记录保留。');return value.sourceId as string;}
 home(sourceId:string){if(!/^[a-f0-9]{24}$/.test(sourceId))throw this.fail('API 来源无效。');return join(this.directory,sourceId,'home');}
 private manager(sourceId:string){return new CodexApiDirect(join(this.directory,sourceId),join(this.home(sourceId),'config.toml'),this.processes);}
 private async save(sourceId:string|null){await mkdir(this.directory,{recursive:true,mode:0o700});const path=join(this.directory,'active.json'),tmp=path+'.'+randomUUID();try{await writeFile(tmp,JSON.stringify({sourceId}),{mode:0o600,flag:'wx'});await rename(tmp,path);}finally{await rm(tmp,{force:true});}}
 async restoration(){return this.configuration.restoration();}
 async status(){const source=await this.selected();if(!source)return this.configuration.status();const active=await this.manager(source).status();return active?{...active,isolated:true as const,home:this.home(source)}:null;}
 async revision(){const source=await this.selected();return createHash('sha256').update(JSON.stringify([await readConfig(this.configPath),source,source?await this.manager(source).revision():null])).digest('hex');}
 async launchEnvironment():Promise<Record<string,string>>{const source=await this.selected();return source?{CODEX_HOME:this.home(source),CODEX_ELECTRON_USER_DATA_PATH:join(this.directory,source,'desktop')}:{};}
 private async locked<T>(revision:string,work:()=>Promise<T>,allowRunning=false){
  await safePath(this.directory);await mkdir(this.directory,{recursive:true,mode:0o700});let release:()=>Promise<void>;
  try{release=await lockfile.lock(this.directory,{realpath:false,retries:0,stale:120000,update:10000});}catch(error){if((error as NodeJS.ErrnoException).code==='ELOCKED')throw this.fail('API 接入正在切换，请等待完成。');throw error;}
  try{if(await this.revision()!==revision)throw this.fail('接入配置已变化，请刷新后重试。');if(!allowRunning&&(await this.processes('codex')).length)throw this.fail('请先退出 Codex 再切换接入方式。');return await work();}finally{await release();}
 }
 /** Restore the configuration overlay before selecting another API or native mode. */
 private async releaseOverlay(){const old=await this.configuration.status();if(old)await this.configuration.restore(old.revision);return !!old;}
 async apply(selection:DirectApiSelection,revision:string){return this.locked(revision,async()=>{
  await this.releaseOverlay();await this.save(null);
  return this.configuration.apply(selection,await this.configuration.revision());
 });}
 async restore(revision:string){return this.locked(revision,async()=>{await this.releaseOverlay();await this.save(null);});}
 /** Source removal may edit an underlying gateway connection. Apply that edit
  * below the API overlay, then put the surviving API back for the next launch. */
 async updateUnderlyingConfig<T>(resume:DirectApiSelection|undefined,work:()=>Promise<T>){return this.locked(await this.revision(),async()=>{
  const active=await this.configuration.status();if(active)await this.configuration.restore(active.revision,true);
  try{return await work();}finally{if(active&&resume)await this.configuration.apply(resume,await this.configuration.revision(),true);}
 },true);}
 /** Removing an API source retires its saved route for the next client launch,
  * including an inactive workspace. Conversation files remain intact. */
 async retireSource(sourceId:string){return this.locked(await this.revision(),async()=>{
  const legacy=await this.configuration.status();if(legacy?.sourceId===sourceId)await this.configuration.restore(legacy.revision,true);
  const manager=this.manager(sourceId),active=await manager.status();if(active)await manager.restore(active.revision,true);
  if(await this.selected()===sourceId)await this.save(null);
 },true);}
}
