import {nativeQoderCredential,verifyNativeQoder} from './qoder-credentials.js';
import {workbuddyLoginDomain,workbuddyLoginTarget} from './workbuddy-region.js';
import {readFile,writeFile,rename,rm,mkdir,open,lstat,rmdir,utimes} from 'node:fs/promises';
import {dirname,basename,join,win32,posix} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {safePath} from './agent-connections.js';
import {nativeConflict as conflict,nativeDigest as digest} from './native-accounts.js';
import type {Secrets} from './service.js';
import {CredentialAccessStaleError,RevisionCredentialAccess} from './revision-credential-access.js';

export type DesktopProvider='workbuddy'|'workbuddy-ai'|'qoder';
export const desktopPoolProvider=(provider:DesktopProvider)=>provider==='workbuddy-ai'?'workbuddy':provider;
export type QoderCrypto=(operation:'encrypt'|'decrypt',value:string)=>Promise<string>;
export const desktopCredentialSchema=z.object({access_token:z.string().min(1).max(30000),refresh_token:z.string().min(1).max(30000),uid:z.union([z.string().min(1),z.number()]).transform(String),expired:z.string().refine(v=>Date.parse(v)>Date.now()+60000),email:z.string().optional(),enterprise_id:z.string().optional(),domain:z.string().optional()});
export {workbuddyLoginDomain,workbuddyLoginTarget} from './workbuddy-region.js';
export const workbuddyLoginIssue=(domain?:string,target:DesktopProvider='workbuddy')=>!workbuddyLoginTarget(domain)?'该 WorkBuddy 登录区域尚不支持自动切换。':workbuddyLoginTarget(domain)!==target?`请使用 ${workbuddyLoginTarget(domain)==='workbuddy-ai'?'WorkBuddyAI 国际版':'WorkBuddy 国内版'} 切换此账号。`:'';
type Credential=z.infer<typeof desktopCredentialSchema>;
type Identity={accountId:string;email?:string;displayName?:string;domain?:string;enterpriseId?:string};
type Snapshot={data:string|null;logout:string|null};
const snapshotSchema=z.object({data:z.string().max(3_000_000).nullable(),logout:z.string().max(3_000_000).nullable()});
const journalSchema=z.object({path:z.string().min(1),before:snapshotSchema,after:snapshotSchema,identity:z.object({accountId:z.string().min(1),email:z.string().optional(),displayName:z.string().optional(),domain:z.string().optional(),enterpriseId:z.string().optional()}),state:z.enum(['prepared','applied','restored']),createdAt:z.string()});
type Journal=z.infer<typeof journalSchema>;
export type DesktopAccountOptions={paths?:Partial<Record<DesktopProvider,string>>;crypto?:QoderCrypto;fetch?:typeof fetch;platform?:NodeJS.Platform};
export function desktopLoginPaths(platform:NodeJS.Platform=process.platform,home=homedir(),env:NodeJS.ProcessEnv=process.env){
 const p=platform==='win32'?win32:posix;
 const base=platform==='win32'?(env.APPDATA||p.join(home,'AppData','Roaming')):platform==='darwin'?p.join(home,'Library','Application Support'):(env.XDG_CONFIG_HOME||p.join(home,'.config'));
 const shared=platform==='win32'?(env.LOCALAPPDATA||p.join(home,'AppData','Local')):platform==='darwin'?base:(env.XDG_DATA_HOME||p.join(home,'.local','share'));
 const workbuddy=(file:string)=>['CodeBuddyExtension','WorkBuddyExtension'].map(name=>p.join(shared,name,'Data','Public','auth',file));
 return {qoder:[p.join(base,'com.qoder.app.stable','auth.v1.dat')],workbuddy:workbuddy('workbuddy-desktop.info'),'workbuddy-ai':workbuddy('workbuddy-desktop-ai.info')};
}
async function read(path:string){await safePath(path);try{const info=await lstat(path);if(!info.isFile()||info.size>2*1024*1024)throw conflict('登录文件格式或大小异常，未修改。');return (await readFile(path)).toString('base64');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
async function write(path:string,value:string|null){await safePath(path);if(value===null){await rm(path,{force:true});return;}await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=`${path}.${randomUUID()}.tmp`;try{await writeFile(temp,Buffer.from(value,'base64'),{mode:0o600,flag:'wx'});await rename(temp,path);}finally{await rm(temp,{force:true});}}
const json=(value:string)=>JSON.parse(Buffer.from(value,'base64').toString('utf8'));
const encoded=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64');
const equalIdentity=(a:Identity|null,b:Identity)=>!!a&&a.accountId===b.accountId&&((a.domain??'')===(b.domain??'')||!!a.domain&&!!b.domain&&!!workbuddyLoginTarget(a.domain)&&workbuddyLoginTarget(a.domain)===workbuddyLoginTarget(b.domain))&&(a.enterpriseId??'')===(b.enterpriseId??'');

/** Keeps the original native bytes in the OS-encrypted TokenFlow credential store. */
export class DesktopAccounts {
 private busy=false;
 private name:string;
 private credentialAccess=new RevisionCredentialAccess<Record<string,any>>();
 constructor(readonly provider:DesktopProvider,private secrets:Secrets,private processes:()=>Promise<number[]>,private options:DesktopAccountOptions={}){this.name=`native-login-${provider}`;}
 private async path(){
  if(this.options.paths?.[this.provider])return this.options.paths[this.provider]!;
  const paths=desktopLoginPaths(this.options.platform)[this.provider],existing=[];
  for(const path of paths)if(await read(path)!==null||this.provider!=='qoder'&&await read(`${path}.logged-out`)!==null)existing.push(path);
  if(existing.length>1)throw conflict('检测到多个官方登录目录，请先确认正在使用的安装版本。');
  return existing[0]??paths[0]!;
 }
 private async snapshot(path:string):Promise<Snapshot>{return {data:await read(path),logout:this.provider!=='qoder'?await read(`${path}.logged-out`):null};}
 private async write(path:string,state:Snapshot){await write(path,state.data);if(this.provider!=='qoder')await write(`${path}.logged-out`,state.logout);}
 private async journal(retry=false):Promise<Journal|null>{const raw=await this.secrets.get(this.name,{retry});if(!raw)return null;try{return journalSchema.parse(JSON.parse(raw));}catch{throw conflict('原登录备份无法读取，已保留备份，请检查系统安全存储。');}}
 private async save(journal:Journal){await this.secrets.set(this.name,JSON.stringify(journal));}
 private async qoderDocument(options?:{retry?:boolean;fresh?:boolean},expected?:Snapshot){
  return this.credentialAccess.read(async()=>{
   const state=await this.snapshot(await this.path());
   if(expected&&digest(state)!==digest(expected))throw new CredentialAccessStaleError();
   if(!state.data){this.credentialAccess.invalidate();throw conflict('未找到 Qoder 本机登录。');}
   return {revision:digest(state.data),input:state.data};
  },async data=>{const value=JSON.parse(await this.options.crypto!('decrypt',data));if(value.schemaVersion!==1)throw conflict('Qoder 本机登录格式不受支持，请在账号授权页连接账号。');return value;},{mode:options?.fresh?'fresh':options?.retry?'retry':'cached'});
 }
 private async identity(state:Snapshot,decrypt=false,options?:{retry?:boolean;fresh?:boolean}):Promise<Identity|null>{
  if(!state.data||state.logout!==null)return null;
  try{
   if(this.provider!=='qoder'){const s=json(state.data);if(!s.account?.uid)return null;const text=(v:unknown)=>typeof v==='string'&&v.trim()?v.trim():undefined;return {accountId:String(s.account.uid),displayName:text(s.account.nickname)??text(s.account.displayName),email:text(s.account.email),domain:workbuddyLoginDomain(s.auth?.domain),enterpriseId:s.account.enterpriseId??''};}
   if(!decrypt||!this.options.crypto)return null;
   const s=await this.qoderDocument(options,state);
   if(!s.user?.id){if(!s.user&&!s.token&&!s.refreshToken)return null;throw Error();}
   return {accountId:String(s.user.id),email:typeof s.user.email==='string'?s.user.email:undefined,displayName:typeof s.user.name==='string'?s.user.name:undefined};
  }catch{if(decrypt)throw conflict('无法确认客户端现有登录，未覆盖原文件。请检查客户端版本或系统钥匙串。');return null;}
 }
 async importCredential(options?:{retry?:boolean}){
  if(this.provider!=='qoder'){
   const state=await this.snapshot(await this.path());if(!state.data||state.logout!==null)throw conflict('未找到 WorkBuddy 本机登录，请先在对应客户端登录。');
   let raw:any;try{raw=json(state.data);}catch{throw conflict('WorkBuddy 本机登录文件无法读取。');}
   const identity=await this.identity(state),auth=raw.auth;
   if(!identity||!auth||workbuddyLoginTarget(auth.domain)!==this.provider)throw conflict('WorkBuddy 本机账号身份或区域不完整，请在客户端确认登录。');
   if(typeof auth.accessToken!=='string'||auth.refreshToken&&typeof auth.refreshToken!=='string')throw Object.assign(conflict('此版本 WorkBuddy 使用客户端专属加密，无法直接读取令牌；若账号池没有同一账号的可用授权，请在 TokenFlow 添加账号授权。'),{code:'NATIVE_PROTECTED'});
   if(!auth.accessToken.trim())throw conflict('WorkBuddy 本机令牌为空，请在客户端确认登录。');
   const expires=typeof auth.expiresAt==='number'?new Date(auth.expiresAt>1e11?auth.expiresAt:auth.expiresAt*1000):new Date(auth.expiresAt??NaN);
   return {access_token:auth.accessToken,refresh_token:auth.refreshToken??'',uid:identity.accountId,email:identity.email??'',enterprise_id:identity.enterpriseId??'',domain:identity.domain,token_type:'Bearer',...(Number.isFinite(expires.getTime())?{expired:expires.toISOString()}:{})};
  }
  if(!this.options.crypto)throw conflict('请使用 TokenFlow 桌面版读取 Qoder 本机授权。');
  if(process.env.QODER_PERSONAL_ACCESS_TOKEN||process.env.QODER_PRODUCT_CATALOG_PATH)throw conflict('检测到 Qoder 环境覆盖，请移除后再导入本机登录。');
  let value:Record<string,unknown>;try{value=await this.qoderDocument(options);}catch{throw conflict('无法读取 Qoder 本机登录，请检查系统安全存储后重试。');}
  return verifyNativeQoder(nativeQoderCredential(value),this.options.fetch);
 }
 private support(){
  if(!['darwin','win32'].includes(this.options.platform??process.platform))return '此系统暂不支持自动切换官方登录，请在客户端内登录。';
  if(this.secrets.canEncrypt?.()===false)return '系统安全存储不可用，请解锁后再切换登录。';
  if(this.secrets.persistent===false)return '当前未启用持久化安全存储，无法备份原登录。';
  if(this.provider==='qoder'&&!this.options.crypto)return '请使用 TokenFlow 桌面版切换 Qoder 登录。';
  if(this.provider==='qoder'&&(process.env.QODER_PERSONAL_ACCESS_TOKEN||process.env.QODER_PRODUCT_CATALOG_PATH))return '检测到 Qoder 环境覆盖，请移除覆盖后再切换官方登录。';
  return '';
 }
 /** Usage observation never imports credentials or reads TokenFlow login backups.
  * Qoder decryption is available only after the startup security-store choice. */
 async usageLogin(){
  const state=await this.snapshot(await this.path());let identity=await this.identity(state);
  if(!state.data)this.credentialAccess.invalidate();
  if(!identity&&this.provider==='qoder'&&this.options.crypto)identity=await this.identity(state,true);
  if(!identity||this.provider!=='qoder'&&workbuddyLoginTarget(identity.domain)!==this.provider)return null;
  return {provider:this.provider,accountId:identity.accountId,email:identity.email??null,displayName:identity.displayName,...(identity.enterpriseId?{organizationId:identity.enterpriseId}:{})};
 }
 async status(refresh=false){const path=await this.path(),state=await this.snapshot(path),journal=await this.journal(refresh);
  if(!state.data)this.credentialAccess.invalidate();
  let identity=await this.identity(state)??(journal&&journal.state!=='restored'&&journal.path===path&&digest(state)===digest(journal.after)?journal.identity:null),readError='';
  if(!identity&&state.data&&state.logout===null&&this.provider==='qoder'){
   if(!this.options.crypto)readError='现有登录需要通过 TokenFlow 桌面版读取。';
   else{try{identity=await this.identity(state,true,{retry:refresh});}catch{readError='现有登录暂不可读取，请检查客户端版本与系统安全存储后刷新。';}}
  }
  if(!identity&&state.data&&state.logout===null&&!readError&&this.provider!=='qoder')readError='检测到登录文件，但暂时无法确认账号。';
  return {revision:digest(state),...identity,loginState:identity?'signed-in' as const:readError?'unreadable' as const:'signed-out' as const,readError,pids:await this.processes(),backup:journal&&journal.state!=='restored'?{state:journal.state,createdAt:journal.createdAt}:null,unavailableReason:this.support()};
 }
 private async request(url:string,token:string,headers:Record<string,string>={}){
  try{const response=await (this.options.fetch??fetch)(url,{headers:{Accept:'application/json',Authorization:`Bearer ${token}`,...headers},redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error();return await response.json();}
  catch{throw conflict('官方客户端未接受此账号凭据，未更改本机登录。请刷新或重新授权后重试。');}
 }
 async prepare(raw:unknown):Promise<{data:string;identity:Identity}>{
  const reason=this.support();if(reason)throw conflict(reason);
  const parsed=desktopCredentialSchema.safeParse(raw);if(!parsed.success)throw conflict('登录凭据不完整或即将过期，请刷新账号或重新授权。');const c:Credential=parsed.data;
  if(this.provider==='qoder'){
   const u=await this.request('https://openapi.qoder.sh/api/v1/userinfo',c.access_token),id=String(u.id??u.user_id??u.uid??'');
   if(!id||id!==c.uid)throw conflict('Qoder 官方账号身份与所选账号不一致，未切换。');
   const user={id,name:u.name??u.username??u.user_name??null,email:u.email??'',phone:u.security_mobile??null,avatarUrl:u.avatar_url??u.avatar??u.image_url??null};
   const data=await this.options.crypto!('encrypt',JSON.stringify({schemaVersion:1,token:c.access_token,refreshToken:c.refresh_token,expiresAt:c.expired,user}));
   return {data,identity:{accountId:id,email:user.email}};
  }
  const domain=workbuddyLoginDomain(c.domain),issue=workbuddyLoginIssue(domain,this.provider);
  if(issue)throw conflict(issue);
  const response=await this.request(`https://${this.provider==='workbuddy-ai'?'www.workbuddy.ai':'www.workbuddy.cn'}/v2/plugin/accounts`,c.access_token,{'X-Domain':domain});
  const allAccounts=response?.data?.accounts;
  if(!Array.isArray(allAccounts))throw conflict('WorkBuddy 未返回有效账号列表，未更改登录。');
  const matches=allAccounts.filter(a=>String(a.uid)===c.uid&&(a.enterpriseId??'')===(c.enterprise_id??''));
  if(matches.length!==1||!matches[0].pluginEnabled)throw conflict('无法唯一确认 WorkBuddy 的个人或企业身份，请在官方客户端确认授权。');
  const account=matches[0],expiresAt=Date.parse(c.expired);
  // Native FileAuthenticationStorage accepts legacy strings and migrates them to protected fields on startup.
  const session={account,accounts:allAccounts.filter(a=>a.pluginEnabled),allAccounts,auth:{accessToken:c.access_token,refreshToken:c.refresh_token,expiresAt,expiresIn:Math.floor((expiresAt-Date.now())/1000),lastRefreshTime:Date.now(),tokenType:'Bearer',domain}};
  return {data:encoded(session),identity:{accountId:c.uid,domain,enterpriseId:account.enterpriseId??'',...(typeof account.nickname==='string'?{displayName:account.nickname}:{}),...(typeof account.email==='string'?{email:account.email}:{})}};
 }
 async check(revision:string,restore=false){const reason=this.support();if(reason)throw conflict(reason);const path=await this.path(),state=await this.snapshot(path);if(digest(state)!==revision)throw conflict('本机登录已变化，请刷新后重试。');const journal=await this.journal();
  if(restore&&(!journal||journal.state==='restored'||journal.path!==path))throw conflict('没有可恢复的原登录备份。');
  if(journal&&journal.state!=='restored'){
   if(journal.path!==path)throw conflict('官方登录目录已变化，请保留原备份并检查安装版本。');
   // A new explicit Qoder switch may replace any readable current login or logout.
   // Restoring the original backup still requires ownership of the current state.
   if(this.provider==='qoder'&&!restore){if(state.data)await this.identity(state,true,{fresh:true});return;}
   if(!(restore&&(state.data===null||state.logout!==null))&&!(journal.state==='prepared'&&digest(state)===digest(journal.before))&&digest(state)!==digest(journal.after)&&!equalIdentity(await this.identity(state,true,{fresh:true}),journal.identity))throw conflict('客户端已登录其他账号或退出登录，未覆盖当前状态。请先在客户端恢复上次切换的账号。');
  }else if(this.provider==='qoder'&&state.data)await this.identity(state,true,{fresh:true});
 }
 async apply(revision:string,prepared:{data:string;identity:Identity}|null,releaseGateway:()=>Promise<unknown>=async()=>{}){
  if(this.busy)throw conflict('账号正在切换，请稍候。');this.busy=true;
  let handle;let lockPath='';let ownsLock=false;let heartbeat:ReturnType<typeof setInterval>|undefined;let lostLease=false;let lockIdentity:{ino:number;birthtimeMs:number}|undefined;
  const checkLease=async()=>{const current=await lstat(lockPath);if(lostLease||current.ino!==lockIdentity?.ino||current.birthtimeMs!==lockIdentity?.birthtimeMs)throw conflict('客户端登录锁已变化，已停止写入。');};
  try{
   const path=await this.path();lockPath=this.provider==='qoder'?join(dirname(path),'auth.v1.lock'):join(dirname(path),`.${basename(path)}.workbuddy.lock`);
   await safePath(lockPath);await mkdir(dirname(path),{recursive:true,mode:0o700});
   try{if(this.provider==='qoder')handle=await open(lockPath,'wx',0o600);else await mkdir(lockPath,{mode:0o700});ownsLock=true;}catch{throw conflict('客户端登录文件正在使用，请稍后重试。');}
   lockIdentity=await lstat(lockPath);
   heartbeat=setInterval(()=>{void (async()=>{await checkLease();const now=new Date();await utimes(lockPath,now,now);})().catch(()=>{lostLease=true;});},1000);heartbeat.unref();
   if((await this.processes()).length)throw conflict('客户端尚未完全退出，未更改登录。');
   await this.check(revision,!prepared);
   const current=await this.snapshot(path),previous=await this.journal();
   const after=prepared?{data:prepared.data,logout:null}:previous!.before;
   const journal:Journal={path,before:previous&&previous.state!=='restored'?previous.before:current,after,identity:prepared?.identity??previous!.identity,state:'prepared',createdAt:previous&&previous.state!=='restored'?previous.createdAt:new Date().toISOString()};
   await this.save(journal);
   try{
    if(digest(await this.snapshot(path))!==revision||(await this.processes()).length)throw conflict('客户端状态已变化，未应用登录。');
    await checkLease();this.credentialAccess.invalidate();await this.write(path,after);this.credentialAccess.invalidate();
    await releaseGateway();
    journal.state=prepared?'applied':'restored';await this.save(journal);
   }catch(error){
    // Roll back only our own bytes; a concurrent external login is never overwritten.
    const now=await this.snapshot(path);
    if(!lostLease&&!(await this.processes()).length&&(digest(now)===digest(current)||digest(now)===digest(after)||now.data===after.data&&now.logout===current.logout)){
     await checkLease();this.credentialAccess.invalidate();await this.write(path,current);this.credentialAccess.invalidate();
     if(previous)await this.save(previous);else await this.secrets.set(this.name,'');
    }
    throw error;
   }
  }finally{if(heartbeat)clearInterval(heartbeat);if(handle)await handle.close();try{if(ownsLock){await checkLease();if(this.provider==='qoder')await rm(lockPath,{force:true});else await rmdir(lockPath);}}finally{this.busy=false;}}
 }
}
