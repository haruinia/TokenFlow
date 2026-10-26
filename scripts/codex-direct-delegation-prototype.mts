/** Prototype: dynamic delegation tool, not native spawn_agent. Isolated live experiment: one Codex app-server PID, native OpenAI while the
 * test TokenFlow service is stopped, then provider switching without restart.
 * Never connects to or stops the user's desktop Codex process.
 */
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
 const binary='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',official='gpt-6-astra',upstreamModel=process.argv.includes('--gateway-model')?process.argv[process.argv.indexOf('--gateway-model')+1]:'antigravity/gemini-3.8-flash-low';
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
 const turn=async(name:string,model:string,text:string,expected:string[])=>{phase=name;const before=events.length,started=performance.now(),requestCount=requests.length;const startedTurn=await rpc('turn/start',{threadId,model,effort:'low',input:[{type:'text',text}]});const answer=await complete(before,startedTurn.turn.id);for(const marker of expected)assert.ok(answer.includes(marker),'Lost marker '+name);record({phase,pid:proc!.pid,markersVerified:expected.length,gatewayCalls:requests.length-requestCount,durationMs:Math.round(performance.now()-started)});};
 const compact=async(name:string)=>{phase=name;const before=events.length,started=performance.now(),requestCount=requests.length;await rpc('thread/compact/start',{threadId});await complete(before);record({phase,pid:proc!.pid,gatewayCalls:requests.length-requestCount,durationMs:Math.round(performance.now()-started)});};
 const resume=async(name:string,provider:string,model:string)=>{const r=await rpc('thread/resume',{threadId,model,modelProvider:provider,approvalPolicy:'never',sandbox:'read-only'});assert.equal(r.thread.id,threadId);const actual=r.modelProvider??r.thread.modelProvider;record({phase:name,pid:proc!.pid,requested:provider,actual,model:r.model});return actual;};
 const rows=async()=>{const found:any[]=[];const walk=async(dir:string)=>{for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else if(e.name.endsWith('.jsonl'))for(const line of (await readFile(p,'utf8')).split('\n'))if(line.trim())found.push(JSON.parse(line));}};await walk(join(home,'sessions'));return found;};
 let samePid=true,delegations=0,delegationError:string|undefined;let runDelegation:()=>Promise<string>;let childThreadId='';
 try{
  await openService();for(let n=0;!(await readFile(config,'utf8')).includes('/local-telemetry/');n++){assert.ok(n<200);await new Promise(r=>setTimeout(r,10));}
  const source=await service!.app.inject({method:'POST',url:'/api/sources',headers:admin,payload:{name:'Hot-switch isolated gateway',baseURL:`http://127.0.0.1:${(adapter.address() as any).port}/v1`,protocol:'responses',models:['gateway'],apiKey:'fixture-key'}});assert.equal(source.statusCode,200);
  const sourceId=source.json().id,model=`api-${sourceId}/gateway`;
  const status=(await service!.app.inject({url:'/api/a2a',headers:admin})).json().targets.find((t:any)=>t.id==='codex');
  const applied=await service!.app.inject({method:'POST',url:'/api/a2a/connect',headers:admin,payload:{target:'codex',sourceId,model,revision:status.revision,codexCoexist:false,codexDirectHybrid:true}});assert.equal(applied.statusCode,200,applied.body);
  const gatewayConfig=parse(await readFile(config,'utf8')) as any;
  assert.equal(gatewayConfig.model_provider,'openai');assert.equal(gatewayConfig.model_providers.token_flow.capabilities.remote_compaction,'unsupported');
  const nativeConfig={...gatewayConfig,model:official,cli_auth_credentials_store:'file',features:{apps:false},analytics:{enabled:false}};
  await writeFile(config,stringify(nativeConfig));
  const bridgeRoot=join(root,'data/codex-direct-bridge');
  proc=spawn(process.execPath,[join(bridgeRoot,'bridge.mjs'),'app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home,...(networkProxy?{HTTPS_PROXY:networkProxy,HTTP_PROXY:networkProxy,ALL_PROXY:networkProxy,NO_PROXY:'127.0.0.1,localhost'}:{})},stdio:['pipe','pipe','pipe']});
  const originalPid=proc.pid;proc.stderr!.resume();proc.stdout!.on('data',c=>{buffer+=c;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let m;try{m=JSON.parse(line);}catch{continue;}const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method==='item/tool/call'){
    if(m.params?.tool!=='delegate_deepseek'){proc!.stdin!.write(JSON.stringify({id:m.id,result:{success:false,contentItems:[{type:'inputText',text:'Unknown test tool'}]}})+'\n');continue;}
    void runDelegation().then(text=>proc!.stdin!.write(JSON.stringify({id:m.id,result:{success:true,contentItems:[{type:'inputText',text}]}})+'\n'),()=>{delegationError='Gateway delegation failed';proc!.stdin!.write(JSON.stringify({id:m.id,result:{success:false,contentItems:[{type:'inputText',text:delegationError}]}})+'\n');});
   }else if(m.method)events.push(m);}});
  await rpc('initialize',{clientInfo:{name:'tokenflow_hot_provider_probe',version:'1'},capabilities:{experimentalApi:true}});proc.stdin!.write('{"method":"initialized"}\n');
  const enginePid=JSON.parse(await readFile(join(bridgeRoot,`status-${proc.pid}.json`),'utf8')).enginePid;
  const delegateTool={type:'function',deferLoading:false,name:'delegate_deepseek',description:'Delegate the isolated synthetic continuity test to a DeepSeek worker. The worker uses its own gateway provider and read-only session. Returns its verified result after long-context compaction. Call exactly once when requested.',inputSchema:{type:'object',properties:{},additionalProperties:false}};
  const started=await rpc('thread/start',{cwd:root,model:official,modelProvider:'openai',approvalPolicy:'never',sandbox:'read-only',dynamicTools:[delegateTool]});threadId=started.thread.id;assert.equal(started.modelProvider??started.thread.modelProvider,'openai');
  runDelegation=async()=>{
   assert.equal(++delegations,1,'Duplicate delegate call');
   const began=performance.now();phase='worker-start';
   const child=await rpc('thread/start',{cwd:root,model,modelProvider:'token_flow',approvalPolicy:'never',sandbox:'read-only'});childThreadId=child.thread.id;
   assert.notEqual(childThreadId,threadId);assert.equal(child.modelProvider,'token_flow');assert.deepEqual(child.sandbox,started.sandbox);assert.deepEqual(child.approvalPolicy,started.approvalPolicy);
   record({phase:'worker-created',provider:child.modelProvider,permissionsMatch:true});
   const filler=Array.from({length:1200},(_,i)=>'Synthetic work log '+i+': '+('completed routine verification; no files changed. '.repeat(7))).join('\n');
   const text='Remember exact code '+markerA+'.\n'+filler+'\nAlso remember exact code '+markerB+'. Do not use tools. Reply with both exact codes only.';
   const before=events.length;phase='worker-long-turn';const result=await rpc('turn/start',{threadId:childThreadId,model,effort:'medium',input:[{type:'text',text}]});const answer=await complete(before,result.turn.id);for(const marker of [markerA,markerB])assert.ok(answer.includes(marker),'Worker first-turn marker missing');
   record({phase:'worker-long-turn',inputBytes:Buffer.byteLength(text),markersVerified:2});
   phase='worker-local-compaction';const compactAt=events.length,compactStart=performance.now();await rpc('thread/compact/start',{threadId:childThreadId});await complete(compactAt);record({phase,durationMs:Math.round(performance.now()-compactStart)});
   phase='worker-after-compaction';const next=events.length;const resumed=await rpc('turn/start',{threadId:childThreadId,model,input:[{type:'text',text:'Return both exact codes from our conversation. Do not use tools.'}]});const final=await complete(next,resumed.turn.id);for(const marker of [markerA,markerB])assert.ok(final.includes(marker),'Worker compacted marker missing');
   await rpc('thread/unsubscribe',{threadId:childThreadId});record({phase:'worker-completed',markersVerified:2,durationMs:Math.round(performance.now()-began)});phase='official-receives-worker-result';return final;
  };
  await turn('official-dispatches-worker',official,'Call delegate_deepseek exactly once now. Wait for its tool result. Return the exact two codes from that result. Do not use other tools, read files, or invent codes.',[markerA,markerB]);
  assert.equal(delegations,1);assert.equal(delegationError,undefined);assert.ok(requests.length>=3);
  const parentRead=await rpc('thread/read',{threadId,includeTurns:false});assert.equal(parentRead.thread.modelProvider,'openai');record({phase:'parent-still-official',provider:parentRead.thread.modelProvider});
  await closeService();await turn('official-after-worker-service-stopped',official,'Repeat both exact codes returned by the worker. Do not call any tool.',[markerA,markerB]);await compact('official-native-compact-after-worker');await turn('official-after-native-compaction',official,'Repeat both exact codes returned by the worker. Do not call any tool.',[markerA,markerB]);
  const state=JSON.parse(await readFile(join(bridgeRoot,`status-${proc.pid}.json`),'utf8'));samePid=proc.pid===originalPid&&proc.exitCode===null;assert.ok(samePid);assert.equal(state.enginePid,enginePid);record({phase:'engine-unchanged',bridgePid:proc.pid,enginePid,long:process.argv.includes('--long')});assert.equal(officialForwardAttempts,0);assert.equal(await readFile(join(home,'auth.json'),'utf8'),login);
 }catch(e){error=e instanceof Error?e.message:'Experiment failed';process.exitCode=1;}
 finally{if(proc&&proc.exitCode===null&&proc.signalCode===null)await new Promise<void>(r=>{proc!.once('exit',()=>r());proc!.kill();});if(service)await service.app.close();adapter.closeAllConnections();await new Promise<void>(r=>adapter.close(()=>r()));}
 const report={passed:!error,samePid,delegations,officialForwardAttempts,scope:'Prototype dynamic tool creates independent gateway worker; not native spawn_agent; actual official and DeepSeek inference',gatewayModel:upstreamModel,...(error?{error}:{}),rounds,requests};console.log(JSON.stringify(report));const out=process.argv.indexOf('--out');if(out>=0)await writeFile(resolve(process.argv[out+1]),JSON.stringify(report,null,2)+'\n');
}
