import { mkdir, writeFile, rename, rm, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readConfig, safePath } from './agent-connections.js';

export const nativeProviderSchema=z.enum(['claude','antigravity']);
export type NativeProvider=z.infer<typeof nativeProviderSchema>;
export const nativeCredentialSchema=z.object({
  access_token:z.string().min(1).max(20000),refresh_token:z.string().min(1).max(20000),
  email:z.string().email(),expired:z.string().refine(v=>Number.isFinite(Date.parse(v))&&Date.parse(v)>0),
  account_uuid:z.string().optional(),organization_uuid:z.string().optional(),
  id_token:z.string().optional(),project_id:z.string().optional(),
  scope:z.string().optional(),scopes:z.array(z.string()).optional(),
});
export type NativeCredential=z.infer<typeof nativeCredentialSchema>;
export type NativeState=Record<string,string|null>;
export const nativeConflict=(message:string)=>Object.assign(new Error(message),{statusCode:409});
export const nativeDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function writePrivate(path:string,value:string|null){
  await safePath(path);
  if(value===null){await rm(path,{force:true});return;}
  await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=`${path}.${randomUUID()}.tmp`;
  try{await writeFile(temp,value,{mode:0o600,flag:'wx'});await rename(temp,path);}finally{await rm(temp,{force:true});}
}
export interface NativeStore {
  lockPath:string;
  storage:string;
  read():Promise<NativeState>;
  write(before:NativeState,after:NativeState):Promise<void>;
  prepare(before:NativeState,credential:NativeCredential,model?:string):NativeState;
  describe(state:NativeState):{email:string|null;model:string|null;accountId?:string|null;organizationId?:string|null};
  loginStatus?(state:NativeState):{loginState:'signed-in'|'signed-out'|'unreadable';readError?:string};
  identity?(state:NativeState):string|null;
  signedOut?(state:NativeState):boolean;
  restoreState?(current:NativeState,original:NativeState,applied:NativeState):NativeState;
}
const stateSchema=z.record(z.string().nullable());
const journalSchema=z.object({before:stateSchema,after:stateSchema,restoreTarget:stateSchema.optional(),createdAt:z.string(),state:z.enum(['prepared','applied','restored'])});
/** Journals contain secrets and stay server-side. Store adapters change only their owned fields. */
export class NativeAccounts {
  constructor(private backupPath:string,private store:NativeStore,private processes:()=>Promise<number[]>){}
  private async journal(){const value=await readConfig(this.backupPath);if(value===null)return null;try{return journalSchema.parse(JSON.parse(value));}catch{throw nativeConflict('账号切换备份无法读取，请保留备份并检查。');}}
  private identity(state:NativeState){return this.store.identity?this.store.identity(state):this.store.describe(state).email;}
  async status(){const state=await this.store.read(),journal=await this.journal();return {revision:nativeDigest(state),...this.store.describe(state),...this.store.loginStatus?.(state),storage:this.store.storage,pids:await this.processes(),backup:journal&&journal.state!=='restored'?{createdAt:journal.createdAt,state:journal.state}:null};}
  private async locked<T>(operation:()=>Promise<T>){
    await safePath(this.store.lockPath);await mkdir(dirname(this.store.lockPath),{recursive:true,mode:0o700});
    let handle;try{handle=await open(this.store.lockPath,'wx',0o600);}catch{throw nativeConflict('另一个配置操作正在进行，请稍后重试。');}
    try{return await operation();}finally{await handle.close();await rm(this.store.lockPath,{force:true});}
  }
  private async check(revision:string){
    if((await this.processes()).length)throw nativeConflict('请先完全退出客户端，再切换或还原账号。');
    const before=await this.store.read();if(nativeDigest(before)!==revision)throw nativeConflict('本机登录或配置已变化，请刷新后重试。');return before;
  }
  async preflightSwitch(input:{revision:string;model?:string},raw:unknown,settings?:NativeState){
    const current=await this.store.read();if(nativeDigest(current)!==input.revision)throw nativeConflict('本机登录或配置已变化，请刷新后重试。');
    if((await this.journal())?.state==='prepared')throw nativeConflict('上次切换未完成，请先还原原登录。');
    const parsed=nativeCredentialSchema.safeParse(raw);if(!parsed.success)throw nativeConflict('账号缺少完整 OAuth 凭据，请重新授权。');
    this.store.prepare({...current,...settings},parsed.data,input.model);
  }
  private restoreTarget(current:NativeState,journal:z.infer<typeof journalSchema>|null){
    if(!journal||journal.state==='restored')throw nativeConflict('没有可还原的账号切换备份。');
    const identity=this.identity(current),original=journal.restoreTarget??journal.before;
    const partial=journal.state==='prepared'&&Object.keys(journal.after).every(key=>current[key]===original[key]||current[key]===journal.after[key]);
    if(!partial&&nativeDigest(current)!==nativeDigest(original)&&nativeDigest(current)!==nativeDigest(journal.after)&&!this.store.signedOut?.(current)&&(!identity||identity!==this.identity(journal.after)))throw nativeConflict('本机登录已有其他修改，已保留备份，未覆盖。');
    if(!this.store.restoreState&&current.model!==undefined&&current.model!==journal.before.model&&current.model!==journal.after.model)throw nativeConflict('默认模型已被其他程序修改，已保留备份，未覆盖。');
    return journal.restoreTarget??this.store.restoreState?.(current,journal.before,journal.after)??journal.before;
  }
  async preflightRestore(revision:string,settings?:NativeState){const current=await this.store.read();if(nativeDigest(current)!==revision)throw nativeConflict('本机登录或配置已变化，请刷新后重试。');this.restoreTarget({...current,...settings},await this.journal());}
  async switch(input:{revision:string;model?:string},raw:unknown){
    const parsed=nativeCredentialSchema.safeParse(raw);if(!parsed.success)throw nativeConflict('账号缺少完整 OAuth 凭据，请重新授权。');
    return this.locked(async()=>{
      const before=await this.check(input.revision);let previous=await this.journal();
      if(previous?.state==='prepared')throw nativeConflict('上次切换未完成，请先还原原登录。');
      // Signed in elsewhere since the last switch: that login becomes the new original.
      if(previous?.state==='applied'&&this.identity(before)!==this.identity(previous.after)&&!this.store.signedOut?.(before))previous=null;
      const after=this.store.prepare(before,parsed.data,input.model);
      const journal={before:previous?.state==='applied'?previous.before:before,after,createdAt:new Date().toISOString(),state:'prepared' as 'prepared'|'applied'|'restored'};
      await writePrivate(this.backupPath,JSON.stringify(journal));
      try{
        await this.check(input.revision);await this.store.write(before,after);
        journal.state='applied';await writePrivate(this.backupPath,JSON.stringify(journal));
      }catch(error){
        const current=await this.store.read();
        if(nativeDigest(current)===nativeDigest(after))await this.store.write(current,before);
        if(nativeDigest(await this.store.read())===nativeDigest(before))await writePrivate(this.backupPath,previous?JSON.stringify(previous):null);
        throw error;
      }
      return this.status();
    });
  }
  async restore(input:{revision:string}){
    return this.locked(async()=>{
      const current=await this.check(input.revision),journal=await this.journal();
      if(!journal||journal.state==='restored')throw nativeConflict('没有可还原的账号切换备份。');
      const restored=this.restoreTarget(current,journal);
      // A crash during restore can also leave a mixture of the two snapshots.
      journal.after=current;journal.restoreTarget=restored;journal.state='prepared';await writePrivate(this.backupPath,JSON.stringify(journal));
      await this.check(input.revision);await this.store.write(current,restored);journal.state='restored';await writePrivate(this.backupPath,JSON.stringify(journal));return this.status();
    });
  }
}
export type NativeAccountStatus=Awaited<ReturnType<NativeAccounts['status']>>;
