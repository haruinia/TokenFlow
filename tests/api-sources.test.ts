import {knownClaudeCodeHelpNotice as gatewayHelpNotice} from '../packages/core/src/gateway-help-notice.js';
import {LocalMaintenance} from '../packages/core/src/local-maintenance.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiSources, apiModelID, genericResponsesBodies, genericMessagesBody } from '../packages/core/src/api-sources.js';
import { createDesktopService } from '../packages/core/src/service.js';
import { defaultProvider, providerSchema } from '../packages/core/src/providers.js';
import { createSecrets } from '../apps/desktop/src/secrets.js';
import { parse } from 'smol-toml';
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function fixture(real=false,configure?:(app:Awaited<ReturnType<typeof createDesktopService>>['app'])=>void,modelProtocols:Record<string,string>={},rejectBlankText=false,streamUsageOptIn=false){
 const root=await realpath(await mkdtemp(join(tmpdir(),'api-sources-')));cleanup.push(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'secrets'));
 const storage={isEncryptionAvailable:()=>true,encryptString:(v:string)=>Buffer.from(Buffer.from(v).map(b=>b^0x73)),decryptString:(v:Buffer)=>Buffer.from(Buffer.from(v).map(b=>b^0x73)).toString()};
 const secrets=createSecrets(root,storage);const calls:Array<{path:string;key:string;body:Record<string,unknown>}>=[];
 let paused:Promise<void>|undefined;
 const upstream=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');const pathname=new URL(req.url!,'http://127.0.0.1').pathname;let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};
  const key=String(req.headers.authorization??req.headers['x-api-key']??'');calls.push({path:req.url!,key,body});
  await paused;
  if(JSON.stringify(body).includes('daily-token-envelope')){res.end(JSON.stringify({code:1008,error:true,message:'超过每天令牌使用限制',data:null,debug:'PRIVATE_PROVIDER_BODY'}));return;}
  if(JSON.stringify(body).includes('classified-context-error')){res.writeHead(400);res.end(JSON.stringify({error:{code:'context_length_exceeded',message:'PRIVATE_PROVIDER_BODY'}}));return;}
  if(JSON.stringify(body).includes('classified-field-error')){res.writeHead(400);res.end(JSON.stringify({error:{type:'invalid_request_error',param:'messages[2].content',message:'PRIVATE_PROVIDER_BODY'}}));return;}
  if(JSON.stringify(body).includes('classified-stream-error')){res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({type:'response.failed',response:{status:'failed',error:{code:'context_length_exceeded',message:'PRIVATE_PROVIDER_BODY'}}})+'\n\n');return;}
  if(JSON.stringify(body).includes('classified-capacity-error')){res.writeHead(429);res.end(JSON.stringify({error:{code:'qoder_capacity_wait_exhausted',message:'PRIVATE_PROVIDER_BODY'}}));return;}
  if(rejectBlankText&&body.messages?.some((message:any)=>Array.isArray(message.content)&&message.content.some((part:any)=>part.type==='text'&&typeof part.text==='string'&&!part.text.trim()))){res.statusCode=400;res.end(JSON.stringify({error:{message:'text content block must contain non-whitespace text'}}));return;}
  const expected=modelProtocols[body.model];
  if(expected&&pathname!==`/v1/${expected}`){res.statusCode=400;res.end(JSON.stringify({error:{message:'Model does not support this protocol'}}));return;}
  if((JSON.stringify(body.input)??'').includes('secret-error')){res.setHeader('content-type','text/event-stream');res.end(`event: error\ndata: ${JSON.stringify({type:'error',message:key,error:{message:'secret-private-upstream-detail'}})}\n\n`);return;}
  if(pathname==='/v1/models'){res.end(JSON.stringify({data:[{id:'shared'},{id:'forbidden'}]}));return;}
  if(body.model==='forbidden'){res.writeHead(403);res.end(JSON.stringify({error:{message:'secret-key-DO-NOT-RETURN'}}));return;}
  // A generic Responses vendor: no ChatGPT-only image tool and no encrypted reasoning include.
  if(pathname==='/v1/responses'&&(JSON.stringify(body.input)??'').includes('strict-generic')&&('include' in body||(body.tools??[]).some((t:{type?:string})=>t.type==='image_generation'))){res.writeHead(400);res.end(JSON.stringify({error:{message:'Unsupported parameter'}}));return;}
  const usage={input_tokens:7,output_tokens:3};
  const response={id:'resp_fixture',object:'response',status:'completed',model:body.model,output:[{id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:key,annotations:[]}]}],usage};
  if(pathname==='/v1/chat/completions'){
   const chat={id:'chat-fixture',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:key},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}};
   if(body.stream&&streamUsageOptIn&&!body.stream_options?.include_usage)delete (chat as {usage?:unknown}).usage;
   if(body.stream){res.setHeader('content-type','text/event-stream');res.end(`data: ${JSON.stringify({...chat,object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:key},finish_reason:null}]})}\n\ndata: ${JSON.stringify({...chat,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);}else res.end(JSON.stringify(chat));return;
  }
  if(pathname==='/v1/messages'){
   const message={id:'msg-fixture',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:key}],stop_reason:'end_turn',usage};
   if(body.stream){res.setHeader('content-type','text/event-stream');res.end([{type:'message_start',message:{...message,content:[],usage:{input_tokens:7,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:key}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:3}},{type:'message_stop'}].map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));}else res.end(JSON.stringify(message));return;
  }
  if(body.stream){res.setHeader('content-type','text/event-stream');const events=[{type:'response.created',response:{...response,status:'in_progress',output:[],usage:null}},{type:'response.output_item.added',output_index:0,item:{...response.output[0],status:'in_progress',content:[]}},{type:'response.content_part.added',output_index:0,content_index:0,part:{type:'output_text',text:''}},{type:'response.output_text.delta',output_index:0,content_index:0,delta:key},{type:'response.output_item.done',output_index:0,item:response.output[0]},{type:'response.completed',response}];res.end(((JSON.stringify(body.input)??'').includes('truncate')?events.slice(0,2):events).map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));}else res.end(JSON.stringify(response));
 });
 await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>upstream.close(()=>r())));
 const baseURL=`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1`;
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const options={root,secrets,binary:resolve(real?`sidecars/${process.platform}-${process.arch}/cliproxyapi`:'tests/fixtures/fake-cliproxy.mjs'),proxyPort:port,token:'admin',localKey:'internal-key',agentPaths:{codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),workbuddy:join(root,'workbuddy/models.json'),qoder:join(root,'qoder/settings.json')},agentProcesses:async()=>[]};
 const service=await createDesktopService(options);
 configure?.(service.app);
 cleanup.push(()=>service.app.close());await service.proxy.start();
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'};
 const add=async(name:string,apiKey:string,protocol='responses')=>{const r=await service.app.inject({method:'POST',url:'/api/sources',headers,payload:{name,apiKey,baseURL,protocol,models:['shared','forbidden']}});expect(r.statusCode,r.body).toBe(200);return r.json();};
 return {root,baseURL,secrets,calls,service,headers,add,options,holdResponses:()=>{let release!:()=>void;paused=new Promise<void>(r=>release=r);return()=>{paused=undefined;release();};}};
}
it('tests connectivity with the raw model name sent by the API card, using saved validation even when the gateway is stopped',async()=>{
 const {root,service,headers,baseURL,calls}=await fixture(false,undefined,{'claude-b':'messages'});
 const added=await service.app.inject({method:'POST',url:'/api/sources/quick',headers,payload:{baseURL,apiKey:'connectivity-fixture-key',model:'claude-b'}});
 expect(added.statusCode,added.body).toBe(200);const source=added.json();calls.length=0;
 await service.proxy.stop();
 const checked=await service.app.inject({method:'POST',url:`/api/sources/${source.id}/check`,headers,payload:{model:'claude-b'}});
 expect(checked.statusCode,checked.body).toBe(200);expect(checked.json().passed).toBe(true);
 expect(calls.map(call=>call.path)).toEqual(['/v1/messages']);expect(calls[0].body.max_tokens).toBe(16);
 const saved=(await service.app.inject({url:'/api/sources',headers})).json().sources[0];
 expect(saved.checks['claude-b'].status).toBe('passed');expect(saved.modelRoutes).toEqual(source.modelRoutes);
 const usage=(await service.app.inject({url:'/api/gateway/usage?days=0',headers})).json().rows.filter((row:any)=>row.sourceId===source.id);
 expect(usage.reduce((sum:number,row:any)=>sum+row.requests,0)).toBe(2);
 expect(usage.reduce((sum:number,row:any)=>sum+row.inputTokens+row.outputTokens,0)).toBe(20);
 const count=calls.length;
 const invalid=await service.app.inject({method:'POST',url:`/api/sources/${source.id}/check`,headers,payload:{model:'not-saved'}});
 expect(invalid.statusCode).toBe(409);expect(calls).toHaveLength(count);
 await service.app.close();
 const persisted=JSON.parse(await readFile(join(root,'usage-ledger.json'),'utf8')).rows.filter((row:any)=>row.sourceId===source.id);
 expect(persisted.reduce((sum:number,row:any)=>sum+row.inputTokens+row.outputTokens,0)).toBe(20);
});
it('synchronizes successive API saves through the real sidecar without requiring a restart',async()=>{
 const {service,headers,baseURL}=await fixture(true);
 for(const [index,model] of ['deepseek-ai/DeepSeek-V4.1-Flash','deepseek-flash','company/third-model','company/fourth-model'].entries()){
  const saved=await service.app.inject({method:'POST',url:'/api/sources',headers,payload:{name:`API ${index}`,baseURL,apiKey:'sync-fixture-key',protocol:'chat',models:[model]}});
  expect(saved.statusCode,saved.body).toBe(200);
  expect(saved.json().routingError).toBeUndefined();
  expect(service.proxy.apiModelAvailable(apiModelID(saved.json().id,model))).toBe(true);
  await new Promise(resolve=>setTimeout(resolve,400));
 }
});
it('finishes delayed API route synchronization after save returns, without resaving or restarting',async()=>{
 const {service,headers,add}=await fixture();
 await fetch(`http://127.0.0.1:${service.proxy.port}/fixture`,{method:'POST',body:JSON.stringify({apiModelDelayReads:50})});
 const source=await add('Delayed API','delayed-fixture-key','chat');
 expect(source.routingError).toBeTruthy();
 expect(source.routingPending).toBe(true);
 expect(service.proxy.snapshot().apiRoutesSyncing).toBe(true);
 await expect.poll(()=>service.proxy.apiModelAvailable(apiModelID(source.id,'shared')),{timeout:4000}).toBe(true);
 const snapshot=(await service.app.inject({url:'/api/local-agent',headers})).json();
 expect(snapshot.models.map((model:any)=>model.id)).toContain(apiModelID(source.id,'shared'));
 expect(snapshot.apiRoutesSyncing).not.toBe(true);
},15000);
it('counts native Chat streams even when the caller did not opt in to usage chunks',async()=>{
 const {service,headers,add,calls}=await fixture(false,undefined,{},false,true);
 const source=await add('Streaming API','stream-usage-fixture','chat'),model=apiModelID(source.id,'shared');
 const result=await service.app.inject({method:'POST',url:'/v1/chat/completions',headers,payload:{model,messages:[{role:'user',content:'hi'}],stream:true,stream_options:{include_obfuscation:false}}});
 expect(result.statusCode,result.body).toBe(200);
 const rows=(await service.app.inject({url:'/api/gateway/usage?days=0',headers})).json().rows.filter((row:any)=>row.sourceId===source.id);
 expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({requests:1,inputTokens:7,outputTokens:3,unmeasured:0});
 expect(calls.at(-1)?.body.stream_options).toEqual({include_usage:true,include_obfuscation:false});
});
it('does not send model probes when selecting or restoring a saved maintenance model',async()=>{
 const {service,headers,add,calls,options}=await fixture();const source=await add('No background probes','background-fixture-key');
 calls.length=0;
 const selected=await service.app.inject({method:'PUT',url:'/api/maintenance',headers,payload:{sourceId:source.id,model:apiModelID(source.id,'shared')}});
 expect(selected.statusCode,selected.body).toBe(200);expect(selected.json().readiness.status).toBe('unchecked');
 await new Promise(resolve=>setTimeout(resolve,100));expect(calls).toHaveLength(0);
 await service.app.close();const restarted=await createDesktopService(options);cleanup.push(()=>restarted.app.close());
 vi.spyOn(restarted.proxy,'importCredential').mockResolvedValue(undefined as never);
 vi.spyOn(restarted.proxy,'importLocal').mockResolvedValue(undefined as never);
 await restarted.discoverLocal();
 await new Promise(resolve=>setTimeout(resolve,100));
 expect((await restarted.app.inject({url:'/api/maintenance',headers})).json().readiness.status).toBe('unchecked');
 expect(calls).toHaveLength(0);
 const sent=await restarted.app.inject({method:'POST',url:'/api/maintenance/run',headers,payload:{prompt:'读取网关状态'}});
 expect(sent.statusCode,sent.body).toBe(200);
 await expect.poll(async()=>(await restarted.app.inject({url:'/api/maintenance',headers})).json().status).toBe('completed');
 expect(calls).toHaveLength(1);
});
it.each(['responses','chat','messages'] as const)('tests a saved full %s endpoint without appending its protocol path twice',async protocol=>{
 const path=protocol==='chat'?'chat/completions':protocol;
 const {service,headers,baseURL,calls}=await fixture(false,undefined,{shared:path});
 const added=await service.app.inject({method:'POST',url:'/api/sources',headers,payload:{name:'Full endpoint',baseURL:`${baseURL}/${path}`,protocol,apiKey:'full-endpoint-fixture-key',models:['shared']}});
 expect(added.statusCode,added.body).toBe(200);const source=added.json();
 const checked=await service.app.inject({method:'POST',url:`/api/sources/${source.id}/check`,headers,payload:{model:'shared'}});
 expect(checked.statusCode,checked.body).toBe(200);expect(checked.json().passed,checked.body).toBe(true);
 expect(calls.map(call=>call.path)).toEqual([`/v1/${path}`]);
});
it('does not send model probes when reading, refreshing, renaming or toggling API sources',async()=>{
 const {service,headers,add,calls,baseURL}=await fixture();const source=await add('Quiet API','quiet-fixture-key');
 expect(calls).toHaveLength(0);
 const update=(name:string,enabled:boolean)=>service.app.inject({method:'PUT',url:`/api/sources/${source.id}`,headers,payload:{name,enabled,baseURL,protocol:source.protocol,models:source.models}});
 for(const url of ['/api/sources','/api/local-agent','/api/maintenance'])expect((await service.app.inject({url,headers})).statusCode).toBe(200);
 await service.proxy.refreshAccounts();
 expect((await update('Renamed API',true)).statusCode).toBe(200);
 expect((await update('Renamed API',false)).statusCode).toBe(200);
 expect((await update('Renamed API',true)).statusCode).toBe(200);
 expect(calls).toHaveLength(0);
});
it('drops the injected image tool and offers a retry body without include or cache key',()=>{
 const fn={type:'function',name:'get_weather'};
 expect(genericResponsesBodies({model:'m',input:'hi',tools:[{type:'image_generation',output_format:'png'}],tool_choice:'auto',include:['reasoning.encrypted_content'],prompt_cache_key:'k'}))
  .toEqual([{model:'m',input:'hi',include:['reasoning.encrypted_content'],prompt_cache_key:'k'},{model:'m',input:'hi'}]);
 expect(genericResponsesBodies({model:'m',tools:[fn,{type:'image_generation'}],tool_choice:'auto'})).toEqual([{model:'m',tools:[fn],tool_choice:'auto'}]);
 expect(genericResponsesBodies({model:'m',tools:[fn],tool_choice:{type:'image_generation'}})).toEqual([{model:'m',tools:[fn]}]);
});
it('renames an in-use API source without probing or changing its routing and key',async()=>{
 const {service,headers,add,calls,secrets}=await fixture();const source=await add('Original','rename-fixture-key');
 const key=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'in use',sourceId:source.id,models:[apiModelID(source.id,'shared')],agents:['openai'],tokenLimit:null}});expect(key.statusCode,key.body).toBe(200);
 const count=calls.length;const get=vi.spyOn(secrets,'get');get.mockResolvedValue('');
 const renamed=await service.app.inject({method:'POST',url:'/api/sources/quick',headers,payload:{id:source.id,name:'公司中转 · Kimi',baseURL:source.baseURL,model:source.models.join(',')}});
 expect(renamed.statusCode,renamed.body).toBe(200);expect(renamed.json()).toMatchObject({id:source.id,name:'公司中转 · Kimi',protocol:source.protocol,models:source.models});
 expect(calls).toHaveLength(count);get.mockRestore();
 expect((await service.app.inject({url:'/api/sources',headers})).json().sources[0].hasKey).toBe(true);
});
it('switches a connected Codex to native login in one request, after checking credentials and revision',async()=>{
 const {service,headers,add,root}=await fixture();const source=await add('Gateway','gateway-key');
 const target=async()=>(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:{id:string})=>t.id==='codex');
 const path=join(root,'codex/config.toml');
 await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target:'codex',sourceId:source.id,model:apiModelID(source.id,'shared'),revision:(await target()).revision}});
 await writeFile(path,(await readFile(path,'utf8')).replace(`model = "${apiModelID(source.id,'shared')}"`,'model = "gpt-5"'));
 const before=await readFile(path,'utf8');const status=async()=>(await service.app.inject({url:'/api/codex-accounts',headers})).json();
 const credential=vi.spyOn(service.proxy,'codexCredential').mockResolvedValue({access_token:'incomplete'});
 const payload={sourceId:'a'.repeat(24),model:'codex/gpt-5',allowRunning:true,revision:(await status()).revision};
 const rejected=await service.app.inject({method:'POST',url:'/api/codex-accounts/switch',headers,payload});expect(rejected.statusCode).toBe(409);expect(await readFile(path,'utf8')).toBe(before);
 credential.mockResolvedValue({access_token:'native-access',refresh_token:'native-refresh',id_token:'x.e30.x',account_id:'native-user'});
 const stale=await service.app.inject({method:'POST',url:'/api/codex-accounts/switch',headers,payload:{...payload,revision:'0'.repeat(64)}});expect(stale.statusCode).toBe(409);expect(await readFile(path,'utf8')).toBe(before);
 const switched=await service.app.inject({method:'POST',url:'/api/codex-accounts/switch',headers,payload});expect(switched.statusCode,switched.body).toBe(200);
 expect(switched.json()).toMatchObject({provider:'openai',model:'gpt-5',gatewayConnected:false,accountId:'native-user'});
 const config=parse(await readFile(path,'utf8'));expect(config.model_catalog_json).toBeUndefined();expect(config.model_provider).toBe('openai');expect((await target()).connection).toBeNull();
 expect(JSON.parse(await readFile(join(root,'codex/auth.json'),'utf8')).tokens.access_token).toBe('native-access');
 expect(switched.body).not.toContain('native-access');
});
it('rejects malformed API source addresses with safe Chinese validation and preserves saved sources',async()=>{
 const {service,headers,add,root}=await fixture();const source=await add('Saved source','validation-fixture-key');const saved=await readFile(join(root,'api-sources.json'),'utf8');
 for(const baseURL of ['not-a-url','', 'http://public.example/v1','https://user:private-url-password@example.test/v1','https://example.test/v1?key=private-query-key','https://example.test/v1#fragment','file:///private']){
  expect(providerSchema.safeParse({...defaultProvider,baseURL}).success).toBe(false);
  for(const method of ['POST','PUT'] as const){
   const response=await service.app.inject({method,url:method==='POST'?'/api/sources':`/api/sources/${source.id}`,headers,payload:{name:'Invalid source',baseURL,protocol:'responses',models:[],apiKey:'validation-fixture-key'}});
   expect(response.statusCode,response.body).toBe(400);expect(response.json()).toMatchObject({code:'api_source_invalid',error:expect.stringMatching(/[\u3400-\u9fff]/)});
   expect(response.body).not.toMatch(/ERR_INVALID_URL|Internal runner error|validation-fixture-key|private-url-password|private-query-key/);
  }
 }
 for(const fields of [{name:''},{protocol:'unknown'},{apiKey:'bad\nkey'},{'私密-secret-field':'value'}]){
  const response=await service.app.inject({method:'POST',url:'/api/sources',headers,payload:{name:'Invalid source',baseURL:source.baseURL,protocol:'responses',models:[],apiKey:'validation-fixture-key',...fields}});
  expect(response.statusCode,response.body).toBe(400);expect(response.json().error).toMatch(/[\u3400-\u9fff]/);expect(response.body).not.toContain('secret-field');
 }
 const settings=await service.app.inject({method:'PUT',url:'/api/settings',headers,payload:{provider:{...defaultProvider,baseURL:'not-a-url'}}});expect(settings.statusCode,settings.body).toBe(400);
 expect(await readFile(join(root,'api-sources.json'),'utf8')).toBe(saved);expect((await service.app.inject({url:'/api/sources',headers})).json().sources).toHaveLength(1);
});
it('classifies model-list authentication, HTTP and response errors, then retries without changing saved models or credentials',async()=>{
 const {service,headers,root}=await fixture();let status=401,body='private-upstream-response-with-key';
 const upstream=createServer((_req,res)=>{res.writeHead(status,{'content-type':'application/json'});res.end(body);});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>upstream.close(()=>r())));
 const added=await service.app.inject({method:'POST',url:'/api/sources',headers,payload:{name:'Model list errors',baseURL:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1`,protocol:'responses',models:['previous-model'],apiKey:'catalog-fixture-key'}});expect(added.statusCode,added.body).toBe(200);const source=added.json();
 const saved=await readFile(join(root,'api-sources.json'),'utf8');
 for(const [nextStatus,nextBody,code,message] of [[401,'private-upstream-response-with-key','api_models_auth','认证'],[403,'private-upstream-response-with-key','api_models_auth','权限'],[429,'private-upstream-response-with-key','api_models_http','HTTP 429'],[503,'private-upstream-response-with-key','api_models_http','HTTP 503'],[200,'private-upstream-response-with-key','api_models_response','响应格式'],[200,'{"models":["private-upstream-response-with-key"]}','api_models_response','响应格式']] as const){
  status=nextStatus;body=nextBody;const response=await service.app.inject({method:'POST',url:`/api/sources/${source.id}/models`,headers,payload:{}});
  expect(response.statusCode,response.body).toBe(400);expect(response.json()).toMatchObject({code,error:expect.stringContaining(message)});expect(response.body).not.toMatch(/catalog-fixture-key|private-upstream-response-with-key/);
  expect(await readFile(join(root,'api-sources.json'),'utf8')).toBe(saved);
 }
 status=200;body='{"data":[{"id":"new-model"}]}';const retried=await service.app.inject({method:'POST',url:`/api/sources/${source.id}/models`,headers,payload:{}});expect(retried.json()).toEqual({models:['new-model']});
 expect(await readFile(join(root,'api-sources.json'),'utf8')).toBe(saved);expect((await service.app.inject({url:'/api/sources',headers})).json().sources[0].models).toEqual(['previous-model']);
});
it('reports the 15-second model-list timeout and preserves saved configuration for retry',async()=>{
 const {service,headers,root}=await fixture();
 const upstream=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{"data":');});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>{upstream.closeAllConnections();upstream.close(()=>r());}));
 const source=(await service.app.inject({method:'POST',url:'/api/sources',headers,payload:{name:'Slow model list',baseURL:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1`,protocol:'responses',models:['old-model'],apiKey:'timeout-fixture-key'}})).json();const saved=await readFile(join(root,'api-sources.json'),'utf8');
 const timeout=AbortSignal.timeout.bind(AbortSignal),spy=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>timeout(ms===15000?30:ms));
 try{const response=await service.app.inject({method:'POST',url:`/api/sources/${source.id}/models`,headers,payload:{}});expect(response.statusCode,response.body).toBe(400);expect(response.json()).toMatchObject({code:'api_models_timeout',error:expect.stringContaining('15 秒')});expect(spy).toHaveBeenCalledWith(15000);}
 finally{spy.mockRestore();}
 expect(await readFile(join(root,'api-sources.json'),'utf8')).toBe(saved);
});
it('cancels an in-flight model list, releases the mutation lock and allows a retry without resaving',async()=>{
 const {service,headers,root}=await fixture();let waiting=true;let started!:()=>void;const received=new Promise<void>(r=>{started=r;});let cancelled=false;
 const upstream=createServer((_req,res)=>{if(waiting){res.once('close',()=>{cancelled=true;});started();return;}res.setHeader('content-type','application/json');res.end('{"data":[{"id":"retry-model"}]}');});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>{upstream.closeAllConnections();upstream.close(()=>r());}));
 const source=(await service.app.inject({method:'POST',url:'/api/sources',headers,payload:{name:'Cancelled model list',baseURL:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1`,protocol:'responses',models:['old-model'],apiKey:'cancel-fixture-key'}})).json();const saved=await readFile(join(root,'api-sources.json'),'utf8');
 const address=await service.app.listen({host:'127.0.0.1',port:0});const controller=new AbortController();const request=fetch(`${address}/api/sources/${source.id}/models`,{method:'POST',headers:{authorization:'Bearer admin'},signal:controller.signal});const aborted=expect(request).rejects.toMatchObject({name:'AbortError'});await received;
 const duplicate=await service.app.inject({method:'POST',url:`/api/sources/${source.id}/models`,headers,payload:{}});expect(duplicate.statusCode).toBe(409);
 controller.abort();await aborted;await expect.poll(()=>cancelled).toBe(true);waiting=false;
 await expect.poll(async()=>{const response=await service.app.inject({method:'POST',url:`/api/sources/${source.id}/models`,headers,payload:{}});return response.statusCode;}).toBe(200);
 expect(await readFile(join(root,'api-sources.json'),'utf8')).toBe(saved);expect((await service.app.inject({url:'/api/sources',headers})).json().sources[0].models).toEqual(['old-model']);
});
it('persists independent encrypted credentials and duplicate model names, and refuses corrupt registries',async()=>{
 const {root,secrets,baseURL,add,service}=await fixture();const a=await add('One','secret-A');const b=await add('Two','secret-B');
 expect(a.id).not.toBe(b.id);expect(a.credentialRef).toBeUndefined();expect(a.apiKey).toBeUndefined();
 const saved=await readFile(join(root,'api-sources.json'),'utf8');expect(saved).not.toContain('secret-A');expect(saved).not.toContain('secret-B');
 expect(await readFile(join(root,'cliproxy/config.yaml'),'utf8')).not.toContain('secret-A');
 const reopened=await ApiSources.open(root,secrets,defaultProvider);cleanup.push(()=>reopened.close());expect((await reopened.list()).map(s=>s.name)).toEqual(['One','Two']);
 expect(reopened.sourceFor(apiModelID(a.id,'shared'))?.id).toBe(a.id);
 const models=await service.app.inject({method:'POST',url:`/api/sources/${a.id}/models`,headers:{host:'127.0.0.1',authorization:'Bearer admin'},payload:{}});expect(models.json().models).toEqual(['shared','forbidden']);
 await expect(reopened.save({name:'bad',baseURL:'https://example.com/v1?key=secret',protocol:'responses',apiKey:'x',models:[]})).rejects.toThrow();
 await writeFile(join(root,'api-sources.json'),'broken');await expect(ApiSources.open(root,secrets,defaultProvider)).rejects.toThrow('已保留');expect(baseURL).toContain('127.0.0.1');
});
it('migrates legacy settings once, copies only ciphertext, and keeps legacy credentials/settings for rollback',async()=>{
 const {root,secrets,baseURL}=await fixture();const legacy={...defaultProvider,kind:'custom' as const,baseURL,model:'shared'};await writeFile(join(root,'settings.json'),JSON.stringify(legacy));await secrets.set('custom','legacy-secret');
 const store=await ApiSources.open(root,secrets,legacy);cleanup.push(()=>store.close());const sources=await store.list();expect(sources).toHaveLength(1);expect(sources[0].name).toBe('迁移的 API 来源');
 expect(await secrets.get('custom')).toBe('legacy-secret');expect(await readFile(join(root,'settings.json'),'utf8')).toBe(JSON.stringify(legacy));
 const backup=await readFile(join(root,'backups/api-sources-migration/custom.bin'));expect(backup).toEqual(await readFile(join(root,'secrets/custom.bin')));expect(backup.toString()).not.toContain('legacy-secret');
 const again=await ApiSources.open(root,secrets,legacy);cleanup.push(()=>again.close());expect(await again.list()).toHaveLength(1);
});
it('keeps the workspace available and legacy credentials intact if migration cannot encrypt the new slot',async()=>{
 const {root,secrets,baseURL}=await fixture();const legacy={...defaultProvider,kind:'custom' as const,baseURL,model:'shared'};
 await writeFile(join(root,'settings.json'),JSON.stringify(legacy));await secrets.set('custom','legacy-private-key');
 const store=await ApiSources.open(root,{get:secrets.get,set:async()=>{throw new Error('locked');}},legacy);cleanup.push(()=>store.close());
 expect(await store.list()).toEqual([]);expect(store.warnings()[0]).toContain('原配置和密钥已保留');expect(await secrets.get('custom')).toBe('legacy-private-key');
});
it('routes all three declared upstream protocols through the real sidecar, source scopes, budgets and activity',async()=>{
 const {service,headers,add,calls}=await fixture(true);
 for(const protocol of ['responses','chat','messages']){
  const source=await add(protocol,`secret-${protocol}`,protocol);const model=apiModelID(source.id,'shared');
  await expect.poll(()=>service.proxy.apiModelAvailable(model),{timeout:10000}).toBe(true);
  const key=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:protocol,sourceId:source.id,models:[model],tokenLimit:30}});expect(key.statusCode,key.body).toBe(200);
  const client={...headers,authorization:`Bearer ${key.json().apiKey}`};
  const request=()=>service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model,input:'Hi',stream:false}});
  let response=await request();if(response.statusCode===404){await new Promise(r=>setTimeout(r,1200));response=await request();}
    expect(response.statusCode,response.body).toBe(200);expect(response.json().output[0].content[0].text).toContain(`secret-${protocol}`);
  expect(calls.some(c=>c.body.model==='shared'&&c.key.includes(`secret-${protocol}`))).toBe(true);
  for(const route of ['chat/completions','messages']){
   const r=await service.app.inject({method:'POST',url:`/v1/${route}`,headers:client,payload:{model,messages:[{role:'user',content:'Hi'}],max_tokens:32}});
   expect(r.statusCode,r.body).toBe(200);expect(r.body).toContain(`secret-${protocol}`);
  }
  const measured=(await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.find((k:{id:string})=>k.id===key.json().key.id);expect(measured.usedTokens).toBe(30);
  expect((await request()).statusCode).toBe(429);

  const check=await service.app.inject({method:'POST',url:`/api/sources/${source.id}/check`,headers,payload:{model}});expect(check.json().passed,check.body).toBe(true);if(protocol==='responses')expect(calls.at(-1)?.body.max_output_tokens).toBe(16);
  const deny=await service.app.inject({method:'POST',url:`/api/sources/${source.id}/check`,headers,payload:{model:apiModelID(source.id,'forbidden')}});expect(deny.json().passed).toBe(false);expect(deny.body).not.toContain('DO-NOT-RETURN');
  const activity=await service.app.inject({url:'/api/gateway/activity',headers});expect(activity.json().recent.some((r:{keyId:string})=>r.keyId===key.json().key.id)).toBe(true);
  const update=await service.app.inject({method:'PUT',url:`/api/sources/${source.id}`,headers,payload:{...source,credentialRef:undefined,checks:undefined,hasKey:undefined,id:undefined,createdAt:undefined,enabled:false}});expect(update.statusCode).toBe(409);
  const disabled=await service.app.inject({method:'PUT',url:`/api/sources/${source.id}`,headers,payload:{name:source.name,baseURL:source.baseURL,protocol,models:source.models,enabled:false,acknowledge:true}});expect(disabled.statusCode,disabled.body).toBe(200);
  expect((await request()).statusCode).toBe(503);expect((await service.app.inject({method:'DELETE',url:`/api/sources/${source.id}`,headers})).statusCode).toBe(409);
 }
},60000);
it('strips ChatGPT-only fields the sidecar adds for generic Responses sources and leaves same-protocol calls untouched',async()=>{
 const {service,headers,add,calls}=await fixture(true);
 const source=await add('generic','secret-generic');const model=apiModelID(source.id,'shared');
 const key=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'generic',models:[model],agents:['codex','claude','openai'],tokenLimit:null}});expect(key.statusCode,key.body).toBe(200);
 const client={...headers,authorization:`Bearer ${key.json().apiKey}`};
 const send=(route:string,payload:object)=>service.app.inject({method:'POST',url:`/v1/${route}`,headers:client,payload:{model,...payload}});
 let first=await send('chat/completions',{messages:[{role:'user',content:'strict-generic'}]});if(first.statusCode===404){await new Promise(r=>setTimeout(r,1200));first=await send('chat/completions',{messages:[{role:'user',content:'strict-generic'}]});}
 for(const response of [first,await send('messages',{messages:[{role:'user',content:'strict-generic'}],max_tokens:32})]){
  expect(response.statusCode,response.body).toBe(200);expect(response.body).toContain('secret-generic');
  const accepted=calls.at(-1)!.body;
  expect(accepted.include).toBeUndefined();expect(JSON.stringify(accepted.tools??[])).not.toContain('image_generation');
 }
 // Exported API keys preserve both client tools and vendor-hosted tools on native routes.
 const tools=[{type:'function',name:'exec_command',parameters:{type:'object',properties:{command:{type:'string'}}}},{type:'web_search'},{type:'image_generation'}];
 const native=await send('responses',{input:'native',include:['reasoning.encrypted_content'],tools,tool_choice:'auto',stream:false});
 expect(native.statusCode,native.body).toBe(200);expect(calls.at(-1)!.body.include).toEqual(['reasoning.encrypted_content']);
 expect(calls.at(-1)!.body.tools).toEqual(tools);expect(calls.at(-1)!.body.tool_choice).toBe('auto');
},60000);
it('keeps two identical API types separate across a service restart, A2A configuration and repair calls',async()=>{
 const {root,service,headers,add,options,calls}=await fixture(true);
 const a=await add('Project A','project-A');const b=await add('Project B','project-B');
 const ma=apiModelID(a.id,'shared'),mb=apiModelID(b.id,'shared');
 const keys=[];
 for(const [source,model] of [[a,ma],[b,mb]] as const){const r=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:source.name,models:[model],sourceId:source.id,tokenLimit:40}});expect(r.statusCode,r.body).toBe(200);keys.push(r.json());}
 const wrong=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'wrong source',models:[mb],sourceId:a.id}});expect(wrong.statusCode).toBe(409);
 const target=(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:{id:string})=>t.id==='codex');
 const connected=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target:'codex',sourceId:a.id,model:ma,revision:target.revision}});expect(connected.statusCode,connected.body).toBe(200);expect(await readFile(join(root,'codex/config.toml'),'utf8')).toContain(ma);
 await service.app.close();const restarted=await createDesktopService(options);cleanup.push(()=>restarted.app.close());await restarted.proxy.start();
 const snapshot=(await restarted.app.inject({url:'/api/local-agent',headers})).json();expect(snapshot.apiSources.map((s:{name:string})=>s.name)).toEqual(['Project A','Project B']);expect(snapshot.models.map((m:{id:string})=>m.id)).toEqual(expect.arrayContaining([ma,mb]));expect(snapshot.accounts).toEqual([]);
 let previous='';
 for(const [index,model] of [ma,mb].entries()){
  const response=await restarted.app.inject({method:'POST',url:'/v1/responses',headers:{...headers,authorization:`Bearer ${keys[index].apiKey}`},payload:{model,input:'Hi',store:true}});expect(response.statusCode,response.body).toBe(200);expect(response.json().output[0].content[0].text).toContain(index?'project-B':'project-A');if(!index)previous=response.json().id;
  for(const route of ['chat/completions','messages']){
   const converted=await restarted.app.inject({method:'POST',url:`/v1/${route}`,headers:{...headers,authorization:`Bearer ${keys[index].apiKey}`},payload:{model,messages:[{role:'user',content:'Hi'}],max_tokens:32}});
   expect(converted.statusCode,converted.body).toBe(200);expect(converted.body).toContain(index?'project-B':'project-A');
  }

 }
 const crossed=await restarted.app.inject({method:'POST',url:'/v1/responses',headers:{...headers,authorization:`Bearer ${keys[1].apiKey}`},payload:{model:mb,input:'continue',previous_response_id:previous}});expect(crossed.statusCode,crossed.body).toBe(400);
 const selected=await restarted.app.inject({method:'PUT',url:'/api/maintenance',headers,payload:{sourceId:b.id,model:mb}});expect(selected.statusCode,selected.body).toBe(200);
 expect((await restarted.app.inject({method:'POST',url:'/api/maintenance/check',headers,payload:{}})).statusCode).toBe(200);await expect.poll(async()=>(await restarted.app.inject({url:'/api/maintenance',headers})).json().readiness.status).toBe('ready');
 const repair=await restarted.app.inject({method:'POST',url:'/api/maintenance/run',headers,payload:{prompt:'检查网关'}});expect(repair.statusCode,repair.body).toBe(200);await expect.poll(async()=>(await restarted.app.inject({url:'/api/maintenance',headers})).json().status).toBe('completed');
 const activity=(await restarted.app.inject({url:'/api/gateway/activity',headers})).json();expect(activity.recent.some((r:{agent:string;model:string})=>r.agent==='内部 · 维修模型'&&r.model===mb)).toBe(true);
 expect(calls.filter(c=>c.key.includes('project-B')).length).toBeGreaterThan(1);
},60000);
it('keeps saved API models callable when an account refresh observes a transient empty API catalog',async()=>{
 const {service,headers,add}=await fixture();const source=await add('Reloading API','reload-key');const model=apiModelID(source.id,'shared');
 const response=await fetch(`http://127.0.0.1:${service.proxy.port}/fixture`,{method:'POST',body:JSON.stringify({apiModelDelayReads:12})});expect(response.ok).toBe(true);
 await service.proxy.refreshAccounts();
 expect(service.proxy.apiModelAvailable(model)).toBe(true);
 const snapshot=(await service.app.inject({url:'/api/local-agent',headers})).json();expect(snapshot.models.map((m:{id:string})=>m.id)).toContain(model);
 const checked=await service.app.inject({method:'POST',url:`/api/sources/${source.id}/check`,headers,payload:{model}});expect(checked.statusCode,checked.body).toBe(200);expect(checked.json().passed).toBe(true);
});
it('preserves API routing when account aliases are saved from a stale sidecar configuration',async()=>{
 const {root,service,headers,add}=await fixture();const source=await add('Mixed sources','mixed-key');const model=apiModelID(source.id,'shared');
 await fetch(`http://127.0.0.1:${service.proxy.port}/fixture`,{method:'POST',body:JSON.stringify({staleConfigOnAliasWrite:true,accounts:[{name:'workbuddy-fixture.json',provider:'workbuddy',status:'active',models:['account-model']}]})});
 await service.proxy.refreshAccounts();
 expect(await readFile(join(root,'cliproxy/config.yaml'),'utf8')).toContain(model);
 const checked=await service.app.inject({method:'POST',url:`/api/sources/${source.id}/check`,headers,payload:{model}});expect(checked.statusCode,checked.body).toBe(200);expect(checked.json().passed).toBe(true);
});
it('marks interrupted API streams as failed, prevents budget replay, and does not fall back after source removal',async()=>{
 const {service,headers,add}=await fixture(true);const s=await add('Stream','stream-key');const model=apiModelID(s.id,'shared');
 const created=(await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'bounded',sourceId:s.id,models:[model],tokenLimit:20}})).json();const client={...headers,authorization:`Bearer ${created.apiKey}`};
 const response=await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model,input:'truncate',stream:true}});expect(response.body).toContain('event: error');expect(response.body).toContain('before completion');
 const key=(await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.find((k:{id:string})=>k.id===created.key.id);expect(key.unmeteredRequests).toBe(1);
 expect((await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model,input:'retry'}})).statusCode).toBe(429);
 const activity=(await service.app.inject({url:'/api/gateway/activity',headers})).json();expect(activity.recent.some((r:{status:number})=>r.status===502)).toBe(true);
 await service.app.inject({method:'DELETE',url:`/api/gateway-keys/${created.key.id}`,headers});expect((await service.app.inject({method:'DELETE',url:`/api/sources/${s.id}`,headers})).statusCode).toBe(200);
 expect((await service.app.inject({method:'POST',url:'/v1/responses',headers,payload:{model,input:'Hi'}})).statusCode).toBe(503);
},60000);
it('reports daily token limits returned as HTTP 200 JSON instead of a broken Responses stream',async()=>{
 const {service,headers,add}=await fixture(true),source=await add('Daily quota fixture','private-fixture-key','responses'),model=apiModelID(source.id,'shared');
 for(const stream of [true,false]){
  const result=await service.app.inject({method:'POST',url:'/v1/responses',headers,payload:{model,input:'daily-token-envelope',stream}});
  expect(result.statusCode,result.body).toBe(429);expect(result.json().error).toMatchObject({code:'upstream_daily_token_limit',message:expect.stringContaining('每日 token')});
  expect(result.body).not.toContain('PRIVATE_PROVIDER_BODY');expect(result.body).not.toContain('response.completed');
 }
 const activity=(await service.app.inject({url:'/api/gateway/activity',headers})).json();
 expect(activity.recent.filter((r:any)=>r.model===model).slice(0,2)).toEqual(expect.arrayContaining([expect.objectContaining({status:429,error:expect.objectContaining({code:'upstream_daily_token_limit'})})]));
});
it.each(['chat','responses'])('preserves classified %s API failures through the relay and Responses gateway',async protocol=>{
 const {service,headers,add}=await fixture(true);const source=await add('Diagnostic API','diagnostic-private-key',protocol),model=apiModelID(source.id,'shared');
 await expect.poll(()=>service.proxy.apiModelAvailable(model),{timeout:5000}).toBe(true);
 for(const [marker,code,detail] of [['classified-context-error','context_length_exceeded','上下文窗口'],['classified-field-error','upstream_invalid_request','messages[2].content']]){
  const result=await service.app.inject({method:'POST',url:'/v1/responses',headers,payload:{model,input:marker,stream:false}});
  expect(result.statusCode,result.body).toBe(400);expect(result.json().error).toMatchObject({code,message:expect.stringContaining(detail!)});expect(result.body).not.toContain('PRIVATE_PROVIDER_BODY');
 }
 if(protocol==='responses'){
  const result=await service.app.inject({method:'POST',url:'/v1/responses',headers,payload:{model,input:'classified-stream-error',stream:true}});
  expect(result.body).toContain('context_length_exceeded');expect(result.body).not.toContain('PRIVATE_PROVIDER_BODY');
 }
},30000);
it('keeps a managed Codex summary failure identical in its stream and activity record',async()=>{
 const {root,service,headers,add}=await fixture();const source=await add('Summary error API','diagnostic-private-key'),model=apiModelID(source.id,'shared');
 const target=(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:{id:string})=>t.id==='codex');
 const connected=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target:'codex',sourceId:source.id,model,revision:target.revision}});expect(connected.statusCode,connected.body).toBe(200);
 const config=parse(await readFile(join(root,'codex/config.toml'),'utf8')) as any;
 const client={...headers,authorization:'Bearer '+config.model_providers.token_flow.experimental_bearer_token,session_id:'compaction-failure-test'};
 await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model,input:'Hello',stream:true}});
 const result=await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model,stream:true,input:[{role:'assistant',content:'classified-capacity-error '+ 'work '.repeat(5000)},...Array.from({length:8},()=>({role:'assistant',content:'Recent work'})),{type:'compaction_trigger'}]}});
 expect(result.statusCode).toBe(200);expect(result.body).toContain('response.failed');expect(result.body).toContain('选择其他模型');expect(result.body).not.toContain('PRIVATE_PROVIDER_BODY');
 const rows=(await service.app.inject({url:'/api/gateway/traces',headers})).json().records;
 expect(rows[0]).toMatchObject({status:429,error:{code:'compaction_upstream_failed',message:expect.stringContaining('Qoder 当前模型容量不足')}});
});
it('restricts the private relay to its own source/model/protocol and refuses redirects with credentials',async()=>{
 const {root,service,headers,add,calls}=await fixture();const source=await add('Private','private-source-key');
 const yaml=await readFile(join(root,'cliproxy/config.yaml'),'utf8');const entry=JSON.parse(yaml.match(/^codex-api-key: (.+)/m)![1])[0];
 const scoped=(await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'client',sourceId:source.id,models:[apiModelID(source.id,'shared')]}})).json();
 const client={...headers,authorization:`Bearer ${scoped.apiKey}`};
 expect((await service.app.inject({url:'/api/sources',headers:client})).statusCode).toBe(401);
 expect((await service.app.inject({method:'DELETE',url:`/api/sources/${source.id}`,headers:client})).statusCode).toBe(401);
 expect((await service.app.inject({url:'/api/sources',headers:{...headers,origin:'https://evil.test'}})).statusCode).toBe(403);
 await service.app.inject({method:'DELETE',url:`/api/gateway-keys/${scoped.key.id}`,headers});
 const url=entry['base-url']+'/responses';const payload=JSON.stringify({model:'shared',input:'Hi'});
 expect((await fetch(url,{method:'POST',body:payload})).status).toBe(401);
 const relayHeaders={authorization:`Bearer ${entry['api-key']}`,'content-type':'application/json'};
 expect((await fetch(url,{method:'POST',headers:relayHeaders,body:JSON.stringify({model:'different'})})).status).toBe(403);
 expect((await fetch(entry['base-url']+'/chat/completions',{method:'POST',headers:relayHeaders,body:payload})).status).toBe(400);
 expect(calls).toHaveLength(0);
 const streamError=await fetch(url,{method:'POST',headers:relayHeaders,body:JSON.stringify({model:'shared',input:'secret-error',stream:true})});const text=await streamError.text();expect(text).toContain('API source stream failed');expect(text).not.toContain('private-source-key');expect(text).not.toContain('secret-private-upstream-detail');
 const redir=createServer((_req,res)=>{res.writeHead(302,{location:'http://127.0.0.1:1/stolen'});res.end();});await new Promise<void>(r=>redir.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>redir.close(()=>r())));
 const baseURL=`http://127.0.0.1:${(redir.address() as {port:number}).port}/v1`;
 expect((await service.app.inject({method:'PUT',url:`/api/sources/${source.id}`,headers,payload:{name:source.name,protocol:'responses',models:source.models,baseURL}})).statusCode).toBe(200);
 const blocked=await fetch(url,{method:'POST',headers:relayHeaders,body:payload});expect(blocked.status).toBe(502);expect(await blocked.text()).not.toContain('private-source-key');
});
it('keeps the previous credential on a failed edit and refuses durable API setup without a persistent vault',async()=>{
 const {root,secrets,baseURL,add}=await fixture();const source=await add('Original','original-private-key');
 const store=await ApiSources.open(root,secrets,defaultProvider);cleanup.push(()=>store.close());const original=await readFile(join(root,'api-sources.json'),'utf8');
 const ref=JSON.parse(original).sources[0].credentialRef;
 await mkdir(join(root,'api-sources.json.tmp'));
 await expect(store.save({name:'Changed',baseURL,protocol:'responses',models:['shared'],apiKey:'replacement-private-key'},source.id)).rejects.toThrow();
 expect(await secrets.get(ref)).toBe('original-private-key');expect((await store.list())[0].name).toBe('Original');expect(await readFile(join(root,'api-sources.json'),'utf8')).toBe(original);
 const memory=await ApiSources.open(root,{...secrets,persistent:false},defaultProvider);cleanup.push(()=>memory.close());
 await expect(memory.save({name:'Memory',baseURL,protocol:'responses',models:['shared'],apiKey:'new-private-key'})).rejects.toThrow('桌面版');
});
it('uses an explicitly selected bounded repair source while sidecar is offline, without granting other keys a bypass',async()=>{
 // This routing test must not invoke the host's Codex/npm installation probes.
 const installation=vi.spyOn(LocalMaintenance.prototype,'installation').mockResolvedValue({target:'codex',channel:'not-found',reason:'Isolated test fixture',reference:''});cleanup.push(async()=>{installation.mockRestore();});
 const {service,headers,add,root,calls}=await fixture();const source=await add('Offline repair','offline-repair-key');const model=apiModelID(source.id,'shared');
 const normal=(await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'normal',models:[model],sourceId:source.id}})).json();
 await service.proxy.stop();
 const direct=await service.app.inject({method:'PUT',url:'/api/maintenance',headers,payload:{sourceId:source.id,model,channel:'direct'}});expect(direct.statusCode,direct.body).toBe(200);
 expect((await service.app.inject({method:'POST',url:'/api/maintenance/check',headers,payload:{}})).statusCode).toBe(200);await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().readiness.status).toBe('ready');
 expect((await service.app.inject({method:'POST',url:'/v1/responses',headers:{...headers,authorization:`Bearer ${normal.apiKey}`},payload:{model,input:'Hi'}})).statusCode).toBe(503);
 const repair=await service.app.inject({method:'POST',url:'/api/maintenance/run',headers,payload:{prompt:'只读检查'}});expect(repair.statusCode,repair.body).toBe(200);await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().status).toBe('completed');
 const key=(await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.find((k:{name:string})=>k.name==='内部 · 维修模型');expect(key.tokenLimit).toBe(32000);expect(key.usedTokens).toBeGreaterThan(0);expect(calls.at(-1)?.key).toContain('offline-repair-key');
 expect((await service.app.inject({method:'POST',url:'/api/maintenance/local/diagnose',headers,payload:{target:'codex'}})).statusCode).toBe(200);await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance/local',headers})).json().active).toBeUndefined();
 expect(await readFile(join(root,'local-maintenance.json'),'utf8')).not.toContain('offline-repair-key');
 expect((await service.app.inject({url:'/api/maintenance/local',headers:{...headers,authorization:`Bearer ${normal.apiKey}`}})).statusCode).toBe(401);
 expect((await service.app.inject({method:'POST',url:'/api/maintenance/local/upgrade',headers,payload:{id:crypto.randomUUID()}})).statusCode).toBe(400);
 await service.proxy.start();
 const target=(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:{id:string})=>t.id==='codex');
 const connected=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target:'codex',sourceId:source.id,model,revision:target.revision}});expect(connected.statusCode,connected.body).toBe(200);
 // Stop any automatic read-only review before exercising the independent repair loop.
 await service.app.inject({method:'POST',url:'/api/maintenance/stop',headers,payload:{}});
 await writeFile(join(root,'codex/config.toml'),'');
 const chain={target:'codex',sourceId:source.id,model,connectionId:connected.json().id};
 const plan=(await service.app.inject({method:'POST',url:'/api/maintenance/propose',headers,payload:{chain}})).json();expect(plan.status).toBe('pending');
 const approved=await service.app.inject({method:'POST',url:'/api/maintenance/approve',headers,payload:{id:plan.id,approve:true}});expect(approved.json().proposal.status,approved.body).toBe('completed');await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().status).toBe('completed');
 expect(await readFile(join(root,'codex/config.toml'),'utf8')).toContain(model);
 const current=(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:{id:string})=>t.id==='codex');
 const repaired=await readFile(join(root,'codex/config.toml'),'utf8');const configuredKey=repaired.match(/experimental_bearer_token = "([^"]+)"/)![1];
 const probe=await service.app.inject({method:'POST',url:'/v1/responses',headers:{...headers,authorization:`Bearer ${configuredKey}`},payload:{model:current.connection.model,input:'minimal gateway test',max_output_tokens:32}});expect(probe.statusCode,probe.body).toBe(200);
 const other=await add('Not native','other','chat');expect((await service.app.inject({method:'PUT',url:'/api/maintenance',headers,payload:{sourceId:other.id,model:apiModelID(other.id,'shared'),channel:'direct'}})).statusCode).toBe(409);
},30000);

it('keeps retained models callable when another authorized model disappears from the pinned source',async()=>{
 const {service,headers,add,baseURL}=await fixture();const source=await add('Changing catalog','catalog-key');
 const model=apiModelID(source.id,'shared'),removed=apiModelID(source.id,'forbidden');
 const created=(await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'Pinned models',sourceId:source.id,models:[model,removed]}})).json();
 const client={...headers,authorization:`Bearer ${created.apiKey}`};
 const update=await service.app.inject({method:'PUT',url:`/api/sources/${source.id}`,headers,payload:{name:source.name,baseURL,protocol:'responses',models:['shared'],acknowledge:true}});expect(update.statusCode,update.body).toBe(200);
 const catalog=await service.app.inject({url:'/v1/models',headers:client});expect(catalog.statusCode,catalog.body).toBe(200);expect(catalog.json().data.map((m:{id:string})=>m.id)).toEqual([model]);
 const retained=await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model,input:'Hi'}});expect(retained.statusCode,retained.body).toBe(200);
 expect((await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model:removed,input:'Hi'}})).statusCode).toBe(503);
 const other=await add('Different source','different-key');
 expect((await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model:apiModelID(other.id,'shared'),input:'Hi'}})).statusCode).toBe(403);
});
it('allows offline key revocation and scope reduction without permitting an authorization expansion',async()=>{
 const {service,headers,add,baseURL}=await fixture();const source=await add('Offline source','offline-key');
 const models=source.models.map((model:string)=>apiModelID(source.id,model));
 const created=(await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'Pinned key',sourceId:source.id,models,agents:['codex','claude'],tokenLimit:100}})).json();
 await service.app.inject({method:'PUT',url:`/api/sources/${source.id}`,headers,payload:{name:source.name,baseURL,protocol:'responses',models:['shared'],enabled:false,acknowledge:true}});
 const put=(extra:object)=>service.app.inject({method:'PUT',url:`/api/gateway-keys/${created.key.id}`,headers,payload:{name:'Pinned key',models,agents:['codex','claude'],tokenLimit:100,...extra}});
 const disabled=await put({enabled:false});expect(disabled.statusCode,disabled.body).toBe(200);expect(disabled.json().enabled).toBe(false);
 const reduced=await put({enabled:false,models:[models[0]],agents:['codex'],tokenLimit:50});expect(reduced.statusCode,reduced.body).toBe(200);
 for(const extra of [{enabled:true},{models},{agents:['codex','claude']},{tokenLimit:100},{tokenLimit:null}]){
  const denied=await put({enabled:false,models:[models[0]],agents:['codex'],tokenLimit:50,...extra});expect([400,409],denied.body).toContain(denied.statusCode);
 }
 const stored=(await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.find((k:{id:string})=>k.id===created.key.id);expect(stored).toMatchObject({enabled:false,models:[models[0]],agents:['codex'],tokenLimit:50,sourceId:source.id});
});
it('clears an idle repair selection durably, keeps history and user keys, and does not reset the direct budget',async()=>{
 const {service,headers,add,options,root}=await fixture();const source=await add('Repair selection','repair-key');const model=apiModelID(source.id,'shared');
 const user=(await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'内部 · 维修模型',sourceId:source.id,models:[model]}})).json();
 const select=()=>service.app.inject({method:'PUT',url:'/api/maintenance',headers,payload:{sourceId:source.id,model,channel:'direct'}});
 expect((await select()).statusCode).toBe(200);expect((await service.app.inject({method:'POST',url:'/api/maintenance/check',headers,payload:{}})).statusCode).toBe(200);await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().readiness.status).toBe('ready');
 await service.app.inject({method:'POST',url:'/api/maintenance/run',headers,payload:{prompt:'保留这条维修记录',chain:{target:'codex',sourceId:source.id,model}}});await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().status).toBe('completed');
 await service.app.inject({method:'PUT',url:'/api/maintenance/approval-policy',headers,payload:{mode:'model'}});
 const before=(await service.app.inject({url:'/api/maintenance',headers})).json();const beforeKeys=(await service.app.inject({url:'/api/gateway-keys',headers})).json().keys;const internal=beforeKeys.find((k:{id:string})=>k.id!==user.key.id);expect(internal.usedTokens).toBeGreaterThan(0);
 const clear=()=>service.app.inject({method:'DELETE',url:'/api/maintenance/selection',headers});
 expect((await service.app.inject({method:'DELETE',url:'/api/maintenance/selection',headers:{host:headers.host}})).statusCode).toBe(401);
 expect((await service.app.inject({method:'DELETE',url:'/api/maintenance/selection',headers:{...headers,authorization:`Bearer ${user.apiKey}`}})).statusCode).toBe(401);
 const cleared=await clear();expect(cleared.statusCode,cleared.body).toBe(200);expect(cleared.json()).toMatchObject({status:before.status,messages:before.messages,chain:before.chain,policy:{mode:'manual'}});expect(cleared.json().selection).toBeUndefined();
 expect((await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.map((k:{id:string})=>k.id)).toEqual([user.key.id]);
 expect((await select()).statusCode).toBe(200);expect((await service.app.inject({method:'POST',url:'/api/maintenance/check',headers,payload:{}})).statusCode).toBe(200);await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().readiness.status).toBe('ready');
 const renewed=(await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.find((k:{id:string})=>k.id!==user.key.id);expect(renewed.tokenLimit).toBe(32000-internal.usedTokens);
 expect((await clear()).statusCode).toBe(200);expect((await clear()).statusCode).toBe(200);
 await expect(readFile(join(root,'maintenance-model.json'))).rejects.toMatchObject({code:'ENOENT'});await expect(readFile(join(root,'maintenance-channel.json'))).rejects.toMatchObject({code:'ENOENT'});
 await service.app.close();const restarted=await createDesktopService(options);cleanup.push(()=>restarted.app.close());expect((await restarted.app.inject({url:'/api/maintenance',headers})).json().selection).toBeUndefined();
 await restarted.app.inject({method:'DELETE',url:`/api/gateway-keys/${user.key.id}`,headers});const removed=await restarted.app.inject({method:'DELETE',url:`/api/sources/${source.id}`,headers});expect(removed.statusCode,removed.body).toBe(200);
});
it('keeps an explicit approval-model reference when clearing only the repair selection',async()=>{
 const {service,headers,add}=await fixture();const source=await add('Separate approval','approval-key');const selection={sourceId:source.id,model:apiModelID(source.id,'shared')};
 await service.app.inject({method:'PUT',url:'/api/maintenance',headers,payload:selection});expect((await service.app.inject({method:'POST',url:'/api/maintenance/check',headers,payload:{}})).statusCode).toBe(200);await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().readiness.status).toBe('ready');
 await service.app.inject({method:'PUT',url:'/api/maintenance/approval-policy',headers,payload:{mode:'model',reviewer:selection}});
 await service.app.inject({method:'POST',url:'/api/maintenance/propose',headers,payload:{chain:{target:'codex',...selection}}});await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().proposal?.reason).toContain('人工审批');
 const reviewerKey=(await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.find((k:{name:string})=>k.name==='内部 · 审批模型');expect(reviewerKey).toBeDefined();
 const cleared=await service.app.inject({method:'DELETE',url:'/api/maintenance/selection',headers});expect(cleared.statusCode,cleared.body).toBe(200);expect(cleared.json().policy).toEqual({mode:'model',reviewer:selection});
 expect((await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.map((k:{id:string})=>k.id)).toEqual([reviewerKey.id]);
 expect((await service.app.inject({url:`/api/sources/${source.id}/usage`,headers})).json()).toMatchObject({repair:false,reviewer:true});
 expect((await service.app.inject({method:'DELETE',url:`/api/sources/${source.id}`,headers})).statusCode).toBe(409);
});
it('refuses selection removal during model checks, repairs and model approval without altering the selection',async()=>{
 const {service,headers,add,holdResponses}=await fixture();const source=await add('Busy repair','busy-key');const selection={sourceId:source.id,model:apiModelID(source.id,'shared')};
 let release=holdResponses();
 const clear=()=>service.app.inject({method:'DELETE',url:'/api/maintenance/selection',headers});
 const unchanged=async()=>expect((await service.app.inject({url:'/api/maintenance',headers})).json().selection).toEqual(selection);
 try{
  await service.app.inject({method:'PUT',url:'/api/maintenance',headers,payload:selection});
  expect((await service.app.inject({method:'POST',url:'/api/maintenance/check',headers,payload:{}})).statusCode).toBe(200);
  expect((await clear()).statusCode).toBe(409);await unchanged();release();
  await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().readiness.status).toBe('ready');
  release=holdResponses();await service.app.inject({method:'POST',url:'/api/maintenance/run',headers,payload:{prompt:'只读检查'}});expect((await clear()).statusCode).toBe(409);await unchanged();release();
  await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().status).toBe('completed');
  await service.app.inject({method:'PUT',url:'/api/maintenance/approval-policy',headers,payload:{mode:'model'}});
  release=holdResponses();await service.app.inject({method:'POST',url:'/api/maintenance/propose',headers,payload:{chain:{target:'codex',...selection}}});
  await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().proposal?.status).toBe('reviewing');expect((await clear()).statusCode).toBe(409);await unchanged();release();
  await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().proposal?.reason).toContain('人工审批');
  const cleared=await clear();expect(cleared.statusCode,cleared.body).toBe(200);expect(cleared.json().proposal).toBeUndefined();expect(cleared.json().policy).toEqual({mode:'manual'});expect((await service.app.inject({url:'/api/gateway-keys',headers})).json().keys).toEqual([]);
 }finally{release();}
});
it('serializes the full offline key update so a concurrent stale edit cannot restore revoked models',async()=>{
 let releaseFirst!:()=>void;const firstGate=new Promise<void>(resolve=>releaseFirst=resolve);
 const {service,headers,add,baseURL,secrets}=await fixture(false,app=>app.addHook('preHandler',(request,_reply,done)=>{
  // Let the second handler reach its first await before the first read resumes.
  done();if(request.headers['x-fixture-edit']==='second')releaseFirst();
 }));
 const source=await add('Concurrent scopes','concurrent-key');const models=source.models.map((model:string)=>apiModelID(source.id,model));
 const created=(await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'Pinned key',sourceId:source.id,models}})).json();
 await service.app.inject({method:'PUT',url:`/api/sources/${source.id}`,headers,payload:{name:source.name,baseURL,protocol:'responses',models:source.models,enabled:false,acknowledge:true}});
 let entered!:()=>void;const firstEntered=new Promise<void>(resolve=>entered=resolve);let finished!:()=>void;const firstFinished=new Promise<void>(resolve=>finished=resolve);let reads=0;
 const originalGet=secrets.get.bind(secrets);
 const get=vi.spyOn(secrets,'get').mockImplementation(async name=>{
  if(name.startsWith(`source-${source.id}-`)){
   if(++reads===1){entered();await firstGate;}else await firstFinished;
  }
  return originalGet(name);
 });
 try{
  const first=service.app.inject({method:'PUT',url:`/api/gateway-keys/${created.key.id}`,headers,payload:{name:'Restricted key',models:[models[0]]}}).then(response=>{finished();return response;});
  await firstEntered;
  const second=service.app.inject({method:'PUT',url:`/api/gateway-keys/${created.key.id}`,headers:{...headers,'x-fixture-edit':'second'},payload:{name:'Stale rename',models}});
  const [restricted,stale]=await Promise.all([first,second]);expect(restricted.statusCode,restricted.body).toBe(200);expect([400,409],stale.body).toContain(stale.statusCode);
  const stored=(await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.find((key:{id:string})=>key.id===created.key.id);expect(stored.models).toEqual([models[0]]);expect(stored.name).toBe('Restricted key');
 }finally{releaseFirst();finished();get.mockRestore();}
});
it('clears the restored repair selection after a normal restart without retaining the prior internal key',async()=>{
 const {service,headers,add,options,root}=await fixture();const source=await add('Restarted repair','restart-key');const selection={sourceId:source.id,model:apiModelID(source.id,'shared')};
 await service.app.inject({method:'PUT',url:'/api/maintenance',headers,payload:selection});expect((await service.app.inject({method:'POST',url:'/api/maintenance/check',headers,payload:{}})).statusCode).toBe(200);await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().readiness.status).toBe('ready');
 const oldKey=(await service.app.inject({url:'/api/gateway-keys',headers})).json().keys[0];expect(oldKey).toBeDefined();
 await service.app.close();expect(JSON.parse(await readFile(join(root,'gateway-keys.json'),'utf8'))).toEqual([]);
 const restarted=await createDesktopService(options);cleanup.push(()=>restarted.app.close());await restarted.proxy.start();
 expect((await restarted.app.inject({url:'/api/maintenance',headers})).json().selection).toMatchObject(selection);
 expect((await restarted.app.inject({method:'POST',url:'/api/maintenance/check',headers,payload:{}})).statusCode).toBe(200);
 await expect.poll(async()=>(await restarted.app.inject({url:'/api/maintenance',headers})).json().readiness.status).toBe('ready');
 const newKey=(await restarted.app.inject({url:'/api/gateway-keys',headers})).json().keys[0];expect(newKey.id).not.toBe(oldKey.id);
 const cleared=await restarted.app.inject({method:'DELETE',url:'/api/maintenance/selection',headers});expect(cleared.statusCode,cleared.body).toBe(200);
 expect((await restarted.app.inject({url:`/api/sources/${source.id}/usage`,headers})).json()).toEqual({targets:[],keys:[],repair:false,reviewer:false});
 const removed=await restarted.app.inject({method:'DELETE',url:`/api/sources/${source.id}`,headers});expect(removed.statusCode,removed.body).toBe(200);
});

it('adds a source from URL, key and model only, detecting the protocol with a real request',async()=>{
 const {service,headers,baseURL,calls}=await fixture();
 const bad=await service.app.inject({method:'POST',url:'/api/sources/quick',headers,payload:{baseURL:'not-a-url',apiKey:'quick-key',model:'shared'}});
 expect(bad.statusCode).toBe(400);expect(calls).toHaveLength(0);
 const added=await service.app.inject({method:'POST',url:'/api/sources/quick',headers,payload:{baseURL,apiKey:'quick-key',model:'shared, extra'}});
 expect(added.statusCode,added.body).toBe(200);
 expect(added.json()).toMatchObject({protocol:'responses',models:['shared','extra'],enabled:true,hasKey:true,name:'本机 '+new URL(baseURL).port});
 expect(calls[0]).toMatchObject({path:'/v1/responses',key:'Bearer quick-key'});
 // Editing keeps the stored key when the field is left blank.
 const edited=await service.app.inject({method:'POST',url:'/api/sources/quick',headers,payload:{id:added.json().id,baseURL,model:'shared'}});
 expect(edited.statusCode,edited.body).toBe(200);expect(edited.json()).toMatchObject({id:added.json().id,models:['shared'],hasKey:true});
 expect(calls.at(-1)).toMatchObject({key:'Bearer quick-key'});
});

it('uses one saved API key for multiple Codex menu models and switches A/B/A without replacing the source',async()=>{
 const {service,headers,baseURL,calls,options}=await fixture();
 const added=await service.app.inject({method:'POST',url:'/api/sources/quick',headers,payload:{name:'Shared API',baseURL,apiKey:'multi-model-fixture-key',model:'shared\nsecond'}});
 expect(added.statusCode,added.body).toBe(200);const source=added.json();
 const models=source.models.map((m:string)=>apiModelID(source.id,m));
 const target=(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:{id:string})=>t.id==='codex');
 const selections=models.map((model:string)=>({sourceId:source.id,model}));
 const connected=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target:'codex',...selections[0],selections,revision:target.revision}});
 expect(connected.statusCode,connected.body).toBe(200);
 const config=parse(await readFile(options.agentPaths.codex,'utf8')) as any;
 expect(JSON.parse(await readFile(config.model_catalog_json,'utf8')).models.map((m:{slug:string})=>m.slug)).toEqual(models);
 const clientHeaders={host:headers.host,authorization:`Bearer ${config.model_providers.token_flow.experimental_bearer_token}`};
 expect((await service.app.inject({url:'/v1/models',headers:clientHeaders})).json().data.map((m:{id:string})=>m.id).sort()).toEqual([...models].sort());
 calls.length=0;let previous:string|undefined;
 for(const model of [models[0],models[1],models[0]]){
  const response=await service.app.inject({method:'POST',url:'/v1/responses',headers:clientHeaders,payload:{model,input:'Continue the same conversation',...(previous?{previous_response_id:previous}:{})}});
  expect(response.statusCode,response.body).toBe(200);expect(response.json().model).toBe(model);previous=response.json().id;
 }
 expect(calls.map(c=>c.body.model)).toEqual(['shared','second','shared']);expect(calls.every(c=>c.key==='Bearer multi-model-fixture-key')).toBe(true);
 expect((calls[2].body.input as unknown[]).length).toBeGreaterThan((calls[0].body.input as unknown[]).length);
});

it('reveals a source key only to the local administrator on explicit request, without caching',async()=>{
 const {service,headers,add}=await fixture();const source=await add('Reveal','fixture-private-key');
 const url=`/api/sources/${source.id}/reveal-key`;
 const request={method:'POST' as const,url,payload:{}};
 expect((await service.app.inject({...request,headers:{host:headers.host}})).statusCode).toBe(401);
 expect((await service.app.inject({...request,headers:{...headers,origin:'https://untrusted.test'}})).statusCode).toBe(403);
 const client=(await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'export',models:[apiModelID(source.id,'shared')]}})).json();
 expect((await service.app.inject({...request,headers:{...headers,authorization:`Bearer ${client.apiKey}`}})).statusCode).toBe(401);
 const reveal=await service.app.inject({...request,headers});expect(reveal.statusCode).toBe(200);expect(reveal.headers['cache-control']).toBe('no-store');expect(reveal.json()).toEqual({apiKey:'fixture-private-key'});
 expect((await service.app.inject({url:'/api/sources',headers})).body).not.toContain('fixture-private-key');
 expect((await service.app.inject({...request,url:`/api/sources/${'0'.repeat(24)}/reveal-key`,headers})).statusCode).toBe(404);
});

it('keeps exported key details encrypted and recoverable only by the administrator, with purpose and revocation intact',async()=>{
 const {service,headers,add,root,secrets}=await fixture();const source=await add('Cards','fixture-source-key');
 const created=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'Team editor',purpose:'Daily coding',models:[apiModelID(source.id,'shared')]}});
 expect(created.statusCode,created.body).toBe(200);const {key,apiKey,keyStored}=created.json();expect(keyStored).toBe(true);expect(key.purpose).toBe('Daily coding');
 const file=join(root,'secrets',`gateway-key-${key.id}.bin`);
 expect((await readFile(file)).includes(Buffer.from(apiKey))).toBe(false);
 expect(await readFile(join(root,'gateway-keys.json'),'utf8')).not.toContain(apiKey);
 const request={method:'POST' as const,url:`/api/gateway-keys/${key.id}/reveal`,payload:{}};
 expect((await service.app.inject({...request,headers:{host:headers.host}})).statusCode).toBe(401);
 expect((await service.app.inject({...request,headers:{...headers,authorization:`Bearer ${apiKey}`}})).statusCode).toBe(401);
 expect((await service.app.inject({...request,headers:{...headers,origin:'https://untrusted.test'}})).statusCode).toBe(403);
 const reveal=await service.app.inject({...request,headers});expect(reveal.json()).toEqual({apiKey});expect(reveal.headers['cache-control']).toBe('no-store');
 await service.app.inject({method:'PUT',url:`/api/gateway-keys/${key.id}`,headers,payload:{name:key.name,models:key.models,enabled:false}});
 expect((await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.find((item:{id:string})=>item.id===key.id).purpose).toBe('Daily coding');
 await service.app.inject({method:'DELETE',url:`/api/gateway-keys/${key.id}`,headers});
 expect(await secrets.get(`gateway-key-${key.id}`)).toBe('');expect((await service.app.inject({...request,headers})).statusCode).toBe(404);
 const before=(await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.length;
 const broken=vi.spyOn(secrets,'set').mockRejectedValueOnce(new Error('private-storage-error'));
 const failed=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'fail',models:key.models}});
 expect(failed.statusCode).toBe(409);expect(failed.body).not.toContain('private-storage-error');broken.mockRestore();
 expect((await service.app.inject({url:'/api/gateway-keys',headers})).json().keys).toHaveLength(before);
});

it('edits exported model permissions in place and preserves credentials, metadata, budgets and usage',async()=>{
 const {service,headers,add,root,secrets,calls,baseURL}=await fixture();
 const a=await add('Original API','original-fixture-key'),b=await add('Added API','added-fixture-key');
 const ma=apiModelID(a.id,'shared'),mb=apiModelID(b.id,'shared');
 const {key,apiKey}=(await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'Existing app',purpose:'Daily use',sourceId:a.id,models:[ma],agents:['codex'],tokenLimit:100}})).json();
 const client={...headers,authorization:`Bearer ${apiKey}`};
 const call=(model:string)=>service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model,input:'Hi'}});
 expect((await call(ma)).statusCode).toBe(200);
 const before=JSON.parse(await readFile(join(root,'gateway-keys.json'),'utf8'))[0];
 const edit=(selections:Array<{model:string;sourceId:string}>,auth:Record<string,string>=headers)=>service.app.inject({method:'PUT',url:`/api/gateway-keys/${key.id}/models`,headers:auth,payload:{selections}});
 const added=await edit([{model:ma,sourceId:a.id},{model:mb,sourceId:b.id}]);expect(added.statusCode,added.body).toBe(200);
 expect(added.json()).toMatchObject({id:key.id,name:'Existing app',purpose:'Daily use',prefix:key.prefix,createdAt:key.createdAt,usedTokens:10,tokenLimit:100,agents:['codex'],exported:true,modelSources:{[ma]:a.id,[mb]:b.id}});
 expect(added.json().sourceId).toBeUndefined();
 expect((await call(mb)).statusCode).toBe(200);expect(calls.at(-1)?.key).toBe('Bearer added-fixture-key');
 expect((await service.app.inject({url:'/v1/models',headers:client})).json().data.map((m:{id:string})=>m.id).sort()).toEqual([ma,mb].sort());
 expect((await edit([{model:ma,sourceId:a.id}],client)).statusCode).toBe(401);
 expect((await edit([{model:ma,sourceId:a.id}],{host:headers.host,authorization:headers.authorization,origin:'https://untrusted.test'})).statusCode).toBe(403);
 expect((await edit([{model:ma,sourceId:a.id},{model:ma,sourceId:b.id}])).statusCode).toBe(400);
 expect((await edit([{model:mb,sourceId:a.id}])).statusCode).toBe(409);
 expect((await edit([{model:apiModelID(b.id,'not-loaded'),sourceId:b.id}])).statusCode).toBe(400);
 const retained=(await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.find((k:{id:string})=>k.id===key.id);expect(retained.models.sort()).toEqual([ma,mb].sort());
 await service.app.inject({method:'PUT',url:`/api/sources/${b.id}`,headers,payload:{name:b.name,baseURL,protocol:'responses',models:b.models,enabled:false,acknowledge:true}});
 const retainedOffline=await edit([{model:ma,sourceId:a.id},{model:mb,sourceId:b.id},{model:apiModelID(a.id,'forbidden'),sourceId:a.id}]);expect(retainedOffline.statusCode,retainedOffline.body).toBe(200);
 // Removing an offline model must not force regeneration or re-authorize the retained source.
 const removed=await edit([{model:ma,sourceId:a.id}]);expect(removed.statusCode,removed.body).toBe(200);expect(removed.json().usedTokens).toBe(20);expect(removed.json().modelSources).toEqual({[ma]:a.id});
 expect((await call(mb)).statusCode).toBe(403);expect((await call(ma)).statusCode).toBe(200);
 const reapplied=await edit([{model:ma,sourceId:a.id},{model:mb,sourceId:b.id}]);expect(reapplied.statusCode,reapplied.body).toBe(200);expect((await call(mb)).statusCode).toBe(503);
 const after=JSON.parse(await readFile(join(root,'gateway-keys.json'),'utf8'))[0];expect(after.digest).toBe(before.digest);expect(after.usedTokens).toBe(30);expect(after.sourceId).toBeUndefined();
 expect(await secrets.get(`gateway-key-${key.id}`)).toBe(apiKey);
 const revoked=await edit([]);expect(revoked.statusCode,revoked.body).toBe(200);expect(revoked.json().models).toEqual([]);expect(revoked.json().usedTokens).toBe(30);
 expect((await call(ma)).statusCode).toBe(403);
 expect((await edit([{model:ma,sourceId:a.id}])).statusCode).toBe(200);expect((await call(ma)).statusCode).toBe(200);
});

it('settles an admitted request after model removal without losing its usage or admitting new calls',async()=>{
 const {service,headers,add,holdResponses}=await fixture();const source=await add('In flight','in-flight-key');const model=apiModelID(source.id,'shared');
 const {key,apiKey}=(await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'Live key',models:[model],modelSources:{[model]:source.id},tokenLimit:100}})).json();
 const client={...headers,authorization:`Bearer ${apiKey}`};const release=holdResponses();
 const call=service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model,input:'Hi'}});
 try{
  await vi.waitFor(async()=>expect((await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.find((k:{id:string})=>k.id===key.id).pendingRequests).toBe(1));
  const edit=await service.app.inject({method:'PUT',url:`/api/gateway-keys/${key.id}/models`,headers,payload:{selections:[]}});expect(edit.statusCode,edit.body).toBe(200);expect(edit.json().pendingRequests).toBe(1);
  expect((await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model,input:'Hi'}})).statusCode).toBe(403);
 }finally{release();}
 expect((await call).statusCode).toBe(200);
 expect((await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.find((k:{id:string})=>k.id===key.id)).toMatchObject({models:[],usedTokens:10,pendingRequests:0});
});

it('prefers the URL suffix and persists different model routes in one source through the real gateway',async()=>{
 const {service,headers,baseURL,calls,root,secrets}=await fixture(true,undefined,{'gpt-a':'responses','claude-b':'messages','chat-only':'chat/completions'});
 const added=await service.app.inject({method:'POST',url:'/api/sources/quick',headers,payload:{name:'Mixed gateway',baseURL:`${baseURL}/responses`,apiKey:'mixed-private-key',model:'gpt-a,claude-b,chat-only'}});
 expect(added.statusCode,added.body).toBe(200);const source=added.json();
 expect(source.modelRoutes).toEqual({'gpt-a':{protocol:'responses',baseURL},'claude-b':{protocol:'messages',baseURL},'chat-only':{protocol:'chat',baseURL}});
 expect(calls.filter(c=>c.body.model==='gpt-a').map(c=>c.path)).toEqual(['/v1/responses']);
 expect(calls.filter(c=>c.body.model==='claude-b').map(c=>c.path)).toEqual(['/v1/responses','/v1/messages']);
 expect(calls.filter(c=>c.body.model==='chat-only').map(c=>c.path)).toEqual(['/v1/responses','/v1/chat/completions']);
 expect((await service.app.inject({url:'/api/sources',headers})).json().sources).toHaveLength(1);
 const config=await readFile(join(root,'cliproxy/config.yaml'),'utf8');
 for(const [field,model] of [['codex-api-key','gpt-a'],['claude-api-key','claude-b'],['openai-compatibility','chat-only']]){
  const entries=JSON.parse(config.split('\n').find(line=>line.startsWith(field+': '))!.slice(field.length+2));
  expect(entries.flatMap((entry:any)=>entry.models.map((m:any)=>m.name))).toEqual([model]);
 }
 const models=source.models.map((m:string)=>apiModelID(source.id,m));
 for(const model of models)await expect.poll(()=>service.proxy.apiModelAvailable(model),{timeout:10000}).toBe(true);
 const key=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'Mixed client',sourceId:source.id,models,tokenLimit:200}});expect(key.statusCode,key.body).toBe(200);
 const client={...headers,authorization:`Bearer ${key.json().apiKey}`};calls.length=0;
 for(const [index,upstream] of source.models.entries()){
  const response=await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model:models[index],input:'Hi',stream:false}});
  expect(response.statusCode,response.body).toBe(200);expect(response.body).toContain('mixed-private-key');
  const call=calls.at(-1)!;expect(call.body.model).toBe(upstream);
  expect(new URL(call.path,baseURL).pathname).toBe(upstream==='claude-b'?'/v1/messages':upstream==='chat-only'?'/v1/chat/completions':'/v1/responses');
  expect(call.key).toBe(upstream==='claude-b'?'mixed-private-key':'Bearer mixed-private-key');
 }
 const native=await service.app.inject({method:'POST',url:'/v1/messages',headers:{...client,'anthropic-version':'2023-06-01'},payload:{model:models[1],messages:[{role:'user',content:'Hi'}],max_tokens:16}});
 expect(native.statusCode,native.body).toBe(200);expect(native.json().type).toBe('message');
 const reopened=await ApiSources.open(root,secrets,defaultProvider);cleanup.push(()=>reopened.close());expect((await reopened.list())[0].modelRoutes).toEqual(source.modelRoutes);
 await reopened.save({name:'Renamed',baseURL,protocol:source.protocol,enabled:false,models:source.models},source.id);
 expect((await reopened.list())[0].modelRoutes).toEqual(source.modelRoutes);
 await reopened.save({name:'Trimmed',baseURL,protocol:source.protocol,models:['gpt-a']},source.id);
 expect((await reopened.list())[0].modelRoutes).toEqual({'gpt-a':source.modelRoutes['gpt-a']});
});

it('does not partially save model routes or a replacement key when one model fails validation',async()=>{
 const {service,headers,baseURL,root,secrets}=await fixture(false,undefined,{'bad-model':'unsupported'});
 const added=await service.app.inject({method:'POST',url:'/api/sources/quick',headers,payload:{baseURL,apiKey:'original-mixed-key',model:'shared'}});
 expect(added.statusCode,added.body).toBe(200);const source=added.json();const before=await readFile(join(root,'api-sources.json'),'utf8');
 const failed=await service.app.inject({method:'POST',url:'/api/sources/quick',headers,payload:{id:source.id,baseURL,apiKey:'replacement-mixed-key',model:'shared,bad-model'}});
 expect(failed.statusCode,failed.body).toBe(400);expect(failed.json().error).toContain('bad-model');expect(failed.json().error).not.toContain('replacement-mixed-key');
 expect(await readFile(join(root,'api-sources.json'),'utf8')).toBe(before);
 const reopened=await ApiSources.open(root,secrets,defaultProvider);cleanup.push(()=>reopened.close());expect(await reopened.keyFor(source.id)).toBe('original-mixed-key');
});

it('revalidates unchanged models on explicit verification and uses each route for offline repair eligibility',async()=>{
 const {service,headers,baseURL,calls}=await fixture(false,undefined,{'claude-b':'messages','gpt-a':'responses'});
 const added=await service.app.inject({method:'POST',url:'/api/sources/quick',headers,payload:{name:'Mixed repair',baseURL,apiKey:'mixed-repair-key',model:'claude-b,gpt-a'}});
 expect(added.statusCode,added.body).toBe(200);const source=added.json();expect(source.protocol).toBe('messages');
 calls.length=0;
 const verified=await service.app.inject({method:'POST',url:'/api/sources/quick',headers,payload:{id:source.id,name:source.name,baseURL:source.baseURL,model:source.models.join(',')}});
 expect(verified.statusCode,verified.body).toBe(200);expect(new Set(calls.map(c=>c.body.model))).toEqual(new Set(source.models));
 await service.proxy.stop();
 const rejected=await service.app.inject({method:'PUT',url:'/api/maintenance',headers,payload:{sourceId:source.id,model:apiModelID(source.id,'claude-b'),channel:'direct'}});
 expect(rejected.statusCode,rejected.body).toBe(409);
 const accepted=await service.app.inject({method:'PUT',url:'/api/maintenance',headers,payload:{sourceId:source.id,model:apiModelID(source.id,'gpt-a'),channel:'direct'}});
 expect(accepted.statusCode,accepted.body).toBe(200);
 expect((await service.app.inject({method:'POST',url:'/api/maintenance/check',headers,payload:{}})).statusCode).toBe(200);await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().readiness.status).toBe('ready');
 expect(calls.at(-1)).toMatchObject({path:'/v1/responses',key:'Bearer mixed-repair-key',body:{model:'gpt-a'}});
});

it('forwards a model to its detected custom base path rather than the source default',async()=>{
 const paths:string[]=[];
 const upstream=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);paths.push(req.url!);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({type:'message',id:'custom-message',role:'assistant',model:body.model,content:[{type:'text',text:'OK'}],usage:{input_tokens:1,output_tokens:1},stop_reason:'end_turn'}));
 });
 await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>upstream.close(()=>r())));
 const {service,headers,baseURL}=await fixture();const customBase=`http://127.0.0.1:${(upstream.address() as {port:number}).port}/company/anthropic/v1`;
 const added=await service.app.inject({method:'POST',url:'/api/sources',headers,payload:{name:'Custom model paths',baseURL,apiKey:'custom-model-key',protocol:'responses',models:['shared','custom-claude'],modelRoutes:{'custom-claude':{protocol:'messages',baseURL:customBase}}}});
 expect(added.statusCode,added.body).toBe(200);const source=added.json();
 const response=await service.app.inject({method:'POST',url:'/v1/messages',headers,payload:{model:apiModelID(source.id,'custom-claude'),messages:[{role:'user',content:'Hi'}],max_tokens:16}});
 expect(response.statusCode,response.body).toBe(200);expect(response.json().type).toBe('message');expect(paths).toEqual(['/company/anthropic/v1/messages']);
});

it('removes blank text blocks from replayed GPT history before sending it to a strict Messages source',async()=>{
 const {service,headers,add,calls}=await fixture(true,undefined,{},true);const source=await add('Strict Claude','strict-claude-key','messages');const model=apiModelID(source.id,'shared');
 await expect.poll(()=>service.proxy.apiModelAvailable(model),{timeout:10000}).toBe(true);
 const response=await service.app.inject({method:'POST',url:'/v1/responses',headers,payload:{model,input:[{role:'user',content:'Remember MAPLE'},{role:'assistant',content:[{type:'output_text',text:' '},{type:'output_text',text:'GPT reply'}]},{role:'user',content:'What word?'}],max_output_tokens:32}});
 expect(response.statusCode,response.body).toBe(200);
 const messages=calls.at(-1)!.body.messages as any[];
 expect(messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='text').every(p=>p.text.trim())).toBe(true);
 expect(JSON.stringify(messages)).toContain('GPT reply');expect(JSON.stringify(messages)).toContain('MAPLE');
});

it('cleans only invalid Messages text blocks while keeping tool results, signatures and meaningful spacing',()=>{
 const tool={type:'tool_result',tool_use_id:'call',content:[{type:'text',text:' '}]};
 const thinking={type:'thinking',thinking:'reasoning',signature:'provider-signature'};
 const body={model:'claude',max_tokens:128,system:[{type:'text',text:' \n'}],messages:[{role:'assistant',content:[{type:'text',text:' '},{type:'text',text:' preserved '},thinking]},{role:'user',content:[tool]}]};
 const original=structuredClone(body);const cleaned=genericMessagesBody(body);
 expect(cleaned.system).toBeUndefined();expect(cleaned.max_tokens).toBe(128);
 expect(cleaned.messages).toEqual([{role:'assistant',content:[{type:'text',text:' preserved '},thinking]},{role:'user',content:[tool]}]);
 expect(body).toEqual(original);
});

it('exports the saved API source name and platform model label through Agent menus and model discovery',async()=>{
 const {service,headers,add,root}=await fixture();const source=await add('🍋 公司接口','fixture-export-key');const model=apiModelID(source.id,'shared');
 const local=(await service.app.inject({url:'/api/local-agent',headers})).json();
 expect(local.models.find((m:{id:string})=>m.id===model)?.displayName).toBe('🍋 公司接口 · shared');
 const target=(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:{id:string})=>t.id==='claude');
 const connected=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target:'claude',sourceId:source.id,model,selections:[{sourceId:source.id,model}],revision:target.revision}});
 expect(connected.statusCode,connected.body).toBe(200);
 const config=JSON.parse(await readFile(join(root,'claude/settings.json'),'utf8'));
 expect(config.modelPicker.options).toEqual([{model,label:'🍋 公司接口 · shared'}]);
 const listed=await service.app.inject({url:'/v1/models',headers:{...headers,authorization:`Bearer ${config.env.ANTHROPIC_AUTH_TOKEN}`}});
 expect(listed.statusCode,listed.body).toBe(200);expect(listed.json().data.find((m:{id:string})=>m.id===model)).toMatchObject({id:model,name:'🍋 公司接口 · shared',display_name:'🍋 公司接口 · shared'});
});


it.each(['messages','chat','responses'] as const)('removes the exact help notice at gateway ingress for a native %s API source',async protocol=>{
 const {service,headers,add,calls}=await fixture();
 const source=await add('Gateway notice normalization','notice-fixture-key',protocol);
 const model=apiModelID(source.id,'shared');
 const created=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'ordinary gateway client',sourceId:source.id,models:[model]}});
 expect(created.statusCode,created.body).toBe(200);
 const client={...headers,authorization:`Bearer ${created.json().apiKey}`};
 const user={role:'user',content:`User data ${gatewayHelpNotice}`};
 const tools=protocol==='messages'?[{name:'read',description:gatewayHelpNotice,input_schema:{type:'object',properties:{}}}]:[{type:'function',...(protocol==='chat'?{function:{name:'read',description:gatewayHelpNotice,parameters:{type:'object',properties:{}}}}:{name:'read',description:gatewayHelpNotice,parameters:{type:'object',properties:{}}})}];
 const payload=protocol==='messages'?{model,max_tokens:64,system:`RULES\n${gatewayHelpNotice}END`,messages:[user],tools}:protocol==='chat'?{model,messages:[{role:'system',content:`RULES\n${gatewayHelpNotice}END`},{role:'developer',content:`OTHER\n${gatewayHelpNotice}END`},user],tools}:{model,instructions:`RULES\n${gatewayHelpNotice}END`,input:[{role:'developer',content:[{type:'input_text',text:`OTHER\n${gatewayHelpNotice}END`}]},user],tools};
 const result=await service.app.inject({method:'POST',url:`/v1/${protocol==='chat'?'chat/completions':protocol}`,headers:client,payload});
 expect(result.statusCode,result.body).toBe(200);
 expect(result.headers['x-token-flow-compatibility']).toBe('claude-code-help-v1');
 const sent=calls.at(-1)!.body as any;
 if(protocol==='messages')expect(sent.system).toBe('RULES\nEND');
 else if(protocol==='chat'){expect(sent.messages[0].content).toBe('RULES\nEND');expect(sent.messages[1].content).toBe('OTHER\nEND');}
 else {expect(sent.instructions).toBe('RULES\nEND');expect(sent.input[0].content[0].text).toBe('OTHER\nEND');}
 expect((protocol==='responses'?sent.input:sent.messages).at(-1)).toEqual(user);
 expect(sent.tools).toEqual(tools);
});
