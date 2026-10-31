import {Worker} from 'node:worker_threads';
import {join,isAbsolute} from 'node:path';
import {lstat,readFile} from 'node:fs/promises';
import {z} from 'zod';

const settings=z.object({version:z.literal(1),enabled:z.boolean().default(true),output:z.string().min(1).refine(isAbsolute).optional()});
export type ReconciliationMonitorOptions={root:string;codexHome:string;allowOfficial:boolean;proxyURL?:string;intervalMs?:number;officialIntervalMs?:number};
export type ReconciliationStatus={state:'starting'|'recording'|'retrying'|'unavailable'|'disabled'|'stopped';at?:string;official?:'available'|'unavailable'|'skipped';responses?:number};

/** Desktop-owned worker: no shell, global daemon, OS autostart or dependency on a checkout. */
export class CodexReconciliationMonitor{
 private worker?:Worker;private closed=false;private starting?:Promise<void>;private exited?:Promise<void>;
 private state:ReconciliationStatus={state:'stopped'};
 constructor(private options:ReconciliationMonitorOptions){}
 snapshot(){return this.state;}
 enableOfficial(){this.options.allowOfficial=true;this.worker?.postMessage('enable-official');}
 start(){return this.starting??=this.launch();}
 private async launch(){
  if(this.closed)return;
  this.state={state:'starting'};
  try{
   let config:z.infer<typeof settings>={version:1,enabled:true};
   try{const path=join(this.options.root,'codex-reconciliation-settings.json'),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error('Invalid recorder settings');config=settings.parse(JSON.parse(await readFile(path,'utf8')));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   if(this.closed)return;
   if(!config.enabled){this.state={state:'disabled'};return;}
   const output=config.output??join(this.options.root,'reconciliation','codex');
   this.worker=new Worker(new URL(import.meta.url.endsWith('.ts')?'./codex-reconciliation-worker.ts':'./codex-reconciliation-worker.js',import.meta.url),{workerData:{...this.options,output},...(import.meta.url.endsWith('.ts')?{execArgv:['--import','tsx/esm']}:{})});
   this.worker.on('message',(value:ReconciliationStatus)=>{this.state=value;});
   this.worker.on('error',()=>{this.state={state:'unavailable'};});
   this.exited=new Promise(resolve=>this.worker!.once('exit',()=>{if(this.closed)this.state={state:'stopped'};resolve();}));
   this.worker.unref();
  }catch{this.state={state:'unavailable'};console.warn('Codex 用量对账记录器暂不可用；已有日志已保留。');}
 }
 async close(){
  this.closed=true;await this.starting;
  if(!this.worker){this.state={state:'stopped'};return;}
  this.worker.postMessage('stop');
  let timer:ReturnType<typeof setTimeout>|undefined;
  await Promise.race([this.exited,new Promise<void>(resolve=>{timer=setTimeout(()=>{void this.worker!.terminate().then(()=>resolve());},10000);})]);
  clearTimeout(timer);this.state={state:'stopped'};
 }
}
