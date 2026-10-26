import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {agentProcesses} from './agent-connections.js';
import {AgentLifecycle} from './agent-lifecycle.js';
import {WindowsAgentLifecycle} from './windows-agent-lifecycle.js';

const exec=promisify(execFile);
const failure=(message:string)=>Object.assign(new Error(message),{statusCode:409});

/** Runs only after explicit confirmation to stop Codex and its active tasks. */
export class CodexSwitchLifecycle {
 phase:'idle'|'stopping'|'changing'|'opening'='idle';
 constructor(
  private processes=()=>agentProcesses('codex'),
  private run:(file:string,args:string[])=>Promise<unknown>=(file,args)=>exec(file,args,{timeout:15000,windowsHide:true}),
  private launch=()=>new AgentLifecycle().restart('codex'),
  private platform=process.platform,
  private wait:()=>Promise<unknown>=()=>delay(250),
  private windows:Pick<WindowsAgentLifecycle,'stop'|'open'>=new WindowsAgentLifecycle(),
 ){}
 private async stop(){
  if(this.platform==='win32'){
   await this.windows.stop('codex');
   if((await this.processes()).length)throw failure('Codex 或其 CLI 仍在运行，请手动退出后重试。未修改配置。');
   return;
  }
  for(const signal of ['TERM','KILL']){
   const pids=await this.processes();
   for(const pid of pids){
    if(!Number.isSafeInteger(pid)||pid<=1||pid===process.pid)throw failure('Codex 进程识别异常，已停止操作。');
    // Recheck before each signal: an exiting process must not become a broad name-based kill.
    if(!(await this.processes()).includes(pid))continue;
    try{await this.run('/bin/kill',[`-${signal}`,String(pid)]);}
    catch{if(signal==='KILL'&&(await this.processes()).includes(pid))throw failure('无法结束 Codex 进程，尚未开始备份或修改配置。');}
   }
   for(let tick=0;tick<20;tick++){if(!(await this.processes()).length)return;await this.wait();}
  }
  throw failure('Codex 仍在运行，尚未开始备份或修改配置，请稍后重试。');
 }
 async change<T>(work:()=>Promise<T>,launch?:()=>Promise<unknown>):Promise<T>{
  if(!['darwin','win32'].includes(this.platform))throw failure('当前系统请手动退出并重新打开 Codex。');
  if(this.phase!=='idle')throw failure('Codex 正在切换，请等待完成。');
  this.phase='stopping';
  try{
   await this.stop();
   this.phase='changing';
   // A failed migration remains stopped; opening during a partial migration can overwrite its state.
   const result=await work();
   this.phase='opening';
   try{if(this.platform==='win32')await this.windows.open('codex');else await (launch??this.launch)();}catch(error){throw failure(`配置操作已完成，但 Codex 未能重新打开。可点击「重启」重试。${error instanceof Error?error.message:''}`);}
   return result;
  }finally{this.phase='idle';}
 }
}
