import {portableCodexItem} from '../../../packages/core/src/codex-history-items.js';
import {nativeAgentDiscovery} from '../../../packages/core/src/codex-unified-agent-catalog.js';
/** Installed native engine + isolated home. No production configuration/history changes.
 * Default is synthetic transport; --live-child sends only the test child to the current gateway.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,readdir} from 'node:fs/promises';
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
const events:any[]=[],calls:any[]=[],results:any[]=[],pending=new Map<number,any>();const transportErrors:string[]=[];let phase='no-child',issued=true,seq=0,childId='',advertised=false;let toolShape:any;
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
const legacy:any=parse(await readFile(join(home,'config.toml'),'utf8'));legacy.model_providers.fixture_old={...legacy.model_providers.token_flow};legacy.model_provider='fixture_old';await writeFile(join(home,'config.toml'),stringify(legacy));
const engine='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
let proc=spawn(engine,['app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});proc.stderr.resume();let buffer='';
const send=(m:any)=>proc.stdin.write(JSON.stringify(m)+'\n');
const attach=()=>proc.stdout.on('data',c=>{buffer+=c;let at;while((at=buffer.indexOf('\n'))>=0){let m;try{m=JSON.parse(buffer.slice(0,at));}catch{}buffer=buffer.slice(at+1);if(!m)continue;const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else events.push(m);}});attach();
const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const id=++seq,t=setTimeout(()=>{pending.delete(id);reject(Error('timeout '+method));},20000);pending.set(id,{resolve:(v:any)=>{clearTimeout(t);resolve(v);},reject:(e:any)=>{clearTimeout(t);reject(e);}});send({id,method,params});});
const wait=async(check:()=>boolean)=>{for(let i=0;i<1200;i++){if(check())return;await new Promise(r=>setTimeout(r,100));}throw Error('timeout waiting native turn');};
const report:any={engine,childModel,scope:liveParent?'native engine, real official parent and configured gateway child':live?'native engine, deterministic parent, real Qiniu DeepSeek child':'native engine, deterministic local transport',catalogContext,nativeV1,productConfig:product};

async function records(path:string):Promise<any[]>{let out:any[]=[];for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isDirectory())out.push(...await records(file));else if(entry.name.endsWith('.jsonl')){for(const line of (await readFile(file,'utf8')).split('\n')){try{const row=JSON.parse(line);if(['session_meta','turn_context'].includes(row.type))out.push({type:row.type,multiAgentVersion:row.payload?.multi_agent_version,provider:row.payload?.model_provider});}catch{}}}}return out;}
try{
 await rpc('initialize',{clientInfo:{name:'tokenflow_unused_protocol_probe',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
 const old=await rpc('thread/start',{cwd:root,model:parentModel,modelProvider:'fixture_old',approvalPolicy:'never',sandbox:'read-only'});
 const turn=async(id:string)=>{const at=events.length;await rpc('turn/start',{threadId:id,input:[{type:'text',text:'Reply OK without using tools.'}]});await wait(()=>events.slice(at).some(e=>e.method==='turn/completed'&&e.params?.threadId===id));};
 await turn(old.thread.id);
 const before=await records(join(home,'sessions'));
 const loadedBefore=(await rpc('thread/loaded/list',{})).data.length;
 for(const model of catalog.models)model.multi_agent_version='v1';await writeFile(join(root,'catalog.json'),JSON.stringify(catalog));
 const next:any=parse(await readFile(join(home,'config.toml'),'utf8'));next.model_provider='token_flow';next.features.multi_agent_v2=false;await writeFile(join(home,'config.toml'),stringify(next));
 await rpc('thread/unsubscribe',{threadId:old.thread.id});
 const resumed=await rpc('thread/resume',{threadId:old.thread.id,model:parentModel,modelProvider:'token_flow'});
 phase='old-after-provider-switch';await turn(old.thread.id);
 await new Promise<void>(r=>{proc.once('exit',()=>r());proc.kill();});
 proc=spawn(engine,['app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});proc.stderr.resume();buffer='';attach();
 await rpc('initialize',{clientInfo:{name:'tokenflow_unused_protocol_probe',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
 const fresh=await rpc('thread/start',{cwd:root,model:parentModel,modelProvider:'token_flow',approvalPolicy:'never',sandbox:'read-only'});phase='new-thread-after-isolated-engine-reload';await turn(fresh.thread.id);
 const result={scope:'installed Codex; synthetic local responses; no child creation, real auth or provider calls',oldProvider:old.thread.modelProvider,newProvider:resumed.thread.modelProvider,threadsBeforeSwitch:loadedBefore,metadataBeforeAnySpawn:before,requests:calls.map(c=>({phase:c.phase,protocol:c.nativeProtocol}))};
 assert.equal(loadedBefore,1);assert.equal(resumed.thread.modelProvider,'token_flow');assert.equal(calls.find(c=>c.phase==='old-after-provider-switch').nativeProtocol,'v2');assert.equal(calls.find(c=>c.phase==='new-thread-after-isolated-engine-reload').nativeProtocol,'v1');assert.ok(before.some(r=>r.multiAgentVersion==='v2'));console.log(JSON.stringify(result,null,2));
}finally{proc.kill();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
