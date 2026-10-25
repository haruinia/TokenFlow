/** Live acceptance: production gateway extension on the unmodified installed official engine. Isolated HOME; no user conversation content. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,realpath,mkdir,readFile,writeFile,rm,readdir,copyFile} from 'node:fs/promises';
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
 const binary='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',official='gpt-6.1-sol',upstreamModel=process.argv.includes('--gateway-model')?process.argv[process.argv.indexOf('--gateway-model')+1]:'antigravity/gemini-3.8-flash-low';
 const auth=JSON.parse(await readFile(join(userHome,'.codex/auth.json'),'utf8'));
 const login=JSON.stringify({...auth,tokens:{...auth.tokens,refresh_token:'verification-refresh-disabled'},last_refresh:new Date().toISOString()});
 await mkdir(home,{recursive:true});await writeFile(join(home,'auth.json'),login,{mode:0o600});await writeFile(config,'cli_auth_credentials_store="file"\n');
 const cached=JSON.parse(await readFile(join(userHome,'.codex/models_cache.json'),'utf8'));
 const officialCatalog=join(home,'official-models.json');await writeFile(officialCatalog,JSON.stringify({models:cached.models}));await writeFile(join(home,'models_cache.json'),JSON.stringify(cached));
 const local=YAML.parse(await readFile(join(userHome,'Library/Application Support/desktop-browser-agent/cliproxy/config.yaml'),'utf8'));
 const proxyIndex=process.argv.indexOf('--proxy'),networkProxy=proxyIndex>=0?process.argv[proxyIndex+1]:undefined;
 const desktopNulls=process.argv.includes('--desktop-nulls'),delegationOnly=process.argv.includes('--delegation-only');
 const rounds:any[]=[],requests:any[]=[];let phase='setup',officialForwardAttempts=0,error:string|undefined;
 const markerA='OFFICIAL_A_'+randomUUID().replaceAll('-','').slice(0,12),markerB='GATEWAY_B_'+randomUUID().replaceAll('-','').slice(0,12);
 const record=(value:any)=>{rounds.push(value);console.log(JSON.stringify(value));};
 const adapter=createServer(async(req,res)=>{try{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);
  assert.ok(!body.input?.some((i:any)=>i.type==='compaction'||i.type==='compaction_trigger'),'Opaque item reached third party');
  requests.push({phase,model:upstreamModel,summary:!!body.instructions?.startsWith('Summarize the supplied')});
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
 const turn=async(name:string,model:string,text:string,expected:string[])=>{phase=name;const before=events.length,started=performance.now(),requestCount=requests.length;const startedTurn=await rpc('turn/start',{...(desktopNulls?{cwd:null,approvalPolicy:null,approvalsReviewer:null,permissions:null,sandboxPolicy:null,disabledPluginIds:null,collaborationMode:null,serviceTier:null}:{}),threadId,model,effort:'low',input:[{type:'text',text}]});const answer=await complete(before,startedTurn.turn.id);for(const marker of expected)assert.ok(answer.includes(marker),'Lost marker '+name+': '+answer.slice(0,2500));record({phase,pid:proc!.pid,markersVerified:expected.length,gatewayCalls:requests.length-requestCount,durationMs:Math.round(performance.now()-started)});};
 const compact=async(name:string)=>{phase=name;const before=events.length,started=performance.now(),requestCount=requests.length;await rpc('thread/compact/start',{threadId});await complete(before);record({phase,pid:proc!.pid,gatewayCalls:requests.length-requestCount,durationMs:Math.round(performance.now()-started)});};
 const resume=async(name:string,provider:string,model:string)=>{const r=await rpc('thread/resume',{threadId,model,modelProvider:provider,approvalPolicy:'never',sandbox:'read-only'});assert.equal(r.thread.id,threadId);const actual=r.modelProvider??r.thread.modelProvider;record({phase:name,pid:proc!.pid,requested:provider,actual,model:r.model});return actual;};
 const rows=async()=>{const found:any[]=[];const walk=async(dir:string)=>{for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else if(e.name.endsWith('.jsonl'))for(const line of (await readFile(p,'utf8')).split('\n'))if(line.trim())found.push(JSON.parse(line));}};await walk(join(home,'sessions'));return found;};
 let samePid=true;let childThreadId='';
 try{
  await openService();for(let n=0;!(await readFile(config,'utf8')).includes('/local-telemetry/');n++){assert.ok(n<200);await new Promise(r=>setTimeout(r,10));}
  const source=await service!.app.inject({method:'POST',url:'/api/sources',headers:admin,payload:{name:'Hot-switch isolated gateway',baseURL:`http://127.0.0.1:${(adapter.address() as any).port}/v1`,protocol:'responses',models:['gateway'],apiKey:'fixture-key'}});assert.equal(source.statusCode,200);
  const sourceId=source.json().id,model=`api-${sourceId}/gateway`;
  const status=(await service!.app.inject({url:'/api/a2a',headers:admin})).json().targets.find((t:any)=>t.id==='codex');
  const applied=await service!.app.inject({method:'POST',url:'/api/a2a/connect',headers:admin,payload:{target:'codex',sourceId,model,revision:status.revision,codexCoexist:false,codexDirectHybrid:true}});assert.equal(applied.statusCode,200,applied.body);
  const gatewayConfig=parse(await readFile(config,'utf8')) as any;
  assert.equal(gatewayConfig.model_provider,'openai');assert.equal(gatewayConfig.model_providers.token_flow.capabilities.remote_compaction,'unsupported');
  const nativeConfig={...gatewayConfig,model:official,cli_auth_credentials_store:'file',features:{apps:false,...(desktopNulls?{code_mode:true,code_mode_host:true}:{})},analytics:{enabled:false}};
  await writeFile(config,stringify(nativeConfig));
  const bridgeRoot=join(root,'data/codex-direct-bridge');
  proc=spawn(process.execPath,[join(bridgeRoot,'bridge.mjs'),'app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home,...(networkProxy?{HTTPS_PROXY:networkProxy,HTTP_PROXY:networkProxy,ALL_PROXY:networkProxy,NO_PROXY:'127.0.0.1,localhost'}:{})},stdio:['pipe','pipe','pipe']});
  const originalPid=proc.pid;proc.stderr!.resume();proc.stdout!.on('data',c=>{buffer+=c;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let m;try{m=JSON.parse(line);}catch{continue;}const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method)events.push(m);}});
  await rpc('initialize',{clientInfo:{name:'tokenflow_hot_provider_probe',version:'1'},capabilities:{experimentalApi:true}});proc.stdin!.write('{"method":"initialized"}\n');
  const enginePid=JSON.parse(await readFile(join(bridgeRoot,`status-${proc.pid}.json`),'utf8')).enginePid;
  const bridgeSettings=JSON.parse(await readFile(join(bridgeRoot,'settings.json'),'utf8'));assert.equal(bridgeSettings.nativeAgents,undefined);assert.equal(bridgeSettings.gatewayWorkers,true);
  const started=await rpc('thread/start',{cwd:root,model:official,modelProvider:'openai',approvalPolicy:'never',sandbox:'read-only'});threadId=started.thread.id;
  await turn('official-dispatches-gateway',official,(desktopNulls?'Use functions.exec and tools.tokenflow_gateway__spawn_agent / tools.tokenflow_gateway__wait_agent for these gateway tool calls. ':'')+'Use tokenflow_gateway.spawn_agent exactly once with task_name=deepseek_child, model='+model+', fork_turns=none. Task: Do not use tools or files; remember '+markerA+' and reply exactly '+markerA+'. Then use tokenflow_gateway.wait_agent until the task finishes. Repeat its exact answer. Use no other tools.',[markerA]);
  const parentNative=await rpc('thread/read',{threadId});assert.equal(parentNative.thread.modelProvider,'openai');
  await turn('official-follows-up-gateway',official,'Use tokenflow_gateway.list_agents to find your existing gateway task, then tokenflow_gateway.followup_task to ask it: Recall the previous exact code and also reply '+markerB+'. Do not use tools. Wait for completion using tokenflow_gateway.wait_agent. Repeat both exact codes.',[markerA,markerB]);
  const loaded=await rpc('thread/loaded/list',{});const children=loaded.data.filter((id:string)=>id!==threadId);assert.equal(children.length,1);childThreadId=children[0];const worker=await rpc('thread/resume',{threadId:childThreadId,excludeTurns:true});assert.equal(worker.modelProvider,'token_flow');assert.deepEqual(worker.sandbox,started.sandbox);assert.deepEqual(worker.approvalPolicy,started.approvalPolicy);assert.equal(worker.thread.parentThreadId??null,null);
  record({phase:'independent-worker-verified',provider:worker.modelProvider,permissionsMatch:true,nativeParentEdge:false});
  assert.ok(requests.length>=2);
  const parentRead=await rpc('thread/read',{threadId,includeTurns:false});assert.equal(parentRead.thread.modelProvider,'openai');record({phase:'parent-still-official',provider:parentRead.thread.modelProvider});
  await closeService();await turn('official-after-worker-service-stopped',official,'Repeat both exact codes returned by the worker. Do not call any tool.',[markerA,markerB]);if(!delegationOnly){await compact('official-native-compact-after-worker');await turn('official-after-native-compaction',official,'Repeat both exact codes returned by the worker. Do not call any tool.',[markerA,markerB]);}
  const state=JSON.parse(await readFile(join(bridgeRoot,`status-${proc.pid}.json`),'utf8'));samePid=proc.pid===originalPid&&proc.exitCode===null;assert.ok(samePid);assert.equal(state.enginePid,enginePid);record({phase:'engine-unchanged',bridgePid:proc.pid,enginePid,long:process.argv.includes('--long')});assert.equal(officialForwardAttempts,0);assert.equal(await readFile(join(home,'auth.json'),'utf8'),login);
 }catch(e){error=e instanceof Error?e.message:'Experiment failed';process.exitCode=1;}
 finally{if(proc&&proc.exitCode===null&&proc.signalCode===null)await new Promise<void>(r=>{proc!.once('exit',()=>r());proc!.kill();});if(service)await service.app.close();adapter.closeAllConnections();await new Promise<void>(r=>adapter.close(()=>r()));}
 const codeModeUsed=events.some(e=>e.method==='item/completed'&&['codeMode','codeModeToolCall'].includes(e.params?.item?.type));
 const report={passed:!error,desktopNulls,delegationOnly,codeModeUsed,itemTypes:[...new Set(events.filter(e=>e.method==='item/completed').map(e=>e.params?.item?.type))],samePid,officialForwardAttempts,scope:'Production extension creates independent gateway worker on installed official engine; native tools and official inference unchanged',gatewayModel:upstreamModel,...(error?{error,events:events.filter(e=>e.method==='item/completed').map(e=>e.params?.item)}:{}),rounds,requests};console.log(JSON.stringify(report));const out=process.argv.indexOf('--out');if(out>=0)await writeFile(resolve(process.argv[out+1]),JSON.stringify(report,null,2)+'\n');
}
