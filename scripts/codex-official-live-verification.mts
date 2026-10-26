/** Explicit live check: a few tiny official-account requests with synthetic text.
 * Uses the production service in an isolated profile; never changes real Codex
 * files, refreshes credentials, or prints credentials/conversation content.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,realpath,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {parse} from 'smol-toml';
import {ProxyAgent} from 'undici';
if(!process.env.TF_VERIFY_ROOT){
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-official-live-'));
 try{
  const proxyIndex=process.argv.indexOf('--proxy');
  const child=spawn(process.execPath,['--import','tsx',resolve(process.argv[1])],{cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:join(root,'codex'),TF_VERIFY_ROOT:root,TF_VERIFY_AUTH_PATH:join(homedir(),'.codex/auth.json'),TF_VERIFY_CATALOG_PATH:join(homedir(),'.codex/models_cache.json'),TF_VERIFY_PRIORITY_ONLY:String(process.argv.includes('--priority-only')),...(proxyIndex>=0?{TF_VERIFY_HTTPS_PROXY:process.argv[proxyIndex+1]}:{})},stdio:'inherit'});
  process.exitCode=await new Promise<number>(r=>child.once('exit',code=>r(code??1)));
 }finally{await rm(root,{recursive:true,force:true});}
}else{
 const root=process.env.TF_VERIFY_ROOT,config=join(root,'codex/config.toml');
 const auth=JSON.parse(await readFile(process.env.TF_VERIFY_AUTH_PATH!,'utf8')).tokens;
 assert.ok(auth?.access_token&&auth?.account_id,'No current official login');
 const cached=JSON.parse(await readFile(process.env.TF_VERIFY_CATALOG_PATH!,'utf8'));
 const models=['gpt-6-astra','gpt-6.1-sol'];for(const m of models)assert.ok(cached.models.some((v:any)=>v.slug===m),'Expected official model absent');
 const {createDesktopService}=await import('../packages/core/src/service.ts');
 await mkdir(join(root,'codex'),{recursive:true});await mkdir(join(root,'data/cliproxy'),{recursive:true});
 await writeFile(config,'');await writeFile(join(root,'codex/auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'synthetic-config-auth',account_id:'synthetic-account'}}),{mode:0o600});
 await writeFile(join(root,'data/cliproxy/fixture-accounts.json'),JSON.stringify([{name:'qoder.json',provider:'qoder',email:'fixture@example.test',status:'active',models:['fixture']}]));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const proxyPort=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 let forwarded=0;const sent:any[]=[];
 const dispatcher=process.env.TF_VERIFY_HTTPS_PROXY?new ProxyAgent(process.env.TF_VERIFY_HTTPS_PROXY):undefined;
 const realFetch=async(url:string,init:RequestInit)=>{
  assert.equal(url,'https://chatgpt.com/backend-api/codex/responses');
  return fetch(url,{...init,signal:AbortSignal.timeout(45000),redirect:'error',...(dispatcher?{dispatcher}:{})} as RequestInit);
 };
 const service=await createDesktopService({root:join(root,'data'),proxyPort,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'synthetic-admin',localKey:'synthetic-internal',secrets:{get:async()=>'',set:async()=>{}},agentProcesses:async()=>[],nativeProcesses:async()=>[],agentPaths:{codex:config,claude:join(root,'claude.json'),qoder:join(root,'qoder.json'),workbuddy:join(root,'workbuddy.json')},antigravityPath:join(root,'antigravity'),cursorLocalPath:join(root,'cursor'),codexOfficialFetch:async(url,init)=>{
  if(url.includes('/models?'))return Response.json({models:cached.models});
  forwarded++;const body=JSON.parse(String(init.body));sent.push({model:body.model,effort:body.reasoning?.effort,tier:body.service_tier??'default',compaction:body.input.some((i:any)=>i.type==='compaction_trigger')});
  return realFetch(url,init);
 }});
 const summarize=(body:any,text:string,status:number)=>{
  const data=text.split('\n').filter(l=>l.startsWith('data:')).map(l=>{try{return JSON.parse(l.slice(5).trim());}catch{return null;}}).filter(Boolean);
  const terminal=data.find(e=>e.type==='response.completed'||e.type==='response.failed')?.response;
  const result={httpStatus:status,requested:{model:body.model,effort:body.reasoning?.effort,tier:body.service_tier??'default'},completed:terminal?.status==='completed',returnedModel:terminal?.model??null,returnedEffort:terminal?.reasoning?.effort??null,returnedTier:terminal?.service_tier??null,outputTypes:terminal?.output?.map((i:any)=>i.type)??[],encryptedCompaction:terminal?.output?.some((i:any)=>i.type==='compaction'&&!!i.encrypted_content)??false,usage:terminal?.usage?{input:terminal.usage.input_tokens,output:terminal.usage.output_tokens,total:terminal.usage.total_tokens,reasoning:terminal.usage.output_tokens_details?.reasoning_tokens??null}:null};
  if(!result.completed){const error=data.find(e=>e.type==='error')?.error??terminal?.error;let parsed;try{parsed=JSON.parse(text);}catch{};console.log(JSON.stringify({failure:result,errorCode:error?.code??parsed?.error?.code??parsed?.error?.type??null}));throw Error('Live request did not complete');}
  assert.equal(terminal.model,body.model,'Returned model differed');
  return {result,output:terminal.output};
 };
 const body=(model:string,effort:string,tier:string,input:any[]=[{role:'user',content:'Transport verification only. Reply exactly PARITY_OK. Do not call any tools.'}])=>({model,instructions:'You are helping with a transport verification. Follow the short user instruction.',input,reasoning:{effort},...(tier==='priority'?{service_tier:'priority'}:{}),store:false,stream:true,tools:[]});
 try{
  await service.proxy.start();const origin=await service.app.listen({port:0,host:'127.0.0.1'}),admin={host:new URL(origin).host,authorization:'Bearer synthetic-admin'};
  for(let i=0;!(await readFile(config,'utf8')).includes('/local-telemetry/');i++){assert.ok(i<200,'Recorder startup timeout');await new Promise(r=>setTimeout(r,10));}
  const status=(await service.app.inject({url:'/api/a2a',headers:admin})).json().targets.find((t:any)=>t.id==='codex'),account=service.proxy.snapshot().accounts.find(a=>a.provider==='qoder')!;
  const applied=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers:admin,payload:{target:'codex',revision:status.revision,sourceId:account.id,model:'qoder/fixture',codexCoexist:true}});assert.equal(applied.statusCode,200,'Isolated coexist setup failed');
  const provider=(parse(await readFile(config,'utf8')) as any).model_providers.token_flow;
  const headers={authorization:`Bearer ${auth.access_token}`,'chatgpt-account-id':auth.account_id,'content-type':'application/json','user-agent':'codex_cli_rs/0.164.0-alpha.11.1',originator:'codex_cli_rs'};
  const proxy=async(request:any)=>{const response=await service.app.inject({method:'POST',url:'/codex/v1/responses',headers:{...headers,host:admin.host,'x-tokenflow-client-key':provider.http_headers['x-tokenflow-client-key']},payload:request});const result=summarize(request,response.body,response.statusCode);console.log(JSON.stringify({route:'isolated-production-tokenflow',...result.result}));return result;};
  const direct=async(request:any)=>{const response=await realFetch('https://chatgpt.com/backend-api/codex/responses',{method:'POST',headers,body:JSON.stringify(request)});const result=summarize(request,await response.text(),response.status);console.log(JSON.stringify({route:'direct-official',...result.result}));return result;};
  if(process.env.TF_VERIFY_PRIORITY_ONLY==='true'){
   const comparisons=[];
   for(const model of models){const request=body(model,'high','priority'),a=await direct(request),b=await proxy(request);comparisons.push({model,directTier:a.result.returnedTier,proxyTier:b.result.returnedTier,priorityConfirmed:b.result.returnedTier==='priority'});}
   console.log(JSON.stringify({passed:true,scope:'Live matched priority requests; request success does not imply priority was granted',comparisons,forwarded,sent}));
  }else{
  const first=body(models[0],'low','default');await direct(first);
  await proxy(first);
  await proxy(body(models[1],'high','priority'));
  const compact=await proxy(body(models[0],'low','default',[{role:'user',content:'Remember the marker PARITY_7284 and reply OK.'},{role:'assistant',content:[{type:'output_text',text:'OK'}]},{type:'compaction_trigger'}]));
  assert.ok(compact.result.encryptedCompaction,'Official compaction did not return an encrypted checkpoint');
  const continuation=await proxy(body(models[0],'low','default',[...compact.output,{role:'user',content:'Reply only with the marker you were told to remember.'}]));
  assert.ok(JSON.stringify(continuation.output).includes('PARITY_7284'),'Compaction continuation lost the synthetic marker');
  console.log(JSON.stringify({passed:true,scope:'Live OpenAI with existing official login; direct baseline + isolated production TokenFlow service; synthetic text only',forwarded,sent,compactionContinuation:true}));
  }
 }catch(error){console.error(JSON.stringify({passed:false,error:error instanceof Error?error.message:'Live verification failed'}));process.exitCode=1;}
 finally{await service.app.close();await dispatcher?.close();}
}
