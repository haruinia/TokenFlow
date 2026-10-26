/** Installed Codex engine, real cached model metadata, synthetic auth/upstream.
 * No real account calls or changes to the user's config, login, or history.
 * node --import tsx scripts/codex-official-parity-smoke.mts [codex binary]
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,mkdir,rm,realpath} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {stringify} from 'smol-toml';
const binary=process.argv[2]&&!process.argv[2].startsWith('--')?process.argv[2]:'/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const cache=JSON.parse(await readFile(join(homedir(),'.codex/models_cache.json'),'utf8'));
const models=['gpt-6-astra','gpt-6.1-sol'].map(slug=>{
 const entry=cache.models.find((m:any)=>m.slug===slug);assert.ok(entry,`Missing cached model ${slug}`);return entry;
});
// Probe one provider with an official -> gateway -> official model sequence.
// The gateway is a synthetic alias, not an inference call to a real provider.
const mixedProbe=process.argv.includes('--mixed-compaction-probe');
if(mixedProbe)models.push({...models[1],slug:'tf-fixture-gateway',display_name:'Synthetic gateway model'});
const root=await mkdtemp(join(await realpath(tmpdir()),'tf-official-parity-'));
type Call={path:string;body:any;phase:string};
const calls:Call[]=[];let phase='',seq=0;
const marker='PARITY_HISTORY_MARKER';
const server=createServer(async(req,res)=>{
 try{
  const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);
  let raw=Buffer.concat(chunks);
  if(req.headers['content-encoding']==='zstd'){const {zstdDecompressSync}=await import('node:zlib');raw=zstdDecompressSync(raw);}
  const body=JSON.parse(raw.toString()||'{}');calls.push({path:req.url!,body,phase});
  if(req.url?.includes('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({models}));return;}
  const remote=body.input?.some((i:any)=>i.type==='compaction_trigger')||req.url?.endsWith('/compact');
  const n=++seq,item=remote?{type:'compaction',encrypted_content:'synthetic-official-checkpoint'}:
   {id:'msg_'+n,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic reply preserves '+marker,annotations:[]}]};
  const response={id:'resp_'+n,object:'response',created_at:Math.floor(Date.now()/1000),model:body.model,status:'completed',service_tier:body.service_tier??'default',output:[item],usage:{input_tokens:100,output_tokens:5,total_tokens:105}};
  if(!body.stream){res.setHeader('content-type','application/json');res.end(JSON.stringify(response));return;}
  const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
  res.setHeader('content-type','text/event-stream');res.end(events.map((e,i)=>'data: '+JSON.stringify({...e,sequence_number:i})+'\n\n').join(''));
 }catch{res.statusCode=500;res.end('Fixture error');}
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
const now=Math.floor(Date.now()/1000),claims={sub:'synthetic-user',iat:now,exp:now+3600,'https://api.openai.com/auth':{chatgpt_plan_type:'plus',chatgpt_account_id:'synthetic-account',user_id:'synthetic-user'}};
const jwt=Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.synthetic-signature';
const results:any[]=[];
async function scenario(name:string,provider:string,capabilities?:Record<string,unknown>){
 const home=join(root,name);await mkdir(home);
 const catalog=join(home,'catalog.json');await writeFile(catalog,JSON.stringify({models}));
 const config:any={model:models[0].slug,model_provider:provider,openai_base_url:origin+'/native/v1',model_catalog_json:catalog,model_reasoning_effort:'high',service_tier:'default',cli_auth_credentials_store:'file',features:{apps:false},analytics:{enabled:false}};
 if(provider!=='openai')config.model_providers={[provider]:{name:'TokenFlow',base_url:origin+'/codex/v1',wire_api:'responses',requires_openai_auth:true,supports_websockets:false,...(capabilities?{capabilities}:{})}};
 await writeFile(join(home,'config.toml'),stringify(config));
 await writeFile(join(home,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{id_token:jwt,access_token:jwt,refresh_token:'synthetic-refresh',account_id:'synthetic-account'},last_refresh:new Date().toISOString()}),{mode:0o600});
 const proc=spawn(binary,['app-server','--listen','stdio://'],{cwd:home,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,OPENAI_BASE_URL:origin+'/native/v1'},stdio:['pipe','pipe','pipe']});
 let buffer='',id=0,stderr='';const pending=new Map<number,any>(),events:any[]=[];
 proc.stderr.on('data',c=>{stderr=(stderr+c.toString()).slice(-4000);});
 proc.stdout.on('data',c=>{buffer+=c;let end;while((end=buffer.indexOf('\n'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);let msg;try{msg=JSON.parse(raw);}catch{continue;}const p=pending.get(msg.id);if(p){pending.delete(msg.id);msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result);}else if(msg.method)events.push(msg);}});
 const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error('RPC timeout '+method));},20000);pending.set(key,{resolve:(r:any)=>{clearTimeout(timer);resolve(r);},reject:(e:any)=>{clearTimeout(timer);reject(e);}});proc.stdin.write(JSON.stringify({id:key,method,params})+'\n');});
 const completed=async(start:number)=>{const until=Date.now()+20000;while(Date.now()<until){const e=events.slice(start).find(e=>e.method==='turn/completed');if(e){assert.equal(e.params.turn.status,'completed',JSON.stringify(e.params.turn.error));return;}await new Promise(r=>setTimeout(r,20));}throw Error('Turn completion timeout');};
 try{
  await rpc('initialize',{clientInfo:{name:'tokenflow_parity_fixture',version:'1'},capabilities:{experimentalApi:true}});proc.stdin.write('{"method":"initialized"}\n');
  const providerCaps=await rpc('modelProvider/capabilities/read',{});
  const start=await rpc('thread/start',{cwd:home,model:models[0].slug,approvalPolicy:'never',sandbox:'read-only'}),threadId=start.thread.id;
  const selections=mixedProbe?
   [models[0].slug,'tf-fixture-gateway',models[0].slug].map(model=>({model,effort:'high',serviceTier:'default'})):
   [{model:models[0].slug,effort:'low',serviceTier:'default'},{model:models[0].slug,effort:'high',serviceTier:'priority'},{model:models[1].slug,effort:'xhigh',serviceTier:'default'}];
  const observed=[];
  const transitions=[];
  for(const selection of selections){
   phase=name+':'+selection.effort;const first=calls.length,e=events.length;
   await rpc('turn/start',{threadId,...selection,input:[{type:'text',text:'Reply OK. Preserve '+marker}]});await completed(e);
   const c=calls.slice(first).filter(c=>c.body.model).at(-1)!;assert.ok(c,'No inference request');
   assert.equal(c.body.model,selection.model);assert.equal(c.body.reasoning?.effort,selection.effort);
   if(selection.serviceTier==='priority')assert.equal(c.body.service_tier,'priority');else assert.ok(c.body.service_tier==null||c.body.service_tier==='default');
   observed.push({model:c.body.model,effort:c.body.reasoning?.effort,tier:c.body.service_tier??'omitted/default',path:c.path});
   if(mixedProbe){
    phase=name+':compact:'+selection.model;const before=calls.length,ev=events.length;
    await rpc('thread/compact/start',{threadId});await completed(ev);
    const requests=calls.slice(before).filter(call=>call.body.model);
    assert.ok(requests.length,'Missing transition compaction');
    transitions.push(...requests.map(call=>({model:call.body.model,remoteTrigger:!!call.body.input?.some((item:any)=>item.type==='compaction_trigger'),localSummaryPrompt:JSON.stringify(call.body.input).includes('CONTEXT CHECKPOINT COMPACTION')})));
   }
  }
  phase=name+':compact';const first=calls.length,e=events.length;
  await rpc('thread/compact/start',{threadId});await completed(e);
  const compact=calls.slice(first).filter(c=>c.body.model).map(c=>({path:c.path,model:c.body.model,remoteTrigger:!!c.body.input?.some((i:any)=>i.type==='compaction_trigger'),localSummaryPrompt:JSON.stringify(c.body.input).includes('CONTEXT CHECKPOINT COMPACTION')}));
  assert.ok(compact.length,'No compaction request');
  const result={scenario:name,provider,providerCaps,selectionPassthrough:true,observed,compaction:compact,...(mixedProbe?{transitions}:{})};results.push(result);console.log(JSON.stringify(result));
 }catch(error){console.log(JSON.stringify({scenario:name,failed:true,error:String(error),stderr:stderr.replaceAll(jwt,'<REDACTED>')}));throw error;}
 finally{await new Promise<void>(r=>{if(proc.exitCode!==null||proc.signalCode!==null)return r();proc.once('exit',()=>r());proc.kill();});}
}
try{
 if(mixedProbe){
  await scenario('mixed-local','token_flow',{remote_compaction:'unsupported'});
  await scenario('mixed-remote','token_flow',{remote_compaction:'v2'});
  assert.deepEqual(results[0].transitions.map((c:any)=>c.model),[models[0].slug,'tf-fixture-gateway',models[0].slug]);
  assert.deepEqual(results[1].transitions.map((c:any)=>c.model),[models[0].slug,'tf-fixture-gateway',models[0].slug]);
  assert.ok(results[0].transitions.every((c:any)=>!c.remoteTrigger&&c.localSummaryPrompt));
  assert.ok(results[1].transitions.every((c:any)=>c.remoteTrigger&&!c.localSummaryPrompt));
  const report={probeCompleted:true,automaticPerModelCapabilitySplit:false,scope:'Installed engine; one provider; official/gateway/official aliases; synthetic auth/upstream; manual compaction; no production changes',results};
  const outIndex=process.argv.indexOf('--out');if(outIndex>=0)await writeFile(process.argv[outIndex+1],JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
 }else{
 await scenario('native','openai');
 await scenario('current-coexist','token_flow');
 await scenario('explicit-remote-compaction','token_flow',{remote_compaction:'v2'});
 const remote=(result:any)=>result.compaction.every((c:any)=>c.remoteTrigger&&!c.localSummaryPrompt);
 assert.ok(remote(results[0]),'Native provider did not trigger remote compaction');
 assert.ok(remote(results[2]),'Explicit capability did not restore remote compaction');
 const report={probeCompleted:true,currentCompactionMatchesNative:remote(results[1])===remote(results[0]),explicitCapabilityMatchesNative:remote(results[2])===remote(results[0]),scope:'Installed Codex engine; synthetic upstream/auth; explicit compaction, not automatic threshold; no real OpenAI inference',results};
 console.log(JSON.stringify(report));
 const outIndex=process.argv.indexOf('--out');if(outIndex>=0)await writeFile(process.argv[outIndex+1],JSON.stringify(report,null,2)+'\n');
 if(process.argv.includes('--require-native-compaction'))assert.ok(report.currentCompactionMatchesNative,'Current coexist configuration uses local summary compaction instead of native remote compaction');
 }
}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
