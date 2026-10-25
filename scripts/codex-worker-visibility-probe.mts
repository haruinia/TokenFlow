/** Research only: installed official engine, isolated homes, synthetic loopback inference.
 * Compares ephemeral/shared-engine tasks with separate official worker processes.
 * Does not change the user's Codex configuration, credentials, history, or app.
 */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createServer,type ServerResponse} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {stringify} from 'smol-toml';
import {codexModelCatalog} from '../packages/core/src/codex-model-catalog.ts';

const binary='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const root=await mkdtemp(join(tmpdir(),'tf-worker-visibility-'));
const mainHome=join(root,'main'),privateHome=join(root,'private-workers');
const processes:Engine[]=[],requests:any[]=[],checks:any[]=[];
let held:ServerResponse|undefined,mode='reply',responseId=0;
const fixture=createServer(async(req,res)=>{
 try{
  if(req.method!=='POST'){res.writeHead(404);res.end();return;}
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw),id=++responseId;
  requests.push({path:req.url,model:body.model,mode,hasFirstMarker:JSON.stringify(body.input).includes('FIRST_WORKER_MARKER'),gatewayCredential:req.headers.authorization==='Bearer fixture-gateway'});
  if(mode==='hold'){held=res;return;}
  if(mode==='fail'){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic worker failure',type:'invalid_request_error'}}));return;}
  const item={id:'msg_'+id,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'FIXTURE_OK',annotations:[]}]};
  const response={id:'resp_'+id,status:'completed',model:body.model,output:[item],usage:{input_tokens:100,output_tokens:5,total_tokens:105}};
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end([{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
 }catch{res.writeHead(500);res.end('Fixture failed');}
});
await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${(fixture.address() as any).port}`;
const catalog=join(root,'models.json');await writeFile(catalog,JSON.stringify(codexModelCatalog(['fixture-official','fixture-gateway'])));
async function prepare(home:string){
 await mkdir(home,{recursive:true});
 await writeFile(join(home,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'fixture-official'}),{mode:0o600});
 await writeFile(join(home,'config.toml'),stringify({model:'fixture-official',model_provider:'openai',openai_base_url:base+'/official/v1',model_catalog_json:catalog,cli_auth_credentials_store:'file',features:{apps:false},analytics:{enabled:false},model_providers:{token_flow:{name:'Fixture gateway',base_url:base+'/gateway/v1',wire_api:'responses',experimental_bearer_token:'fixture-gateway',requires_openai_auth:false,capabilities:{remote_compaction:'unsupported'}}}}));
}
const wait=async(check:()=>boolean,label:string)=>{for(let i=0;i<400;i++){if(check())return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+label);};
class Engine {
 events:any[]=[];private seq=0;private pending=new Map<number,any>();private buffer='';
 proc:ReturnType<typeof spawn>;
 constructor(home:string){
  this.proc=spawn(binary,['app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home,OPENAI_BASE_URL:base+'/official/v1'},stdio:['pipe','pipe','pipe']});
  this.proc.stderr!.resume();
  this.proc.stdout!.on('data',c=>{this.buffer+=c;let at;while((at=this.buffer.indexOf('\n'))>=0){let m;try{m=JSON.parse(this.buffer.slice(0,at));}catch{}this.buffer=this.buffer.slice(at+1);if(!m)continue;const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else this.events.push(m);}});
  processes.push(this);
 }
 rpc(method:string,params:any){return new Promise<any>((resolve,reject)=>{const id=++this.seq,t=setTimeout(()=>{this.pending.delete(id);reject(Error('RPC timeout '+method));},15000);this.pending.set(id,{resolve:(v:any)=>{clearTimeout(t);resolve(v);},reject:(e:any)=>{clearTimeout(t);reject(e);}});this.proc.stdin!.write(JSON.stringify({id,method,params})+'\n');});}
 async init(){await this.rpc('initialize',{clientInfo:{name:'worker_visibility_probe',version:'1'},capabilities:{experimentalApi:true}});this.proc.stdin!.write('{"method":"initialized"}\n');return this;}
 async close(){if(this.proc.exitCode===null&&this.proc.signalCode===null)await new Promise<void>(r=>{this.proc.once('exit',()=>r());this.proc.kill();});}
 async turn(threadId:string,text:string,status='completed'){
  const from=this.events.length,r=await this.rpc('turn/start',{threadId,input:[{type:'text',text}]});
  await wait(()=>this.events.slice(from).some(e=>e.method==='turn/completed'&&e.params?.turn?.id===r.turn.id),'turn '+status);
  assert.equal(this.events.slice(from).find(e=>e.method==='turn/completed'&&e.params?.turn?.id===r.turn.id).params.turn.status,status);
 }
}
async function rollouts(home:string){const paths:string[]=[];const walk=async(dir:string)=>{let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{return;}for(const e of entries){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else if(e.name.endsWith('.jsonl'))paths.push(p);}};await walk(join(home,'sessions'));return paths;}
const listed=async(engine:Engine,id:string)=>(await engine.rpc('thread/list',{limit:100,modelProviders:['openai','token_flow'],sourceKinds:['cli','vscode','exec','appServer','subAgent','subAgentThreadSpawn','unknown']})).data.some((t:any)=>t.id===id);
let error:string|undefined;
try{
 await prepare(mainHome);await prepare(privateHome);
 const main=await new Engine(mainHome).init();
 const parent=await main.rpc('thread/start',{model:'fixture-official',modelProvider:'openai',cwd:root,approvalPolicy:'never',sandbox:'read-only'});
 await main.turn(parent.thread.id,'PARENT_ONLY');assert.ok(await listed(main,parent.thread.id));
 for(const variant of ['same-engine-ephemeral','separate-engine-ephemeral','separate-engine-private-persistent']){
  const ephemeral=!variant.endsWith('persistent'),home=ephemeral?mainHome:privateHome;
  let worker=variant.startsWith('same-')?main:await new Engine(home).init();
  const parentEventsFrom=main.events.length;
  const child=await worker.rpc('thread/start',{model:'fixture-gateway',modelProvider:'token_flow',cwd:root,approvalPolicy:parent.approvalPolicy,sandbox:'read-only',ephemeral});
  const id=child.thread.id;assert.equal(child.modelProvider,'token_flow');assert.deepEqual(child.sandbox,parent.sandbox);assert.deepEqual(child.approvalPolicy,parent.approvalPolicy);
  await worker.turn(id,'FIRST_WORKER_MARKER');await worker.turn(id,'Recall the earlier marker.');
  assert.equal(requests.at(-1).hasFirstMarker,true);
  const parentReceivedWorkerStart=main.events.slice(parentEventsFrom).some(e=>e.method==='thread/started'&&e.params?.thread?.id===id);
  const normalListContainsWorker=await listed(main,id),ownListContainsWorker=await listed(worker,id);
  const persisted=(await rollouts(home)).some(p=>p.includes(id));
  assert.equal(normalListContainsWorker,false);assert.equal(ownListContainsWorker,!ephemeral);assert.equal(persisted,!ephemeral);
  assert.equal(parentReceivedWorkerStart,variant.startsWith('same-'));
  // Interrupt must abort the underlying worker HTTP request.
  mode='hold';held=undefined;const cancelFrom=worker.events.length;
  const running=await worker.rpc('turn/start',{threadId:id,input:[{type:'text',text:'Wait for cancellation.'}]});await wait(()=>!!held,'held HTTP');
  await worker.rpc('turn/interrupt',{threadId:id,turnId:running.turn.id});
  await wait(()=>!!held?.destroyed,'HTTP abort');await wait(()=>worker.events.slice(cancelFrom).some(e=>e.method==='turn/completed'&&e.params?.turn?.id===running.turn.id),'interrupt event');
  assert.equal(worker.events.slice(cancelFrom).find(e=>e.method==='turn/completed'&&e.params?.turn?.id===running.turn.id).params.turn.status,'interrupted');
  mode='fail';await worker.turn(id,'Trigger synthetic failure.','failed');mode='reply';
  let resumeAfterRestart:boolean|undefined;
  if(worker!==main){
   await worker.close();worker=await new Engine(home).init();
   try{const resumed=await worker.rpc('thread/resume',{threadId:id});assert.equal(resumed.modelProvider,'token_flow');resumeAfterRestart=true;}catch{resumeAfterRestart=false;}
   assert.equal(resumeAfterRestart,!ephemeral);
   if(resumeAfterRestart){await worker.turn(id,'Recall the original marker after restart.');assert.equal(requests.at(-1).hasFirstMarker,true);}
   await worker.close();
  }
  const check={variant,provider:child.modelProvider,nativeParentEdge:child.thread.parentThreadId??null,permissionsMatch:true,parentReceivedWorkerStart,normalListContainsWorker,ownListContainsWorker,rolloutPersisted:persisted,followupHasContext:true,cancellationAbortsHTTP:true,failureReported:true,...(resumeAfterRestart===undefined?{}:{resumeAfterRestart})};checks.push(check);console.log(JSON.stringify(check));
 }
 await main.turn(parent.thread.id,'PARENT_STILL_WORKS');assert.equal((await main.rpc('thread/read',{threadId:parent.thread.id})).thread.modelProvider,'openai');
 assert.ok(requests.filter(r=>r.model==='fixture-gateway').every(r=>r.path.startsWith('/gateway/')&&r.gatewayCredential));
 assert.ok(requests.filter(r=>r.model==='fixture-official').every(r=>r.path.startsWith('/official/')&&!r.gatewayCredential));
}catch(e){error=e instanceof Error?e.message:'Probe failed';process.exitCode=1;}
finally{held?.destroy();for(const p of processes)await p.close();fixture.closeAllConnections();await new Promise<void>(r=>fixture.close(()=>r()));await rm(root,{recursive:true,force:true});}
const report={passed:!error,engine:execFileSync(binary,['--version'],{encoding:'utf8'}).trim(),scope:'Official engine; isolated homes; synthetic loopback responses; no desktop UI test or real model inference',...(error?{error}:{}),checks,requestCount:requests.length};
console.log(JSON.stringify(report));const out=process.argv.indexOf('--out');if(out>=0)await writeFile(resolve(process.argv[out+1]),JSON.stringify(report,null,2)+'\n');
