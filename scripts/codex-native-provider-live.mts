/** Isolated source-engine probe: native cross-provider delegation and child compaction.
 * Real OpenAI and DeepSeek; synthetic task data. Does not control desktop Codex. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,realpath,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {stringify,parse} from 'smol-toml';
import YAML from 'yaml';
assert.ok(process.argv.includes('--live'),'Explicit --live required');
if(!process.env.TF_HOT_ROOT){
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-hot-provider-'));
 try{const child=spawn(process.execPath,['--import','tsx',resolve(process.argv[1]),...process.argv.slice(2)],{env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:join(root,'codex'),TF_HOT_ROOT:root,TF_HOT_USER_HOME:homedir()},stdio:'inherit'});process.exitCode=await new Promise<number>(r=>child.once('exit',c=>r(c??1)));}
 finally{await rm(root,{recursive:true,force:true});}
}else{
 const root=process.env.TF_HOT_ROOT,userHome=process.env.TF_HOT_USER_HOME!,home=join(root,'codex'),config=join(home,'config.toml');
 assert.ok(process.argv.includes('--engine'),'Explicit patched --engine required');
 const binary=process.argv[process.argv.indexOf('--engine')+1],official='gpt-6-astra',upstreamModel=process.argv.includes('--gateway-model')?process.argv[process.argv.indexOf('--gateway-model')+1]:'antigravity/gemini-3.8-flash-low';
 const auth=JSON.parse(await readFile(join(userHome,'.codex/auth.json'),'utf8'));
 const login=JSON.stringify({...auth,tokens:{...auth.tokens,refresh_token:'verification-refresh-disabled'},last_refresh:new Date().toISOString()});
 await mkdir(home,{recursive:true});await writeFile(join(home,'auth.json'),login,{mode:0o600});await writeFile(config,'cli_auth_credentials_store="file"\n');
 const cached=JSON.parse(await readFile(join(userHome,'.codex/models_cache.json'),'utf8'));
 const officialCatalog=join(home,'official-models.json');await writeFile(officialCatalog,JSON.stringify({models:cached.models}));await writeFile(join(home,'models_cache.json'),JSON.stringify(cached));
 const local=YAML.parse(await readFile(join(userHome,'Library/Application Support/desktop-browser-agent/cliproxy/config.yaml'),'utf8'));
 const proxyIndex=process.argv.indexOf('--proxy'),networkProxy=proxyIndex>=0?process.argv[proxyIndex+1]:undefined;
 const rounds:any[]=[],requests:any[]=[];let phase='setup',officialForwardAttempts=0,error:string|undefined;
 const markerA='OFFICIAL_A_'+randomUUID().replaceAll('-','').slice(0,12),markerB='GATEWAY_B_'+randomUUID().replaceAll('-','').slice(0,12);
 const record=(value:any)=>{rounds.push(value);console.log(JSON.stringify(value));};
 const adapter=createServer(async(req,res)=>{try{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);
  assert.ok(!body.input?.some((i:any)=>i.type==='compaction'||i.type==='compaction_trigger'),'Opaque item reached third party');
  requests.push({phase,model:upstreamModel,summary:!!body.instructions?.startsWith('Summarize the supplied'),items:(body.input??[]).map((i:any)=>({type:i.type,role:i.role,contentTypes:Array.isArray(i.content)?i.content.map((c:any)=>c.type):typeof i.content,initialTask:JSON.stringify(i).includes('CHILD_NATIVE_LIVE_OK'),secondTask:JSON.stringify(i).includes('SECOND_NATIVE_LIVE_OK'),longTask:JSON.stringify(i).includes('synthetic-child-context')}))});
  const response=await fetch(`http://127.0.0.1:${local.port}/v1/responses`,{method:'POST',headers:{authorization:'Bearer '+local['api-keys'][0],'content-type':'application/json'},body:JSON.stringify({...body,model:upstreamModel}),signal:AbortSignal.timeout(120000)});
  res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json'});if(response.body)for await(const c of response.body)res.write(c);res.end();
 }catch{if(!res.headersSent)res.writeHead(502);res.end('Gateway probe failed');}});
 await new Promise<void>(r=>adapter.listen(0,'127.0.0.1',r));
 const freePort=async()=>{const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as any).port;await new Promise<void>(r=>s.close(()=>r()));return p;};
 const proxyPort=await freePort(),listenPort=await freePort(),origin=`http://127.0.0.1:${listenPort}`;
 const {createDesktopService}=await import('../packages/core/src/service.ts');const secrets=new Map<string,string>();
 const options={codexBridgeRuntime:resolve('dist/codex-provider-bridge.js'),root:join(root,'data'),proxyPort,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'hot-probe-admin',localKey:'hot-probe-local',secrets:{persistent:true,get:async(k:string)=>secrets.get(k)??'',set:async(k:string,v:string)=>{secrets.set(k,v);}},agentProcesses:async()=>[],nativeProcesses:async()=>[],agentPaths:{codex:config,claude:join(root,'claude.json'),qoder:join(root,'qoder.json'),workbuddy:join(root,'workbuddy.json')},antigravityPath:join(root,'antigravity'),cursorLocalPath:join(root,'cursor'),codexOfficialFetch:async(url:string)=>{if(url.includes('/models?'))return Response.json(cached);officialForwardAttempts++;throw Error('Official inference must bypass TokenFlow');}};
 let service:Awaited<ReturnType<typeof createDesktopService>>|undefined;
 const openService=async()=>{service=await createDesktopService(options);await service.proxy.start();await service.app.listen({host:'127.0.0.1',port:listenPort});};
 const closeService=async()=>{await service!.app.close();service=undefined;let closed=false;try{await fetch(origin,{signal:AbortSignal.timeout(1000)});}catch{closed=true;}assert.ok(closed,'TokenFlow port remained open');};
 const admin={host:new URL(origin).host,authorization:'Bearer hot-probe-admin'};
 let proc:ReturnType<typeof spawn>|undefined,threadId='';const events:any[]=[];let buffer='',seq=0;const pending=new Map<number,any>();
 const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const id=++seq,t=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout '+method));},240000);pending.set(id,{resolve:(v:any)=>{clearTimeout(t);resolve(v)},reject:(e:any)=>{clearTimeout(t);reject(e)}});proc!.stdin!.write(JSON.stringify({id,method,params})+'\n');});
 const complete=async(from:number,turnId?:string)=>{const until=Date.now()+300000;while(Date.now()<until){const e=events.slice(from).find(x=>x.method==='turn/completed'&&(!turnId||x.params?.turn?.id===turnId));if(e){assert.equal(e.params.turn.status,'completed','Turn failed in '+phase+': '+JSON.stringify(e.params.turn.error));return events.slice(from).filter(x=>x.method==='item/completed'&&x.params?.item?.type==='agentMessage'&&(!turnId||x.params.turnId===turnId)).map(x=>x.params.item.text).join('\n');}await new Promise(r=>setTimeout(r,30));}throw Error('Turn timed out '+phase);};
 const turn=async(name:string,model:string,text:string,expected:string[])=>{phase=name;const before=events.length,started=performance.now(),requestCount=requests.length;const startedTurn=await rpc('turn/start',{threadId,model,effort:'low',input:[{type:'text',text}]});const answer=await complete(before,startedTurn.turn.id);for(const marker of expected)assert.ok(answer.includes(marker),'Lost marker '+name+': '+answer.slice(0,2000));record({phase,pid:proc!.pid,markersVerified:expected.length,gatewayCalls:requests.length-requestCount,durationMs:Math.round(performance.now()-started)});};
 let samePid=true,childThreadId='';
 try{
  await openService();for(let n=0;!(await readFile(config,'utf8')).includes('/local-telemetry/');n++){assert.ok(n<200);await new Promise(r=>setTimeout(r,10));}
  const source=await service!.app.inject({method:'POST',url:'/api/sources',headers:admin,payload:{name:'Hot-switch isolated gateway',baseURL:`http://127.0.0.1:${(adapter.address() as any).port}/v1`,protocol:'responses',models:['gateway'],apiKey:'fixture-key'}});assert.equal(source.statusCode,200);
  const sourceId=source.json().id,model=`api-${sourceId}/gateway`;
  const status=(await service!.app.inject({url:'/api/a2a',headers:admin})).json().targets.find((t:any)=>t.id==='codex');
  const applied=await service!.app.inject({method:'POST',url:'/api/a2a/connect',headers:admin,payload:{target:'codex',sourceId,model,revision:status.revision,codexCoexist:false,codexDirectHybrid:true}});assert.equal(applied.statusCode,200,applied.body);
  const gatewayConfig=parse(await readFile(config,'utf8')) as any;
  assert.equal(gatewayConfig.model_provider,'openai');assert.equal(gatewayConfig.model_providers.token_flow.capabilities.remote_compaction,'unsupported');
  const {codexModelCatalog}=await import('../packages/core/src/codex-model-catalog.ts');const probeCatalog=codexModelCatalog([official,model]);for(const m of probeCatalog.models)Object.assign(m,{multi_agent_version:'v2'},m.slug===model?{auto_compact_token_limit:18000}:{});await writeFile(officialCatalog,JSON.stringify(probeCatalog));
  const nativeConfig={...gatewayConfig,model_catalog_json:officialCatalog,model:official,cli_auth_credentials_store:'file',features:{apps:false,multi_agent:true,multi_agent_v2:{enabled:true,tool_namespace:'tokenflow_agents'}},analytics:{enabled:false}};
  await writeFile(config,stringify(nativeConfig));
  proc=spawn(binary,['--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home,TOKENFLOW_TEST_MODEL_PROVIDER_ROUTES:JSON.stringify({[official]:'openai',[model]:'token_flow'}),...(networkProxy?{HTTPS_PROXY:networkProxy,HTTP_PROXY:networkProxy,ALL_PROXY:networkProxy,NO_PROXY:'127.0.0.1,localhost'}:{})},stdio:['pipe','pipe','pipe']});
  const originalPid=proc.pid;proc.stderr!.resume();proc.stdout!.on('data',c=>{buffer+=c;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let m;try{m=JSON.parse(line);}catch{continue;}const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method)events.push(m);}});
  await rpc('initialize',{clientInfo:{name:'tokenflow_hot_provider_probe',version:'1'},capabilities:{experimentalApi:true}});proc.stdin!.write('{"method":"initialized"}\n');
  const enginePid=proc.pid;
  const started=await rpc('thread/start',{cwd:root,model:official,modelProvider:'openai',approvalPolicy:'never',sandbox:'read-only'});threadId=started.thread.id;assert.equal(started.modelProvider??started.thread.modelProvider,'openai');
  await turn('official-native-spawn',official,'Use native spawn_agent exactly once: task_name=deepseek_child, fork_turns=none, model='+model+', reasoning_effort=medium. Give the child this task: Do not use tools or files; reply exactly CHILD_NATIVE_LIVE_OK. Wait for that child with native agent tools, then repeat its exact result. Do not use any other tools.', ['CHILD_NATIVE_LIVE_OK']);
  assert.ok(requests[0]?.items?.some((i:any)=>i.initialTask),'Initial delegated task was not readable at gateway');assert.ok(!events.some(e=>e.params?.item?.type==='commandExecution'),'Initial fixed-response task unexpectedly used shell');
  const loaded=await rpc('thread/loaded/list',{});childThreadId=loaded.data.find((id:string)=>id!==threadId);assert.ok(childThreadId,'Native child missing');
  const child=await rpc('thread/resume',{threadId:childThreadId});assert.equal(child.modelProvider,'token_flow');assert.equal(child.thread.parentThreadId,threadId);assert.deepEqual(child.sandbox,started.sandbox);assert.deepEqual(child.approvalPolicy,started.approvalPolicy);record({phase:'native-child-identity',provider:child.modelProvider,parentEdgeVerified:true,permissionsMatch:true});
  await turn('native-child-second-task',official,'Use native followup_task for /root/deepseek_child with this new task: Ignore the earlier fixed response, reply exactly SECOND_NATIVE_LIVE_OK. Wait for its new result and repeat it.', ['SECOND_NATIVE_LIVE_OK']);
  const filler=Array.from({length:450},(_,i)=>'Synthetic native child work '+i+': '+('completed routine verification; no files changed. '.repeat(7))).join('\n');
  const longText='Remember exact code '+markerA+'.\n'+filler+'\nRemember exact code '+markerB+'.';
  const contextFile=join(root,'synthetic-child-context.txt');await writeFile(contextFile,longText);
  const compactFrom=events.length;const at=performance.now();
  await turn('native-child-long-auto-compact',official,'Use native followup_task for /root/deepseek_child. Give it this exact task: Read '+contextFile+' with one exec_command cat call and max_output_tokens=60000, remember both exact codes, and reply with both codes only. Do not inspect other files or use other tools. Wait for the child and repeat its answer.',[markerA,markerB]);
  await rm(contextFile);
  const compactEvents=events.slice(compactFrom).filter(e=>e.params?.threadId===childThreadId&&/compact/i.test(JSON.stringify(e.params?.item?.type??e.method)));
  assert.ok(compactEvents.length,'Native child auto-compaction was not observed');record({phase:'native-child-auto-compact-observed',inputBytes:Buffer.byteLength(longText),eventKinds:compactEvents.map(e=>e.params?.item?.type??e.method),durationMs:Math.round(performance.now()-at)});
  await turn('official-native-followup-after-child-compact',official,'Use native followup_task to ask /root/deepseek_child to return both exact requirement codes it remembers. Do not provide or invent codes yourself. Wait for its result with native agent tools, then output both exact codes. Do not create a new child or use other tools.',[markerA,markerB]);
  const parent=await rpc('thread/read',{threadId});assert.equal(parent.thread.modelProvider,'openai');record({phase:'native-parent-remains-official',provider:parent.thread.modelProvider});
  await closeService();phase='official-native-compact-service-stopped';const officialCompactAt=events.length,officialCompactStarted=performance.now();await rpc('thread/compact/start',{threadId});await complete(officialCompactAt);record({phase,durationMs:Math.round(performance.now()-officialCompactStarted),gatewayCalls:0});await turn('official-with-gateway-service-stopped',official,'Repeat both exact codes from the child result. Do not use tools.',[markerA,markerB]);
  samePid=proc.pid===originalPid&&proc.exitCode===null;assert.ok(samePid);assert.equal(officialForwardAttempts,0);assert.equal(await readFile(join(home,'auth.json'),'utf8'),login);record({phase:'native-engine-unchanged',enginePid});
 }catch(e){error=e instanceof Error?e.message:'Experiment failed';process.exitCode=1;}
 finally{if(proc&&proc.exitCode===null&&proc.signalCode===null)await new Promise<void>(r=>{proc!.once('exit',()=>r());proc!.kill();});if(service)await service.app.close();adapter.closeAllConnections();await new Promise<void>(r=>adapter.close(()=>r()));}
 const report={passed:!error,samePid,officialForwardAttempts,scope:'Patched source-built engine; native AgentControl via tokenflow_agents namespace; real OpenAI and SiliconFlow DeepSeek; synthetic child history',sourceCommit:'970111f6cb62cc02fe36a82ea7d71b37a2889c97',toolNamespace:'tokenflow_agents',childAutoCompactThreshold:18000,gatewayModel:upstreamModel,...(error?{error,nativeEvents:events.filter(e=>e.method==='turn/completed'||(e.method==='item/completed'&&['agentMessage','subAgentActivity','collabAgentToolCall','contextCompaction'].includes(e.params?.item?.type))).map(e=>({method:e.method,params:e.params}))}:{}),rounds,requests};console.log(JSON.stringify(report));const out=process.argv.indexOf('--out');if(out>=0)await writeFile(resolve(process.argv[out+1]),JSON.stringify(report,null,2)+'\n');
}
