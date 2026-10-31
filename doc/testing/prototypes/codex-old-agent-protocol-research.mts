import {portableCodexItem} from '../../../packages/core/src/codex-history-items.js';
import {nativeAgentDiscovery} from '../../../packages/core/src/codex-unified-agent-catalog.js';
/** Installed native engine + isolated home. No production configuration/history changes.
 * Default is synthetic transport; --live-child sends only the test child to the current gateway.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {parse,stringify} from 'smol-toml';
import {randomUUID} from 'node:crypto';
import {AgentConnections} from '../../../packages/core/src/agent-connections.js';
const current:any={};
const {codexModelCatalog}=await import('../../../packages/core/src/codex-model-catalog.js');
const catalog:any=codexModelCatalog(['gpt-6.1-sol','fixture/deepseek']);
for(const model of catalog.models)model.multi_agent_version='v2';
catalog.tokenflow_gateway_models=['fixture/deepseek'];
const childModel='fixture/deepseek';
const parentModel='gpt-6.1-sol';
const liveParent=false; // No production credentials or real model requests in this harness.
const live=false,catalogContext=true;
const product=false;
const nativeV1=false;
if(nativeV1&&!product)for(const model of catalog.models)model.multi_agent_version='v1';
const auth=undefined;
const root=await mkdtemp(join(await realpath(tmpdir()),'tf-native-unified-')),home=join(root,'codex');await mkdir(home);
const events:any[]=[],calls:any[]=[],results:any[]=[],pending=new Map<number,any>();const transportErrors:string[]=[];let phase='initial',issued=false,seq=0,childId='',advertised=false;let toolShape:any;
const server=createServer(async(req,res)=>{try{
 let raw='';for await(const b of req)raw+=b;const body=nativeAgentDiscovery(JSON.parse(raw));
 const plainTask=JSON.stringify((body.input??[]).map((i:any)=>({type:i.type,content:i.content?.filter?.((p:any)=>p.type!=='encrypted_content')})));
 calls.push({phase,model:body.model,compact:body.input?.some((i:any)=>i.type==='compaction_trigger')??false,...(body.model===childModel?{taskMarkerPresent:plainTask.includes('CHILD_PROBE_OK'),encryptedAgentMessage:body.input?.some((i:any)=>i.type==='agent_message'&&i.content?.some((p:any)=>p.type==='encrypted_content')),toolNames:body.input?.filter((i:any)=>i.type==='function_call').map((i:any)=>i.name)}:{})});
 if(body.model===parentModel&&calls.filter(c=>c.model===parentModel).length===1)advertised=JSON.stringify(body).includes(childModel);
 if(body.model===childModel&&live||body.model===parentModel&&liveParent){
  assert.ok(calls.length<=16,'Probe request limit reached');
  const headers:any={'content-type':'application/json',...current.model_providers.token_flow.http_headers};
  if(body.model===parentModel){headers.authorization='Bearer '+auth.tokens.access_token;headers['chatgpt-account-id']=auth.tokens.account_id;for(const name of ['user-agent','version','originator','openai-beta'])if(req.headers[name])headers[name]=req.headers[name];}
  const upstream=await fetch(current.model_providers.token_flow.base_url+'/responses',{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
  const record=calls.filter(c=>c.model===body.model).at(-1);record.httpStatus=upstream.status;if(!upstream.ok){const error=await upstream.clone().json().catch(()=>null);record.errorCode=error?.error?.code??error?.error?.type;}
  res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});
  for await(const chunk of upstream.body??[])res.write(chunk);res.end();return;
 }
 if(body.model===childModel){for(const item of body.input??[])portableCodexItem(item);}
 const declarations=[...(body.tools??[]),...(body.input??[]).flatMap((i:any)=>i.tools??[])];
 const tools=declarations.flatMap((t:any)=>t.type==='namespace'?t.tools.map((x:any)=>({...x,namespace:t.name})):[t]);
 calls.at(-1).nativeProtocol=tools.some((t:any)=>t.name==='followup_task')?'v2':'v1';
 calls.at(-1).dispatchResults=body.model===parentModel?(body.input??[]).filter((i:any)=>i.type==='function_call_output'&&i.call_id==='probe_spawn_'+phase).map((i:any)=>i.output):[];
 const tool=tools.find((t:any)=>t.name==='spawn_agent');
 toolShape??=declarations.map((t:any)=>({type:t.type,name:t.name,keys:Object.keys(t),nested:t.tools?.map((f:any)=>f.name)}));
 if(body.model===parentModel){if(!issued)advertised=JSON.stringify(declarations).includes(childModel)||JSON.stringify(body.input).includes(childModel);for(const i of body.input??[])if(i.type==='function_call_output'&&i.call_id==='probe_spawn'&&!results.length)results.push(i.output);}
 let item:any={id:'msg_'+calls.length,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:body.model===childModel?'CHILD_PROBE_OK':'PARENT_PROBE_OK',annotations:[]}]};
 if(body.model===parentModel&&!issued){assert.ok(tool,'No native spawn_agent tool');issued=true;const modern=tools.some((t:any)=>t.name==='followup_task');item={id:'fc_probe_'+phase,type:'function_call',call_id:'probe_spawn_'+phase,name:tool.name,...(tool.namespace?{namespace:tool.namespace}:{}),arguments:JSON.stringify(modern?{task_name:'deepseek_probe_'+phase.replaceAll('-','_'),fork_turns:'none',model:childModel,message:'This is an isolated connectivity test. Do not use tools or inspect files. Reply exactly CHILD_PROBE_OK.'}:{model:childModel,fork_context:false,message:'This is an isolated connectivity test. Do not use tools or inspect files. Reply exactly CHILD_PROBE_OK.'}),status:'completed'};}
 const response={id:'resp_'+calls.length,object:'response',status:'completed',model:body.model,output:[item],usage:{input_tokens:30,output_tokens:5,total_tokens:35}};
 res.writeHead(200,{'content-type':'text/event-stream'});res.end([{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
}catch(e){const message=e instanceof Error?e.message:'probe failure';transportErrors.push(message);res.writeHead((e as any)?.status??(e as any)?.statusCode??400);res.end(JSON.stringify({error:{message,code:(e as any)?.code}}));}});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
await writeFile(join(root,'catalog.json'),JSON.stringify(catalog));
await writeFile(join(home,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'probe-only'}),{mode:0o600});
await writeFile(join(home,'config.toml'),stringify({model:parentModel,web_search:'disabled',model_provider:'token_flow',model_catalog_json:join(root,'catalog.json'),cli_auth_credentials_store:'file',features:{apps:false,multi_agent:true,multi_agent_v2:!nativeV1,model_catalog_in_context:catalogContext},analytics:{enabled:false},model_providers:{token_flow:{name:'TokenFlow probe',base_url:`http://127.0.0.1:${(server.address() as any).port}/v1`,wire_api:'responses',experimental_bearer_token:'probe-only',requires_openai_auth:false,supports_websockets:false,capabilities:{remote_compaction:'v2'}}}}));
if(product){
 const connections=new AgentConnections(root,{codex:join(home,'config.toml')},async()=>[]);
 const gateways=new Set<string>(catalog.tokenflow_gateway_models);const choices=[...gateways].map(model=>({model,sourceId:'a'.repeat(24)}));
 const status=(await connections.status()).find(t=>t.id==='codex')!;
 await connections.apply({target:'codex',revision:status.revision,origin:`http://127.0.0.1:${(server.address() as any).port}`,model:childModel,sourceId:'a'.repeat(24),keyId:randomUUID(),key:'probe-only',selections:choices,modelLabels:Object.fromEntries(catalog.models.map((m:any)=>[m.slug,m.display_name])),officialCatalog:{models:catalog.models.filter((m:any)=>!gateways.has(m.slug))}});
}
const engine='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
let proc=spawn(engine,['app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});proc.stderr.resume();let buffer='';
const send=(m:any)=>proc.stdin.write(JSON.stringify(m)+'\n');
const attach=()=>proc.stdout.on('data',c=>{buffer+=c;let at;while((at=buffer.indexOf('\n'))>=0){let m;try{m=JSON.parse(buffer.slice(0,at));}catch{}buffer=buffer.slice(at+1);if(!m)continue;const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else events.push(m);}});attach();
const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const id=++seq,t=setTimeout(()=>{pending.delete(id);reject(Error('timeout '+method));},20000);pending.set(id,{resolve:(v:any)=>{clearTimeout(t);resolve(v);},reject:(e:any)=>{clearTimeout(t);reject(e);}});send({id,method,params});});
const wait=async(check:()=>boolean)=>{for(let i=0;i<1200;i++){if(check())return;await new Promise(r=>setTimeout(r,100));}throw Error('timeout waiting native turn');};
const report:any={engine,childModel,scope:liveParent?'native engine, real official parent and configured gateway child':live?'native engine, deterministic parent, real Qiniu DeepSeek child':'native engine, deterministic local transport',catalogContext,nativeV1,productConfig:product};
try{
 await rpc('initialize',{clientInfo:{name:'tokenflow_native_probe',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
 const p=await rpc('thread/start',{cwd:root,model:parentModel,modelProvider:'token_flow',approvalPolicy:'never',sandbox:'read-only'});
 await rpc('turn/start',{threadId:p.thread.id,input:[{type:'text',text:product?`这是已授权的隔离集成测试。请派发一个${process.env.TF_PROBE_CHILD_NAME??'七牛的 DeepSeek Flash'}子代理，给它独立的新任务，不继承完整对话。任务是：不要使用工具或读取文件，计算 17 乘 19，仅回复 CHILD_PROBE_OK 和结果。等待它完成并转告答案。请使用原生子代理，只派发一个，不读取文件。`:liveParent?`This is an authorized isolated integration test. Use native spawn_agent exactly once with model ${childModel}, ${nativeV1?'fork_context false':'task_name deepseek_probe, fork_turns none'}. This exact model is in the loaded catalog and uses the same token_flow provider; the tool description only shows the first five models and is not an exhaustive allowlist. Give the child this exact task: Do not use tools or inspect files. Compute 17 times 19 and reply CHILD_PROBE_OK followed by the number. Wait for its answer and report it. Do not create other agents or inspect files.`:'Run the native spawn test.'}]});
 await wait(()=>events.some(e=>e.method==='turn/completed'&&e.params?.threadId===p.thread.id));
 const loadedIds=await rpc('thread/loaded/list',{});
 let child:any;for(const id of loadedIds.data??[])if(id!==p.thread.id){const r=await rpc('thread/read',{threadId:id});if(r.thread.source?.subagent?.thread_spawn?.parent_thread_id===p.thread.id||r.thread.parentThreadId===p.thread.id)child=r.thread;}
 report.loaded=loadedIds.data.length;
 report.advertised=advertised;report.spawnResults=results;report.childCreated=!!child;
 if(child){childId=child.id;await wait(()=>events.some(e=>e.method==='turn/completed'&&e.params?.threadId===childId));const loaded=await rpc('thread/read',{threadId:childId,includeTurns:true});const terminal=events.filter(e=>e.method==='turn/completed'&&e.params?.threadId===childId).at(-1);report.childProvider=loaded.thread.modelProvider;report.parentRelation=loaded.thread.parentThreadId===p.thread.id||loaded.thread.source?.subagent?.thread_spawn?.parent_thread_id===p.thread.id;report.childStatus=terminal.params.turn.status;report.childError=terminal.params.turn.error;report.childReply=loaded.thread.turns.flatMap((t:any)=>t.items??[]).filter((i:any)=>i.type==='agentMessage').map((i:any)=>i.text);}
 report.calls=calls;report.firstChildTaskVisible=calls.find(c=>c.model===childModel)?.taskMarkerPresent;assert.ok(child,'Native child not created');if(live){assert.ok(report.firstChildTaskVisible,'Task missing from first child plaintext input');assert.match(JSON.stringify(report.childReply),/CHILD_PROBE_OK/,'Child did not receive the test task');}if(!liveParent)assert.ok(report.advertised,'Gateway child absent from native tool catalog');
 if(liveParent&&nativeV1){
  let at=events.length;await rpc('thread/compact/start',{threadId:childId});await wait(()=>events.slice(at).some(e=>e.method==='turn/completed'&&e.params?.threadId===childId));
  report.compactStatus=events.slice(at).find(e=>e.method==='turn/completed'&&e.params?.threadId===childId)?.params.turn.status;assert.equal(report.compactStatus,'completed');
  at=events.length;await rpc('turn/start',{threadId:p.thread.id,input:[{type:'text',text:`Use native send_input to the existing child ${childId}. Ask it to recall its previous multiplication result and reply FOLLOWUP_OK followed by that result. Tell it not to use tools or inspect files. Wait for the child and report its answer. Do not create another child.`}]});
  await wait(()=>events.slice(at).some(e=>e.method==='turn/completed'&&e.params?.threadId===p.thread.id));
  const state=await rpc('thread/read',{threadId:childId,includeTurns:true});report.followupReply=state.thread.turns.flatMap((t:any)=>t.items??[]).filter((i:any)=>i.type==='agentMessage').map((i:any)=>i.text).at(-1);assert.match(report.followupReply,/FOLLOWUP_OK\s+323/);
  report.nativeFollowupAfterCompact=true;
 }

 report.initial={childStatus:report.childStatus,firstChildTaskVisible:report.firstChildTaskVisible,error:report.childError};
 for(const model of catalog.models)model.multi_agent_version='v1';
 await writeFile(join(root,'catalog.json'),JSON.stringify(catalog));
 const conf:any=parse(await readFile(join(home,'config.toml'),'utf8'));conf.features.multi_agent_v2=false;
 await writeFile(join(home,'config.toml'),stringify(conf));
 report.phases=[];
 for(const stage of ['loaded-config-updated','unsubscribe-resume','restart-resume']){
  phase=stage;issued=false;const beforeCalls=calls.length,ev=events.length;
  const beforeIds=(await rpc('thread/loaded/list',{})).data;
  if(stage==='restart-resume'){
   await new Promise<void>(r=>{proc.once('exit',()=>r());proc.kill();});
   proc=spawn(engine,['app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});proc.stderr.resume();buffer='';attach();
   await rpc('initialize',{clientInfo:{name:'tokenflow_native_probe',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
   await rpc('thread/resume',{threadId:p.thread.id,model:parentModel,modelProvider:'token_flow'});
  }
  if(stage==='unsubscribe-resume'){
   report.unsubscribe=await rpc('thread/unsubscribe',{threadId:p.thread.id});
   await rpc('thread/resume',{threadId:p.thread.id,model:parentModel,modelProvider:'token_flow',config:{'features.multi_agent_v2':false}});
  }
  await rpc('turn/start',{threadId:p.thread.id,input:[{type:'text',text:'Run the native spawn test again with a fresh child.'}]});
  await wait(()=>events.slice(ev).some(e=>e.method==='turn/completed'&&e.params?.threadId===p.thread.id));
  const nowIds=(await rpc('thread/loaded/list',{})).data;
  const ids=nowIds.filter((id:string)=>!beforeIds.includes(id));
  for(const id of ids)await wait(()=>events.slice(ev).some(e=>e.method==='turn/completed'&&e.params?.threadId===id));
  report.phases.push({phase:stage,newChildren:ids.length,requests:structuredClone(calls.slice(beforeCalls)),terminal:events.slice(ev).filter(e=>e.method==='turn/completed').map(e=>({root:e.params?.threadId===p.thread.id,status:e.params?.turn?.status,error:e.params?.turn?.error}))});
 }

 phase='fresh-thread-v1';issued=false;const beforeCalls=calls.length,ev=events.length;
 const fresh=await rpc('thread/start',{cwd:root,model:parentModel,modelProvider:'token_flow',approvalPolicy:'never',sandbox:'read-only'});
 await rpc('turn/start',{threadId:fresh.thread.id,input:[{type:'text',text:'Run the native spawn test with a fresh child.'}]});
 await wait(()=>events.slice(ev).some(e=>e.method==='turn/completed'&&e.params?.threadId===fresh.thread.id));
 await wait(()=>calls.slice(beforeCalls).some(c=>c.model===childModel));
 report.phases.push({phase,newChildren:1,requests:structuredClone(calls.slice(beforeCalls))});
 const old=await rpc('thread/read',{threadId:p.thread.id,includeTurns:false});report.oldThreadMetadata=old.thread;
 const {readdir}=await import('node:fs/promises');
 const walk=async(d:string):Promise<string[]>=>{const out:string[]=[];for(const e of await readdir(d,{withFileTypes:true})){const q=join(d,e.name);if(e.isDirectory())out.push(...await walk(q));else if(e.name.includes(p.thread.id)&&e.name.endsWith('.jsonl'))out.push(q);}return out;};
 report.savedMetadata=[];
 for(const f of await walk(join(home,'sessions'))){const lines=(await readFile(f,'utf8')).trim().split('\n').map(l=>JSON.parse(l));report.savedMetadata.push({sessionMeta:lines.find(l=>l.type==='session_meta'),turnContexts:lines.filter(l=>l.type==='turn_context').map(l=>({keys:Object.keys(l.payload??{}),features:l.payload?.features,multi_agent_version:l.payload?.multi_agent_version,modelInfo:l.payload?.model_info}))});}

 await new Promise<void>(r=>{proc.once('exit',()=>r());proc.kill();});
 const ownRollouts=await walk(join(home,'sessions'));let changedMetadata=0,unchangedContent=true;
 for(const f of ownRollouts){
  assert.ok(f.startsWith(home+'/'));const before=await readFile(f,'utf8');
  const prior=before.split('\n');const after=prior.map(line=>{if(!line)return line;const row=JSON.parse(line);if(['session_meta','turn_context'].includes(row.type)&&row.payload?.multi_agent_version==='v2'){row.payload.multi_agent_version='v1';changedMetadata++;return JSON.stringify(row);}return line;});
  unchangedContent&&=prior.filter(line=>line&&JSON.parse(line).type==='response_item').join('\n')===after.filter(line=>line&&JSON.parse(line).type==='response_item').join('\n');
  await writeFile(f,after.join('\n'));
 }
 proc=spawn(engine,['app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});proc.stderr.resume();buffer='';attach();
 await rpc('initialize',{clientInfo:{name:'tokenflow_native_probe',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
 await rpc('thread/resume',{threadId:p.thread.id,model:parentModel,modelProvider:'token_flow'});
 phase='offline-metadata-migration';issued=false;const migrationCalls=calls.length,migrationEvents=events.length;
 await rpc('turn/start',{threadId:p.thread.id,input:[{type:'text',text:'Run the native spawn test again with a fresh child.'}]});
 await wait(()=>events.slice(migrationEvents).some(e=>e.method==='turn/completed'&&e.params?.threadId===p.thread.id));
 await wait(()=>calls.slice(migrationCalls).some(c=>c.model===childModel));
 report.phases.push({phase,changedMetadata,unchangedResponseItemBytes:unchangedContent,requests:structuredClone(calls.slice(migrationCalls))});
}catch(e){report.error=e instanceof Error?e.message:String(e);process.exitCode=1;}finally{if(proc.exitCode===null)await new Promise<void>(r=>{proc.once('exit',()=>r());proc.kill();});server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true,maxRetries:3});}
report.toolShape=toolShape;report.transportErrors=transportErrors;console.log(JSON.stringify(report,null,2));
if(!report.error){
 assert.equal(report.initial.childStatus,'failed');
 assert.equal(report.initial.error.codexErrorInfo.httpConnectionFailed.httpStatusCode,422);
 for(const name of ['loaded-config-updated','unsubscribe-resume','restart-resume'])assert.equal(report.phases.find((p:any)=>p.phase===name).requests[0].nativeProtocol,'v2');
 for(const name of ['fresh-thread-v1','offline-metadata-migration']){const phase=report.phases.find((p:any)=>p.phase===name);assert.equal(phase.requests[0].nativeProtocol,'v1');assert.ok(phase.requests.some((r:any)=>r.model===childModel&&r.taskMarkerPresent&&!r.encryptedAgentMessage));}
 assert.equal(report.phases.at(-1).unchangedResponseItemBytes,true);
}
await writeFile('/tmp/tokenflow-old-agents-resume.json',JSON.stringify(report,null,2)+'\n');
