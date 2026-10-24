import { constants } from 'node:fs';
import { copyFile, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {CredentialAccessStaleError,RevisionCredentialAccess} from '../../../packages/core/src/revision-credential-access.js';

type Storage = {
  decryptString(data:Buffer):string;
  encryptString(value:string):Buffer;
  isEncryptionAvailable():boolean;
  getSelectedStorageBackend?():string;
};
/** Keep unreadable ciphertext for recovery; missing credentials must not prevent the workspace opening. */
export function createSecrets(root:string, storage:Storage, platform=process.platform,allowAccess=true) {
  const unreadable=new Map<string,string>();
  const warnings=new Map<string,string>();
  const readWarnings=new Set<string>();
  const scopes=new Map<string,{access:RevisionCredentialAccess<string>;tail:Promise<void>}>();
  const scope=(name:string)=>{path(name);let value=scopes.get(name);if(!value){value={access:new RevisionCredentialAccess<string>(),tail:Promise.resolve()};scopes.set(name,value);}return value;};
  const revision=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
  const mutate=(name:string,work:(access:RevisionCredentialAccess<string>)=>Promise<void>,retainSuccess=false)=>{const s=scope(name);const result=s.tail.then(async()=>{s.access.invalidate({retainSuccess});try{await work(s.access);}catch(error){s.access.invalidate();throw error;}});s.tail=result.catch(()=>{});return result;};
  class StorageUnavailable extends Error {}
  class FileReadError extends Error {constructor(readonly original:unknown){super('密钥文件暂不可读取');}}
  const label=(name:string)=>name.startsWith('gateway-key-')?'导出 Key':name.startsWith('source-')?'API 来源':({cliproxy:'内部网关',openai:'OpenAI',custom:'自定义接口','cursor-account':'Cursor 账号'}[name]??name);
  const path=(name:string)=>{
    // Accept new credential types without a registry; names must remain portable filenames.
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(name)||/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name))throw new Error('密钥存储名称无效');
    return join(root,'secrets',`${name}.bin`);
  };
  // Even probing availability can open an OS permission prompt. A skipped startup must never call storage.
  const canEncrypt=()=>allowAccess&&storage.isEncryptionAvailable()&&!(platform==='linux'&&storage.getSelectedStorageBackend?.()==='basic_text');
  return {
    canEncrypt,
    warnings:()=>[...warnings.values()],
    async remove(name:string) {return mutate(name,async access=>{await rm(path(name),{force:true});access.invalidate();warnings.delete(name);readWarnings.delete(name);unreadable.delete(name);});},
    temporaryGateway:()=>{readWarnings.delete('cliproxy');warnings.set('cliproxy','系统安全密钥存储不可用，内部网关本次使用临时密钥；重启后会变化。原有登录账号和客户端 Key 不受影响。');},
    async get(name:string,options?:{retry?:boolean}) {
      const s=scope(name);await s.tail;
      try{return await s.access.read(async()=>{
        let data:Buffer;try{data=await readFile(path(name));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {revision:'missing',input:null};throw new FileReadError(error);}
        if(!canEncrypt())throw new StorageUnavailable();
        return {revision:revision(data),input:data};
      },data=>{
        if(data===null)return '';
        try{return storage.decryptString(data);}
        catch(error){
          unreadable.set(name,revision(data));
          if(!name.startsWith('native-login-')){readWarnings.add(name);warnings.set(name,`${label(name)}密钥无法解密，原加密文件已保留。${name==='cliproxy'?'已重新生成内部网关密钥，旧的内部直连客户端需更新密钥；账号登录和受限客户端 Key 不受影响。':'请解锁系统钥匙串后重启，或在模型来源重新填写 API Key。'}`);}
          throw error;
        }
      },{mode:options?.retry?'retry':'cached',onSuccess:()=>{unreadable.delete(name);if(readWarnings.delete(name))warnings.delete(name);}});}
      catch(error) {
        if(error instanceof CredentialAccessStaleError)throw error;
        if(error instanceof StorageUnavailable){
          if(name.startsWith('native-login-'))throw new Error('系统安全存储暂不可用，原登录备份已保留。');
          readWarnings.add(name);warnings.set(name,allowAccess?`${label(name)}密钥暂时无法读取，请解锁系统钥匙串后重启应用。原加密文件已保留。`:`本次启动已跳过 ${label(name)} 安全存储，原加密文件已保留。`);return '';
        }
        if(error instanceof FileReadError)throw error.original;
        if(name.startsWith('native-login-'))throw new Error('无法解密原登录备份，未覆盖现有文件。');
        return '';
      }
    },
    async set(name:string,value:string) {return mutate(name,async access=>{
      if(!canEncrypt())throw new Error(allowAccess?'系统安全密钥存储不可用，请解锁系统钥匙串后重试。':'本次启动已跳过安全存储，请重启后选择“允许读取”。');
      const file=path(name);
      const encrypted=storage.encryptString(value);
      // Back up even if get() was not called before replacing the credential.
      let existing:Buffer|undefined;
      try{existing=await readFile(file);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(existing&&unreadable.get(name)!==revision(existing)){try{await access.read(async()=>({revision:revision(existing!),input:existing!}),data=>storage.decryptString(data));}catch{unreadable.set(name,revision(existing));}}
      if(existing&&unreadable.get(name)===revision(existing))await copyFile(file,`${file}.unreadable-${randomUUID()}`,constants.COPYFILE_EXCL);
      const temp=`${file}.${randomUUID()}.tmp`;
      try{await writeFile(temp,encrypted,{mode:0o600,flag:'wx'});await rename(temp,file);}finally{await rm(temp,{force:true});}
      access.seed(revision(encrypted),value);
      unreadable.delete(name);
      if(name!=='cliproxy'){warnings.delete(name);readWarnings.delete(name);}
    },true);},
  };
}
