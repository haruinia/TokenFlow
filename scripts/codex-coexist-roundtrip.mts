/** Installed Codex + production TokenFlow service, isolated HOME and synthetic task.
 * --live uses existing official login and the running local gateway (small paid calls).
 * No refresh token rotation, user config writes, or real conversation replay.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,realpath,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parse,stringify} from 'smol-toml';
import YAML from 'yaml';
import {ProxyAgent} from 'undici';
const live=process.argv.includes('--live');
const long=process.argv.includes('--long'),legacy=process.argv.includes('--legacy-local');
if(!process.env.TF_ROUNDTRIP_ROOT){
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-coexist-roundtrip-'));
 try{
  const child=spawn(process.execPath,['--import','tsx',resolve(process.argv[1]),...process.argv.slice(2)],{env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:join(root,'codex'),TF_ROUNDTRIP_ROOT:root,TF_ROUNDTRIP_USER_HOME:homedir()},stdio:'inherit'});
  process.exitCode=await new Promise<number>(r=>child.once('exit',c=>r(c??1)));
 }finally{await rm(root,{recursive:true,force:true});}
}else{
 const root=process.env.TF_ROUNDTRIP_ROOT,userHome=process.env.TF_ROUNDTRIP_USER_HOME!;
 const binary='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
 const officialModel='gpt-6-astra',upstreamModel='antigravity/gemini-3.8-flash-low';
 const home=join(root,'codex'),config=join(home,'config.toml');await mkdir(home,{recursive:true});
 const cached=JSON.parse(await readFile(join(userHome,'.codex/models_cache.json'),'utf8'));
 const officialEntry=cached.models.find((m:any)=>m.slug===officialModel);assert.ok(officialEntry);
 const now=Math.floor(Date.now()/1000),claims={sub:'fixture',exp:now+3600,iat:now,'https://api.openai.com/auth':{chatgpt_plan_type:'plus',chatgpt_account_id:'fixture',user_id:'fixture'}};
 const jwt=Buffer.from('{"alg":"none"}').toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.fixture';
 const auth=live?JSON.parse(await readFile(join(userHome,'.codex/auth.json'),'utf8')):{auth_mode:'chatgpt',tokens:{id_token:jwt,access_token:jwt,account_id:'fixture'}};
 const login=JSON.stringify({...auth,tokens:{...auth.tokens,refresh_token:'verification-refresh-disabled'},last_refresh:new Date().toISOString()});
 await writeFile(join(home,'auth.json'),login,{mode:0o600});await writeFile(config,'cli_auth_credentials_store="file"\n[features]\napps=false\n');
 const local=live?YAML.parse(await readFile(join(userHome,'Library/Application Support/desktop-browser-agent/cliproxy/config.yaml'),'utf8')):null;
 const proxyFlag=process.argv.indexOf('--proxy'),dispatcher=live&&proxyFlag>=0?new ProxyAgent(process.argv[proxyFlag+1]):undefined;
 const requests:any[]=[],rounds:any[]=[];let phase='setup',seq=0,seedBytes=0;
 const markers=['A','B','C'].map(label=>label+'_'+randomUUID().replaceAll('-','').slice(0,12));
 const anchors=long?['EARLY','MIDDLE','LATE'].map(label=>label+'_'+randomUUID().replaceAll('-','').slice(0,12)):[];
 const constraints=long?['deployment region must remain eu-west-2','budget must stay below 730 units','do not delete the migration backup']:[];
 const allMarkers=[...markers,...anchors];
 const fixtureCheckpoints=new Map<string,string>();
 const fixture=(body:any,official:boolean)=>{
  let text=JSON.stringify(body.input);for(const [key,value]of fixtureCheckpoints)if(text.includes(key))text+=value;
  const remote=body.input?.some((i:any)=>i.type==='compaction_trigger');
  const token='synthetic-official-'+(++seq);if(remote)fixtureCheckpoints.set(token,text);
  const answer=allMarkers.filter(m=>text.includes(m)).join(' ')+(long?' '+constraints.join('; '):'');
  const output=remote?[{type:'compaction',encrypted_content:token}]:[{type:'message',id:'msg_'+seq,role:'assistant',content:[{type:'output_text',text:answer||'OK'}]}];
  const response={id:'resp_'+(++seq),status:'completed',model:body.model,output,usage:{input_tokens:100,output_tokens:10,total_tokens:110}};
  const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.done',output_index:0,item:output[0]},{type:'response.completed',response}];
  return body.stream?new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}}):Response.json(response);
 };
 // Synthetic archived work, emitted through the real engine so its rollout is
 // authentic. Only the compaction and continuation phases use live models.
 const seedResponse=(body:any)=>{
  const batch=Number(phase.split('-').at(-1));
  const facts=batch===0?anchors[0]:batch===6?anchors[1]:batch===11?anchors[2]:'';
  const lines=[`Archived task requirement: ${facts}. Preserve exact identifiers and constraints: ${constraints.join('; ')}.\n`];
  let bytes=Buffer.byteLength(lines[0]);
  for(let n=0;bytes<32768;n++){const line=`Batch ${batch} validation ${n}: module src/components/item-${n}.ts compiled; dependency order ${(n*37)%101}; fixture checksum ${String(n*7919).padStart(8,'0')}; archived diagnostic only.\n`;lines.push(line);bytes+=Buffer.byteLength(line);}
  const text=lines.join('');seedBytes+=Buffer.byteLength(text);
  const item={type:'message',id:'msg_seed_'+batch,role:'assistant',content:[{type:'output_text',text}]};
  const response={id:'resp_seed_'+batch,model:body.model,status:'completed',output:[item],usage:{input_tokens:100,output_tokens:100,total_tokens:200}};
  return new Response([{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 };
 const observed=async(response:Response,record:any,started:number)=>{
  record.httpStatus=response.status;
  if(!response.body)return response;
  const decoder=new TextDecoder();let pending='';
  const inspect=(line:string)=>{if(!line.startsWith('data:'))return;try{const e=JSON.parse(line.slice(5));if(e.type==='response.completed'){record.durationMs=Math.round(performance.now()-started);const u=e.response?.usage;record.usage=u?{input_tokens:u.input_tokens,output_tokens:u.output_tokens,total_tokens:u.total_tokens,cached_tokens:u.input_tokens_details?.cached_tokens}:undefined;}}catch{}};
  const body=response.body.pipeThrough(new TransformStream({transform(chunk,out){pending+=decoder.decode(chunk,{stream:true});let end;while((end=pending.indexOf('\n'))>=0){inspect(pending.slice(0,end));pending=pending.slice(end+1);}out.enqueue(chunk);},flush(){if(pending)inspect(pending);}}));
  return new Response(body,{status:response.status,headers:response.headers});
 };
 const gateway=createServer(async(req,res)=>{
  try{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);const summary=body.instructions?.startsWith('Summarize the supplied');
   const record={phase,route:'gateway',summary:!!summary,localSummary:JSON.stringify(body.input).includes('CONTEXT CHECKPOINT COMPACTION'),model:upstreamModel,bytes:Buffer.byteLength(raw),opaque:body.input?.filter((i:any)=>i.type==='compaction').length??0};requests.push(record);const started=performance.now();
   assert.ok(!body.input?.some((i:any)=>i.type==='compaction'||i.type==='compaction_trigger'),'Opaque state leaked to gateway');
   const response=await observed(live?await fetch(`http://127.0.0.1:${local.port}/v1/responses`,{method:'POST',headers:{authorization:'Bearer '+local['api-keys'][0],'content-type':'application/json'},body:JSON.stringify({...body,model:upstreamModel}),signal:AbortSignal.timeout(300000)}):fixture(body,false),record,started);
   res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json'});if(response.body)for await(const c of response.body)res.write(c);res.end();
  }catch{if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Isolated gateway verification failed'}}));}
 });
 await new Promise<void>(r=>gateway.listen(0,'127.0.0.1',r));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const proxyPort=(allocator.address() as any).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const {createDesktopService}=await import('../packages/core/src/service.ts');
 const secrets=new Map<string,string>();
 const service=await createDesktopService({root:join(root,'data'),proxyPort,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'fixture-admin',localKey:'fixture-local',secrets:{persistent:true,get:async(k:string)=>secrets.get(k)??'',set:async(k:string,v:string)=>{secrets.set(k,v);}},agentProcesses:async()=>[],nativeProcesses:async()=>[],agentPaths:{codex:config,claude:join(root,'claude.json'),qoder:join(root,'qoder.json'),workbuddy:join(root,'workbuddy.json')},antigravityPath:join(root,'antigravity'),cursorLocalPath:join(root,'cursor'),codexOfficialFetch:async(url,init)=>{
  if(url.includes('/models?'))return Response.json({models:[officialEntry]});
  assert.equal(url,'https://chatgpt.com/backend-api/codex/responses');
  const body=JSON.parse(String(init.body));assert.ok(!JSON.stringify(body).includes('tfctx1.'),'Local ciphertext leaked to official');
  const record={phase,route:'official',model:body.model,fixtureSeed:phase.startsWith('long-seed-'),bytes:Buffer.byteLength(String(init.body)),localSummary:JSON.stringify(body.input).includes('CONTEXT CHECKPOINT COMPACTION'),remoteTrigger:!!body.input?.some((i:any)=>i.type==='compaction_trigger')};requests.push(record);const started=performance.now();
  if(record.fixtureSeed)return seedResponse(body);
  return observed(live?await fetch(url,{...init,signal:AbortSignal.timeout(300000),redirect:'error',...(dispatcher?{dispatcher}:{})} as RequestInit):fixture(body,true),record,started);
 }});
 let proc:ReturnType<typeof spawn>|undefined;let errorMessage:string|undefined;
 try{
  await service.proxy.start();const origin=await service.app.listen({host:'127.0.0.1',port:0}),admin={host:new URL(origin).host,authorization:'Bearer fixture-admin'};
  for(let n=0;!(await readFile(config,'utf8')).includes('/local-telemetry/');n++){assert.ok(n<200,'Recorder startup timeout');await new Promise(r=>setTimeout(r,10));}
  const source=await service.app.inject({method:'POST',url:'/api/sources',headers:admin,payload:{name:'Roundtrip isolated gateway',baseURL:`http://127.0.0.1:${(gateway.address() as any).port}/v1`,protocol:'responses',models:['roundtrip-gateway'],apiKey:'fixture-source-key'}});assert.equal(source.statusCode,200);
  const sourceId=source.json().id,model=`api-${sourceId}/roundtrip-gateway`;
  const status=(await service.app.inject({url:'/api/a2a',headers:admin})).json().targets.find((t:any)=>t.id==='codex');
  const applied=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers:admin,payload:{target:'codex',sourceId,model,revision:status.revision,codexCoexist:true}});assert.equal(applied.statusCode,200,'Isolated coexist connection failed');
  const written=parse(await readFile(config,'utf8')) as any;assert.equal(written.model_providers.token_flow.capabilities?.remote_compaction,'v2','Production connection must declare remote compaction');
  if(legacy){delete written.model_providers.token_flow.capabilities;await writeFile(config,stringify(written));}
  assert.equal(await readFile(join(home,'auth.json'),'utf8'),login,'Connection changed login');
  proc=spawn(binary,['app-server','--listen','stdio://'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});
  let buffer='',id=0;const pending=new Map<number,any>(),events:any[]=[];
  proc.stderr!.resume();proc.stdout!.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let m;try{m=JSON.parse(line);}catch{continue;}const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error('RPC failed: '+p.method)):p.resolve(m.result);}else if(m.method)events.push(m);}});
  const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const key=++id,t=setTimeout(()=>{pending.delete(key);reject(Error('RPC timeout '+method));},20000);pending.set(key,{method,resolve:(v:any)=>{clearTimeout(t);resolve(v)},reject:(e:any)=>{clearTimeout(t);reject(e)}});proc!.stdin!.write(JSON.stringify({id:key,method,params})+'\n');});
  const completed=async(start:number)=>{const until=Date.now()+360000;while(Date.now()<until){const e=events.slice(start).find(e=>e.method==='turn/completed');if(e){assert.equal(e.params.turn.status,'completed','Turn failed in '+phase+': '+JSON.stringify(e.params.turn.error));return events.slice(start).filter(e=>e.method==='item/completed'&&e.params?.item?.type==='agentMessage').map(e=>e.params.item.text).join('\n');}await new Promise(r=>setTimeout(r,30));}throw Error('Completion timeout in '+phase);};
  await rpc('initialize',{clientInfo:{name:'tokenflow_coexist_roundtrip',version:'1'},capabilities:{experimentalApi:true}});proc.stdin!.write('{"method":"initialized"}\n');
  const thread=(await rpc('thread/start',{cwd:root,model:officialModel,approvalPolicy:'never',sandbox:'read-only'})).thread.id;
  const turn=async(name:string,selected:string,text:string,expected:string[])=>{phase=name;const start=events.length,started=performance.now();await rpc('turn/start',{threadId:thread,model:selected,effort:selected===officialModel?'low':'medium',input:[{type:'text',text}]});const answer=await completed(start);const required=long&&!name.startsWith('long-seed-')&&name!=='official-seed'?[...expected,...anchors]:expected;for(const marker of required)assert.ok(answer.includes(marker),'Missing retained requirement in '+phase);let constraintsVerified=0;if(long&&name==='official-final-return'){for(const value of ['eu-west-2','730','backup'])assert.ok(answer.toLowerCase().includes(value),'Missing semantic constraint '+value);constraintsVerified=3;}const record={phase,completed:true,markersVerified:required.length,constraintsVerified,durationMs:Math.round(performance.now()-started)};rounds.push(record);console.log(JSON.stringify(record));};
  const compact=async(name:string,official:boolean)=>{phase=name;const start=events.length,before=requests.length,started=performance.now();await rpc('thread/compact/start',{threadId:thread});await completed(start);const sent=requests.slice(before);if(legacy)assert.ok(sent.some(r=>r.localSummary),'Legacy Codex did not generate a summary');else if(official)assert.ok(sent.some(r=>r.route==='official'&&r.remoteTrigger),'Official did not use native compaction');else assert.ok(sent.some(r=>r.route==='gateway'&&r.summary),'Gateway did not generate a summary');const record={phase,completed:true,nativeRemote:official&&!legacy,gatewaySummaryCalls:sent.filter(r=>r.summary).length,durationMs:Math.round(performance.now()-started)};rounds.push(record);console.log(JSON.stringify(record));};
  const recall='Return every exact requirement identifier (A_, B_, C_, EARLY_, MIDDLE_, LATE_) recorded earlier, and the deployment region, budget ceiling, and backup restriction. Do not invent any. Do not use tools or files.';
  await turn('official-seed',officialModel,`This is an isolated continuity test. Never use tools or files. Retain the exact initial requirement identifier ${markers[0]} across future summaries. Reply with that identifier.`,[markers[0]]);
  if(long){for(let n=0;n<12;n++)await turn('long-seed-'+n,officialModel,'Archive the next synthetic validation batch. Preserve all task identifiers and constraints; acknowledge without tools.',[]);assert.ok(seedBytes>=384*1024);}
  await compact('official-compact-1',true);
  await turn('gateway-after-official-compact',model,recall,[markers[0]]);
  await turn('gateway-add-requirement',model,`Also retain this new requirement identifier ${markers[1]}. ${recall}`,[markers[0],markers[1]]);
  await turn('gateway-before-compact',model,recall,[markers[0],markers[1]]);
  await compact('gateway-compact-1',false);
  await turn('official-after-gateway-compact',officialModel,recall,[markers[0],markers[1]]);
  await compact('official-compact-2',true);
  await turn('gateway-second-return',model,recall,[markers[0],markers[1]]);
  await turn('gateway-add-final-requirement',model,`Also retain ${markers[2]}. ${recall}`,markers);
  await turn('gateway-final-before-compact',model,recall,markers);
  await compact('gateway-compact-2',false);
  await turn('official-final-return',officialModel,recall,markers);
  assert.equal(await readFile(join(home,'auth.json'),'utf8'),login,'Verification changed isolated login');
 }catch(error){errorMessage=error instanceof Error?error.message:'Verification failed';process.exitCode=1;}
 finally{
  if(proc&&proc.exitCode===null&&proc.signalCode===null)await new Promise<void>(r=>{proc!.once('exit',()=>r());proc!.kill();});
  await service.app.close();gateway.closeAllConnections();await new Promise<void>(r=>gateway.close(()=>r()));await dispatcher?.close();
 }
 const report={passed:!errorMessage,live,long,legacyLocalComparison:legacy,seedBytes,seedUsageIsSynthetic:long,scope:'Installed Codex, production coexist routing, isolated login/config/history; explicit compaction and two model round trips',...(errorMessage?{error:errorMessage}:{}),rounds,requests};
 console.log(JSON.stringify(report));const out=process.argv.indexOf('--out');if(out>=0)await writeFile(resolve(process.argv[out+1]),JSON.stringify(report,null,2)+'\n');
}
