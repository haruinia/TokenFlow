import {parentPort,workerData} from 'node:worker_threads';
import {writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {CodexReconciliationRecorder} from './codex-reconciliation.js';
import {migrationBinary} from './codex-runtime.js';
import type {ReconciliationMonitorOptions,ReconciliationStatus} from './codex-reconciliation-monitor.js';

const options=workerData as ReconciliationMonitorOptions&{output:string};
const interval=options.intervalMs??60000,officialInterval=options.officialIntervalMs??15*60000;
let recorder:CodexReconciliationRecorder|undefined,stop=false,wake:(()=>void)|undefined,officialAt=0;
const abort=new AbortController();
parentPort?.on('message',message=>{if(message==='stop'){stop=true;abort.abort();wake?.();}else if(message==='enable-official'){options.allowOfficial=true;wake?.();}});
const publish=async(state:ReconciliationStatus)=>{
 const value={...state,at:new Date().toISOString()};parentPort?.postMessage(value);
 const path=join(options.root,'codex-reconciliation-status.json'),tmp=path+'.tmp';
 try{await writeFile(tmp,JSON.stringify(value)+'\n',{mode:0o600});await rename(tmp,path);}catch{/* Recording must not depend on a UI status file. */}
};
try{
 while(!stop){
  try{
   recorder??=await CodexReconciliationRecorder.open({output:options.output,codexHome:options.codexHome,dataRoot:options.root,intervalMs:interval});
   const snapshot=await recorder.scan();let official:ReconciliationStatus['official']=options.allowOfficial?undefined:'skipped';
   await publish({state:'recording',responses:snapshot.uniqueResponses,official});
   if(options.allowOfficial&&!stop&&Date.now()-officialAt>=officialInterval){
    // Resolve every period so installing/updating Codex does not require a TokenFlow restart.
    try{official=await recorder.officialSnapshot(await migrationBinary(),Date.now(),Date.now,{signal:abort.signal,proxyURL:options.proxyURL})?'available':'unavailable';}catch{official='unavailable';}
    officialAt=Date.now();await publish({state:'recording',responses:snapshot.uniqueResponses,official});
   }
  }catch{await publish({state:'retrying'});}
  if(!stop)await new Promise<void>(done=>{const timer=setTimeout(()=>{wake=undefined;done();},interval);wake=()=>{clearTimeout(timer);wake=undefined;done();};});
 }
}finally{
 try{if(recorder){await recorder.scan().catch(()=>{});await recorder.close(Date.now(),'signal');}}finally{await publish({state:'stopped'});parentPort?.close();}
}
