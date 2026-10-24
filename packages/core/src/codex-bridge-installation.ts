import {access,mkdir,readFile,writeFile,rename,chmod,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {desktopCandidates} from './agent-installation.js';
import {macAppIdentity} from './agent-lifecycle.js';
import type {CodexBridgeRouting} from './codex-provider-bridge.js';
const exec=promisify(execFile);
const fail=(message:string)=>Object.assign(new Error(message),{statusCode:409});
const quote=(text:string)=>"'"+text.replaceAll("'","'\\''")+"'";
/** The bridge belongs to Codex's process tree and lives outside the TokenFlow app. */
export class CodexBridgeInstallation {
 readonly directory:string;
 constructor(root:string,private runtime?:string){this.directory=join(root,'codex-direct-bridge');}
 async preflight(){
  if(process.platform!=='darwin'||!this.runtime)throw fail('此实验模式需要带会话桥接程序的 macOS 安装版。');
  await access(this.runtime,constants.R_OK);
  const found=[];
  for(const app of desktopCandidates('codex')){
   if((await macAppIdentity(app))?.bundle!=='com.openai.codex')continue;
   const binary=join(app,'Contents/Resources/codex-cli/bin/codex'),node=join(app,'Contents/Resources/cua_node/bin/node');
   try{await access(binary,constants.X_OK);await access(node,constants.X_OK);found.push({app,binary,node});}catch{/* Unsupported distribution: fail before changing the user's config. */}
  }
  if(found.length!==1)throw fail('无法唯一确认支持会话桥接的 Codex 桌面版本，未修改配置。');
  return found[0];
 }
 private async atomic(name:string,text:string,mode=0o600){const path=join(this.directory,name),temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,text,{mode,flag:'wx'});await rename(temp,path);await chmod(path,mode);}
 async install(routing:CodexBridgeRouting){
  const installation=await this.preflight();
  await mkdir(this.directory,{recursive:true,mode:0o700});
  await this.atomic('bridge.mjs',await readFile(this.runtime!,'utf8'));
  await this.atomic('settings.json',JSON.stringify({...installation,...routing}));
  await this.atomic('codex',`#!/bin/sh\nexec ${quote(installation.node)} ${quote(join(this.directory,'bridge.mjs'))} "$@"\n`,0o700);
 }
 async prepareRouting(routing:CodexBridgeRouting){
  const before=await readFile(join(this.directory,'settings.json'),'utf8'),after=JSON.stringify({...JSON.parse(before),...routing});
  return {apply:async()=>{if(await readFile(join(this.directory,'settings.json'),'utf8')!==before)throw fail('会话桥配置已变化，请刷新后重试。');await this.atomic('settings.json',after);},rollback:async()=>{if(await readFile(join(this.directory,'settings.json'),'utf8')===after)await this.atomic('settings.json',before);}};
 }
 async launch(){
  const installation=await this.preflight();await access(join(this.directory,'codex'),constants.X_OK);
  await exec('/usr/bin/open',['--env',`CODEX_CLI_PATH=${join(this.directory,'codex')}`,'--env',`CODEX_APP_RUNTIME_CLI_PATH=${installation.binary}`,installation.app],{timeout:10000});
  // open's success only confirms launch dispatch. Require a live protocol bridge.
  for(let i=0;i<80;i++){if((await this.status()).connected)return;await new Promise(r=>setTimeout(r,250));}
  throw fail('配置已保存，但会话桥接尚未连接。请从 TokenFlow 的「重启」入口再次启动 Codex。');
 }
 async status(){
  const files=await readdir(this.directory).catch(()=>[]);let connected=false,stage:string|undefined;
  for(const name of files.filter(n=>/^status-\d+\.json$/.test(n))){
   try{const state=JSON.parse(await readFile(join(this.directory,name),'utf8'));if(!Number.isSafeInteger(state.pid)||!Number.isSafeInteger(state.enginePid))continue;
    const {stdout}=await exec('/bin/ps',['-p',String(state.pid),'-o','args='],{timeout:2000});
    if(!stdout.includes(join(this.directory,'bridge.mjs')))continue;
    process.kill(state.enginePid,0);connected=true;stage=state.stage;
   }catch{/* Stale process records are not a connected client. */}
  }
  return {supported:process.platform==='darwin'&&!!this.runtime,connected,...(stage?{stage}:{}),launchRequired:!connected};
 }
}
