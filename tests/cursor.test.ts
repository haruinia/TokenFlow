import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,rm,writeFile,readFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {createServer} from 'node:net';
import {CursorProvider,parseCursorInput} from '../packages/core/src/cursor.js';
import {createDesktopService} from '../packages/core/src/service.js';
it('accepts a large client catalog and preserves union schemas while retaining a bounded limit',()=>{
 const parameters={anyOf:[{type:'object',properties:{path:{type:'string'}}},{type:'object',properties:{id:{type:'number'}}}]};
 const tools=Array.from({length:301},(_,i)=>({type:'function',name:`tool_${i}`,parameters}));
 const input=parseCursorInput('responses',{model:'cursor/test',input:'hello',tools});
 expect(input.tools).toHaveLength(301);expect(input.tools[300].parameters).toEqual(parameters);
 expect(()=>parseCursorInput('responses',{model:'cursor/test',input:'hello',tools:Array.from({length:2049},(_,i)=>({...tools[0],name:`tool_${i}`}))})).toThrow();
});
const sdk=vi.hoisted(()=>({login:vi.fn(),models:vi.fn(),create:vi.fn(),cancel:vi.fn(),close:vi.fn(),quota:vi.fn(),runUsage:vi.fn(),localSession:vi.fn(),localCreate:vi.fn()}));
vi.mock('../packages/core/src/cursor-local.js',async importOriginal=>({...await importOriginal<typeof import('../packages/core/src/cursor-local.js')>(),localCursorSession:sdk.localSession}));
vi.mock('../packages/core/src/cursor-usage.js',()=>({CursorUsage:class{quota=sdk.quota;runUsage=sdk.runUsage;}}));
vi.mock('@cursor/sdk',()=>({Cursor:{auth:{login:sdk.login},models:{list:sdk.models}},Agent:{create:sdk.create},JsonlLocalAgentStore:class{constructor(readonly path:string){}}}));
const cleanup:Array<()=>Promise<unknown>>=[];afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.restoreAllMocks();});
beforeEach(async()=>{
 // Resolve the mocked dynamic module before concurrent account catalog loads.
 await import('@cursor/sdk');
 sdk.localSession.mockResolvedValue({email:'native@example.test',createCredential:sdk.localCreate});sdk.localCreate.mockResolvedValue({apiKey:'native-fixture-key',email:'native@example.test',disabled:false});
 vi.clearAllMocks();sdk.quota.mockResolvedValue({plan:'Pro',windows:[]});sdk.runUsage.mockResolvedValue(undefined);sdk.login.mockImplementation(async(options)=>{options.onLoginUrl('https://cursor.com/loginDeepControl?uuid=fixture&challenge=fixture');return {apiKey:'cursor-secret-fixture',email:'cursor@example.test',apiKeyExpiresAtMs:Date.now()+86400000};});
 sdk.models.mockResolvedValue([{id:'fixture-model',displayName:'Fixture model'}]);sdk.cancel.mockResolvedValue(undefined);
 sdk.create.mockResolvedValue({close:sdk.close,send:async()=>({cancel:sdk.cancel,wait:async()=>({status:'finished',result:'Cursor fixture reply',usage:{inputTokens:7,outputTokens:3,cacheReadTokens:2,cacheWriteTokens:1,totalTokens:13}})})});
});
it('imports the native account alongside the existing account, deduplicates, persists both, and routes by account ID',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'original-fixture-key',email:'original@example.test'}));
 const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();const originalId=provider.id!;await provider.importLocal();await provider.importLocal();expect(sdk.localCreate).toHaveBeenCalledOnce();
 const snapshot=provider.snapshot();expect(snapshot.accounts).toHaveLength(2);expect(snapshot.accounts[0].id).toBe(originalId);expect(JSON.stringify(snapshot)).not.toContain('fixture-key');
 const nativeId=snapshot.accounts.find(a=>a.label==='native@example.test')!.id;
 for(const [id,key] of [[originalId,'original-fixture-key'],[nativeId,'native-fixture-key']]){await provider.response('messages',{model:'cursor/fixture-model',messages:[{role:'user',content:'hello'}]},new AbortController().signal,id);expect(sdk.create.mock.lastCall![0].apiKey).toBe(key);}
 const reopened=new CursorProvider(root,secrets);cleanup.push(()=>reopened.close());await reopened.load();expect(reopened.snapshot().accounts.map(a=>a.id)).toEqual(snapshot.accounts.map(a=>a.id));await reopened.setEnabled(false,nativeId);expect(reopened.snapshot().accounts.find(a=>a.id===originalId)?.disabled).toBe(false);expect(()=>reopened.assertSource(nativeId,'cursor/fixture-model')).toThrow();await reopened.remove(nativeId);expect(reopened.snapshot().accounts.map(a=>a.id)).toEqual([originalId]);
});
async function setup(){const root=await mkdtemp(join(await realpath(tmpdir()),'cursor-test-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));const values=new Map<string,string>();const secrets={get:async(name:string)=>values.get(name)??'',set:async(name:string,value:string)=>{values.set(name,value);}};return {root,values,secrets};}
it('uses official login with independent credentials, discovers real account models and keeps secrets out of snapshots',async()=>{
 const {root,values,secrets}=await setup();const opened:string[]=[];const provider=new CursorProvider(root,secrets,async url=>{opened.push(url);});await provider.load();await provider.beginLogin();await expect.poll(()=>provider.snapshot().login?.status).toBe('completed');
 expect(opened[0]).toMatch(/^https:\/\/cursor.com\/loginDeepControl/);expect(sdk.login.mock.calls[0][0]).toMatchObject({store:null,backendUrl:'https://api2.cursor.sh',apiKeyName:'token-flow'});
 expect(values.get('cursor-account')).toContain('cursor-secret-fixture');expect(JSON.stringify(provider.snapshot())).not.toContain('cursor-secret-fixture');expect(provider.snapshot().models[0].id).toBe('cursor/fixture-model');
 const reopened=new CursorProvider(root,secrets);await reopened.load();expect(reopened.snapshot().accounts[0].id).toBe(provider.id);await reopened.setEnabled(false);expect(reopened.snapshot().models).toEqual([]);expect(values.get('cursor-account')).toContain('cursor-secret-fixture');await reopened.remove();expect(values.get('cursor-account')).toBe('');
});
it('does not save credentials from a cancelled login, including late SDK completion',async()=>{
 const {root,values,secrets}=await setup();let complete!:(value:unknown)=>void;sdk.login.mockImplementation(options=>{options.onLoginUrl('https://cursor.com/loginDeepControl?uuid=test');return new Promise(r=>{complete=r;});});
 const provider=new CursorProvider(root,secrets);await provider.beginLogin();await expect.poll(()=>provider.snapshot().login?.status).toBe('waiting_for_browser');provider.cancelLogin(provider.snapshot().login!.id);complete({apiKey:'must-not-save'});await provider.close();expect(values.size).toBe(0);expect(provider.snapshot().accounts).toEqual([]);
});
it('routes Cursor through the existing scoped API, meters tokens, isolates SDK tools, and denies unsupported server tools',async()=>{
 // Synthetic credentials must not reach the real REST catalog during a fallback.
 const originalFetch=globalThis.fetch;vi.spyOn(globalThis,'fetch').mockImplementation((url,init)=>String(url)==='https://api.cursor.com/v1/models'?Promise.resolve(Response.json({items:[{id:'fixture-model',displayName:'Fixture model'}]})):originalFetch(url,init));
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({version:1,accounts:[{apiKey:'cursor-secret-fixture',disabled:false},{apiKey:'second-cursor-fixture',email:'second@example.test',disabled:false}]}));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));await mkdir(join(root,'cliproxy'));await writeFile(join(root,'cliproxy','fixture-accounts.json'),'[]');
 const service=await createDesktopService({root,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),proxyPort:port,token:'admin-token',localKey:'internal-key',secrets});cleanup.push(()=>service.app.close());await service.proxy.start();await service.proxy.cursor.refresh();expect(service.proxy.snapshot().accounts.filter(a=>a.provider==='cursor'&&a.models?.includes('cursor/fixture-model')).length,JSON.stringify(service.proxy.cursor.snapshot().accounts)).toBe(2);
 const admin={host:'127.0.0.1:9527',authorization:'Bearer admin-token'};const account=service.proxy.snapshot().accounts[0];
 const created=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:admin,payload:{name:'Cursor caller',models:['cursor/fixture-model'],sourceId:account.id,tokenLimit:100}});expect(created.statusCode,created.body).toBe(200);const client={host:admin.host,authorization:`Bearer ${created.json().apiKey}`};
 expect((await service.app.inject({url:'/v1/models',headers:client})).json().data[0].id).toBe('cursor/fixture-model');
 for(const path of ['responses','chat/completions','messages']){
  const result=await service.app.inject({method:'POST',url:`/v1/${path}`,headers:client,payload:{model:'cursor/fixture-model',...(path==='responses'?{input:'Hello'}:{messages:[{role:'user',content:'Hello'}]}),stream:true}});expect(result.statusCode,result.body).toBe(200);expect(result.body).toContain('Cursor fixture reply');
 }
 const keys=(await service.app.inject({url:'/api/gateway-keys',headers:admin})).json().keys;expect(keys[0].usedTokens).toBe(39);expect(keys[0].unmeteredRequests).toBe(0);
 const options=sdk.create.mock.calls[0][0];expect(options).toMatchObject({tools:[],mcpServers:{},agents:{},local:{settingSources:[]}});expect(options.local.cwd.startsWith(join(root,'cursor-runs'))).toBe(true);expect(sdk.close).toHaveBeenCalledTimes(3);
 const denied=await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model:'cursor/fixture-model',input:'Read private files',tools:[{type:'web_search'}]}});expect(denied.statusCode).toBe(400);expect(denied.body).toContain('服务端工具');expect(sdk.create).toHaveBeenCalledTimes(3);
 const failedTrace=(await service.app.inject({url:'/api/gateway/traces',headers:admin})).json().records.find((record:{status:number})=>record.status===400);expect(failedTrace.error).toMatchObject({code:'cursor_invalid_request',message:expect.stringContaining('tools.0')});
 const other=service.proxy.snapshot().accounts.find(a=>a.id!==account.id)!;const otherCreated=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:admin,payload:{name:'Second account',models:['cursor/fixture-model'],sourceId:other.id,tokenLimit:100}});expect(otherCreated.statusCode,otherCreated.body).toBe(200);const otherKey=otherCreated.json();
 const routed=await service.app.inject({method:'POST',url:'/v1/messages',headers:{...admin,authorization:`Bearer ${otherKey.apiKey}`},payload:{model:'cursor/fixture-model',messages:[{role:'user',content:'Bound account'}]}});expect(routed.statusCode).toBe(200);expect(sdk.create.mock.lastCall![0].apiKey).toBe('second-cursor-fixture');
 await service.proxy.setAccountEnabled(account.id,false);expect((await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model:'cursor/fixture-model',input:'hi'}})).statusCode).toBe(503);
 const imported=await service.app.inject({method:'POST',url:'/api/local-agent/import-local/cursor',headers:admin,payload:{}});expect(imported.statusCode,imported.body).toBe(200);expect(service.proxy.cursor.snapshot().accounts).toHaveLength(3);expect(sdk.localCreate).toHaveBeenCalledOnce();expect(imported.body).not.toContain('native-fixture-key');
 sdk.localSession.mockResolvedValue({email:'NATIVE@example.test',createCredential:sdk.localCreate});await service.proxy.cursor.importLocal();expect(service.proxy.cursor.snapshot().accounts).toHaveLength(3);expect(sdk.localCreate).toHaveBeenCalledOnce();
});
it('exposes explicit text API limits',()=>{
 for(const body of [{input:[{role:'user',content:[{type:'input_image',image_url:'x'}]}]},{input:'hi',previous_response_id:'old'},{input:'hi',text:{format:{type:'json_schema'}}}])expect(()=>parseCursorInput('responses',{model:'cursor/x',...body})).toThrow();
});
it('forwards historical tool-result images through the SDK without losing tool identity or treating tool arguments as attachments',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();
 const data='aW1hZ2UtYnl0ZXM=',send=vi.fn().mockResolvedValue({cancel:sdk.cancel,wait:async()=>({status:'finished',result:'OK'})});
 sdk.create.mockResolvedValue({close:sdk.close,send});
 const body={model:'cursor/fixture-model',messages:[
  {role:'assistant',content:[{type:'tool_use',id:'read-image',name:'Read',input:{example:{type:'image',source:{type:'base64',media_type:'image/jpeg',data:'keep-as-argument'}}}}]},
  {role:'user',content:[{type:'tool_result',tool_use_id:'read-image',content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data}}]}]},
  {role:'user',content:'Continue'},
 ]};
 const response=await provider.response('messages',body,new AbortController().signal);expect(response.status).toBe(200);
 const input=send.mock.calls[0][0];expect(input.images).toEqual([{data,mimeType:'image/jpeg'}]);expect(input.text).toContain('read-image');expect(input.text).toContain('[Attached image 1]');expect(input.text).not.toContain(data);expect(input.text).toContain('keep-as-argument');
});
it('preserves attachment order across Responses tool outputs and Chat image URLs',()=>{
 const model='cursor/fixture-model',data='aW1hZ2U=',url='https://images.example.test/image.png';
 const response=parseCursorInput('responses',{model,input:[
  {type:'function_call_output',call_id:'prior-read',output:[{type:'input_image',image_url:`data:image/png;base64,${data}`}]},
  {role:'user',content:[{type:'input_image',image_url:url},{type:'input_text',text:'Compare both'}]},
 ]});
 expect(response.images).toEqual([{data,mimeType:'image/png'},{url}]);expect(response.prompt).toContain('prior-read');expect(response.prompt).toContain('[Attached image 2]');expect(response.prompt).not.toContain(data);
 const chat=parseCursorInput('chat/completions',{model,messages:[{role:'user',content:[{type:'image_url',image_url:{url}},{type:'text',text:'Describe'}]}]});
 expect(chat.images).toEqual([{url}]);expect(chat.prompt).toContain('Describe');
});
it('continues Claude tool history containing provider thinking and discovered tool references',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();
 const request={model:'cursor/fixture-model',messages:[
  {role:'assistant',content:[{type:'thinking',thinking:'private prior reasoning',signature:'provider-signature'},{type:'redacted_thinking',data:'opaque-provider-data'},{type:'tool_use',id:'discover-1',name:'ToolSearch',input:{query:'lookup'}}]},
  {role:'user',content:[{type:'tool_result',tool_use_id:'discover-1',content:[{type:'tool_reference',tool_name:'client_lookup'},{type:'text',text:'Tool ready'}]}]},
  {role:'user',content:'Continue with the discovered tool'},
 ],tools:[{name:'client_lookup',input_schema:{type:'object',properties:{}}}]};
 const response=await provider.response('messages',request,new AbortController().signal);
 expect(response.status,await response.clone().text()).toBe(200);
 const parsed=parseCursorInput('messages',request);
 expect(parsed.prompt).toContain('discover-1');expect(parsed.prompt).toContain('client_lookup');expect(parsed.prompt).toContain('Tool ready');
 expect(parsed.prompt).not.toContain('private prior reasoning');expect(parsed.prompt).not.toContain('provider-signature');expect(parsed.prompt).not.toContain('opaque-provider-data');
});
it('reports only safe schema fields for unsupported Cursor requests before any network call',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();
 const response=await provider.response('messages',{model:'cursor/fixture-model',messages:[{role:'user',content:[{type:'document',source:{type:'url',url:'https://private.example/secret'}}]}]},new AbortController().signal);
 expect(response.status).toBe(400);const text=await response.text();const result=JSON.parse(text);
 expect(result.error).toMatchObject({code:'cursor_invalid_request',fields:['messages.0.content']});expect(text).not.toContain('private.example');expect(sdk.create).not.toHaveBeenCalled();
});
it('explains unsupported Desktop auto-permission safeguards without dropping them or calling the SDK',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();
 const response=await provider.response('messages',{model:'cursor/fixture-model',messages:[{role:'user',content:'Hi'}],safeguards:[{type:'dangerous_tool_use',classifier_context:{private:'never expose'}}]},new AbortController().signal);
 expect(response.status).toBe(400);const data=await response.json();
 expect(data.error).toMatchObject({code:'cursor_safeguards_unsupported',fields:['safeguards']});
 expect(data.error.message).toContain('逐次');
 expect(JSON.stringify(data)).not.toContain('never expose');expect(sdk.create).not.toHaveBeenCalled();
});
it.each([
 [new TypeError('private network detail'),'cursor_network_error'],
 [Object.assign(new Error('private timeout detail'),{code:'deadline_exceeded'}),'cursor_timeout'],
 [Object.assign(new Error('private quota detail'),{status:429}),'cursor_rate_limited'],
])('retains a safe upstream failure category across Cursor responses (%s)',async(error,code)=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();
 sdk.create.mockRejectedValue(error);
 const response=await provider.response('responses',{model:'cursor/fixture-model',input:'hello'},new AbortController().signal);
 expect(response.status).toBe(502);const text=await response.text();expect(JSON.parse(text).error.code).toBe(code);expect(text).not.toContain('private');
});
it('accepts Claude Code adaptive thinking and context hints without claiming native Anthropic thinking support',()=>{
 const value=parseCursorInput('messages',{model:'cursor/grok-4.6',messages:[{role:'user',content:'continue'}],thinking:{type:'adaptive'},context_management:{edits:[{type:'clear_thinking_20251015',keep:'all'}]},output_config:{effort:'low'}});
 expect(value.effort).toBe('low');expect(value.prompt).toContain('continue');
 expect(()=>parseCursorInput('messages',{model:'cursor/grok-4.6',messages:[{role:'user',content:'hi'}],output_config:{format:{type:'json_schema',schema:{}}}})).toThrow();
});

const tokenUsage={inputTokens:7,outputTokens:3,cacheReadTokens:2,cacheWriteTokens:1,totalTokens:13};
it('settles the exact agent against the official bill even when SDK usage already reports a smaller visible output',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();
 sdk.create.mockResolvedValue({agentId:'exact-billed-agent',close:sdk.close,send:async()=>({wait:async()=>({status:'finished',result:'OK',usage:{inputTokens:2000,outputTokens:5,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:2005}}),cancel:sdk.cancel})});
 sdk.runUsage.mockResolvedValue({inputTokens:2000,outputTokens:29,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:2029});
 const result=await provider.response('responses',{model:'cursor/fixture-model',input:'OK'},new AbortController().signal);
 expect((await result.json()).usage).toMatchObject({input_tokens:2000,output_tokens:29,total_tokens:2029});expect(sdk.runUsage).toHaveBeenCalledWith('exact-billed-agent',expect.any(Number),expect.any(AbortSignal));
});
function toolRun(hasUsage=true){
 sdk.create.mockImplementation(async options=>({agentId:'agent-fixture',close:sdk.close,send:async()=>{
  let finish!:(value:unknown)=>void;
  const pending=new Promise(resolve=>{finish=resolve;});
  return {agentId:'agent-fixture',usage:hasUsage?tokenUsage:undefined,cancel:async()=>{sdk.cancel();finish({status:'cancelled',usage:hasUsage?tokenUsage:undefined});},wait:()=>{
   void options.local.customTools.client_0.execute({value:'ping'},{});
   return pending;
  }};
 }}));
}
it.each(['responses','chat/completions','messages'])('hands tools to the %s client and accepts the next tool-result turn',async path=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);await provider.load();
 toolRun();const model='cursor/fixture-model';
 const fn={name:'client_echo',description:'Echo input',parameters:{type:'object',properties:{value:{type:'string'}},required:['value']}};
 const tools=path==='responses'?[{type:'function',...fn}]:path==='messages'?[{name:fn.name,description:fn.description,input_schema:fn.parameters}]:[{type:'function',function:fn}];
 const body={model,tools,...(path==='responses'?{input:'Echo ping',max_output_tokens:64}:{messages:[{role:'user',content:'Echo ping'}],max_tokens:64})};
 const response=await provider.response(path,body,new AbortController().signal);expect(response.status).toBe(200);const result=await response.json();
 const call=path==='responses'?result.output[0]:path==='messages'?result.content[0]:result.choices[0].message.tool_calls[0];
 expect(path==='chat/completions'?call.function.name:call.name).toBe('client_echo');
 expect(sdk.create.mock.calls[0][0]).toMatchObject({tools:['mcp'],mcpServers:{},agents:{},local:{settingSources:[]}});
 expect(sdk.cancel).toHaveBeenCalledOnce();expect(response.headers.get('X-Token-Flow-Output-Limit')).toContain('advisory');
 const history=path==='responses'?[{role:'user',content:'Echo ping'},...result.output,{type:'function_call_output',call_id:call.call_id,output:'pong'}]:path==='messages'?[{role:'assistant',content:result.content},{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'pong'}]}]:[result.choices[0].message,{role:'tool',tool_call_id:call.id,content:'pong'}];
 let prompt='';sdk.create.mockResolvedValue({close:sdk.close,send:async(value:string)=>{prompt=value;return {wait:async()=>({status:'finished',result:'pong',usage:tokenUsage}),cancel:sdk.cancel};}});
 const next=await provider.response(path,{...body,...(path==='responses'?{input:history}:{messages:history}),stream:true},new AbortController().signal);
 expect(next.status).toBe(200);expect(await next.text()).toContain('pong');expect(prompt).toContain('pong');expect(prompt).toContain(call.call_id??call.id);
 await provider.close();
});
it('recovers model discovery using the official catalog without guessed models, and preserves last-known models on transient failure',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'private-fixture'}));sdk.models.mockRejectedValue(new TypeError('secret upstream details'));
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({items:[{id:'returned-model',displayName:'Returned model'}]}));
 const provider=new CursorProvider(root,secrets);await provider.load();expect(provider.snapshot().models[0].id).toBe('cursor/returned-model');expect(fetcher.mock.calls[0][0]).toBe('https://api.cursor.com/v1/models');expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
 fetcher.mockRejectedValue(new TypeError('private-fixture'));await provider.refresh();expect(provider.snapshot().models).toHaveLength(1);expect(provider.snapshot().accounts[0].modelError).toContain('网络');expect(JSON.stringify(provider.snapshot())).not.toContain('private-fixture');
 sdk.models.mockRejectedValue(Object.assign(new Error('private-fixture'),{status:401}));await provider.refresh();expect(provider.snapshot().models).toEqual([]);expect(provider.snapshot().accounts[0].modelError).toContain('重新连接');
});
it('connects Cursor to all local Agent targets and routes maintenance through the SDK instead of the sidecar',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 await mkdir(join(root,'cliproxy'));await writeFile(join(root,'cliproxy','fixture-accounts.json'),'[]');
 const paths={codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),qoder:join(root,'qoder/settings.json'),workbuddy:join(root,'workbuddy/models.json')};
 const service=await createDesktopService({root,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),proxyPort:port,token:'admin-token',localKey:'internal',secrets,agentPaths:paths,agentProcesses:async()=>[]});cleanup.push(()=>service.app.close());await service.proxy.start();await expect.poll(()=>service.proxy.snapshot().models.length).toBe(1);
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin-token'};const sourceId=service.proxy.cursor.id!;const model='cursor/fixture-model';
 for(const target of ['codex','claude','qoder','workbuddy']){
  const state=(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:{id:string})=>t.id===target);
  const connected=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target,sourceId,model,revision:state.revision}});
  expect(connected.statusCode,connected.body).toBe(200);expect(connected.json().verification.checks.every((c:{ok:boolean})=>c.ok)).toBe(true);
  const written=await readFile(paths[target as keyof typeof paths],'utf8');if(target==='workbuddy')expect(JSON.parse(written)).toMatchObject([{id:'cursor/Fixture-model',name:'cursor/Fixture-model'}]);else expect(written).toContain(model);
 }
 const selected=await service.app.inject({method:'PUT',url:'/api/maintenance',headers,payload:{sourceId,model}});expect(selected.statusCode,selected.body).toBe(200);
 expect(selected.json().readiness.status).toBe('unchecked');
 expect((await service.app.inject({method:'POST',url:'/api/maintenance/check',headers,payload:{}})).statusCode).toBe(200);
 await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().readiness.status).toBe('ready');
 expect(sdk.create).toHaveBeenCalled();
});
it('reports plan_required without retrying a denied catalog or presenting endless sync',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));
 sdk.models.mockRejectedValue(Object.assign(new Error('private upstream'),{status:403,code:'plan_required'}));
 const fetcher=vi.spyOn(globalThis,'fetch');const provider=new CursorProvider(root,secrets);await provider.load();
 expect(fetcher).not.toHaveBeenCalled();expect(provider.snapshot().accounts[0]).toMatchObject({status:'模型同步失败',modelError:expect.stringContaining('plan_required')});expect(provider.snapshot().models).toEqual([]);
});
it('supports Responses custom text tools and keeps their text results in the next turn',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);await provider.load();
 sdk.create.mockImplementation(async options=>({agentId:'agent-fixture',close:sdk.close,send:async()=>{
  let finish!:(value:unknown)=>void;const pending=new Promise(resolve=>{finish=resolve;});
  return {cancel:async()=>finish({status:'cancelled',usage:tokenUsage}),wait:()=>{void options.local.customTools.client_0.execute({input:'*** Begin Patch\n*** End Patch'},{});return pending;}};
 }}));
 const body={model:'cursor/fixture-model',input:'Prepare a patch',tools:[{type:'custom',name:'apply_patch',description:'Apply a patch',format:{type:'text'}}],tool_choice:{type:'custom',name:'apply_patch'}};
 const response=await provider.response('responses',body,new AbortController().signal);const result=await response.json();expect(response.status).toBe(200);expect(result.output[0].id).toMatch(/^ctc_/);expect(result.output[0]).toMatchObject({type:'custom_tool_call',name:'apply_patch',input:'*** Begin Patch\n*** End Patch'});
 const next=parseCursorInput('responses',{...body,input:[...result.output,{type:'custom_tool_call_output',call_id:result.output[0].call_id,output:'Applied'}]});expect(next.prompt).toContain('Applied');
});
it('lets the real Pi Responses client consume the streamed tool call',async()=>{
 const {streamSimple}=await import('@earendil-works/pi-ai/api/openai-responses');const {normalizeContext}=await import('@earendil-works/pi-ai/utils/transcript');const {Type}=await import('typebox');
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);await provider.load();toolRun();
 const model={id:'cursor/fixture-model',name:'Fixture',api:'openai-responses' as const,provider:'token-flow',baseUrl:'http://127.0.0.1:8317/v1',reasoning:false,input:['text' as const],contextWindow:32768,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 const transport:typeof fetch=async(input,init)=>{const request=new Request(input,init);return provider.response('responses',await request.json(),request.signal);};
 const events=streamSimple(model,normalizeContext({messages:[{role:'user',content:'Echo ping',timestamp:Date.now()}],tools:[{name:'client_echo',description:'Echo input',parameters:Type.Object({value:Type.String()})}]}),{apiKey:'local-fixture',fetch:transport,maxRetries:0});
 const result=await events.result();expect(result.stopReason,result.errorMessage).toBe('toolUse');expect(result.content).toContainEqual(expect.objectContaining({type:'toolCall',name:'client_echo',arguments:{value:'ping'}}));
 await provider.close();
});
it('cancels the SDK request when the client disconnects and releases the single-request slot',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);await provider.load();
 let finish!:(result:unknown)=>void;const pending=new Promise(resolve=>{finish=resolve;});
 sdk.cancel.mockImplementation(async()=>finish({status:'cancelled'}));sdk.create.mockResolvedValue({close:sdk.close,send:async()=>({wait:()=>pending,cancel:sdk.cancel})});
 const controller=new AbortController();const response=provider.response('responses',{model:'cursor/fixture-model',input:'hi'},controller.signal);
 await expect.poll(()=>sdk.create.mock.calls.length).toBe(1);controller.abort();expect((await response).status).toBe(499);
 sdk.create.mockResolvedValue({close:sdk.close,send:async()=>({wait:async()=>({status:'finished',result:'OK',usage:tokenUsage}),cancel:sdk.cancel})});
 expect((await provider.response('responses',{model:'cursor/fixture-model',input:'hi'},new AbortController().signal)).status).toBe(200);
});

it('refreshes an expired Cursor catalog and does not retain an old list indefinitely',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture-key'}));const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());
 const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);await provider.load();
 sdk.models.mockResolvedValue([{id:'new-model',displayName:'New'}]);vi.mocked(Date.now).mockReturnValue(now+300001);
 await provider.refreshIfStale();expect(provider.snapshot().models.map(m=>m.id)).toEqual(['cursor/new-model']);
 sdk.models.mockRejectedValue(new Error('offline'));vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('offline'));
 vi.mocked(Date.now).mockReturnValue(now+310000);await provider.refresh();expect(provider.snapshot().models).toHaveLength(1);
 vi.mocked(Date.now).mockReturnValue(now+21*60000);await provider.refreshIfStale();expect(provider.snapshot().models).toEqual([]);
});

it('settles cancelled tool handoffs from the matching official bill so capped keys can continue and still stop at the cap',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 await mkdir(join(root,'cliproxy'));await writeFile(join(root,'cliproxy','fixture-accounts.json'),'[]');
 const service=await createDesktopService({root,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),proxyPort:port,token:'admin-token',localKey:'internal',secrets});cleanup.push(()=>service.app.close());await service.proxy.start();await service.proxy.cursor.load();await service.proxy.cursor.refresh();
 const admin={host:'127.0.0.1:9527',authorization:'Bearer admin-token'};
 const key=(await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:admin,payload:{name:'Metered tools',models:['cursor/fixture-model'],sourceId:service.proxy.cursor.id,tokenLimit:26}})).json();
 toolRun(false);sdk.runUsage.mockResolvedValue(tokenUsage);
 const client={host:admin.host,authorization:`Bearer ${key.apiKey}`};
 for(let i=0;i<2;i++){
  const result=await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model:'cursor/fixture-model',input:'Echo ping',stream:i===1,tools:[{type:'function',name:'client_echo',parameters:{type:'object'}}],tool_choice:'required'}});
  expect(result.statusCode,result.body).toBe(200);
 }
 const state=(await service.app.inject({url:'/api/gateway-keys',headers:admin})).json().keys[0];expect(state.usedTokens).toBe(26);expect(state.unmeteredRequests).toBe(0);
 expect(sdk.runUsage).toHaveBeenCalledWith('agent-fixture',expect.any(Number),expect.any(AbortSignal));
 expect((await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model:'cursor/fixture-model',input:'hi'}})).statusCode).toBe(429);
 const unknown=(await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:admin,payload:{name:'Unknown bill',models:['cursor/fixture-model'],sourceId:service.proxy.cursor.id,tokenLimit:100}})).json();
 sdk.runUsage.mockRejectedValue(new Error('Billing unavailable'));
 const unknownClient={host:admin.host,authorization:`Bearer ${unknown.apiKey}`};
 const request={method:'POST' as const,url:'/v1/responses',headers:unknownClient,payload:{model:'cursor/fixture-model',input:'Echo ping',tools:[{type:'function',name:'client_echo',parameters:{type:'object'}}]}};
 expect((await service.app.inject(request)).statusCode).toBe(200);
 const blocked=await service.app.inject(request);expect(blocked.statusCode).toBe(429);expect(blocked.body).toContain('未结算');
});

it('keeps quota failures separate from model availability and never attributes old quota to a new login',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'first',email:'first@example.test'}));
 sdk.quota.mockResolvedValue({plan:'Pro',windows:[{id:'included',label:'Plan',used:1,limit:20,usedPercent:5}]});
 const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();const id=provider.id!;
 sdk.quota.mockRejectedValue(new Error('private upstream'));await provider.refresh();expect(provider.snapshot().models).toHaveLength(1);expect(provider.snapshot().quotas[id]).toMatchObject({status:'error',plan:'Pro',windows:[{used:1}],lastSuccessfulAt:expect.any(String)});
 await provider.beginLogin();await expect.poll(()=>provider.snapshot().login?.status).toBe('completed');expect(provider.snapshot().accounts).toHaveLength(2);const newId=provider.snapshot().accounts.find(a=>a.id!==id)!.id;expect(provider.snapshot().quotas[newId].windows).toEqual([]);expect(provider.snapshot().quotas[id].windows).toHaveLength(1);expect(JSON.stringify(provider.snapshot())).not.toContain('private upstream');
});

it('accepts actual Codex metadata and grouped tool catalogs without losing namespace identity',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();
 const body={model:'cursor/fixture-model',input:'Read',client_metadata:{'x-codex-turn-id':'fixture-turn'},tools:[{type:'function',name:'read',parameters:{type:'object'}},{type:'namespace',name:'fs',tools:[{type:'function',name:'read',parameters:{type:'object'}}]}],tool_choice:{type:'function',namespace:'fs',name:'read'}};
 const before=JSON.stringify(body);const parsed=parseCursorInput('responses',body);expect(parsed.tools).toHaveLength(1);expect(parsed.tools[0]).toMatchObject({name:'read',namespace:'fs'});expect(JSON.stringify(body)).toBe(before);
 toolRun();const response=await provider.response('responses',body,new AbortController().signal);expect(response.status).toBe(200);expect((await response.json()).output[0]).toMatchObject({name:'read',namespace:'fs',type:'function_call'});
});
it('bounds flattened Cursor tools and rejects duplicate names within the same namespace',()=>{
 const ns={type:'namespace',name:'fs',tools:[{type:'function',name:'read'}]};
 expect(()=>parseCursorInput('responses',{model:'cursor/test',input:'hello',tools:[ns,ns]})).toThrow();
 expect(()=>parseCursorInput('responses',{model:'cursor/test',input:'hello',tools:[{...ns,tools:Array.from({length:2049},(_,i)=>({type:'function',name:`read${i}`}))}]})).toThrow();
});

it('skips repeatedly unavailable SDK billing per account, expires the hint, and keeps official settlement',async()=>{
 // Isolate billing from REST catalog fallback during concurrent mocked SDK imports.
 const originalFetch=globalThis.fetch;vi.spyOn(globalThis,'fetch').mockImplementation((url,init)=>String(url)==='https://api.cursor.com/v1/models'?Promise.resolve(Response.json({items:[{id:'fixture-model',displayName:'Fixture model'}]})):originalFetch(url,init));
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({version:1,accounts:[{apiKey:'first',email:'first@test'},{apiKey:'second',email:'second@test'}]}));
 const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();
 const getUsage=vi.fn().mockRejectedValue(Object.assign(new Error('Unsupported'),{status:403,code:'feature_unavailable'}));
 sdk.create.mockResolvedValue({agentId:'billing-fixture',close:sdk.close,getUsage,send:async()=>({wait:async()=>({status:'finished',result:'ok'}),cancel:sdk.cancel})});sdk.runUsage.mockResolvedValue(tokenUsage);
 const accounts=provider.snapshot().accounts;for(const account of accounts)expect(account.models,JSON.stringify(account)).toContain('cursor/fixture-model');const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);
 const send=(id:string)=>provider.response('responses',{model:'cursor/fixture-model',input:'hi'},new AbortController().signal,id);
 for(let i=0;i<3;i++){const r=await send(accounts[0].id);expect(r.status).toBe(200);expect((await r.json()).usage.total_tokens).toBe(13);}
 expect(getUsage).toHaveBeenCalledTimes(1);expect(sdk.runUsage).toHaveBeenCalledTimes(3);
 await send(accounts[1].id);expect(getUsage).toHaveBeenCalledTimes(2);
 vi.mocked(Date.now).mockReturnValue(now+300001);await send(accounts[0].id);expect(getUsage).toHaveBeenCalledTimes(3);
});
it.each([{status:403,code:'plan_required'},{status:500,code:'feature_unavailable'},{status:503,code:'unavailable'}])('retries SDK billing after transient or unrelated errors %j',async error=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();
 const getUsage=vi.fn().mockRejectedValueOnce(Object.assign(new Error('Failure'),error)).mockResolvedValue({runs:[{}],usage:tokenUsage});
 sdk.create.mockResolvedValue({agentId:'agent-fixture',getUsage,close:sdk.close,send:async()=>({wait:async()=>({status:'finished',result:'ok'}),cancel:sdk.cancel})});sdk.runUsage.mockResolvedValue(tokenUsage);
 for(let i=0;i<2;i++)expect((await provider.response('responses',{model:'cursor/fixture-model',input:'hi'},new AbortController().signal)).status).toBe(200);
 expect(getUsage).toHaveBeenCalledTimes(2);expect(sdk.runUsage).toHaveBeenCalledTimes(2);
});

it('keeps SDK workspace paths out of client tools and allows the model to correct the path',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));
 const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();let prompt='';
 sdk.create.mockImplementation(async options=>({close:sdk.close,send:async(value:string)=>{
  prompt=value;let finish!:(value:unknown)=>void;const pending=new Promise(resolve=>{finish=resolve;});
  return {cancel:async()=>finish({status:'cancelled',usage:tokenUsage}),wait:()=>{
   void options.local.customTools.client_0.execute({file_path:join(options.local.cwd,'first.txt')},{})
    .catch(()=>options.local.customTools.client_0.execute({file_path:'/client/project/first.txt'},{}));return pending;
  }};
 }}));
 const response=await provider.response('messages',{model:'cursor/fixture-model',system:'Working directory: /client/project',messages:[{role:'user',content:'Read first.txt'}],tools:[{name:'Read',input_schema:{type:'object',properties:{file_path:{type:'string'}}}}]},new AbortController().signal);
 expect(response.status).toBe(200);expect((await response.json()).content[0].input.file_path).toBe('/client/project/first.txt');
 expect(prompt).toContain('client conversation');expect(prompt).toContain('not the client workspace');
});
it('overlaps SDK disposal with official settlement but waits for both before releasing the request',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();
 let disposeStarted=false,disposeAtBilling=false,finishDispose!:()=>void;const disposed=new Promise<void>(r=>{finishDispose=r;});
 sdk.create.mockResolvedValue({agentId:'agent-fixture',close:sdk.close,[Symbol.asyncDispose]:async()=>{disposeStarted=true;await disposed;},send:async()=>({wait:async()=>({status:'finished',result:'ok'}),cancel:sdk.cancel})});
 sdk.runUsage.mockImplementation(async()=>{disposeAtBilling=disposeStarted;return tokenUsage;});
 const request=provider.response('responses',{model:'cursor/fixture-model',input:'hi'},new AbortController().signal);
 try{await expect.poll(()=>sdk.runUsage.mock.calls.length).toBe(1);expect(disposeStarted).toBe(true);
  expect((await provider.response('responses',{model:'cursor/fixture-model',input:'next'},new AbortController().signal)).status).toBe(429);
 }finally{finishDispose();}
 expect((await request).status).toBe(200);expect(disposeAtBilling).toBe(true);expect(sdk.runUsage).toHaveBeenCalledOnce();
});

it('reuses Cursor discovery for five minutes while explicit refresh bypasses the cache',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());
 const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);await provider.load();
 for(const elapsed of [1000,30000,60000,299999]){vi.mocked(Date.now).mockReturnValue(now+elapsed);await provider.refreshIfStale();}
 expect(sdk.models).toHaveBeenCalledOnce();expect(sdk.quota).toHaveBeenCalledOnce();
 await provider.refresh();expect(sdk.models).toHaveBeenCalledTimes(2);expect(sdk.quota).toHaveBeenCalledTimes(2);
 vi.mocked(Date.now).mockReturnValue(now+600000);await Promise.all([provider.refreshIfStale(),provider.refreshIfStale()]);
 expect(sdk.models).toHaveBeenCalledTimes(3);expect(sdk.quota).toHaveBeenCalledTimes(3);
});
it('groups case-insensitive Cursor identities, keeps all authorization versions privately and prefers usable grants',async()=>{
 const {root,secrets,values}=await setup();const now=Date.now();
 await secrets.set('cursor-account',JSON.stringify({version:1,accounts:[{apiKey:'valid-original',email:'Member@Example.test',apiKeyExpiresAtMs:now+86400000},{apiKey:'newest-expired',email:'member@example.test',apiKeyExpiresAtMs:now-1000,authorizedAt:now},{apiKey:'valid-latest',email:'MEMBER@example.test',apiKeyExpiresAtMs:now+86400000,authorizedAt:now},{apiKey:'other-person',email:'other@example.test'}]}));
 const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();expect(provider.snapshot().accounts).toHaveLength(2);
 const member=provider.snapshot().accounts.find(a=>a.label.toLowerCase()==='member@example.test')!;
 await provider.response('responses',{model:'cursor/fixture-model',input:'hello'},new AbortController().signal,member.id);expect(sdk.create.mock.lastCall![0].apiKey).toBe('valid-latest');
 expect([...values.entries()].filter(([name])=>name.startsWith('grant-'))).toHaveLength(3);expect(JSON.stringify(provider.snapshot())).not.toMatch(/valid-original|valid-latest|newest-expired/);
 const oldId=(await import('node:crypto')).createHash('sha256').update('cursor:Member@Example.test').digest('hex').slice(0,24);expect(provider.owns(oldId)).toBe(true);expect(provider.assertSource(oldId,'cursor/fixture-model')).toContain('cursor:');
});
it('replaces an expired Cursor SDK grant on explicit local import and retains its private backup',async()=>{
 const {root,secrets,values}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'expired-private',email:'native@example.test',apiKeyExpiresAtMs:1}));
 const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();await provider.importLocal();expect(sdk.localCreate).toHaveBeenCalledOnce();expect(provider.snapshot().accounts).toHaveLength(1);expect(provider.snapshot().models).toHaveLength(1);
 expect([...values.entries()].filter(([name])=>name.startsWith('grant-')).some(([,raw])=>raw.includes('expired-private'))).toBe(true);
});

it.each([
 ['resource_exhausted','cursor_rate_limited'],['permission_denied','cursor_permission_denied'],
 ['invalid_argument','cursor_request_rejected'],['unavailable','cursor_upstream_unavailable'],
 ['internal','cursor_upstream_internal'],['deadline_exceeded','cursor_timeout'],['unauthenticated','cursor_authentication_failed'],
])('classifies SDK RunError code %s after its name and status have been stripped',async(code,expected)=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();
 sdk.create.mockResolvedValue({close:sdk.close,send:async()=>({cancel:sdk.cancel,wait:async()=>({status:'error',error:{code,message:'private upstream detail'}})})});
 const response=await provider.response('responses',{model:'cursor/fixture-model',input:'hello'},new AbortController().signal);
 const text=await response.text();expect(JSON.parse(text).error.code).toBe(expected);expect(text).not.toContain('private');
});
it('retries Cursor quota and catalog reads twice without generating a model response',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));
 sdk.models.mockRejectedValue(new TypeError('fetch failed'));const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(null,{status:503})).mockResolvedValueOnce(Response.json({items:[{id:'recovered',displayName:'Recovered'}]}));
 sdk.quota.mockRejectedValueOnce(Object.assign(new Error('temporary'),{status:503})).mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue({plan:'Pro',windows:[]});
 const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();
 expect(sdk.models).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledTimes(2);expect(sdk.quota).toHaveBeenCalledTimes(3);expect(provider.snapshot().models[0].id).toBe('cursor/recovered');expect(sdk.create).not.toHaveBeenCalled();
},10000);

it('reports the actual serialized SDK model-not-found failure without retryable 502 or raw details',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();
 sdk.create.mockResolvedValue({close:sdk.close,send:async()=>({cancel:sdk.cancel,wait:async()=>({status:'error',error:'model not found: private upstream model details'})})});
 const response=await provider.response('messages',{model:'cursor/fixture-model',messages:[{role:'user',content:'hello'}]},new AbortController().signal);
 expect(response.status).toBe(400);const raw=await response.text();expect(JSON.parse(raw).error.code).toBe('cursor_model_not_found');expect(raw).not.toContain('private');
});

it.each(['string','object'])('reports Cursor model region restrictions from a serialized %s error without invalidating the account',async(shape)=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();
 const message='Model not available This model provider is not supported in your region. Visit https://cursor.com/docs/account/regions for more information. PRIVATE';
 sdk.create.mockResolvedValue({close:sdk.close,send:async()=>({cancel:sdk.cancel,wait:async()=>({status:'error',error:shape==='string'?message:{message}})})});
 const response=await provider.response('messages',{model:'cursor/fixture-model',messages:[{role:'user',content:'hello'}]},new AbortController().signal);
 expect(response.status).toBe(403);const raw=await response.text();expect(JSON.parse(raw).error).toMatchObject({code:'cursor_region_unsupported'});expect(raw).toContain('地区');expect(raw).not.toContain('PRIVATE');
 expect(provider.snapshot().models.some(m=>m.id==='cursor/fixture-model')).toBe(true);
});


it('refreshes only the selected Cursor account',async()=>{
 const {root,secrets}=await setup();
 await secrets.set('cursor-account',JSON.stringify({version:1,accounts:[{apiKey:'one-fixture',email:'one@example.test'},{apiKey:'two-fixture',email:'two@example.test'}]}));
 const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();
 const chosen=provider.snapshot().accounts.find(a=>a.label==='one@example.test')!;
 sdk.models.mockClear();sdk.quota.mockClear();
 await provider.refresh(true,chosen.id);
 expect(sdk.models).toHaveBeenCalledTimes(1);expect(sdk.models.mock.calls[0][0]).toMatchObject({apiKey:'one-fixture'});
 expect(sdk.quota).toHaveBeenCalledTimes(1);
});

it('uses the configured native database for the import endpoint as well as detection',async()=>{
 const {root,secrets}=await setup();const path=join(root,'portable-cursor','state.vscdb');
 const service=await createDesktopService({root,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'local',secrets,cursorLocalPath:path,claudeCredentialStore:null});cleanup.push(()=>service.app.close());
 const response=await service.app.inject({url:'/api/local-agent/import-local/cursor',method:'POST',headers:{host:'127.0.0.1:9527',authorization:'Bearer admin'},payload:{}});
 expect(response.statusCode,response.body).toBe(200);expect(sdk.localSession).toHaveBeenCalledWith(path);expect(response.json().accounts.some((a:{models?:string[]})=>a.models?.includes('cursor/fixture-model'))).toBe(true);
});

const grokCatalog=()=>({id:'grok-4.7',displayName:'Grok 4.7',parameters:[{id:'context',values:[{value:'256k'},{value:'500k'}]},{id:'reasoning_effort',values:[{value:'high'},{value:'low'}]},{id:'fast',values:[{value:'true'}]}],variants:['500k','256k'].flatMap(context=>['high','low'].map(effort=>({displayName:context+effort,isDefault:context==='500k'&&effort==='high',params:[{id:'context',value:context},{id:'reasoning_effort',value:effort},{id:'fast',value:'true'}]})))});
async function grokProvider(accounts=[{apiKey:'grok-fixture',email:'one@example.test'}]){const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({version:1,accounts}));sdk.models.mockResolvedValue([grokCatalog()]);const provider=new CursorProvider(root,secrets);cleanup.push(()=>provider.close());await provider.load();return provider;}
const grokRequest={model:'cursor/grok-4.7',input:'Reply OK'};
const missingModel={code:'model_not_found',message:'PRIVATE model not found'};
function grokRun(result:unknown){return {cancel:sdk.cancel,wait:async()=>result};}
it.each(['create','send','wait'])('recovers a silent Grok 4.7 model rejection at %s once, preserving every other advertised parameter',async stage=>{
 const provider=await grokProvider();let attempts=0,closed=0;
 sdk.create.mockImplementation(async(options)=>{const context=options.model.params.find((p:{id:string})=>p.id==='context').value;attempts++;if(attempts===2)expect(closed).toBe(stage==='create'?0:1);if(context==='500k'&&stage==='create')throw missingModel;return {close:()=>{closed++;},send:async()=>{if(context==='500k'&&stage==='send')throw missingModel;return grokRun(context==='500k'?{status:'error',error:missingModel}:{status:'finished',result:'OK',usage:tokenUsage});}};});
 const response=await provider.response('responses',grokRequest,new AbortController().signal);expect(response.status,await response.clone().text()).toBe(200);expect(sdk.create).toHaveBeenCalledTimes(2);
 expect(sdk.create.mock.calls.map(([options])=>options.model)).toEqual(['500k','256k'].map(context=>({id:'grok-4.7',params:[{id:'context',value:context},{id:'reasoning_effort',value:'high'},{id:'fast',value:'true'}]})));
 expect(provider.snapshot().models.some(model=>model.id==='cursor/grok-4.7')).toBe(true);
 expect((await provider.response('responses',grokRequest,new AbortController().signal)).status).toBe(200);expect(sdk.create).toHaveBeenCalledTimes(3);expect(sdk.create.mock.lastCall![0].model.params[0].value).toBe('256k');
});
it.each(['text-delta','thinking-delta','tool-call-started','partial-tool-call','tool-call-delta','shell-output-delta'])('never replays a rejected run after SDK %s activity',async type=>{
 const provider=await grokProvider();sdk.create.mockImplementation(async()=>({close:sdk.close,send:async(_input:unknown,options:{onDelta:(value:unknown)=>void})=>{options?.onDelta({update:{type,text:'produced',tokens:1}});return grokRun({status:'error',error:missingModel});}}));
 expect((await provider.response('responses',grokRequest,new AbortController().signal)).status).toBe(400);expect(sdk.create).toHaveBeenCalledOnce();
});
it.each([
 {status:'error',error:{code:'invalid_argument'}},
 {status:'error',error:{code:'unavailable'}},
 {status:'error',error:{code:'unauthenticated'}},
 {status:'error',error:{message:'Model not available This model provider is not supported in your region.'}},
 {status:'error',error:missingModel,result:'partial answer'},
 {status:'error',error:missingModel,usage:tokenUsage},
 {status:'cancelled',error:missingModel},
])('does not retry non-model rejection, partial output, billed generation or cancellation: %j',async result=>{
 const provider=await grokProvider();sdk.create.mockResolvedValue({close:sdk.close,send:async()=>grokRun(result)});await provider.response('responses',grokRequest,new AbortController().signal);expect(sdk.create).toHaveBeenCalledOnce();
});
it('requires an exact advertised alternate combination and never hides or downgrades other models',async()=>{
 const provider=await grokProvider();const model=grokCatalog();model.variants=model.variants.filter(v=>v.params[0].value==='500k');sdk.models.mockResolvedValue([model,{id:'grok-4.6',displayName:'Grok 4.6',parameters:model.parameters,variants:grokCatalog().variants}]);await provider.refresh();
 sdk.create.mockResolvedValue({close:sdk.close,send:async()=>grokRun({status:'error',error:missingModel})});for(const id of['grok-4.7','grok-4.6'])await provider.response('responses',{...grokRequest,model:'cursor/'+id},new AbortController().signal);expect(sdk.create).toHaveBeenCalledTimes(2);expect(provider.snapshot().models).toHaveLength(2);
});
it('does not cache a failed alternate or retry it repeatedly within one request',async()=>{
 const provider=await grokProvider();sdk.create.mockResolvedValue({close:sdk.close,send:async()=>grokRun({status:'error',error:missingModel})});for(let i=0;i<2;i++)expect((await provider.response('responses',grokRequest,new AbortController().signal)).status).toBe(400);expect(sdk.create).toHaveBeenCalledTimes(4);expect(sdk.create.mock.calls.map(([o])=>o.model.params[0].value)).toEqual(['500k','256k','500k','256k']);
});
it('isolates successful compatibility choices by account, effort and catalog, and expires them',async()=>{
 const provider=await grokProvider([{apiKey:'one-key',email:'one@example.test'},{apiKey:'two-key',email:'two@example.test'}]);sdk.create.mockImplementation(async(options)=>({close:sdk.close,send:async()=>grokRun(options.model.params[0].value==='500k'?{status:'error',error:missingModel}:{status:'finished',result:'OK'})}));
 const [one,two]=provider.snapshot().accounts;await provider.response('responses',grokRequest,new AbortController().signal,one.id);await provider.response('responses',grokRequest,new AbortController().signal,two.id);expect(sdk.create).toHaveBeenCalledTimes(4);
 await provider.response('responses',{...grokRequest,reasoning:{effort:'low'}},new AbortController().signal,one.id);expect(sdk.create).toHaveBeenCalledTimes(6);expect(sdk.create.mock.lastCall![0].model.params[1].value).toBe('low');
 const altered=grokCatalog();altered.parameters.push({id:'catalog_revision',values:[{value:'2'}]});sdk.models.mockResolvedValue([altered]);await provider.refresh();await provider.response('responses',grokRequest,new AbortController().signal,one.id);expect(sdk.create).toHaveBeenCalledTimes(8);
 const date=Date.now();vi.spyOn(Date,'now').mockReturnValue(date+5*60000+1);await provider.response('responses',grokRequest,new AbortController().signal,one.id);expect(sdk.create).toHaveBeenCalledTimes(10);
});

it('does not replay after even a rejected custom-tool callback',async()=>{
 const provider=await grokProvider();sdk.create.mockImplementation(async(options)=>({close:sdk.close,send:async()=>{await options.local.customTools.client_0.execute({path:options.local.cwd},{}).catch(()=>{});return grokRun({status:'error',error:missingModel});}}));
 const response=await provider.response('responses',{...grokRequest,tools:[{type:'function',name:'read',parameters:{type:'object'}}]},new AbortController().signal);expect(response.status).toBe(400);expect(sdk.create).toHaveBeenCalledOnce();
});
it('does not start the alternate when the client disconnects during rejected-agent disposal',async()=>{
 const provider=await grokProvider(),controller=new AbortController();sdk.create.mockResolvedValue({close:()=>controller.abort(),send:async()=>grokRun({status:'error',error:missingModel})});
 expect((await provider.response('responses',grokRequest,controller.signal)).status).toBe(499);expect(sdk.create).toHaveBeenCalledOnce();
});
it('evicts a cached context that fails and probes the official default on the next request',async()=>{
 const provider=await grokProvider();let compatible=true;sdk.create.mockImplementation(async(options)=>({close:sdk.close,send:async()=>grokRun(options.model.params[0].value==='256k'&&compatible?{status:'finished',result:'OK'}:{status:'error',error:missingModel})}));
 expect((await provider.response('responses',grokRequest,new AbortController().signal)).status).toBe(200);compatible=false;
 expect((await provider.response('responses',grokRequest,new AbortController().signal)).status).toBe(400);expect(sdk.create).toHaveBeenCalledTimes(3);
 await provider.response('responses',grokRequest,new AbortController().signal);expect(sdk.create.mock.calls.slice(3).map(([o])=>o.model.params[0].value)).toEqual(['500k','256k']);
});
it('expires successful compatibility after five minutes even under continuous cache hits',async()=>{
 const provider=await grokProvider();sdk.create.mockImplementation(async(options)=>({close:sdk.close,send:async()=>grokRun(options.model.params[0].value==='256k'?{status:'finished',result:'OK'}:{status:'error',error:missingModel})}));
 const initial=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(initial);await provider.response('responses',grokRequest,new AbortController().signal);
 clock.mockReturnValue(initial+4*60000);await provider.response('responses',grokRequest,new AbortController().signal);expect(sdk.create).toHaveBeenCalledTimes(3);
 clock.mockReturnValue(initial+5*60000+1);await provider.response('responses',grokRequest,new AbortController().signal);expect(sdk.create.mock.calls.slice(3).map(([o])=>o.model.params[0].value)).toEqual(['500k','256k']);
});

it.each(['close','dispose'])('never replays after rejected-agent %s fails',async stage=>{
 const provider=await grokProvider();sdk.create.mockResolvedValue({close:stage==='close'?async()=>{throw Error('cleanup failed');}:sdk.close,...(stage==='dispose'?{[Symbol.asyncDispose]:async()=>{throw Error('dispose failed');}}:{}),send:async()=>grokRun({status:'error',error:missingModel})});
 const response=await provider.response('responses',grokRequest,new AbortController().signal);expect(response.status).toBe(400);expect(sdk.create).toHaveBeenCalledOnce();
});
it('does not reuse a successful variant after the account grant changes',async()=>{
 const provider=await grokProvider();sdk.create.mockImplementation(async(options)=>({close:sdk.close,send:async()=>grokRun(options.model.params[0].value==='256k'?{status:'finished',result:'OK'}:{status:'error',error:missingModel})}));
 await provider.response('responses',grokRequest,new AbortController().signal);expect(sdk.create).toHaveBeenCalledTimes(2);const account=provider.snapshot().accounts[0];await provider.setEnabled(false,account.id);await provider.setEnabled(true,account.id);
 await provider.response('responses',grokRequest,new AbortController().signal);expect(sdk.create.mock.calls.slice(2).map(([o])=>o.model.params[0].value)).toEqual(['500k','256k']);
});
