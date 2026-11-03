/** Installed Codex picker, isolated home and unreachable fixture upstream; no inference. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {stringify} from 'smol-toml';
import {codexModelCatalog} from '../packages/core/src/codex-model-catalog.ts';
import {qoderSelectedCapabilities} from '../packages/core/src/qoder-model-capabilities.ts';
const root=await mkdtemp(join(tmpdir(),'qoder-codex-options-')),home=join(root,'home');await mkdir(home);
const model='qoder/dfmodel',cap=qoderSelectedCapabilities(model,{contextWindow:200000,contextWindows:[200000,400000,1000000],reasoning:{levels:['none','low','high','max'],default:'high'}},1000000)!;
const catalog=join(root,'models.json');await writeFile(catalog,JSON.stringify(codexModelCatalog(model,{}, {},{}, {[model]:cap})));
await writeFile(join(home,'config.toml'),stringify({model,model_provider:'token_flow',model_catalog_json:catalog,analytics:{enabled:false},features:{apps:false},model_providers:{token_flow:{name:'Fixture',base_url:'http://127.0.0.1:1/v1',wire_api:'responses',experimental_bearer_token:'fixture'}}}));
const proc=spawn('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',['app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});proc.stderr.resume();
let seq=0,buffer='';const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
proc.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){let msg;try{msg=JSON.parse(buffer.slice(0,i));}catch{}buffer=buffer.slice(i+1);const p=pending.get(msg?.id);if(p){pending.delete(msg.id);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result);}}});
const rpc=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout'));},15000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});proc.stdin.write(JSON.stringify({id,method,params})+'\n');});
try{
 await rpc('initialize',{clientInfo:{name:'qoder_options_probe',version:'1'},capabilities:{experimentalApi:true}});proc.stdin.write('{"method":"initialized"}\n');
 const result=await rpc('model/list',{limit:100,includeHidden:true});const entry=result.data.find((m:any)=>m.model===model);assert.ok(entry,'Qoder model missing');
 const efforts=entry.supportedReasoningEfforts.map((r:any)=>r.reasoningEffort);
 assert.deepEqual(efforts,['none','low','high','max']);assert.equal(entry.defaultReasoningEffort,'high');
 console.log(JSON.stringify({passed:true,scope:'installed Codex model/list, no inference',model,efforts,defaultEffort:entry.defaultReasoningEffort,configuredContext:cap.contextWindow,configuredCompaction:cap.autoCompactTokenLimit}));
}finally{if(proc.exitCode===null&&proc.signalCode===null)await new Promise<void>(r=>{proc.once('exit',()=>r());proc.kill();});await rm(root,{recursive:true,force:true});}
