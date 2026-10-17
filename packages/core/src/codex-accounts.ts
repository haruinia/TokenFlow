import { mkdir, writeFile, rename, unlink, open, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';
import { agentProcesses, readConfig, safePath, officialCodexModel } from './agent-connections.js';
import { migrationBinary, runtimeLaunch } from './codex-runtime.js';
import type {NativeUsageLogin} from './native-usage-logins.js';

const conflict=(message:string)=>Object.assign(new Error(message),{statusCode:409});
const run=promisify(execFile);

/** Administrator layers that override config.toml in Codex's config loader: system files and macOS MDM. */
export async function managedCodexConfigs(platform=process.platform):Promise<string[]>{
  const layers:string[]=[];
  if(platform!=='win32')for(const path of ['/etc/codex/managed_config.toml','/etc/codex/requirements.toml'])try{layers.push(await readFile(path,'utf8'));}catch{/* Not managed. */}
  if(platform==='darwin')for(const key of ['config_toml_base64','requirements_toml_base64'])try{layers.push(Buffer.from((await run('/usr/bin/defaults',['read','com.openai.codex',key],{timeout:5000})).stdout.trim(),'base64').toString('utf8'));}catch{/* No MDM profile. */}
  return layers;
}
function forcedStore(layers:string[]){
  for(const raw of layers){try{const value=parse(raw).cli_auth_credentials_store;if(typeof value==='string'&&value!=='file')return value;}catch{/* Unparseable layers are Codex's to report. */}}
  return null;
}
export type CodexLoginCheck='ok'|'failed'|'unavailable';
/** `codex login status` only names the login method, so it proves Codex reads a ChatGPT login, not which account. */
export async function codexLoginStatus(home:string):Promise<CodexLoginCheck>{
  let launch;try{launch=await runtimeLaunch(await migrationBinary());}catch{return 'unavailable';}
  const signedIn=(output:string)=>/Logged in using ChatGPT/.test(output);
  try{const {stdout,stderr}=await run(launch.file,[...launch.args,'login','status'],{env:{...process.env,...launch.env,CODEX_HOME:home},timeout:15000,windowsHide:true});return signedIn(stdout+stderr)?'ok':'failed';}
  catch(error){const output=String((error as {stdout?:unknown}).stdout??'')+String((error as {stderr?:unknown}).stderr??'');return signedIn(output)?'ok':output.trim()?'failed':'unavailable';}
}
const loginCheckMessage:Record<CodexLoginCheck,string>={
  ok:'',
  failed:'切换后 codex login status 没有读到 ChatGPT 登录，Codex 可能被配置为钥匙串等其他凭据存储。请在 Codex 里确认登录，必要时点「恢复原登录」。',
  unavailable:'未找到官方 Codex 程序，未做切换后的登录核验。',
};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const token=z.string().min(1).max(20000);
const credential=z.object({access_token:token,refresh_token:token,id_token:token,account_id:z.string().min(1),last_refresh:z.string().optional()});
const journalSchema=z.object({before:z.object({auth:z.string().nullable(),config:z.string().nullable()}),after:z.object({auth:z.string(),config:z.string()}),accountId:z.string(),createdAt:z.string(),state:z.enum(['prepared','applied','restored'])});
type Journal=z.infer<typeof journalSchema>;
function identity(auth:string|null){try{const value=JSON.parse(auth??'{}');return typeof value.tokens?.account_id==='string'?value.tokens.account_id:null;}catch{return null;}}
function tokenEmail(token:unknown){try{const claims=JSON.parse(Buffer.from(String(token).split('.')[1],'base64url').toString());return typeof claims.email==='string'?claims.email:null;}catch{return null;}}
function email(auth:string|null){try{return tokenEmail(JSON.parse(auth??'{}').tokens.id_token);}catch{return null;}}
// account_id is the ChatGPT workspace, shared by everyone in a team; the email tells members apart.
const sameLogin=(auth:string|null,accountId:string,mail:string|null)=>identity(auth)===accountId&&email(auth)===mail;

const ownedFields=['model','model_provider','cli_auth_credentials_store','profile'] as const;
function sameValue(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
  const x=a as Record<string,unknown>,y=b as Record<string,unknown>;
  return Object.keys(x).length===Object.keys(y).length&&Object.keys(x).every(k=>Object.hasOwn(y,k)&&sameValue(x[k],y[k]));
}
function nativeRouting(config:Record<string,unknown>){
  return (config.model_provider??'openai')==='openai'&&(config.cli_auth_credentials_store??'file')==='file'&&!config.profile;
}
function restoredConfig(current:string|null,journal:Journal){
  const now=parse(current??''),after=parse(journal.after.config),before=parse(journal.before.config??'');
  const rest=(value:Record<string,unknown>)=>Object.fromEntries(Object.entries(value).filter(([k])=>!ownedFields.includes(k as typeof ownedFields[number])));
  if(sameValue(rest(now),rest(after)))return journal.before.config;
  // Restore only fields this module owns; keep new projects, preferences, MCP settings, etc.
  for(const key of ownedFields){if(Object.hasOwn(before,key))now[key]=before[key];else delete now[key];}
  return stringify(now);
}

/** Native file login is independent of the gateway pool. The keyring is left intact for rollback. */
export class CodexAccounts {
  private authPath:string;
  private backupPath:string;
  private managedCache?:{at:number;store:Promise<string|null>};
  constructor(private root:string,private configPath:string,private processes=()=>agentProcesses('codex'),
    private checks:{managed?:()=>Promise<string[]>;loginStatus?:(home:string)=>Promise<CodexLoginCheck>}={}){
    this.authPath=join(dirname(configPath),'auth.json');
    this.backupPath=join(root,'codex-account-backup.json');
  }
  /** A store forced above config.toml makes the auth.json written on switch invisible to Codex. */
  private managedStore(){
    if(!this.managedCache||Date.now()-this.managedCache.at>60000)this.managedCache={at:Date.now(),store:(this.checks.managed??managedCodexConfigs)().then(forcedStore,()=>null)};
    return this.managedCache.store;
  }
  private async files(){return {auth:await readConfig(this.authPath),config:await readConfig(this.configPath)};}
  private async journal():Promise<Journal|null>{const raw=await readConfig(this.backupPath);if(raw===null)return null;try{return journalSchema.parse(JSON.parse(raw));}catch{throw conflict('账号切换备份无法读取，请保留备份并检查。');}}
  private async write(path:string,value:string|null){
    await safePath(path);
    if(value===null){await rm(path,{force:true});return;}
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    const temp=`${path}.${randomUUID()}.tmp`;
    try{await writeFile(temp,value,{mode:0o600,flag:'wx'});await rename(temp,path);}finally{await rm(temp,{force:true});}
  }
  private save(value:Journal){return this.write(this.backupPath,JSON.stringify(value));}
  async usageLogin():Promise<NativeUsageLogin|null>{
    const files=await this.files(),base=parse(files.config??'');
    const profile=typeof base.profile==='string'?(base.profiles as Record<string,Record<string,unknown>>|undefined)?.[base.profile]:undefined;
    if(base.profile&&!profile)return null;
    const config={...base,...profile},auth=JSON.parse(files.auth??'{}'),accountId=identity(files.auth);
    const mail=email(files.auth);
    if((config.cli_auth_credentials_store??'file')!=='file'||(config.model_provider??'openai')!=='openai'||config.openai_base_url||config.model_providers&&typeof config.model_providers==='object'&&'openai' in config.model_providers||auth.auth_mode&&auth.auth_mode!=='chatgpt'||auth.OPENAI_API_KEY||!auth.tokens?.access_token||!accountId||!mail)return null;
    return {provider:'codex',accountId,email:mail};
  }
  async status(){
    const files=await this.files();let config:Record<string,unknown>;
    try{config=parse(files.config??'');}catch{throw conflict('Codex 配置格式无效，未修改。');}
    const journal=await this.journal();
    const storage=String(config.cli_auth_credentials_store??'file');
    const fileActive=storage==='file';
    let auth:{auth_mode?:unknown;OPENAI_API_KEY?:unknown;tokens?:{access_token?:unknown}}={};let readError='';
    try{auth=JSON.parse(files.auth??'{}');if(!auth||typeof auth!=='object'||Array.isArray(auth))throw Error();}catch{auth={};readError='Codex 登录文件格式无效，请在客户端重新登录。';}
    if(!fileActive)readError='Codex 当前使用系统钥匙串或自动凭据存储，暂不能确认本机登录；可在此页重新授权。';
    const managed=await this.managedStore();
    if(managed)readError=`Codex 被管理员配置强制用「${managed}」方式保存登录，TokenFlow 无法切换本机登录。`;
    const signedIn=fileActive&&!readError&&(!auth.auth_mode||auth.auth_mode==='chatgpt')&&!auth.OPENAI_API_KEY&&typeof auth.tokens?.access_token==='string'&&!!auth.tokens.access_token.trim()&&!!identity(files.auth);
    const loginState=readError?'unreadable' as const:signedIn?'signed-in' as const:'signed-out' as const;
    return {revision:digest(files),accountId:signedIn?identity(files.auth):null,email:signedIn?email(files.auth):null,loginState,readError,storage,model:typeof config.model==='string'?config.model:null,provider:typeof config.model_provider==='string'?config.model_provider:'openai',pids:await this.processes(),backup:journal&&journal.state!=='restored'?{createdAt:journal.createdAt,state:journal.state}:null};
  }
  private async locked<T>(operation:()=>Promise<T>){
    await safePath(this.configPath);await mkdir(dirname(this.configPath),{recursive:true,mode:0o700});
    // Share the A2A lock: these features both own config.toml writes.
    const lock=`${this.configPath}.token-flow.lock`;let handle;
    try{handle=await open(lock,'wx',0o600);}catch{throw conflict('另一个配置操作正在进行，请稍后重试。');}
    try{return await operation();}finally{await handle.close();await unlink(lock);}
  }
  private async check(revision:string,allowRunning:boolean){
    if(digest(await this.files())!==revision)throw conflict('本机登录或配置已变化，请刷新后重试。');
    const pids=await this.processes();if(pids.length&&!allowRunning)throw conflict('检测到 Codex 仍在运行，请确认切换后重启。');
  }
  async checkSwitch(input:{revision:string;allowRunning:boolean;model:string},raw:unknown){
    await this.check(input.revision,input.allowRunning);
    const c=credential.safeParse(raw);if(!c.success)throw conflict('账号缺少完整 OAuth 凭据，请重新授权。');
    if(!/^codex\/[a-zA-Z0-9._-]+$/.test(input.model)||/(?:gpt-image-|codex-auto-review)/.test(input.model))throw conflict('请选择 Codex 支持的模型。');
    if((await this.journal())?.state==='prepared')throw conflict('上次切换尚未完成，请先还原原登录。');
    const managed=await this.managedStore();
    if(managed)throw conflict(`Codex 被管理员配置强制用「${managed}」方式保存登录，写入的登录文件不会生效，未切换。`);
    const config=parse((await this.files()).config??'');
    if(config.forced_login_method&&config.forced_login_method!=='chatgpt')throw conflict('Codex 配置限制了登录方式，请先解除该限制。');
    if(config.forced_chatgpt_workspace_id&&config.forced_chatgpt_workspace_id!==c.data.account_id)throw conflict('所选账号与 Codex 限定的工作空间不一致。');
    if(config.model_providers&&typeof config.model_providers==='object'&&'openai' in config.model_providers)throw conflict('OpenAI 提供商有自定义覆盖，请先检查接口配置，未写入登录凭据。');
    return c.data;
  }
  async switch(input:{revision:string;allowRunning:boolean;model:string},raw:unknown){
    return this.locked(async()=>{
      let c=await this.checkSwitch(input,raw);
      const before=await this.files();let previous=await this.journal();
      if(previous?.state==='prepared')throw conflict('上次切换尚未完成，请先还原原登录。');
      // Login or config changed outside token-flow since the last switch: the current state becomes the new original.
      if(previous?.state==='applied'&&(!nativeRouting(parse(before.config??''))||!sameLogin(before.auth,previous.accountId,email(previous.after.auth))))previous=null;
      // Prefer the running client's refreshed tokens when selecting the same native account.
      if(sameLogin(before.auth,c.account_id,tokenEmail(c.id_token))){const native=credential.safeParse(JSON.parse(before.auth!).tokens);if(native.success)c={...native.data,last_refresh:JSON.parse(before.auth!).last_refresh??undefined};}
      const config=parse(before.config??'');
      config.model=input.model.slice('codex/'.length);config.model_provider='openai';config.cli_auth_credentials_store='file';delete config.profile;
      const after={auth:JSON.stringify({auth_mode:'chatgpt',OPENAI_API_KEY:null,tokens:{access_token:c.access_token,refresh_token:c.refresh_token,id_token:c.id_token,account_id:c.account_id},last_refresh:c.last_refresh??null},null,2)+'\n',config:stringify(config)};
      // Retain the original login across repeated A -> B switches.
      const journal:Journal={before:previous?.state==='applied'?{...previous.before,config:restoredConfig(before.config,previous)}:before,after,accountId:c.account_id,createdAt:new Date().toISOString(),state:'prepared'};
      await this.save(journal);
      try{
        await this.check(input.revision,input.allowRunning);
        await this.write(this.authPath,after.auth);
        if((await readConfig(this.configPath))!==before.config)throw conflict('配置被其他程序修改，已停止切换。');
        await this.write(this.configPath,after.config);
        journal.state='applied';await this.save(journal);
      }catch(error){
        // Roll back only bytes we wrote. Do not overwrite a concurrent external edit.
        if(await readConfig(this.authPath)===after.auth)await this.write(this.authPath,before.auth);
        if(await readConfig(this.configPath)===after.config)await this.write(this.configPath,before.config);
        if(digest(await this.files())===digest(before)){if(previous)await this.save(previous);else await this.write(this.backupPath,null);}
        throw error;
      }
      const check=await (this.checks.loginStatus??codexLoginStatus)(dirname(this.configPath));
      return {...await this.status(),message:loginCheckMessage[check]||undefined};
    });
  }
  async restoreModel(){
    const journal=await this.journal();if(!journal)return undefined;
    return officialCodexModel(this.configPath,journal.before.config,journal.before.auth);
  }
  async restore(input:{revision:string;allowRunning:boolean}){
    return this.locked(async()=>{
      await this.check(input.revision,input.allowRunning);
      const journal=await this.journal();if(!journal||journal.state==='restored')throw conflict('没有可还原的账号切换备份。');
      const current=await this.files();
      // Refreshed tokens for the same account are expected; a different native login is not.
      if(!sameValue(parse(current.config??''),parse(journal.before.config??''))&&!nativeRouting(parse(current.config??''))||current.auth!==journal.before.auth&&!sameLogin(current.auth,journal.accountId,email(journal.after.auth)))throw conflict('本机登录或配置已有其他修改，已保留备份，未覆盖。');
      await this.write(this.authPath,journal.before.auth);
      await this.write(this.configPath,restoredConfig(current.config,journal));
      journal.state='restored';await this.save(journal);
      return this.status();
    });
  }
}
export type CodexAccountStatus=Awaited<ReturnType<CodexAccounts['status']>>;
