import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {RunnerCoreError} from './errors.js';
import {windowsStoreApp} from './agent-installation.js';
const fail=(message:string)=>new RunnerCoreError(message,{statusCode:409,code:'codex_migration_failed'});

/** Keep only bounded protocol metadata. RPC messages can contain private paths,
 * thread identifiers or history and must never become public error text. */
export class CodexRuntimeRPCError extends RunnerCoreError {
 readonly rpcMethod:string;readonly rpcCode?:number;readonly rpcReason:'turn_not_found'|'unknown';
 constructor(method:string,error:unknown){
  const value=error as {code?:unknown;message?:unknown}|null;
  const known=new Set(['initialize','model/list','thread/resume','thread/fork','thread/archive','thread/unarchive','thread/unsubscribe','thread/turns/list']);
  const rpcMethod=known.has(method)?method:'unknown',rpcCode=typeof value?.code==='number'&&Number.isSafeInteger(value.code)?value.code:undefined;
  const rpcReason=rpcCode===-32600&&typeof value?.message==='string'&&/^turn not found\b/i.test(value.message)?'turn_not_found':'unknown';
  super(rpcMethod==='thread/fork'?'Codex 历史索引修复未完成，迁移已停止，备份保留。':'Codex 会话服务请求未完成，迁移已停止，备份保留。',{statusCode:409,code:'codex_migration_failed',hint:`RPC ${rpcMethod}${rpcCode===undefined?'':` · ${rpcCode}`} · ${rpcReason}`});
  this.rpcMethod=rpcMethod;this.rpcCode=rpcCode;this.rpcReason=rpcReason;
 }
}

/** Uses the installed runtime's supported resume API, never starts a turn or tool. */
export async function migrationBinary(binary?:string){
 const win=process.platform==='win32';
 const candidates=binary?[binary]:[
  ...['/Applications',join(homedir(),'Applications')].flatMap(base=>['ChatGPT','Codex'].flatMap(app=>['bin/codex','CodexCLI.app/Contents/MacOS/codex'].map(leaf=>join(base,`${app}.app/Contents/Resources/codex-cli`,leaf)))),
  // npm creates codex.cmd on Windows; resolve its native executable below.
  ...[...(process.env.PATH??'').split(win?';':':'),...(win&&process.env.APPDATA?[join(process.env.APPDATA,'npm')]:[])].filter(Boolean).flatMap(dir=>win?[join(dir,'codex.exe'),join(dir,'codex.cmd')]:[join(dir,'codex')]),
 ];
 let executable:string|undefined;for(const path of candidates){try{await access(path,constants.X_OK);executable=path;break;}catch{}}
 // The Microsoft Store desktop app keeps its bundled runtime inside its package.
 if(!executable&&win&&!binary){const cli=(await windowsStoreApp('codex',{cli:true}))?.cli;if(cli)try{await access(cli,constants.X_OK);executable=cli;}catch{}}
 if(!executable)throw fail('未找到可用于迁移的 Codex 程序，请先安装官方 Codex。');
 return executable;
}
/** Own the native child directly. Killing a Windows Node launcher can leave its
 * Codex child running, locking conversation state after migration completes. */
export async function runtimeLaunch(executable:string,platform=process.platform,arch=process.arch):Promise<{file:string;args:string[];env:{[key:string]:string}}>{
 if(platform==='win32'&&/\.cmd$/i.test(executable)){
  const modules=join(dirname(executable),'node_modules'),root=join(modules,'@openai','codex');
  const triple=arch==='arm64'?'aarch64-pc-windows-msvc':arch==='x64'?'x86_64-pc-windows-msvc':undefined;
  if(triple)for(const vendor of [join(root,'node_modules','@openai',`codex-win32-${arch}`,'vendor'),join(modules,'@openai',`codex-win32-${arch}`,'vendor'),join(root,'vendor')])for(const leaf of ['bin','codex']){
   const native=join(vendor,triple,leaf,'codex.exe');
   try{await access(native,constants.R_OK);return {file:native,args:[],env:{}};}catch{/* Try the next official npm layout. */}
  }
  throw fail('找到 codex.cmd，但缺少可用的官方 Codex 原生程序，无法用于迁移，请重新安装官方 Codex。');
 }
 return {file:executable,args:[],env:{}};
}
export async function codexRuntimeClient(home:string,binary?:string){
 const launch=await runtimeLaunch(await migrationBinary(binary));
 const child:ChildProcessWithoutNullStreams=spawn(launch.file,[...launch.args,'app-server','--listen','stdio://'],{cwd:home,env:{...process.env,...launch.env,CODEX_HOME:home},stdio:['pipe','pipe','pipe'],windowsHide:true});
 let buffer='',next=0,closed=false;const pending=new Map<number,{method:string;resolve:(v:any)=>void;reject:(e:Error)=>void}>();
 const rejectAll=()=>{for(const request of pending.values())request.reject(fail('Codex 会话服务已停止，备份保留，可再次点击启动继续迁移。'));pending.clear();};
 child.on('error',rejectAll);child.on('exit',()=>{closed=true;rejectAll();});child.stderr.resume();child.stdout.setEncoding('utf8');
 child.stdout.on('data',chunk=>{
  buffer+=String(chunk);if(buffer.length>128*1024*1024){rejectAll();child.kill();return;}
  let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let message;try{message=JSON.parse(line);}catch{continue;}
   if(typeof message.id==='number'&&pending.has(message.id)){const request=pending.get(message.id)!;pending.delete(message.id);message.error?request.reject(new CodexRuntimeRPCError(request.method,message.error)):request.resolve(message.result);}
   // Approval/tool requests cannot execute anything during migration.
   else if(message.method&&message.id!==undefined)child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'Migration does not execute tools or approvals'}})+'\n');
  }
 });
 const rpc=(method:string,params:unknown):Promise<any>=>new Promise((resolve,reject)=>{
  if(closed)return reject(fail('Codex 会话服务未启动。'));
  const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(fail('旧对话迁移超时，备份已保留，请重试。'));},60000);
  pending.set(id,{method,resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
  child.stdin.write(JSON.stringify({id,method,params})+'\n');
 });
 const close=async()=>{if(closed)return;await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill();});};
 try{await rpc('initialize',{clientInfo:{name:'token_flow_migration',version:'1.0'}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n');}catch(error){await close();throw error;}
 return {pid:child.pid,close,rpc};
}

/** Resolve the installed runtime's default instead of pinning a model name. */
export async function codexDefaultModel(home:string){
 const client=await codexRuntimeClient(home);
 try{
  let cursor:string|undefined;const seen=new Set<string>();
  do{
   const result=await client.rpc('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});
   const selected=result.data?.find((item:{isDefault?:boolean;model?:string})=>item.isDefault&&typeof item.model==='string'&&/^[a-zA-Z0-9._-]+$/.test(item.model));
   if(selected)return selected.model as string;
   cursor=result.nextCursor??undefined;
   if(cursor&&seen.has(cursor))break;
   if(cursor)seen.add(cursor);
  }while(cursor);
  throw fail('无法确定官方默认模型，请在官方账号中选择模型后再恢复。');
 }finally{await client.close();}
}
