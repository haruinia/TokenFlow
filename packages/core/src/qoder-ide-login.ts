import {nativeQoderCredential,verifyNativeQoder} from './qoder-credentials.js';
import {DatabaseSync} from 'node:sqlite';
import {access} from 'node:fs/promises';
import {homedir} from 'node:os';
import {win32,posix} from 'node:path';
import {nativeDigest,nativeConflict as conflict} from './native-accounts.js';
import {desktopCredentialSchema,type QoderCrypto} from './desktop-accounts.js';
import {safePath} from './agent-connections.js';
import type {Secrets} from './service.js';
import {z} from 'zod';
import {CredentialAccessStaleError,RevisionCredentialAccess} from './revision-credential-access.js';

export type QoderIdeOptions={path?:string;crypto?:QoderCrypto;platform?:NodeJS.Platform;fetch?:typeof fetch};
/** Electron's user-data root for Qoder IDE. Every Electron child process carries it on the
 * command line, so its presence says nothing about a custom profile; only a different path does. */
export function qoderIdeUserDataPath(platform:NodeJS.Platform=process.platform,home=homedir(),env:NodeJS.ProcessEnv=process.env){
 const p=platform==='win32'?win32:posix,base=platform==='win32'?(env.APPDATA||p.join(home,'AppData','Roaming')):platform==='darwin'?p.join(home,'Library','Application Support'):(env.XDG_CONFIG_HOME||p.join(home,'.config'));
 return p.join(base,'Qoder');
}
export function qoderIdeLoginPath(platform:NodeJS.Platform=process.platform,home=homedir(),env:NodeJS.ProcessEnv=process.env){
 const p=platform==='win32'?win32:posix;
 return p.join(qoderIdeUserDataPath(platform,home,env),'User','globalStorage','state.vscdb');
}
const keys=['secret://aicoding.auth.userInfo','secret://aicoding.auth.userPlan','secret://aicoding.auth.creditUsage','secret://aicoding.auth.enterpriseUsage'] as const;
const stateSchema=z.tuple([z.string().max(2*1024*1024).nullable(),z.string().max(2*1024*1024).nullable(),z.string().max(2*1024*1024).nullable(),z.string().max(2*1024*1024).nullable()]);
type State=z.infer<typeof stateSchema>;
const identitySchema=z.object({accountId:z.string().min(1),email:z.string().optional(),displayName:z.string().optional(),orgId:z.string().optional()});
type Identity=z.infer<typeof identitySchema>;
const journalSchema=z.object({path:z.string(),before:stateSchema,after:stateSchema,pendingBefore:stateSchema,identity:identitySchema,state:z.enum(['prepared','applied','restored']),createdAt:z.string()});
type Journal=z.infer<typeof journalSchema>;
const vaultKey='native-login-qoder-ide';
/** Own only the IDE's four auth rows. Keep exact original encrypted values in the OS-protected vault. */
export class QoderIdeLogin {
 private credentialAccess=new RevisionCredentialAccess<Record<string,any>>();
 private busy=false;
 constructor(private options:QoderIdeOptions={},private secrets?:Secrets,private processes:()=>Promise<number[]>=async()=>[]){}
 private path(){return this.options.path??qoderIdeLoginPath(this.options.platform);}
 private rows(db:DatabaseSync):State{
  return stateSchema.parse(keys.map(key=>{const row=db.prepare('SELECT value FROM ItemTable WHERE key=?').get(key);return row?row.value:null;}));
 }
 private async stored():Promise<State>{
  const path=this.path();await safePath(path);try{await access(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [null,null,null,null];throw error;}
  const db=new DatabaseSync(path,{readOnly:true});try{db.exec('PRAGMA busy_timeout=1000');return this.rows(db);}finally{db.close();}
 }
 private async document(options?:{retry?:boolean;fresh?:boolean},expected?:string){
  return this.credentialAccess.read(async()=>{
   const stored=(await this.stored())[0];if(expected!==undefined&&stored!==expected)throw new CredentialAccessStaleError();
   if(!stored){this.credentialAccess.invalidate();throw conflict('未找到 Qoder IDE 本机登录。');}return {revision:nativeDigest(stored),input:stored};
  },async stored=>{
   if(!this.options.crypto)throw Error();const envelope=JSON.parse(stored);
   if(envelope?.type!=='Buffer'||!Array.isArray(envelope.data)||!envelope.data.length||!envelope.data.every((n:unknown)=>Number.isInteger(n)&&Number(n)>=0&&Number(n)<=255))throw Error();
   return JSON.parse(await this.options.crypto('decrypt',Buffer.from(envelope.data).toString('base64')));
  },{mode:options?.fresh?'fresh':options?.retry?'retry':'cached'});
 }
 private async identity(stored:string,options?:{retry?:boolean;fresh?:boolean}){
  try{
  const value=await this.document(options,stored);
  const text=(v:unknown)=>typeof v==='string'&&v.trim()?v.trim():undefined;
  if(!value||!text(value.token))return null;
  const accountId=text(value.id);if(!accountId)throw Error();
  return {accountId,email:text(value.email),displayName:text(value.name),orgId:text(value.orgId)};
  }catch{throw conflict('无法确认 Qoder IDE 现有登录，未覆盖原数据。请检查系统安全存储后刷新。');}
 }
 async importCredential(options?:{retry?:boolean}){
  if(!this.options.crypto)throw conflict('请使用 TokenFlow 桌面版读取 Qoder IDE 本机授权。');
  if(process.env.QODER_PERSONAL_TOKEN||process.env.QODER_PERSONAL_ACCESS_TOKEN||process.env.QODER_CONFIG_DIR||process.env.VSCODE_PORTABLE||process.env.VSCODE_APPDATA)throw conflict('检测到 Qoder IDE 环境覆盖，请移除后再导入本机登录。');
  let value:Record<string,unknown>;try{
   value=await this.document(options);
  }catch{throw conflict('无法读取 Qoder IDE 本机登录，请检查系统安全存储后重试。');}
  return verifyNativeQoder(nativeQoderCredential(value,true),this.options.fetch);
 }
 private support(){
  if(!['darwin','win32'].includes(this.options.platform??process.platform))return '此系统暂不支持自动切换 Qoder IDE，请在 IDE 内登录。';
  if(!this.options.crypto||!this.secrets)return '请使用 TokenFlow 桌面版切换 Qoder IDE 登录。';
  if(this.secrets.canEncrypt?.()===false||this.secrets.persistent===false)return '系统持久化安全存储不可用，无法备份原登录。';
  if(process.env.QODER_PERSONAL_TOKEN||process.env.QODER_PERSONAL_ACCESS_TOKEN||process.env.QODER_CONFIG_DIR||process.env.VSCODE_PORTABLE||process.env.VSCODE_APPDATA)return '检测到 Qoder 登录环境覆盖，请移除覆盖后再切换。';
  return '';
 }
 private async journal(retry=false):Promise<Journal|null>{const raw=await this.secrets?.get(vaultKey,{retry});if(!raw)return null;try{return journalSchema.parse(JSON.parse(raw));}catch{throw conflict('Qoder IDE 原登录备份无法读取，请保留备份并检查系统安全存储。');}}
 private async save(journal:Journal|null){await this.secrets!.set(vaultKey,journal?JSON.stringify(journal):'');}
 async status(refresh=false){
  let stored:State=[null,null,null,null],identity:Identity|null=null,readError='';
  try{stored=await this.stored();if(stored[0])identity=await this.identity(stored[0],{retry:refresh});else this.credentialAccess.invalidate();}
  catch{readError=this.options.crypto?'Qoder IDE 登录暂不可读取，请检查系统安全存储后刷新。':'Qoder IDE 登录需要通过 TokenFlow 桌面版读取。';}
  const journal=await this.journal(refresh);
  return {revision:nativeDigest(stored),accountId:identity?.accountId,email:identity?.email,displayName:identity?.displayName,loginState:identity?'signed-in' as const:readError?'unreadable' as const:'signed-out' as const,readError,readOnly:!this.secrets,pids:await this.processes(),backup:journal&&journal.state!=='restored'?{state:journal.state,createdAt:journal.createdAt}:null,gatewayConnected:false,unavailableReason:this.support()};
 }
 async usageLogin(){
  if(!this.options.crypto)return null;
  const state=await this.stored();if(!state[0]){this.credentialAccess.invalidate();return null;}
  const identity=await this.identity(state[0]);
  return identity?{provider:'qoder' as const,accountId:identity.accountId,email:identity.email??null,displayName:identity.displayName}:null;
 }
 async prepare(raw:unknown){
  const reason=this.support();if(reason)throw conflict(reason);
  const parsed=desktopCredentialSchema.safeParse(raw);if(!parsed.success)throw conflict('登录凭据不完整或即将过期，请刷新账号或重新授权。');
  const c=parsed.data;let user:Record<string,unknown>;
  try{const r=await (this.options.fetch??fetch)('https://openapi.qoder.sh/api/v3/user/status',{headers:{Accept:'application/json',Authorization:`Bearer ${c.access_token}`},redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error();user=await r.json();}
  catch{throw conflict('Qoder IDE 官方服务未接受此账号，请刷新或重新授权后重试。');}
  if(!user||String(user.id??'')!==c.uid)throw conflict('Qoder IDE 官方账号身份与所选账号不一致，未切换。');
  // These values match Qoder IDE 1.33's QoderAuthService._calculateAuthStatus.
  const whitelist=({PASS:3,NoLicense:5,NoQuota:6,EXPIRED:6} as Record<string,number>)[String(user.whitelistStatus)];
  if(!whitelist)throw conflict('此账号尚未获得 Qoder IDE 登录许可，请先在官方客户端确认。');
  const profile:Record<string,unknown>={id:c.uid,token:c.access_token,refreshToken:c.refresh_token,expireTime:String(Date.parse(c.expired)),status:2,whitelist};
  for(const field of ['name','email','avatarUrl','userType','userTag','isSubAccount','quota','isQuotaExceeded','orgId','orgName','yxUid','staffId','cloudType','isPrivacyPolicyModifiable','isPrivacyPolicyVisible','featureSwitches'])if(user[field]!==undefined)profile[field]=user[field];
  const data=await this.options.crypto!('encrypt',JSON.stringify(profile));
  const identity=identitySchema.parse({accountId:c.uid,email:typeof user.email==='string'?user.email:undefined,displayName:typeof user.name==='string'?user.name:undefined,orgId:typeof user.orgId==='string'&&user.orgId?user.orgId:undefined});
  return {data:JSON.stringify(Buffer.from(data,'base64')),identity};
 }
 async check(revision:string,restore=false){
  const reason=this.support();if(reason)throw conflict(reason);
  const state=await this.stored();if(nativeDigest(state)!==revision)throw conflict('Qoder IDE 本机登录已变化，请刷新后重试。');
  // An initialized IDE database is required. Never create a guessed profile/schema.
  try{await access(this.path());}catch{throw conflict('请先打开一次 Qoder IDE 初始化本机配置，再切换账号。');}
  const journal=await this.journal();
  if(restore&&(!journal||journal.state==='restored'))throw conflict('没有可恢复的 Qoder IDE 原登录备份。');
  if(journal&&journal.state!=='restored'){
   if(journal.path!==this.path())throw conflict('Qoder IDE 登录目录已变化，已保留原备份。');
   // An explicit new selection supersedes the previous switch; do not first restore
   // old credentials over an external login. Revision/SQLite checks still apply.
   if(!restore){if(state[0])await this.identity(state[0],{fresh:true});return;}
   const exact=[journal.after,...(restore?[journal.before,journal.pendingBefore]:[])].some(s=>nativeDigest(s)===revision);
   if(!exact&&!(restore&&state[0]===null)){
    const identity=state[0]?await this.identity(state[0],{fresh:true}):null;
    if(!identity||identity.accountId!==journal.identity.accountId||(identity.orgId??'')!==(journal.identity.orgId??''))throw conflict('Qoder IDE 已登录其他账号或退出登录，未覆盖当前状态；原备份仍保留。');
   }
  }else if(state[0])await this.identity(state[0],{fresh:true});
 }
 private async database(){
  for(const suffix of ['', '-wal', '-shm', '-journal'])await safePath(this.path()+suffix);
  const db=new DatabaseSync(this.path());db.exec('PRAGMA busy_timeout=1000');return db;
 }
 private writeRows(db:DatabaseSync,after:State){
  keys.forEach((key,i)=>after[i]===null?db.prepare('DELETE FROM ItemTable WHERE key=?').run(key):db.prepare('INSERT OR REPLACE INTO ItemTable (key,value) VALUES (?,?)').run(key,after[i]));
 }
 private async write(expected:State,after:State){
  const db=await this.database();
  try{db.exec('BEGIN IMMEDIATE');if(nativeDigest(this.rows(db))!==nativeDigest(expected))throw conflict('Qoder IDE 登录在写入前发生变化，未覆盖。');this.credentialAccess.invalidate();this.writeRows(db,after);db.exec('COMMIT');this.credentialAccess.invalidate();}
  catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
 }
 async apply(revision:string,prepared:Awaited<ReturnType<QoderIdeLogin['prepare']>>|null){
  if(this.busy)throw conflict('Qoder IDE 账号正在切换，请稍候。');this.busy=true;let db:DatabaseSync|undefined;
  try{
   if((await this.processes()).length)throw conflict('Qoder IDE 尚未完全退出，未更改登录。');
   await this.check(revision,!prepared);
   db=await this.database();
   // SQLite owns this cross-process lease and releases it automatically after a crash.
   // Do not leave a persistent lock file that would prevent recovery of the original login.
   try{db.exec('BEGIN IMMEDIATE');}catch{throw conflict('Qoder IDE 登录数据库正在使用，请稍后重试。');}
   await this.check(revision,!prepared);const current=this.rows(db),previous=await this.journal();
   if(nativeDigest(current)!==revision)throw conflict('Qoder IDE 本机登录已变化，请刷新后重试。');
   const after:State=prepared?[prepared.data,null,null,null]:previous!.before;
   const journal:Journal={path:this.path(),before:previous&&previous.state!=='restored'?previous.before:current,pendingBefore:current,after,identity:prepared?.identity??previous!.identity,createdAt:previous&&previous.state!=='restored'?previous.createdAt:new Date().toISOString(),state:'prepared'};
   await this.save(journal);
   try{
    if((await this.processes()).length)throw conflict('Qoder IDE 已重新运行，未更改登录。');
    this.credentialAccess.invalidate();this.writeRows(db,after);db.exec('COMMIT');this.credentialAccess.invalidate();db.close();db=undefined;
    journal.state=prepared?'applied':'restored';await this.save(journal);
   }catch(error){
    if(db){try{db.exec('ROLLBACK');}catch{}db.close();db=undefined;}
    const now=await this.stored();
    if(!(await this.processes()).length){
     if(nativeDigest(now)===nativeDigest(after))await this.write(after,current);
     if(nativeDigest(await this.stored())===nativeDigest(current))await this.save(previous);
    }
    throw error;
   }
  }finally{try{if(db){try{db.exec('ROLLBACK');}catch{}db.close();}}finally{this.busy=false;}}
 }
}
