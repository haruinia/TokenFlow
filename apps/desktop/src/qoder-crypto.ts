import {spawn} from 'node:child_process';
import {app,safeStorage} from 'electron';
import {rmSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createInterface} from 'node:readline';
import {qoderCryptoProfile,type QoderClient} from './qoder-crypto-profile.js';
import type {QoderCrypto} from '../../../packages/core/src/desktop-accounts.js';

const sessions=new Set<()=>Promise<void>>();
export async function closeQoderCrypto(){await Promise.all([...sessions].map(close=>close()));}

/** One isolated Electron session per client reuses its initialized OS encryption key.
 * Credentials travel only through pipes, never argv/environment/logs or a disk cache. */
export const qoderCryptoFor=(client:QoderClient):QoderCrypto=>{
 let session:ReturnType<typeof startSession>|undefined;
 return async(operation,value)=>{
  session??=startSession(client,()=>{session=undefined;});
  return session.request(operation,value);
 };
};
function startSession(client:QoderClient,onClose:()=>void){
 const profile=qoderCryptoProfile(process.platform,app.getPath('appData'),undefined,client);
 let child:ReturnType<typeof spawn>;
 try{child=spawn(process.execPath,[...(app.isPackaged?[]:[app.getAppPath()]),'--tokenflow-qoder-crypto',`--tokenflow-qoder-client=${client}`,`--tokenflow-qoder-profile=${profile}`],{stdio:['pipe','pipe','ignore'],windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});}
 catch(error){rmSync(profile,{recursive:true,force:true});throw error;}
 const pending=new Map<number,{resolve:(value:string)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 let id=0,output='',ended=false;
 let finish!:()=>void;const closed=new Promise<void>(resolve=>{finish=resolve;});
 const error=()=>new Error('Qoder 系统安全存储不可用，请允许系统钥匙串访问后重试。');
 const fail=()=>{
  if(ended)return;ended=true;onClose();
  for(const request of pending.values()){clearTimeout(request.timer);request.reject(error());}pending.clear();child.kill();
 };
 const close=async()=>{fail();await closed;};sessions.add(close);
 child.on('error',fail);child.stdin!.on('error',fail);
 child.stdout!.setEncoding('utf8');
 child.stdout!.on('data',(chunk:string)=>{
  output+=chunk;if(output.length>5_000_000){fail();return;}
  let newline:number;
  while((newline=output.indexOf('\n'))>=0){
   const line=output.slice(0,newline);output=output.slice(newline+1);if(!line.startsWith('TOKENFLOW_CRYPTO:'))continue;
   try{const result=JSON.parse(line.slice('TOKENFLOW_CRYPTO:'.length)),request=pending.get(result.id);
    if(!request||typeof result.value!=='string'){fail();return;}
    pending.delete(result.id);clearTimeout(request.timer);request.resolve(result.value);
   }catch{fail();return;}
  }
 });
 child.once('close',()=>{fail();sessions.delete(close);try{rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});}finally{finish();}});
 return {request(operation:'encrypt'|'decrypt',value:string){
  if(ended)return Promise.reject(error());
  return new Promise<string>((resolve,reject)=>{
   const current=++id;pending.set(current,{resolve,reject,timer:setTimeout(fail,60000)});
   child.stdin!.write(JSON.stringify({id:current,operation,value})+'\n');
  });
 }};
}
export const qoderCrypto=qoderCryptoFor('qoder');
export const qoderIdeCrypto=qoderCryptoFor('qoder-ide');
export async function runQoderCrypto(){
 try{
  if(!['darwin','win32'].includes(process.platform))throw Error();
  // Configure the isolated client identity before Electron initializes OSCrypt.
  const client=process.argv.find(arg=>arg.startsWith('--tokenflow-qoder-client='))?.slice('--tokenflow-qoder-client='.length)??'qoder';
  if(client!=='qoder'&&client!=='qoder-ide')throw Error();
  if(process.platform==='darwin')app.setActivationPolicy('prohibited');
  app.setName(process.platform==='darwin'&&client==='qoder'?'Qoder App':'Qoder');
  const profile=process.argv.find(arg=>arg.startsWith('--tokenflow-qoder-profile='))?.slice('--tokenflow-qoder-profile='.length);
  if(!profile||!isAbsolute(profile))throw Error();
  app.setPath('userData',profile);app.setPath('sessionData',profile);
  await app.whenReady();app.dock?.hide();
  if(!safeStorage.isEncryptionAvailable())throw Error();
  const input=createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of input){
   if(line.length>4_000_000)throw Error();const request=JSON.parse(line);
   if(!Number.isSafeInteger(request.id)||request.id<1||typeof request.value!=='string')throw Error();
   let value:string;
   if(request.operation==='encrypt')value=safeStorage.encryptString(request.value).toString('base64');
   else if(request.operation==='decrypt')value=safeStorage.decryptString(Buffer.from(request.value,'base64'));
   else throw Error();
   await new Promise<void>((resolve,reject)=>process.stdout.write(`TOKENFLOW_CRYPTO:${JSON.stringify({id:request.id,value})}\n`,error=>error?reject(error):resolve()));
  }
  app.exit(0);
 }catch{app.exit(1);}
}
