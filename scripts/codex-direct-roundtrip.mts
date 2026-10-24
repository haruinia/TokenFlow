/** Live native OpenAI -> gateway -> native OpenAI, with isolated HOME/history.
 * No official inference hook or base URL override. --proxy is an ordinary network
 * proxy for the native Codex process, not TokenFlow. Original login is read only.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,realpath,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {stringify,parse} from 'smol-toml';
import YAML from 'yaml';
assert.ok(process.argv.includes('--live'),'Explicit --live is required');
if(!process.env.TF_DIRECT_ROOT){
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-direct-roundtrip-'));
 try{const proc=spawn(process.execPath,['--import','tsx',resolve(process.argv[1]),...process.argv.slice(2)],{env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:join(root,'codex'),TF_DIRECT_ROOT:root,TF_DIRECT_USER_HOME:homedir()},stdio:'inherit'});process.exitCode=await new Promise<number>(r=>proc.once('exit',c=>r(c??1)));}
 finally{await rm(root,{recursive:true,force:true});}
}else{
 const root=process.env.TF_DIRECT_ROOT,userHome=process.env.TF_DIRECT_USER_HOME!,home=join(root,'codex'),config=join(home,'config.toml');
 const binary='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',official='gpt-6-astra',gatewayModel='antigravity/gemini-3.8-flash-low';
 const auth=JSON.parse(await readFile(join(userHome,'.codex/auth.json'),'utf8'));
 const login=JSON.stringify({...auth,tokens:{...auth.tokens,refresh_token:'verification-refresh-disabled'},last_refresh:new Date().toISOString()});
 await mkdir(home,{recursive:true});await writeFile(join(home,'auth.json'),login,{mode:0o600});await writeFile(config,'cli_auth_credentials_store="file"\n');
 const cached=JSON.parse(await readFile(join(userHome,'.codex/models_cache.json'),'utf8'));
 const officialCatalog=join(home,'official-models.json');await writeFile(officialCatalog,JSON.stringify({models:cached.models}));
 const nativeConfig={model:official,model_provider:'openai',model_catalog_json:officialCatalog,cli_auth_credentials_store:'file',features:{apps:false},analytics:{enabled:false}};
 const local=YAML.parse(await readFile(join(userHome,'Library/Application Support/desktop-browser-agent/cliproxy/config.yaml'),'utf8'));
 const proxyIndex=process.argv.indexOf('--proxy'),networkProxy=proxyIndex>=0?process.argv[proxyIndex+1]:undefined;
 const requests:any[]=[],rounds:any[]=[];let phase='setup',officialForwardAttempts=0,serviceClosed=false,adapterClosed=false;
 const markers=['DIRECT_A_','GATEWAY_B_'].map(p=>p+randomUUID().replaceAll('-','').slice(0,12));
 const adapter=createServer(async(req,res)=>{try{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);assert.ok(!body.input?.some((i:any)=>i.type==='compaction'||i.type==='compaction_trigger'),'Opaque state reached gateway');requests.push({phase,summary:!!body.instructions?.startsWith('Summarize the supplied'),model:gatewayModel});const response=await fetch(`http://127.0.0.1:${local.port}/v1/responses`,{method:'POST',headers:{authorization:'Bearer '+local['api-keys'][0],'content-type':'application/json'},body:JSON.stringify({...body,model:gatewayModel}),signal:AbortSignal.timeout(120000)});res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json'});if(response.body)for await(const c of response.body)res.write(c);res.end();}catch{if(!res.headersSent)res.writeHead(502);res.end('Gateway verification failed');}});
 await new Promise<void>(r=>adapter.listen(0,'127.0.0.1',r));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const proxyPort=(allocator.address() as any).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const {createDesktopService}=await import('../packages/core/src/service.ts');const secrets=new Map<string,string>();
 const service=await createDesktopService({root:join(root,'data'),proxyPort,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'direct-probe-admin',localKey:'direct-probe-local',secrets:{persistent:true,get:async(k:string)=>secrets.get(k)??'',set:async(k:string,v:string)=>{secrets.set(k,v);}},agentProcesses:async()=>[],nativeProcesses:async()=>[],agentPaths:{codex:config,claude:join(root,'claude.json'),qoder:join(root,'qoder.json'),workbuddy:join(root,'workbuddy.json')},antigravityPath:join(root,'antigravity'),cursorLocalPath:join(root,'cursor'),codexOfficialFetch:async(url)=>{if(url.includes('/models?'))return Response.json(cached);officialForwardAttempts++;throw Error('Official inference must bypass TokenFlow');}});
 const record=(r:any)=>{rounds.push(r);console.log(JSON.stringify(r));};
 let proc:ReturnType<typeof spawn>|undefined;let client:any,threadId:string|undefined,error:string|undefined;
 const stop=async()=>{if(proc&&proc.exitCode===null&&proc.signalCode===null)await new Promise<void>(r=>{proc!.once('exit',()=>r());proc!.kill();});};
 const start=async(provider:string,model:string)=>{
  proc=spawn(binary,['app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home,...(networkProxy?{HTTPS_PROXY:networkProxy,HTTP_PROXY:networkProxy,ALL_PROXY:networkProxy,NO_PROXY:'127.0.0.1,localhost'}:{})},stdio:['pipe','pipe','pipe']});
  let buffer='',id=0;const events:any[]=[],pending=new Map<number,any>();proc.stderr!.resume();
  proc.stdout!.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let m;try{m=JSON.parse(line);}catch{continue;}const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error('RPC '+p.method+' failed: '+m.error.message)):p.resolve(m.result);}else if(m.method)events.push(m);}});
  const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const n=++id,t=setTimeout(()=>{pending.delete(n);reject(Error('RPC timeout '+method));},30000);pending.set(n,{method,resolve:(v:any)=>{clearTimeout(t);resolve(v)},reject:(e:any)=>{clearTimeout(t);reject(e)}});proc!.stdin!.write(JSON.stringify({id:n,method,params})+'\n');});
  const complete=async(from:number)=>{const until=Date.now()+180000;while(Date.now()<until){const e=events.slice(from).find(x=>x.method==='turn/completed');if(e){assert.equal(e.params.turn.status,'completed','Turn failed in '+phase+': '+JSON.stringify(e.params.turn.error));return events.slice(from).filter(x=>x.method==='item/completed'&&x.params?.item?.type==='agentMessage').map(x=>x.params.item.text).join('\n');}await new Promise(r=>setTimeout(r,25));}throw Error('Turn timed out: '+phase);};
  await rpc('initialize',{clientInfo:{name:'tokenflow_direct_probe',version:'1'},capabilities:{experimentalApi:true}});proc.stdin!.write('{"method":"initialized"}\n');
  const result=await rpc(threadId?'thread/resume':'thread/start',{...(threadId?{threadId}:{}),cwd:root,model,modelProvider:provider,approvalPolicy:'never',sandbox:'read-only'});threadId=result.thread.id;
  assert.equal(result.modelProvider??result.thread.modelProvider,provider,'Requested provider was not applied on load');
  return {rpc,turn:async(name:string,text:string,expected:string[])=>{phase=name;const begin=performance.now(),before=events.length;await rpc('turn/start',{threadId,model,effort:provider==='openai'?'low':'medium',input:[{type:'text',text}]});const answer=await complete(before);for(const m of expected)assert.ok(answer.includes(m),'Lost requirement in '+phase);record({phase,provider,markersVerified:expected.length,durationMs:Math.round(performance.now()-begin)});},compact:async(name:string)=>{phase=name;const begin=performance.now(),before=events.length;await rpc('thread/compact/start',{threadId});await complete(before);record({phase,provider,durationMs:Math.round(performance.now()-begin)});}};
 };
 const rows=async()=>{const result:any[]=[];const walk=async(dir:string)=>{for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else if(e.name.endsWith('.jsonl'))for(const line of (await readFile(p,'utf8')).split('\n')){if(line.trim())result.push(JSON.parse(line));}}};await walk(join(home,'sessions'));return result;};
 const checkpoint=async(prefix:string)=>{const data=await rows();const items=data.flatMap(row=>row.type==='compacted'?row.payload?.replacement_history??[]:row.type==='response_item'?[row.payload]:[]);assert.ok(items.some(i=>i.type==='compaction'&&typeof i.encrypted_content==='string'&&(prefix==='native'?!i.encrypted_content.startsWith('tfctx1.'):i.encrypted_content.startsWith('tfctx1.'))),'Missing '+prefix+' checkpoint');record({phase:phase+'-checkpoint',kind:prefix});};
 try{
  await service.proxy.start();const origin=await service.app.listen({host:'127.0.0.1',port:0}),admin={host:new URL(origin).host,authorization:'Bearer direct-probe-admin'};
  for(let n=0;!(await readFile(config,'utf8')).includes('/local-telemetry/');n++){assert.ok(n<200);await new Promise(r=>setTimeout(r,10));}
  const source=await service.app.inject({method:'POST',url:'/api/sources',headers:admin,payload:{name:'Direct test gateway',baseURL:`http://127.0.0.1:${(adapter.address() as any).port}/v1`,protocol:'responses',models:['gateway'],apiKey:'fixture-key'}});assert.equal(source.statusCode,200);
  const sourceId=source.json().id,model=`api-${sourceId}/gateway`;
  const status=(await service.app.inject({url:'/api/a2a',headers:admin})).json().targets.find((t:any)=>t.id==='codex');
  const applied=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers:admin,payload:{target:'codex',sourceId,model,revision:status.revision,codexCoexist:true}});assert.equal(applied.statusCode,200);
  const gatewayConfig=parse(await readFile(config,'utf8')) as any;
  // Keep the gateway provider declared for a read-only hot-resume probe. Native
  // OpenAI has no URL override and no TokenFlow credentials or telemetry.
  await writeFile(config,stringify({...nativeConfig,model_providers:gatewayConfig.model_providers}));
  client=await start('openai',official);
  await client.turn('native-official-seed',`Isolated continuity test. Do not use tools or files. Remember ${markers[0]} and reply with it.`,[markers[0]]);
  await client.compact('native-official-compact');await checkpoint('native');
  assert.equal(officialForwardAttempts,0);assert.equal(requests.length,0);
  const hot=await client.rpc('thread/resume',{threadId,model,modelProvider:'token_flow',approvalPolicy:'never',sandbox:'read-only'});
  record({phase:'loaded-thread-provider-switch-probe',requested:'token_flow',actual:hot.modelProvider??hot.thread.modelProvider});
  await stop();await writeFile(config,stringify(gatewayConfig));client=await start('token_flow',model);
  const recall='Return all exact DIRECT_A_ and GATEWAY_B_ requirement identifiers from prior context. Do not use tools or files.';
  await client.turn('gateway-after-native-checkpoint',recall,[markers[0]]);
  await client.turn('gateway-add-requirement',`Also remember ${markers[1]}. ${recall}`,markers);
  await client.turn('gateway-before-summary',recall,markers);
  await client.compact('gateway-summary');await checkpoint('gateway');assert.ok(requests.some(r=>r.summary));await stop();
  // Materialize the gateway-owned checkpoint while the isolated client is shut
  // down. This is required before a true direct official endpoint can read it.
  const {GatewayContext}=await import('../packages/core/src/gateway-context.ts');const {CodexContext}=await import('../packages/core/src/codex-context.ts');
  const context=await GatewayContext.open(join(root,'data')),migration=new CodexContext(join(root,'data'),config,context);
  const converted=await migration.prepareOfficial([],async()=>[]);assert.ok(converted.migrated>0,'Gateway checkpoint was not materialized');record({phase:'prepare-direct-official',migrated:converted.migrated});
  await service.app.close();serviceClosed=true;adapter.closeAllConnections();await new Promise<void>(r=>adapter.close(()=>r()));adapterClosed=true;
  let portClosed=false;try{await fetch(origin,{signal:AbortSignal.timeout(1000)});}catch{portClosed=true;}assert.ok(portClosed,'Isolated TokenFlow listener must be stopped');
  await writeFile(config,stringify(nativeConfig));client=await start('openai',official);
  await client.turn('native-after-tokenflow-stopped',recall,markers);
  await client.compact('native-compact-tokenflow-stopped');
  await client.turn('native-continue-after-compact-tokenflow-stopped',recall,markers);await stop();
  assert.equal(officialForwardAttempts,0);assert.equal(await readFile(join(home,'auth.json'),'utf8'),login);
  const {LocalUsageParser}=await import('../packages/core/src/local-usage.ts');const parser=new LocalUsageParser('codex','direct-probe');for(const row of await rows())parser.accept(row);const usage=parser.rows().filter(r=>r.model===official);assert.ok(usage.some(r=>r.inputTokens+r.outputTokens>0),'Native usage could not be read passively');
  record({phase:'passive-usage-without-inference-proxy',samples:usage.length,inputTokens:usage.reduce((s,r)=>s+r.inputTokens,0),outputTokens:usage.reduce((s,r)=>s+r.outputTokens,0)});
 }catch(e){error=e instanceof Error?e.message:'Verification failed';process.exitCode=1;}
 finally{await stop();if(!serviceClosed)await service.app.close();if(!adapterClosed){adapter.closeAllConnections();await new Promise<void>(r=>adapter.close(()=>r()));}}
 const report={passed:!error,scope:'Native Codex OpenAI provider, no official base URL override; isolated TokenFlow stopped before final official continuation and compaction',networkProxy:!!networkProxy,officialForwardAttempts,serviceStopped:serviceClosed,...(error?{error}:{}),rounds,requests};console.log(JSON.stringify(report));const out=process.argv.indexOf('--out');if(out>=0)await writeFile(resolve(process.argv[out+1]),JSON.stringify(report,null,2)+'\n');
}
