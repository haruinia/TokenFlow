import {Worker} from 'node:worker_threads';
import {dirname,join} from 'node:path';
import type {AgentPaths} from './agent-connections.js';
import type {LocalUsageSnapshot} from './local-usage.js';
import {deepseekHome} from './deepseek-config.js';
import {homedir} from 'node:os';
import {cursorDatabasePath} from './cursor-local.js';
import {claudeDesktopDirectory} from './claude-desktop.js';
export class LocalUsageIndex{
 private worker?:Worker;private state:LocalUsageSnapshot={rows:[],coverage:[],scanning:false};private last=0;private closed=false;
 constructor(private root:string,private paths:AgentPaths,private gatewayPorts:()=>number[]=()=>[],private extraSources:Record<string,string[]>={}){}
 snapshot(){
  if(!this.closed&&!this.worker){const home=dirname(dirname(this.paths.workbuddy));this.state.scanning=true;this.worker=new Worker(new URL(import.meta.url.endsWith('.ts')?'./local-usage-worker.ts':'./local-usage-worker.js',import.meta.url),{workerData:{root:this.root,gatewayPorts:this.gatewayPorts(),claudeDesktop:claudeDesktopDirectory(process.platform,home,home===homedir()?process.env:{}),sources:{codex:[join(dirname(this.paths.codex),'sessions'),join(dirname(this.paths.codex),'archived_sessions')],claude:[join(dirname(this.paths.claude),'projects')],qoder:[join(dirname(this.paths.qoder),'projects')],workbuddy:[join(dirname(this.paths.workbuddy),'projects')],'workbuddy-ai':[join(home,'.workbuddy-ai','projects'),join(home,'.workbuddy-ai','sessions')],antigravity:[join(home,'.gemini','antigravity-ide','conversations'),join(home,'.gemini','antigravity','conversations')],cursor:[cursorDatabasePath(process.platform,home,home===homedir()?process.env:{})],zcode:[join(home,'.zcode','cli','db','db.sqlite')],pi:[join(dirname(this.paths.pi),'sessions')],deepseek:[join(deepseekHome(this.paths.deepseek),'sessions')],...this.extraSources}},...(import.meta.url.endsWith('.ts')?{execArgv:['--import','tsx/esm']}:{})});
   this.worker.on('message',(state:LocalUsageSnapshot)=>{this.state=state;});this.worker.on('error',()=>{this.state={...this.state,scanning:false,warning:'本机用量索引暂不可用。'};});this.worker.unref();this.last=Date.now();
  }else if(this.worker&&Date.now()-this.last>60000&&!this.state.scanning){this.last=Date.now();this.state={...this.state,scanning:true};this.worker.postMessage('refresh');}
  return this.state;
 }
 refresh(){this.last=0;return this.snapshot();}
 async close(){this.closed=true;await this.worker?.terminate();}
}
