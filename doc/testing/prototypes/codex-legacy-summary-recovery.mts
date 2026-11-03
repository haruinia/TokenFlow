/** Differential probe: installed Codex and TokenFlow recover the same legacy
 * readable summary. All files, auth and inference are synthetic and temporary. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {stringify} from 'smol-toml';
import {codexModelCatalog} from '../../../packages/core/src/codex-model-catalog.js';
import {CodexContext} from '../../../packages/core/src/codex-context.js';
import {GatewayContext} from '../../../packages/core/src/gateway-context.js';
import {CODEX_SUMMARY_PREFIX} from '../../../packages/core/src/codex-rollout-history.js';
import {CodexHistoryEditor} from '../../../packages/core/src/codex-history-editor.js';
const engine='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const root=await mkdtemp(join(await realpath(tmpdir()),'tf-legacy-summary-')),home=join(root,'codex');await mkdir(home);
const model='fixture/summary',requests:any[]=[],events:any[]=[],pending=new Map<number,any>();let seq=0,buffer='',proc:any;
const server=createServer(async(req,res)=>{
 try{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);requests.push(body);
  const item={id:'msg_'+requests.length,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'PROBE_REPLY'}]};
  const response={id:'resp_'+requests.length,object:'response',status:'completed',model,output:[item],usage:{input_tokens:30,output_tokens:5,total_tokens:35}};
  res.writeHead(200,{'content-type':'text/event-stream'});res.end([{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
 }catch{res.writeHead(400);res.end();}
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const send=(m:any)=>proc.stdin.write(JSON.stringify(m)+'\n');
const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{
 const id=++seq,t=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout '+method));},20000);
 pending.set(id,{resolve:(v:any)=>{clearTimeout(t);resolve(v);},reject:(e:any)=>{clearTimeout(t);reject(e);}});send({id,method,params});
});
const start=async()=>{
 proc=spawn(engine,['app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});proc.stderr.resume();buffer='';
 proc.stdout.on('data',(c:any)=>{buffer+=c;let at;while((at=buffer.indexOf('\n'))>=0){let m;try{m=JSON.parse(buffer.slice(0,at));}catch{}buffer=buffer.slice(at+1);if(!m)continue;const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else events.push(m);}});
 await rpc('initialize',{clientInfo:{name:'tokenflow_legacy_summary_probe',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
};
const stop=async()=>{if(proc&&proc.exitCode===null)await new Promise<void>(r=>{proc.once('exit',()=>r());proc.kill();});};
const turn=async(id:string,text:string)=>{
 const at=events.length;await rpc('turn/start',{threadId:id,input:[{type:'text',text}]});
 for(let i=0;i<200;i++){const done=events.slice(at).find(e=>e.method==='turn/completed'&&e.params?.threadId===id);if(done){assert.equal(done.params.turn.status,'completed');return;}await new Promise(r=>setTimeout(r,100));}throw Error('Turn timeout');
};
const files=async(dir:string):Promise<string[]>=>{let out:string[]=[];for(const e of await readdir(dir,{withFileTypes:true})){const f=join(dir,e.name);if(e.isDirectory())out.push(...await files(f));else if(e.name.endsWith('.jsonl'))out.push(f);}return out;};
try{
 await writeFile(join(home,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'synthetic-only'}),{mode:0o600});
 await writeFile(join(root,'catalog.json'),JSON.stringify(codexModelCatalog([model])));
 await writeFile(join(home,'config.toml'),stringify({model,model_provider:'fixture',model_catalog_json:join(root,'catalog.json'),cli_auth_credentials_store:'file',web_search:'disabled',features:{apps:false},analytics:{enabled:false},model_providers:{fixture:{name:'Local synthetic inference',base_url:`http://127.0.0.1:${(server.address() as any).port}/v1`,wire_api:'responses',experimental_bearer_token:'synthetic-only',requires_openai_auth:false,supports_websockets:false}}}));
 await start();const thread=await rpc('thread/start',{cwd:root,model,modelProvider:'fixture',approvalPolicy:'never',sandbox:'read-only'}),id=thread.thread.id;
 await turn(id,'ORIGINAL_TASK');await stop();
 const path=(await files(join(home,'sessions'))).find(f=>f.includes(id));assert.ok(path);
 const before=await readFile(path,'utf8'),rows=before.trim().split('\n').map(l=>JSON.parse(l));
 const summary=CODEX_SUMMARY_PREFIX+'\nSAVED_LEGACY_SUMMARY: preserve API and validate the result.';
 const last=rows.at(-1)?.ordinal;
 const compact={timestamp:new Date().toISOString(),...(Number.isSafeInteger(last)?{ordinal:last+1}:{}),type:'compacted',payload:{message:summary,replacement_history:null}};
 await new CodexHistoryEditor(root,join(home,'config.toml')).rewrite((file,text)=>file===path?text.trimEnd()+'\n'+JSON.stringify(compact)+'\n':text,async()=>[]);
 await start();await rpc('thread/resume',{threadId:id,model,modelProvider:'fixture'});await turn(id,'AFTER_SUMMARY');await stop();
 const native=requests.at(-1).input;assert.ok(JSON.stringify(native).includes('SAVED_LEGACY_SUMMARY'));assert.ok(JSON.stringify(native).includes('ORIGINAL_TASK'));
 // Put the foreign checkpoint immediately after the saved summary, before any
 // new turn. Recovery must not include the later native continuation.
 const live=(await readFile(path,'utf8')).trim().split('\n'),index=live.findIndex(l=>JSON.parse(l).type==='compacted');assert.ok(index>=0);
 const token='synthetic-official-checkpoint',checkpoint={type:'compacted',payload:{message:'',replacement_history:[{type:'compaction',encrypted_content:token}]}};
 live.splice(index+1,0,JSON.stringify(checkpoint));const fixture=live.join('\n')+'\n';await writeFile(path,fixture);
 const context=new CodexContext(root,join(home,'config.toml'),await GatewayContext.open(root));
 const recovered=await context.recover({type:'compaction',encrypted_content:token},[]),text=JSON.stringify(recovered);
 assert.ok(text.includes('ORIGINAL_TASK'));assert.ok(text.includes('SAVED_LEGACY_SUMMARY'));assert.ok(!text.includes('AFTER_SUMMARY'));assert.ok(!text.includes('PROBE_REPLY'));assert.equal(await readFile(path,'utf8'),fixture);
 console.log(JSON.stringify({engineVersion:execFileSync(engine,['--version'],{encoding:'utf8'}).trim(),scope:'isolated HOME; installed native engine; synthetic local upstream/auth; no production history',nativeUsesLegacySummary:true,gatewayUsesSameSummary:true,retainsOriginalTask:true,excludesFutureTurn:true,sourceUnchanged:true,inferenceRequests:requests.length},null,2));
}finally{await stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true,maxRetries:3});}
