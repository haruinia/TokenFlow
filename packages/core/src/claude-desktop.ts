import {execFile} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import {homedir,userInfo} from 'node:os';
import {join,win32,posix,dirname} from 'node:path';
import {mkdir,open,rm,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {readConfig,safePath,modelSelectionSchema,type ModelSelection} from './agent-connections.js';
import {claudeDesktopModelLimit,claudeDesktopPlan} from '../../../apps/shared/claude-desktop-models.js';
import {nativeDigest as digest,nativeConflict as conflict,writePrivate} from './native-accounts.js';
import {macAppIdentity} from './agent-lifecycle.js';
import {WindowsAgentLifecycle,electronPackageName} from './windows-agent-lifecycle.js';
import type {Secrets} from './service.js';
import type {DirectApiSelection} from './api-direct-config.js';
import {claudeDesktopApiProfile} from './claude-desktop-api.js';
const exec=promisify(execFile);
const secretName='native-login-claude-desktop';
export type ClaudeDesktopOptions={directory?:string;platform?:NodeJS.Platform;env?:NodeJS.ProcessEnv;processes?:()=>Promise<number[]>;policy?:()=>Promise<void>};
export function claudeDesktopDirectory(platform=process.platform,home=homedir(),env:NodeJS.ProcessEnv=process.env){
 const p=platform==='win32'?win32:posix;
 const base=platform==='win32'?env.LOCALAPPDATA||p.join(home,'AppData','Local'):platform==='darwin'?p.join(home,'Library','Application Support'):env.XDG_CONFIG_HOME||p.join(home,'.config');
 return p.join(base,'Claude-3p');
}
const parse=(raw:string|null):Record<string,any>=>{try{const d=JSON.parse(raw??'{}');if(d&&typeof d==='object'&&!Array.isArray(d))return d;}catch{}throw conflict('Claude Desktop 配置格式无效，已保留原文件。');};
const encode=(v:unknown)=>JSON.stringify(v,null,2)+'\n';
const fields=(meta:Record<string,any>)=>({appliedId:meta.appliedId??null,hybridPointer:meta.hybridPointer??null});
const mergeFields=(raw:string|null,values:Record<string,unknown>)=>{const doc=parse(raw);for(const [k,v] of Object.entries(values))if(v===null)delete doc[k];else doc[k]=v;return Object.keys(doc).length?encode(doc):raw===null?null:'{}\n';};
const snapshot=z.object({meta:z.string().nullable(),mode:z.string().nullable(),profile:z.string().nullable()});
const desktopSelections=z.array(modelSelectionSchema).min(1).max(claudeDesktopModelLimit).refine(items=>new Set(items.map(i=>i.model)).size===items.length,'每个模型只能选择一个来源账号');
const directSchema=z.object({sourceId:z.string(),name:z.string(),model:z.string(),baseURL:z.string()});
const journalSchema=z.object({directory:z.string(),id:z.string().uuid(),before:snapshot,after:snapshot,rollback:snapshot.optional(),keyId:z.string().uuid().optional(),direct:directSchema.optional(),selections:desktopSelections,fastModel:z.string().min(1).max(300).optional(),modelAliases:z.record(z.string().min(1).max(80),z.string().min(1).max(300)).optional(),state:z.enum(['prepared','applied','restored']),createdAt:z.string(),restoring:z.boolean().optional()}).refine(j=>!!j.direct!==!!j.keyId);
type Snapshot=z.infer<typeof snapshot>;
type Journal=z.infer<typeof journalSchema>;
export async function claudeDesktopProcesses():Promise<number[]>{
 if(process.platform==='win32')return (await new WindowsAgentLifecycle().processes('claude-desktop')).map(p=>p.pid);
 const {stdout}=await exec('/bin/ps',['-axo','pid=,comm='],{timeout:5000,maxBuffer:2*1024*1024});const result:number[]=[];
 for(const line of stdout.split('\n')){
  const m=line.trim().match(/^(\d+)\s+(.+)$/);if(!m)continue;
  if(process.platform==='darwin'){
   const app=m[2].match(/^(\/.*\.app)\/Contents\/MacOS\/([^/]+)$/);if(!app)continue;
   const id=await macAppIdentity(app[1]);if(id?.bundle==='com.anthropic.claudefordesktop'&&id.executable===app[2])result.push(Number(m[1]));
  }else if(/(?:^|\/)(?:Claude|claude-desktop)$/.test(m[2])){
   let path=m[2];try{if(!path.startsWith('/'))path=await (await import('node:fs/promises')).readlink(`/proc/${m[1]}/exe`);if(await electronPackageName(join(dirname(path),'resources','app.asar'))==='@ant/desktop')result.push(Number(m[1]));}catch{throw conflict('无法确认 Claude Desktop 进程，请先手动退出客户端。');}
  }
 }
 return result;
}
export async function checkClaudeDesktopPolicy(platform=process.platform,env:NodeJS.ProcessEnv=process.env){
 if(env.CLAUDE_USER_DATA_DIR)throw conflict('检测到特殊 Claude 数据目录，请通过 Claude Desktop 自己的配置窗口接入。');
 if(platform==='win32'){
  const script="$ErrorActionPreference='Stop';$present=$false;foreach($p in @('HKLM:\\SOFTWARE\\Policies\\Claude','HKCU:\\SOFTWARE\\Policies\\Claude')){if(Test-Path -LiteralPath $p){$k=Get-Item -LiteralPath $p;if($k.GetValueNames().Length -gt 0){$present=$true}}};if($present){'managed'}else{'local'}";
  const value=(await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:5000,maxBuffer:4096,windowsHide:true})).stdout.trim();
  if(value!=='local')throw conflict('Claude Desktop 受组织策略管理，请通过官方第三方推理配置窗口接入。');return;
 }
 const files=platform==='darwin'?['/Library/Managed Preferences/com.anthropic.claudefordesktop.plist',join('/Library/Managed Preferences',userInfo().username,'com.anthropic.claudefordesktop.plist')]:['/etc/claude-desktop/managed-settings.json'];
 for(const path of files){try{await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw conflict('无法检查 Claude 管理配置，请通过客户端配置窗口接入。');}throw conflict('Claude Desktop 存在管理策略，请通过官方第三方推理配置窗口接入。');}
}
/** Changes only the official profile selector/deployment flag. First-party cookies and keychains are never read or modified. */
export class ClaudeDesktopConnections{
 readonly directory:string;
 private platform:NodeJS.Platform;
 private env:NodeJS.ProcessEnv;
 constructor(private secrets:Secrets,private options:ClaudeDesktopOptions={}){this.platform=options.platform??process.platform;this.env=options.env??process.env;this.directory=options.directory??claudeDesktopDirectory(this.platform,homedir(),this.env);}
 private paths(id:string){return {meta:join(this.directory,'configLibrary','_meta.json'),mode:join(this.directory,'claude_desktop_config.json'),profile:join(this.directory,'configLibrary',`${id}.json`)};}
 private async journal(){const text=await this.secrets.get(secretName);if(!text)return null;try{const j=journalSchema.parse(JSON.parse(text));if(j.directory!==this.directory)throw Error();return j;}catch{throw conflict('Claude Desktop 接入备份与当前目录不匹配，未修改配置。');}}
 private save(j:Journal){return this.secrets.set(secretName,JSON.stringify(j));}
 async route(){const j=await this.journal();return j&&j.keyId&&!j.direct&&j.state!=='restored'?{keyId:j.keyId,selections:j.selections,fastModel:j.fastModel,modelAliases:j.modelAliases}:null;}
 async directSource(){const j=await this.journal();return j&&j.state!=='restored'?j.direct??null:null;}
 private async read(id:string){const paths=this.paths(id);return {meta:await readConfig(paths.meta),mode:await readConfig(paths.mode),profile:await readConfig(paths.profile)};}
 private async policy(){
  if(this.secrets.canEncrypt&&!this.secrets.canEncrypt()||this.secrets.persistent===false)throw conflict('系统安全存储不可用，无法保存原配置备份。');
  await (this.options.policy??(()=>checkClaudeDesktopPolicy(this.platform,this.env)))();
  if(this.platform==='win32'&&!this.options.directory&&this.env.APPDATA){const old=win32.join(this.env.APPDATA,'Claude-3p');try{await lstat(old);throw conflict('检测到旧版 Claude 数据目录，请先打开官方 Claude Desktop 完成迁移后重试。');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 }
 async status(){
  const journal=await this.journal(),state=await this.read(journal?.id??'00000000-0000-0000-0000-000000000000');
  const meta=parse(state.meta),mode=parse(state.mode);let unavailableReason='';try{await this.policy();}catch(e){unavailableReason=e instanceof Error?e.message:'无法检查 Claude Desktop 配置';}
  const active=journal&&journal.state!=='restored'?journal:null;
  const mappingUpdateRequired=!!active&&!active.direct&&claudeDesktopPlan(active.selections,{},active.fastModel).visible.some(item=>active.modelAliases?.[item.name]!==item.model);
  const selectorsMatch=!!active&&meta.appliedId===active.id&&!meta.hybridPointer&&mode.deploymentMode==='3p';
  let profileMatches=false;
  if(active&&state.profile!==null)try{profileMatches=isDeepStrictEqual(parse(state.profile),parse(active.after.profile));}catch{/* Invalid external profiles can still be explicitly reapplied. */}
  const configurationChanged=!!active&&active.state==='applied'&&(!selectorsMatch||!profileMatches);
  return {revision:digest(state),mode:mode.deploymentMode??'1p',connected:!active?.direct&&selectorsMatch&&profileMatches,apiDirect:active?.direct?{...active.direct,configured:selectorsMatch&&profileMatches}:null,configurationChanged,mappingUpdateRequired,backup:active?{state:active.state,createdAt:active.createdAt}:null,selections:active?.direct?[]:active?.selections??[],fastModel:active?.fastModel,keyId:active?.keyId,unavailableReason,pids:await (this.options.processes??claudeDesktopProcesses)()};
 }
 async check(revision:string){await this.policy();const state=await this.status();if(state.revision!==revision)throw conflict('Claude Desktop 配置已变化，请刷新后重试。');return state;}
 private async locked<T>(work:()=>Promise<T>){
  const lock=join(this.directory,'.tokenflow.lock');await safePath(lock);await mkdir(this.directory,{recursive:true,mode:0o700});let fd;try{fd=await open(lock,'wx',0o600);}catch{throw conflict('另一个 Claude Desktop 配置操作正在进行，请稍后重试。');}
  try{return await work();}finally{await fd.close();await rm(lock,{force:true});}
 }
 private async replace(id:string,before:Snapshot,after:Snapshot){
  const paths=this.paths(id);const done:(keyof Snapshot)[]=[];
  try{for(const key of ['profile','meta','mode'] as const){if(await readConfig(paths[key])!==before[key])throw conflict('Claude Desktop 配置被其他程序修改，已停止操作。');await writePrivate(paths[key],after[key]);done.push(key);}}
  catch(error){for(const key of done.reverse())if(await readConfig(paths[key])===after[key])await writePrivate(paths[key],before[key]);throw error;}
 }
 async connect(input:{revision:string;selections:ModelSelection[];fastModel?:string;keyId:string;key:string;origin:string;labels?:Record<string,string>;allowRunning?:boolean}){
  const selections=desktopSelections.parse(input.selections);
  let plan;try{plan=claudeDesktopPlan(selections,input.labels,input.fastModel);}catch(error){throw conflict(error instanceof Error?error.message:'Claude Desktop 模型过多。');}
  const origin=new URL(input.origin);if(origin.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(origin.hostname))throw conflict('Claude Desktop 接入只允许本机网关。');
  return this.applyProfile({...input,selections,name:'TokenFlow',modelAliases:plan.aliases,profile:{inferenceGatewayApiKey:input.key,inferenceGatewayAuthScheme:'bearer',inferenceGatewayBaseUrl:origin.origin,inferenceProvider:'gateway',inferenceModels:plan.visible.map(item=>({name:item.name,labelOverride:item.label,...(item.familyDefault?{anthropicFamilyTier:'sonnet',isFamilyDefault:true}:{})})),coworkEgressAllowedHosts:['*'],disableDeploymentModeChooser:true}});
 }
 async connectApi(input:{revision:string;selection:DirectApiSelection;allowRunning?:boolean}){
  const profile=claudeDesktopApiProfile(input.selection),{sourceId,name,model,baseURL}=input.selection;
  return this.applyProfile({revision:input.revision,allowRunning:input.allowRunning,name,selections:profile.inferenceModels.map(m=>({sourceId,model:m.name})),direct:{sourceId,name,model,baseURL},profile});
 }
 private async applyProfile(input:{revision:string;allowRunning?:boolean;name:string;selections:ModelSelection[];keyId?:string;direct?:z.infer<typeof directSchema>;fastModel?:string;modelAliases?:Record<string,string>;profile:Record<string,unknown>}){
  return this.locked(async()=>{
   await this.check(input.revision);if(!input.allowRunning&&(await (this.options.processes??claudeDesktopProcesses)()).length)throw conflict('请先完全退出 Claude Desktop，再应用模型配置。');
   const previous=await this.journal();if(previous?.state==='prepared')throw conflict('上次 Claude Desktop 接入未完成，请先切回官方后重试。');
   const active=previous?.state==='applied'?previous:null,id=active?.id??randomUUID(),before=await this.read(id);
   const meta=parse(before.meta);if(meta.entries!==undefined&&!Array.isArray(meta.entries))throw conflict('Claude Desktop 配置目录格式异常，未修改。');
   const entries=(meta.entries??[]).filter((e:any)=>e?.id!==id);entries.push({id,name:input.name});delete meta.hybridPointer;meta.appliedId=id;meta.entries=entries;
   const after={meta:encode(meta),mode:mergeFields(before.mode,{deploymentMode:'3p'}),profile:encode(input.profile)};
   const journal:Journal={directory:this.directory,id,before:active?.before??before,after,rollback:before,keyId:input.keyId,direct:input.direct,selections:input.selections,fastModel:input.fastModel,modelAliases:input.modelAliases,state:'prepared',createdAt:active?.createdAt??new Date().toISOString()};await this.save(journal);
   try{await this.replace(id,before,after);journal.state='applied';await this.save(journal);}catch(error){if(digest(await this.read(id))===digest(before)){if(previous)await this.save(previous);else await this.secrets.set(secretName,'');}throw error;}
   return this.status();
  });
 }
 async detachSource(sourceId:string){
  const journal=await this.journal();if(!journal||journal.state!=='applied'||!journal.selections.some(item=>item.sourceId===sourceId))return;
  if(journal.direct){await this.restore((await this.status()).revision,'native',true);return;}
  const selections=journal.selections.filter(item=>item.sourceId!==sourceId),status=await this.status();
  if(!selections.length){await this.restore(status.revision,'native',true);return;}
  const profile=parse(journal.after.profile);
  const labels=Object.fromEntries((profile.inferenceModels??[]).map((item:any)=>[journal.modelAliases?.[item.name]??item.name,item.labelOverride??item.name]));
  await this.connect({revision:status.revision,selections,fastModel:selections.some(item=>item.model===journal.fastModel)?journal.fastModel:undefined,keyId:journal.keyId!,key:profile.inferenceGatewayApiKey,origin:profile.inferenceGatewayBaseUrl,labels,allowRunning:true});
 }
 async restore(revision:string,destination:'previous'|'native'='previous',allowRunning=false){return this.locked(async()=>{
  await this.check(revision);if(!allowRunning&&(await (this.options.processes??claudeDesktopProcesses)()).length)throw conflict('请先完全退出 Claude Desktop，再停用网关。');
  const journal=await this.journal();if(!journal||journal.state==='restored')throw conflict('没有 Claude Desktop 接入备份。');
  const current=await this.read(journal.id),meta=parse(current.meta),mode=parse(current.mode);
  const partial=journal.state==='prepared'&&(['meta','mode','profile'] as const).every(k=>current[k]===journal.after[k]||current[k]===(journal.rollback??journal.before)[k]);
  if(destination==='previous'&&!partial&&(digest(fields(meta))!==digest(fields(parse(journal.after.meta)))||mode.deploymentMode!==parse(journal.after.mode).deploymentMode||current.profile!==journal.after.profile))throw conflict('Claude Desktop 配置已被客户端修改，原备份已保留，未覆盖。');
  const originalMeta=parse(journal.before.meta),originalMode=parse(journal.before.mode);
  const merged=parse(mergeFields(current.meta,destination==='native'?{appliedId:null,hybridPointer:null}:fields(originalMeta)));if(Array.isArray(merged.entries)){merged.entries=merged.entries.filter((e:any)=>e?.id!==journal.id);if(!merged.entries.length&&originalMeta.entries===undefined)delete merged.entries;}
  const restoredMode=mergeFields(current.mode,{deploymentMode:destination==='native'?'1p':originalMode.deploymentMode??null});
  const after:Snapshot={meta:Object.keys(merged).length?encode(merged):journal.before.meta===null?null:'{}\n',mode:journal.before.mode===null&&!Object.keys(parse(restoredMode)).length?null:restoredMode,profile:destination==='native'?null:journal.before.profile};
  journal.rollback=current;journal.after=after;journal.restoring=true;journal.state='prepared';await this.save(journal);await this.replace(journal.id,current,after);journal.state='restored';await this.save(journal);return this.status();
 });}
}
