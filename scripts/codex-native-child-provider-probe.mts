/** Installed or isolated patched engine, synthetic endpoints. Exercises native lifecycle and first-request routing. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer, type ServerResponse} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {stringify} from 'smol-toml';
import {codexModelCatalog} from '../packages/core/src/codex-model-catalog.ts';
const root=await mkdtemp(join(tmpdir(),'tf-native-provider-')),home=join(root,'codex');await mkdir(home);
const engine=process.argv.includes('--engine')?process.argv[process.argv.indexOf('--engine')+1]:'/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';const routeChild=process.argv.includes('--route-child');
const parentModel='fixture-parent',childModel='fixture-child',parentProvider=process.argv.includes('--parent-gateway')?'token_flow':'openai';const calls:any[]=[],events:any[]=[],checks:any[]=[];let mode='spawn',spawned=false,issued=false,seq=0,childId='',parentId='',held:ServerResponse|undefined;
const desiredChildProvider=routeChild?(process.argv.includes('--official-child')?'openai':'token_flow'):parentProvider;
const target='/root/provider_child';let toolNames:string[]=[];const toolResults:any[]=[];
const fixture=createServer(async(req,res)=>{
 if(req.method!=='POST'){res.writeHead(404);res.end();return;}
 try{
 let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);calls.push({mode,path:req.url,model:b.model,credentialKind:req.headers.authorization==='Bearer fixture-gateway'?'gateway':req.headers.authorization==='Bearer fixture-key'?'official':'unexpected'});
 const ns=b.tools?.find((t:any)=>t.type==='namespace'&&t.tools?.some((f:any)=>f.name==='spawn_agent'));
 for(const i of b.input??[])if(i.type==='function_call_output'){let out;try{out=JSON.parse(i.output)}catch{out=String(i.output).slice(0,1000)};if(!toolResults.some(x=>x.callId===i.call_id))toolResults.push({mode,callId:i.call_id,output:out});}
 const functions=(b.tools??[]).flatMap((t:any)=>t.type==='namespace'?t.tools.map((x:any)=>({...x,namespace:t.name})):[t]);
 if(b.model===parentModel)toolNames=functions.map((t:any)=>t.name).filter(Boolean);
 let item:any={id:'msg_'+calls.length,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:b.model===childModel?'CHILD_NATIVE_OK':'PARENT_NATIVE_OK',annotations:[]}]};
 if(b.model===childModel&&mode==='hold'){held=res;return;}
 if(b.model===childModel&&mode==='fail'){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic child failure',type:'invalid_request_error'}}));return;}
 if(b.model===parentModel&&!issued){
  const v2=toolNames.includes('followup_task');let name:string,args:any;
  if(mode==='spawn'){name='spawn_agent';args=v2?{task_name:'provider_child',fork_turns:'none',model:childModel,message:'Reply CHILD_NATIVE_OK only.'}:{model:childModel,fork_context:false,message:'Reply CHILD_NATIVE_OK only.'};spawned=true;}
  else if(mode==='followup'||mode==='hold'||mode==='fail'){name=v2?'followup_task':'send_input';args=v2?{target,message:'Reply CHILD_NATIVE_OK only.'}:{id:childId,message:'Reply CHILD_NATIVE_OK only.'};}
  else if(mode==='interrupt'){name=v2?'interrupt_agent':'close_agent';args=v2?{target}:{id:childId};}
  else if(mode==='status'){name=v2?'list_agents':'wait';args=v2?{}:{ids:[childId],timeout_ms:1000};}
  else throw Error('unknown fixture mode');
  const tool=functions.find((t:any)=>t.name===name);assert.ok(tool,'Missing native tool '+name+'; available '+toolNames.join(','));issued=true;
  item={id:'fc_'+mode,type:'function_call',call_id:'call_'+mode+'_'+calls.length,name,...(tool.namespace?{namespace:tool.namespace}:{}),arguments:JSON.stringify(args),status:'completed'};
 }
 const response={id:'resp_'+calls.length,object:'response',status:'completed',model:b.model,output:[item],usage:{input_tokens:100,output_tokens:5,total_tokens:105}};
 res.writeHead(200,{'content-type':'text/event-stream'});res.end([{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
 }catch(e){res.writeHead(500);res.end(JSON.stringify({error:{message:e instanceof Error?e.message:'Fixture error'}}));}
});await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(fixture.address() as any).port}`;
const catalog=codexModelCatalog([parentModel,childModel]);for(const m of catalog.models)Object.assign(m,{multi_agent_version:'v2'});
await writeFile(join(root,'catalog.json'),JSON.stringify(catalog));await writeFile(join(home,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'fixture-key'}),{mode:0o600});
await writeFile(join(home,'config.toml'),stringify({model:parentModel,model_provider:parentProvider,openai_base_url:base+'/parent/v1',model_catalog_json:join(root,'catalog.json'),cli_auth_credentials_store:'file',features:{apps:false,multi_agent:true,multi_agent_v2:routeChild?{enabled:true,tool_namespace:'tokenflow_agents'}:true},analytics:{enabled:false},model_providers:{token_flow:{name:'Gateway fixture',base_url:base+'/gateway/v1',wire_api:'responses',experimental_bearer_token:'fixture-gateway',requires_openai_auth:false,capabilities:{remote_compaction:'unsupported'}}}}));
const proc=spawn(engine,[...(engine.endsWith('codex-app-server')?[]:['app-server']),'--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home,OPENAI_BASE_URL:base+'/parent/v1',...(routeChild?{TOKENFLOW_TEST_MODEL_PROVIDER_ROUTES:JSON.stringify({[parentModel]:'openai',[childModel]:desiredChildProvider})}:{})},stdio:['pipe','pipe','pipe']});proc.stderr!.resume();const pending=new Map<number,any>();let buffer='';
const send=(m:any)=>proc.stdin!.write(JSON.stringify(m)+'\n');proc.stdout!.on('data',c=>{buffer+=c;let at;while((at=buffer.indexOf('\n'))>=0){let m;try{m=JSON.parse(buffer.slice(0,at))}catch{}buffer=buffer.slice(at+1);if(!m)continue;const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}else events.push(m);}});
const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const id=++seq,t=setTimeout(()=>{pending.delete(id);reject(Error('Timeout '+method))},15000);pending.set(id,{resolve:(v:any)=>{clearTimeout(t);resolve(v)},reject:(e:any)=>{clearTimeout(t);reject(e)}});send({id,method,params});});
const wait=async(check:()=>boolean,label:string)=>{for(let i=0;i<300;i++){if(check())return;await new Promise(r=>setTimeout(r,50));}throw Error('Timeout '+label)};
const parentTurn=async(nextMode:string)=>{mode=nextMode;issued=false;const from=events.length;const r=await rpc('turn/start',{threadId:parentId,input:[{type:'text',text:'Run native child operation '+mode+'.'}]});await wait(()=>events.slice(from).some(e=>e.method==='turn/completed'&&e.params?.turn?.id===r.turn.id),'parent '+mode);const end=events.slice(from).find(e=>e.method==='turn/completed'&&e.params?.turn?.id===r.turn.id);assert.equal(end.params.turn.status,'completed');};
let error:string|undefined;
try{
 await rpc('initialize',{clientInfo:{name:'native_provider_probe',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
 const p=await rpc('thread/start',{cwd:root,model:parentModel,modelProvider:parentProvider,approvalPolicy:'never',sandbox:'read-only'});parentId=p.thread.id;
 await parentTurn('spawn');assert.ok(spawned);await wait(()=>calls.some(c=>c.model===childModel),'child initial inference');
 const list=await rpc('thread/list',{limit:100,sourceKinds:['subAgent','subAgentThreadSpawn']});let child=list.data.find((t:any)=>t.id!==parentId);if(!child){const loaded=await rpc('thread/loaded/list',{});const id=loaded.data.find((id:string)=>id!==parentId);if(id)child={id};}assert.ok(child,'Native child absent');childId=child.id;
 for(let i=0;i<100;i++){const state=await rpc('thread/read',{threadId:childId});if(state.thread.status.type!=='active')break;await new Promise(r=>setTimeout(r,50));}
 const before=await rpc('thread/resume',{threadId:childId});assert.equal(before.thread.parentThreadId,parentId,'Native parent edge lost');assert.equal(before.modelProvider,desiredChildProvider);assert.ok(calls.filter(c=>c.mode==='spawn'&&c.model===childModel).every(c=>c.path.startsWith(desiredChildProvider==='token_flow'?'/gateway/':'/parent/')));checks.push({check:'native-spawn-initial-provider',provider:before.modelProvider,parentRelation:before.thread.parentThreadId??before.thread.source});
 const unsubscribe=await rpc('thread/unsubscribe',{threadId:childId});checks.push({check:'native-child-unsubscribe',result:unsubscribe});const loaded=await rpc('thread/resume',{threadId:childId,model:childModel,modelProvider:'token_flow',approvalPolicy:'never',sandbox:'read-only'});checks.push({check:'requested-provider-change',requested:'token_flow',actual:loaded.modelProvider,applied:loaded.modelProvider==='token_flow'});assert.equal(loaded.thread.id,childId);assert.equal(loaded.thread.parentThreadId,parentId);assert.deepEqual(loaded.sandbox,p.sandbox);assert.deepEqual(loaded.approvalPolicy,p.approvalPolicy);checks.push({check:'reload-same-native-child',provider:loaded.modelProvider,sameId:loaded.thread.id===childId,permissionsMatch:true});
 await parentTurn('followup');await wait(()=>calls.some(c=>c.mode==='followup'&&c.model===childModel),'native followup request');const follow=calls.filter(c=>c.mode==='followup'&&c.model===childModel);assert.ok(follow.every(c=>c.path.startsWith(loaded.modelProvider==='token_flow'?'/gateway/':'/parent/')),'Followup route disagrees with actual provider');checks.push({check:'native-followup-uses-actual-child-provider',provider:loaded.modelProvider,passed:true});
 await parentTurn('status');assert.ok(JSON.stringify(toolResults.filter(r=>r.mode==='status')).includes(target),'Child missing from native list_agents');checks.push({check:'native-status',passed:true});
 await parentTurn('hold');await wait(()=>!!held,'held child');await parentTurn('interrupt');await wait(()=>!!held?.destroyed||!!held?.writableEnded,'child cancellation aborts HTTP');checks.push({check:'native-interrupt-aborts-child-HTTP',passed:true});
 const failedAt=events.length;await parentTurn('fail');await wait(()=>events.slice(failedAt).some(e=>e.method==='turn/completed'&&e.params?.threadId===childId&&e.params?.turn?.status==='failed'),'child native failure event');checks.push({check:'native-failure-event',passed:true});await parentTurn('status');const failureStatus=toolResults.filter(r=>r.mode==='status').at(-1)?.output?.agents?.find((a:any)=>a.agent_name===target)?.agent_status;assert.ok(/error|errored|failed/i.test(JSON.stringify(failureStatus)),'Native status did not expose child failure');checks.push({check:'native-failure-visible-to-parent',status:failureStatus,passed:true});
 const after=await rpc('thread/read',{threadId:parentId});assert.equal(after.thread.modelProvider,parentProvider);checks.push({check:'parent-provider-unchanged',passed:true});assert.ok(calls.every(c=>c.credentialKind===(c.path.startsWith('/gateway/')?'gateway':'official')),'Provider credential crossed route');checks.push({check:'provider-credential-separation',passed:true});
}catch(e){error=e instanceof Error?e.message:'Failed';process.exitCode=1;}finally{held?.destroy();if(proc.exitCode===null)await new Promise<void>(r=>{proc.once('exit',()=>r());proc.kill()});fixture.closeAllConnections();await new Promise<void>(r=>fixture.close(()=>r()));await rm(root,{recursive:true,force:true});}
const report={nativeLifecyclePassed:!error,parentProvider,requestedReloadProviderMatched:checks.some(c=>c.check==='requested-provider-change'&&c.applied),scope:'Real engine, native agent operations, synthetic local provider endpoints',engineVariant:routeChild?'patched-source':'installed',toolNamespace:routeChild?'tokenflow_agents':'collaboration',firstRequestRoutingEnabled:routeChild,desiredChildProvider,toolNames,toolResults,checks,calls,...(error?{error}:{})};console.log(JSON.stringify(report));await writeFile(resolve('doc/testing/results/codex-native-child-provider-'+parentProvider+(routeChild?'-patched-'+desiredChildProvider:'')+'-2026-10-25.json'),JSON.stringify(report,null,2)+'\n');
