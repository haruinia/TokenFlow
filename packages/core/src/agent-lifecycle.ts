import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {join,dirname} from 'node:path';
import {access} from 'node:fs/promises';
import {desktopCandidates} from './agent-installation.js';
import {WindowsAgentLifecycle} from './windows-agent-lifecycle.js';

const exec=promisify(execFile);
const failure=(message:string)=>Object.assign(new Error(message),{statusCode:409});
type Run=(file:string,args:string[])=>Promise<{stdout:string}>;
const apps={
 'qoder-ide':{name:'Qoder IDE',bundle:'com.qoder.ide',image:'Qoder'},
 qoder:{name:'Qoder',bundle:'com.qoder.app',image:'Qoder'},
 codex:{name:'Codex',bundle:'com.openai.codex',image:'Codex'},
 workbuddy:{name:'WorkBuddy',bundle:'com.tencent.workbuddy.mac',image:'WorkBuddy'},
 'workbuddy-ai':{name:'WorkBuddyAI 国际版',bundle:'com.workbuddy.workbuddy-ai',image:'WorkBuddyAI'},
 'claude-desktop':{name:'Claude',bundle:'com.anthropic.claudefordesktop',image:'Claude'},
 claude:{name:'VS Code',bundle:'com.microsoft.VSCode'},
 deepseek:{name:'DeepSeek Harness',bundle:'com.deepseek.dsh',image:'DeepSeek Harness'},
} as const;
export type RestartTarget=keyof typeof apps;
type AppIdentity={bundle:string;executable:string};
export async function macAppIdentity(path:string):Promise<AppIdentity|undefined>{
  try{
    const {stdout}=await exec('/usr/bin/plutil',['-convert','json','-o','-',join(path,'Contents/Info.plist')],{timeout:3000,maxBuffer:1024*1024});
    const info=JSON.parse(stdout);
    if(typeof info.CFBundleIdentifier==='string'&&typeof info.CFBundleExecutable==='string')return {bundle:info.CFBundleIdentifier,executable:info.CFBundleExecutable};
  }catch{/* An unavailable or malformed bundle is not a verified restart target. */}
}
// Validate the bundle identity and main executable, not the app's display name.
/** The IDE main process and its renderers must stop before SQLite login writes.
 * Crash reporters may outlive the IDE; TokenFlow crypto workers are a different bundle. */
export async function macQoderIdeProcesses(stdout:string,inspect=macAppIdentity){
 const identities=new Map<string,Promise<AppIdentity|undefined>>();
 const rows=stdout.split('\n').flatMap(line=>{const m=line.trim().match(/^(?:(\d+)\s+)?(\/.*?\.app)\/Contents\/(.+)$/);return m?[{pid:m[1]?Number(m[1]):0,path:m[2],relative:m[3]}]:[];});
 const result=[];
 for(const row of rows){
  if(/(?:crashpad|crash_reporter)/i.test(row.relative))continue;
  let identity=identities.get(row.path);if(!identity){identity=inspect(row.path);identities.set(row.path,identity);}
  const app=await identity;if(app?.bundle!=='com.qoder.ide')continue;
  const main=row.relative===`MacOS/${app.executable}`;
  if(main||/^Frameworks\/.+\.app\/Contents\/MacOS\/[^/]+$/.test(row.relative))result.push({...row,main});
 }
 return result;
}

export class AgentLifecycle {
  private busy=false;
  private app:typeof apps[RestartTarget]=apps.qoder;
  private target:RestartTarget='qoder';
  private macPath:string|undefined;
  private launchEnv:Record<string,string>={};
  private identities=new Map<string,Promise<AppIdentity|undefined>>();
  constructor(private run:Run=(file,args)=>exec(file,args,{timeout:file==='/usr/bin/open'?5000:15000,maxBuffer:1024*1024,windowsHide:true}),private platform=process.platform,private wait:()=>Promise<unknown>=()=>delay(250),private inspectApp=macAppIdentity){}
  private identity(path:string){let result=this.identities.get(path);if(!result){result=this.inspectApp(path);this.identities.set(path,result);}return result;}
  private async running(includeIdeHelpers=false){
    const {stdout}=await this.run('/bin/ps',['-axo','comm=']);
    const paths=new Set<string>();
    if(this.target==='qoder-ide'&&includeIdeHelpers){
      const processes=await macQoderIdeProcesses(stdout,p=>this.identity(p));
      for(const process of processes)if(!this.macPath||process.path===this.macPath)paths.add(process.path);
      return paths.size>0;
    }
    for(const line of stdout.split('\n')){
      const match=line.trim().match(/^(\/.*\.app)\/Contents\/MacOS\/([^/]+)$/);if(!match)continue;
      if(this.macPath&&match[1]!==this.macPath)continue;
      const identity=await this.identity(match[1]);
      if(identity?.bundle===this.app.bundle&&identity.executable===match[2])paths.add(match[1]);
    }
    if(paths.size>1)throw failure(`检测到多个 ${this.app.name} 版本正在运行，请先退出多余版本再重启。`);
    if(paths.size)this.macPath=[...paths][0];
    return paths.size>0;
  }
  private async until(running:boolean){
    for(let i=0;i<40;i++){if(await this.running(!running)===running)return;await this.wait();}
    throw failure(running?`${this.app.name} 启动尚未确认，请手动打开后检查模型列表。`:`${this.app.name} 尚未退出，请处理它的保存或退出提示后重试。未强制结束进程。`);
  }
  private async quit(){
    await this.run('/usr/bin/osascript',['-e',`tell application ${this.macPath?JSON.stringify(this.macPath):`id "${this.app.bundle}"`} to quit`]);
  }
  private async checkIdeProfile(){
    if(this.target!=='qoder-ide'||!this.macPath)return;
    let portable=false;try{await access(join(dirname(this.macPath),'qoder-portable-data'));portable=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw failure('无法确认 Qoder IDE 的配置目录，请手动检查。');}
    if(portable)throw failure('检测到 Qoder IDE 便携配置，请在 IDE 内切换账号；默认登录目录未修改。');
    const {stdout}=await this.run('/bin/ps',['-axo','pid=,comm=']);
    const pids=stdout.split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(.+)$/);return m&&m[2].startsWith(this.macPath!+'/Contents/MacOS/')?[m[1]]:[];});
    if(pids.length){const result=await this.run('/bin/ps',['-p',pids.join(','),'-o','args=']);if(/(?:^|\s)--(?:user-data-dir|profile)(?:=|\s|$)/m.test(result.stdout))throw failure('Qoder IDE 正在使用自定义配置目录或个人资料，请在 IDE 内切换账号。');}
  }
  private async open(){
    if(!this.macPath)for(const path of desktopCandidates(this.target,'darwin')){
      if((await this.identity(path))?.bundle===this.app.bundle){this.macPath=path;break;}
    }
    await this.run('/usr/bin/open',[...Object.entries(this.launchEnv).flatMap(([key,value])=>['--env',`${key}=${value}`]),...(this.macPath?[this.macPath]:['-b',this.app.bundle]),...(this.launchEnv.CODEX_ELECTRON_USER_DATA_PATH?['--args',`--user-data-dir=${this.launchEnv.CODEX_ELECTRON_USER_DATA_PATH}`]:[])]);
  }
  async restart(target:RestartTarget='qoder',env:Record<string,string>={}){this.launchEnv=env;return this.change(target,async()=>{},false);}
  async change(target:RestartTarget,work:()=>Promise<unknown>,requireInstallation=true){
    if(!['darwin','win32'].includes(this.platform)||this.platform==='win32'&&!('image' in apps[target]))throw failure('当前系统请完全退出并重新打开对应 Agent。');
    if(this.busy)throw failure('Agent 正在重启，请稍候。');
    this.busy=true;this.app=apps[target];this.target=target;this.macPath=undefined;this.identities.clear();
    try{
      if(this.platform==='win32'&&target!=='claude'){const lifecycle=new WindowsAgentLifecycle(this.run,this.wait);await lifecycle.stop(target);await work();await lifecycle.open(target,this.launchEnv);return {message:`${this.app.name} 已重新打开。`};}
      if(await this.running()){
        await this.checkIdeProfile();
        try{await this.quit();}
        catch{throw failure(`${this.app.name} 未完成退出，请处理保存提示或手动退出后重试。未强制结束进程。`);}
        await this.until(false);
      }
      if(requireInstallation&&!this.macPath){
        const verified:string[]=[];
        for(const path of desktopCandidates(target,'darwin'))if((await this.identity(path))?.bundle===this.app.bundle)verified.push(path);
        if(verified.length!==1)throw failure('无法唯一确认客户端安装位置，请手动打开目标应用后重试。');
        this.macPath=verified[0];
      }
      if(target==='qoder-ide')await this.until(false);
      await this.checkIdeProfile();
      await work();
      // LaunchServices can still consider the old app terminating after its process exits.
      for(let attempt=0;attempt<3;attempt++){
        try{await this.open();break;}
        catch{
          if(attempt===2)throw failure(`无法打开 ${this.app.name}，请确认已安装，或手动打开。`);
          for(let tick=0;tick<4;tick++)await this.wait();
        }
      }
      await this.until(true);
      return {message:target==='qoder'?'Qoder 已重新打开，请在「模型 → 自定义」选择 TokenFlow 模型。':`${this.app.name} 已重新打开，请确认模型选择。`};
    }finally{this.busy=false;}
  }
}

// Keep the existing Qoder integration compatible.
export {AgentLifecycle as QoderLifecycle};
