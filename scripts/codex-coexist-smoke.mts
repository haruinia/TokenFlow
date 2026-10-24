// Installed Codex + actual TokenFlow service; isolated HOME, synthetic auth/providers only.
import assert from 'node:assert/strict';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const root=await mkdtemp(join(await realpath(tmpdir()),'tokenflow-codex-coexist-')),home=join(root,'codex');
process.env.HOME=root;process.env.CODEX_HOME=home;
const {createDesktopService}=await import('../packages/core/src/service.ts');
const {codexModelCatalog}=await import('../packages/core/src/codex-model-catalog.ts');
const {parse}=await import('smol-toml');
const binary=process.argv[2]??'/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
let officialModel='gpt-fixture-official';const gatewayModel='qoder/fixture',compactBeforeOfficial=process.argv.includes('--compact-before-official'),switchAccounts=process.argv.includes('--switch-accounts');let privateGatewayReferencesObserved=false;
const now=Math.floor(Date.now()/1000),claims={sub:'synthetic-user',iat:now,exp:now+3600,email:'fixture@example.test','https://api.openai.com/auth':{chatgpt_plan_type:'plus',chatgpt_account_id:'synthetic-account',user_id:'synthetic-user'}};
const jwt=Buffer.from(JSON.stringify({alg:'none',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.synthetic-signature';
const auth=JSON.stringify({auth_mode:'chatgpt',tokens:{id_token:jwt,access_token:jwt,refresh_token:'synthetic-refresh',account_id:'synthetic-account'},last_refresh:new Date().toISOString()});
const nextJWT=Buffer.from(JSON.stringify({alg:'none',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({...claims,email:'next-fixture@example.test','https://api.openai.com/auth':{...claims['https://api.openai.com/auth'],chatgpt_account_id:'synthetic-next-account'}})).toString('base64url')+'.synthetic-signature';
const officialCatalog=(model=officialModel)=>({models:codexModelCatalog(model).models});
let service:Awaited<ReturnType<typeof createDesktopService>>|undefined,child:ChildProcessWithoutNullStreams|undefined;
const subagents=process.argv.includes('--subagents');let subagentSpawned=false;
let gatewayKey='',sequence=0,failedMarker=false;const routes:Array<{route:string;model:string;chatgptAuth:boolean;gatewayCredential:boolean;input:string}>=[];
const savedFetch=globalThis.fetch;
const sse=(body:Record<string,any>,route:string)=>{
 const n=++sequence,text=route+'_REPLY_'+n+' '+[...new Set(JSON.stringify(body.input).match(/MIXED_[A-Z_]+_MARKER/g)??[])].join(' ');
 let item:Record<string,any>={type:'message',id:'msg_fixture_'+n,role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
 if(subagents&&!subagentSpawned&&JSON.stringify(body.input?.at(-1)).includes('SPAWN_GATEWAY_CHILD_MARKER')){
  subagentSpawned=true;const namespace=body.tools?.find((tool:any)=>tool.type==='namespace'&&tool.tools?.some((fn:any)=>fn.name==='spawn_agent'));
  assert.ok(namespace||body.tools?.some((tool:any)=>tool.name==='spawn_agent'),'spawn_agent missing');
  item={type:'function_call',id:'fc_fixture_spawn',call_id:'call_fixture_spawn',name:'spawn_agent',...(namespace?{namespace:namespace.name}:{}),arguments:JSON.stringify({model:gatewayModel,fork_context:false,message:'Reply CHILD_GATEWAY_ONLY_MARKER only.'}),status:'completed'};
 }
 const response={id:'resp_fixture_'+n,object:'response',created_at:Math.floor(Date.now()/1000),model:body.model,status:'completed',output:[item],usage:{input_tokens:100,output_tokens:3,total_tokens:103}};
 if(!body.stream)return Response.json(response);
 return new Response([{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}].map((event,index)=>'data: '+JSON.stringify({...event,sequence_number:index})+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
};
async function freePort(){const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));return port;}
async function start(){
 const proc=child=spawn(binary,['app-server','--listen','stdio://','-c','features.apps=false',...(compactBeforeOfficial?['-c','model_providers.token_flow.name="OpenAI"']:[])],{cwd:home,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});
 let buffer='',id=0,turnResolve:((value:any)=>void)|undefined,compactResolve:(()=>void)|undefined;const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();proc.stderr.resume();proc.stdout.setEncoding('utf8');
 proc.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let msg:any;try{msg=JSON.parse(line);}catch{continue;}const wait=pending.get(msg.id);if(wait){pending.delete(msg.id);msg.error?wait.reject(Error(String(msg.error.message))):wait.resolve(msg.result);}if(msg.method==='turn/completed'){turnResolve?.(msg.params.turn);compactResolve?.();}}});
 const rpc=(method:string,params:unknown):Promise<any>=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>reject(Error('RPC timeout: '+method)),30000);pending.set(key,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});proc.stdin.write(JSON.stringify({id:key,method,params})+'\n');});
 await rpc('initialize',{clientInfo:{name:'tokenflow_coexist_fixture',version:'1.0'},capabilities:{experimentalApi:true}});proc.stdin.write(JSON.stringify({method:'initialized'})+'\n');
 return {rpc,compact:async(threadId:string)=>{let timer:ReturnType<typeof setTimeout>|undefined;const done=new Promise<void>((resolve,reject)=>{compactResolve=resolve;timer=setTimeout(()=>reject(Error('Compaction timeout')),45000);});try{await rpc('thread/compact/start',{threadId});await done;}finally{clearTimeout(timer);compactResolve=undefined;}},turn:async(threadId:string,model:string,text:string,status='completed')=>{let timer:ReturnType<typeof setTimeout>|undefined;const done=new Promise<any>((resolve,reject)=>{turnResolve=resolve;timer=setTimeout(()=>reject(Error('Turn timeout')),45000);});try{await rpc('turn/start',{threadId,model,input:[{type:'text',text}]});const turn=await done;assert.equal(turn.status,status,JSON.stringify({marker:text,error:turn.error,routes:routes.map(r=>r.route)}));return turn;}finally{clearTimeout(timer);}},stop:()=>new Promise<void>(resolve=>{proc.once('exit',()=>resolve());proc.kill();})};
}
async function page(client:Awaited<ReturnType<typeof start>>,method:string,threadId:string){let cursor:string|undefined;const data:any[]=[];for(let i=0;i<1000;i++){const result=await client.rpc(method,{threadId,limit:2,sortDirection:'asc',...(cursor?{cursor}:{})});data.push(...result.data);if(!result.nextCursor)return data;assert.notEqual(cursor,result.nextCursor);cursor=result.nextCursor;}throw Error('Pagination did not finish');}
try{
 await mkdir(home,{recursive:true});await mkdir(join(root,'data/cliproxy'),{recursive:true});await writeFile(join(home,'auth.json'),auth,{mode:0o600});await writeFile(join(home,'config.toml'),`model = "${officialModel}"\n`);
 await writeFile(join(root,'data/cliproxy/fixture-accounts.json'),JSON.stringify([{name:'qoder.json',provider:'qoder',email:'fixture@example.test',status:'active',models:['fixture']},...(switchAccounts?[{name:'next.json',provider:'codex',email:'next-fixture@example.test',status:'active',models:['gpt-fixture-official-next']}]:[])]));
 if(switchAccounts){await mkdir(join(root,'data/cliproxy/auth'),{recursive:true});await writeFile(join(root,'data/cliproxy/auth/next.json'),JSON.stringify({access_token:nextJWT,id_token:nextJWT,refresh_token:'synthetic-next-refresh',account_id:'synthetic-next-account',last_refresh:new Date().toISOString()}),{mode:0o600});}
 const proxyPort=await freePort();
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));assert.ok(['127.0.0.1','localhost'].includes(url.hostname),'External network forbidden in isolated smoke');
  if(url.port===String(proxyPort)&&url.pathname==='/v1/responses'){
   const body=JSON.parse(String(init?.body)),headers=new Headers(init?.headers);routes.push({route:'gateway',model:body.model,chatgptAuth:headers.get('authorization')===`Bearer ${jwt}`,gatewayCredential:headers.get('x-tokenflow-client-key')===gatewayKey,input:JSON.stringify(body.input)});
   assert.notEqual(headers.get('authorization'),`Bearer ${jwt}`,'ChatGPT auth leaked to third-party provider');assert.notEqual(headers.get('authorization'),`Bearer ${nextJWT}`,'Next ChatGPT auth leaked to third-party provider');assert.equal(headers.get('x-tokenflow-client-key'),null,'Client key leaked to third-party provider');return sse(body,'GATEWAY');
  }
  return savedFetch(input,init);
 };
 service=await createDesktopService({root:join(root,'data'),binary:resolve('tests/fixtures/fake-cliproxy.mjs'),proxyPort,token:'synthetic-admin',localKey:'synthetic-internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{codex:join(home,'config.toml'),claude:join(root,'claude.json'),qoder:join(root,'qoder.json'),workbuddy:join(root,'workbuddy.json')},agentProcesses:async()=>[],nativeProcesses:async()=>[],antigravityPath:join(root,'antigravity'),cursorLocalPath:join(root,'cursor'),codexOfficialFetch:async(url,init)=>{
  assert.ok(url.startsWith('https://chatgpt.com/backend-api/codex/'));
  const headers=new Headers(init.headers),next=headers.get('chatgpt-account-id')==='synthetic-next-account';assert.equal(headers.get('authorization'),`Bearer ${next?nextJWT:jwt}`);assert.equal(headers.get('chatgpt-account-id'),next?'synthetic-next-account':'synthetic-account');assert.equal(headers.get('x-tokenflow-client-key'),null);
  if(url.includes('/models?'))return Response.json(officialCatalog(next?'gpt-fixture-official-next':'gpt-fixture-official'));
  const body=JSON.parse(String(init.body));assert.equal(body.model,officialModel);assert.ok(!body.input?.some((item:any)=>item.type==='compaction'&&String(item.encrypted_content).startsWith('tfctx1.')),'Private gateway checkpoint reached official provider');assert.ok(!String(body.previous_response_id??'').startsWith('resp_tf_'),'Private gateway response ID reached official provider');routes.push({route:'official',model:body.model,chatgptAuth:true,gatewayCredential:false,input:JSON.stringify(body.input)});
  if(JSON.stringify(body.input?.at(-1)).includes('FAILED_MIXED_MARKER')){failedMarker=true;return Response.json({error:{type:'invalid_request_error',message:'Synthetic official source failure'}},{status:400});}
  return sse(body,'OFFICIAL');
 }});
 service.app.addHook('preHandler',async req=>{const body=req.body as Record<string,any>|undefined;if(req.url==='/codex/v1/responses'&&body?.model===officialModel&&body.input?.some((item:any)=>item.type==='compaction'&&String(item.encrypted_content).startsWith('tfctx1.')))privateGatewayReferencesObserved=true;});
 await service.proxy.start();const origin=await service.app.listen({port:0,host:'127.0.0.1'}),host=new URL(origin).host,admin={host,authorization:'Bearer synthetic-admin'};

 for(let attempt=0;!(await readFile(join(home,'config.toml'),'utf8')).includes('/local-telemetry/codex/v1/logs');attempt++){assert.ok(attempt<200,'Recorder startup did not finish');await new Promise(r=>setTimeout(r,10));}
 const inspected=await service.app.inject({url:'/api/a2a',headers:admin});assert.equal(inspected.statusCode,200);const targets=inspected.json().targets,account=service.proxy.snapshot().accounts.find(a=>a.provider==='qoder')!;
 const connected=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers:admin,payload:{target:'codex',revision:targets.find(t=>t.id==='codex')!.revision,model:gatewayModel,sourceId:account.id,codexCoexist:true}});assert.equal(connected.statusCode,200,connected.body);
 const config=parse(await readFile(join(home,'config.toml'),'utf8')) as any,provider=config.model_providers.token_flow;gatewayKey=provider.http_headers['x-tokenflow-client-key'];assert.equal(provider.requires_openai_auth,true);assert.equal(provider.experimental_bearer_token,undefined);assert.equal(provider.base_url,origin+'/codex/v1');
 let client=await start();const catalog=await client.rpc('model/list',{});assert.ok(catalog.data.some((m:any)=>m.id===officialModel));assert.ok(catalog.data.some((m:any)=>m.id===gatewayModel));
 let turns:any[]=[],items:any[]=[];
 if(!subagents){
 const first=await client.rpc('thread/start',{cwd:home,approvalPolicy:'never',sandbox:'read-only'}),thread=first.thread.id;
 await client.turn(thread,gatewayModel,'MIXED_FIRST_MARKER');if(compactBeforeOfficial)await client.compact(thread);await client.turn(thread,officialModel,'MIXED_OFFICIAL_MARKER');await client.turn(thread,gatewayModel,'MIXED_GATEWAY_RETURN_MARKER');
 await client.stop();client=await start();await client.rpc('thread/resume',{threadId:thread,excludeTurns:true});
 await client.turn(thread,officialModel,'MIXED_RESTART_MARKER');const failed=await client.turn(thread,officialModel,'FAILED_MIXED_MARKER','failed');
 turns=await page(client,'thread/turns/list',thread);items=await page(client,'thread/items/list',thread);assert.ok(turns.length>=5);for(const marker of ['MIXED_FIRST_MARKER','MIXED_OFFICIAL_MARKER','MIXED_GATEWAY_RETURN_MARKER','MIXED_RESTART_MARKER'])assert.ok(JSON.stringify(items).includes(marker));
 const fork=await client.rpc('thread/fork',{threadId:thread,beforeTurnId:failed.id,excludeTurns:true});await client.turn(fork.thread.id,gatewayModel,'MIXED_FORK_MARKER');const forkItems=await page(client,'thread/items/list',fork.thread.id);assert.ok(JSON.stringify(forkItems).includes('MIXED_FORK_MARKER'));assert.ok(!JSON.stringify(forkItems).includes('FAILED_MIXED_MARKER'));await client.stop();
 assert.equal(await readFile(join(home,'auth.json'),'utf8'),auth,'Synthetic original login was rewritten');assert.ok(failedMarker);if(!compactBeforeOfficial)assert.deepEqual(routes.map(r=>r.route),['gateway','official','gateway','official','official','gateway']);else{assert.ok(privateGatewayReferencesObserved,'Fixture did not exercise gateway checkpoint at official boundary');assert.ok(routes.length>=6);}
 for(const route of routes.slice(1))assert.ok(route.input.includes('MIXED_FIRST_MARKER'));assert.ok(!routes.at(-1)!.input.includes('FAILED_MIXED_MARKER'));
 if(switchAccounts){
  const beforeConfig=parse(await readFile(join(home,'config.toml'),'utf8')) as any,connection=connected.json(),native=service.proxy.snapshot().accounts.find(a=>a.provider==='codex')!;
  let status=(await service.app.inject({url:'/api/codex-accounts',headers:admin})).json();
  const switched=await service.app.inject({method:'POST',url:'/api/codex-accounts/switch',headers:admin,payload:{revision:status.revision,sourceId:native.id,model:'codex/gpt-fixture-official-next',restoreHistory:false}});assert.equal(switched.statusCode,200,switched.body);assert.equal(switched.json().gatewayConnected,true);assert.equal(switched.json().codexCoexist,true);
  officialModel='gpt-fixture-official-next';client=await start();let menu=await client.rpc('model/list',{});assert.ok(menu.data.some((model:any)=>model.id===officialModel));assert.ok(menu.data.some((model:any)=>model.id===gatewayModel));assert.ok(!menu.data.some((model:any)=>model.id==='gpt-fixture-official'));
  const switchedThread=await client.rpc('thread/start',{cwd:home,approvalPolicy:'never',sandbox:'read-only'});await client.turn(switchedThread.thread.id,officialModel,'ACCOUNT_SWITCH_OFFICIAL');await client.turn(switchedThread.thread.id,gatewayModel,'ACCOUNT_SWITCH_GATEWAY');await client.stop();
  status=(await service.app.inject({url:'/api/codex-accounts',headers:admin})).json();const restored=await service.app.inject({method:'POST',url:'/api/codex-accounts/restore',headers:admin,payload:{revision:status.revision,restoreHistory:false}});assert.equal(restored.statusCode,200,restored.body);assert.equal(restored.json().gatewayConnected,true);assert.equal(restored.json().backup,null);
  officialModel='gpt-fixture-official';client=await start();menu=await client.rpc('model/list',{});assert.ok(menu.data.some((model:any)=>model.id===officialModel));assert.ok(menu.data.some((model:any)=>model.id===gatewayModel));assert.ok(!menu.data.some((model:any)=>model.id==='gpt-fixture-official-next'));
  const restoredThread=await client.rpc('thread/start',{cwd:home,approvalPolicy:'never',sandbox:'read-only'});await client.turn(restoredThread.thread.id,officialModel,'ACCOUNT_RESTORE_OFFICIAL');await client.turn(restoredThread.thread.id,gatewayModel,'ACCOUNT_RESTORE_GATEWAY');await client.stop();
  const afterConfig=parse(await readFile(join(home,'config.toml'),'utf8')) as any,target=(await service.app.inject({url:'/api/a2a',headers:admin})).json().targets.find((target:any)=>target.id==='codex');assert.deepEqual(afterConfig.model_providers,beforeConfig.model_providers);assert.equal(target.connection.id,connection.id);assert.equal(target.connection.keyId,connection.keyId);assert.deepEqual(target.connection.officialModelSlugs,[officialModel]);assert.equal(await readFile(join(home,'auth.json'),'utf8'),auth);
 }
 }
 if(subagents){
  const parent=await client.rpc('thread/start',{cwd:home,model:officialModel,approvalPolicy:'never',sandbox:'read-only'});const before=routes.length;
  await client.turn(parent.thread.id,officialModel,'SPAWN_GATEWAY_CHILD_MARKER');
  for(let i=0;i<100&&!routes.slice(before).some(r=>r.route==='gateway'&&r.input.includes('CHILD_GATEWAY_ONLY_MARKER'));i++)await new Promise(r=>setTimeout(r,50));
  assert.ok(subagentSpawned);assert.equal(routes[before].route,'official');assert.ok(routes.slice(before).some(r=>r.route==='gateway'&&r.model===gatewayModel&&r.input.includes('CHILD_GATEWAY_ONLY_MARKER')),'official parent did not route explicit child to gateway');await client.stop();
 }
 console.log(JSON.stringify({passed:true,scope:'installed Codex + actual TokenFlow service; isolated HOME and synthetic ChatGPT JWT/providers; no live account',mixedCatalog:true,officialParentGatewaySubagent:subagents,officialIdentitySwitchAndRestore:switchAccounts,gatewayCompactionBeforeOfficial:compactBeforeOfficial,privateGatewayReferencesObserved,requiresOpenAIAuth:true,authPreserved:true,credentialSeparation:true,modelRoutes:routes.map(r=>r.route),restart:!subagents,turns:turns.length,items:items.length,forkBeforeFailedTurn:!subagents}));
}finally{
 if(child&&child.exitCode===null)await new Promise<void>(resolve=>{child!.once('exit',()=>resolve());child!.kill();});
 await service?.app.close();globalThis.fetch=savedFetch;await rm(root,{recursive:true,force:true});
}
