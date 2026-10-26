// Run with the packaged Electron executable and ELECTRON_RUN_AS_NODE=1.
// All service data/configuration lives in a disposable directory; no real account is used.
import assert from 'node:assert/strict';
import {zstdCompressSync} from 'node:zlib';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';

const archive=resolve(process.argv[2]),fixture=resolve(process.argv[3]);
assert.ok(process.versions.electron,'Use the packaged Electron runtime');
const root=await mkdtemp(join(await realpath(tmpdir()),'tokenflow-packaged-check-'));
const req=createRequire(join(archive,'package.json'));
let service;
try{
 for(const pkg of ['react','react-dom','openai','@earendil-works/pi-ai','esbuild','playwright','puppeteer']){
  await assert.rejects(readFile(join(archive,'node_modules',pkg,'package.json')));
 }
 assert.ok((await readFile(join(archive,'dist/bundled-dependencies.LICENSE.txt'),'utf8')).includes('pi-ai'));
 const cursor=await import(pathToFileURL(join(archive,'node_modules/@cursor/sdk/dist/esm/index.js')).href);
 assert.ok(cursor.Agent,'Cursor SDK loads its native runtime');
 const sdk=await import(pathToFileURL(req.resolve('@token-flow/codebuddy-runtime')).href);
 assert.equal(typeof sdk.runOfficialSDK,'function');
 const schemaModule=await import(new URL('./client-schema.js',pathToFileURL(req.resolve('@token-flow/codebuddy-runtime'))).href);
 const compile=schemaModule.createClientSchemaCompiler();
 const declared={type:'object',properties:{selection:{type:'object',properties:{id:{type:'string'},name:{type:'string'}},oneOf:[{required:['id']},{required:['name']}]}},required:['selection']};
 const schema=compile(declared),args={selection:{id:'synthetic'}};
 assert.deepEqual(schema.inputSchema,declared);
 assert.deepEqual(schema.parse(args),args);
 assert.throws(()=>schema.parse({selection:{id:'synthetic',name:'ambiguous'}}));
 assert.deepEqual(compile({$schema:'http://json-schema.org/draft-06/schema#',type:'object'}).parse({}),{});
 let createDesktopService;
 for(const file of await readdir(join(archive,'dist'))){
  if(!/^chunk-.*\.js$/.test(file))continue;
  const loaded=await import(pathToFileURL(join(archive,'dist',file)).href);
  if(loaded.createDesktopService)createDesktopService=loaded.createDesktopService;
 }
 assert.equal(typeof createDesktopService,'function');
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 await mkdir(join(root,'cliproxy'),{recursive:true});
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'qoder.json',provider:'qoder',status:'active',models:['kmodel_latest',...Array.from({length:10},(_,i)=>`extra-${i}`)]}]));
 const paths=Object.fromEntries(['codex','claude','qoder','workbuddy','deepseek','pi'].map(t=>[t,join(root,t,t==='codex'?'config.toml':'settings.json')]));
 await mkdir(join(root,'codex/sessions'),{recursive:true});
 await mkdir(join(root,'claude/projects'),{recursive:true});
 await writeFile(paths.claude,'{}');
 await writeFile(join(root,'claude/.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'fixture-claude-token'}}));
 await writeFile(join(root,'claude/.claude.json'),JSON.stringify({oauthAccount:{accountUuid:'fixture-claude-account',organizationUuid:'fixture-org',emailAddress:'claude-native@example.test'}}));
 await writeFile(join(root,'codex/sessions/fixture.jsonl'),[
  {type:'session_meta',payload:{id:'isolated-thread',model_provider:'openai'}},
  {type:'turn_context',payload:{model:'isolated-native-model'}},
  {type:'token_usage_record',timestamp:new Date().toISOString(),payload:{response_id:'isolated-response',usage:{input_tokens:100,cached_input_tokens:50,output_tokens:20}}},
 ].map(row=>JSON.stringify(row)).join('\n'));
 const loginPaths=Object.fromEntries(['workbuddy','workbuddy-ai','qoder'].map(provider=>[provider,join(root,'native',provider+'.json')]));await mkdir(join(root,'native'));
 for(const provider of ['workbuddy','workbuddy-ai'])await writeFile(loginPaths[provider],JSON.stringify({account:{uid:provider+'-native',nickname:provider+' native'},auth:{domain:provider==='workbuddy-ai'?'www.workbuddy.ai':'copilot.tencent.com'}}));
 await writeFile(loginPaths.qoder,JSON.stringify({schemaVersion:1,user:{id:'qoder-native',email:'qoder-native@example.test'}}));
 const idePath=join(root,'native/ide.vscdb'),ideDB=new DatabaseSync(idePath);ideDB.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT)');ideDB.prepare('INSERT INTO ItemTable VALUES (?,?)').run('secret://aicoding.auth.userInfo',JSON.stringify(Buffer.from(JSON.stringify({id:'qoder-ide-native',email:'ide-native@example.test',token:'fixture-ide-token'}))));ideDB.close();
 const {createSecrets}=await import(pathToFileURL(join(archive,'dist/credential-store.js')).href);await mkdir(join(root,'secrets'),{recursive:true});const secrets=createSecrets(root,{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from('fixture:'+value),decryptString:data=>{assert.ok(data.toString().startsWith('fixture:'));return data.toString().slice(8);}});await mkdir(join(root,'cliproxy/auth'),{recursive:true});await writeFile(join(root,'cliproxy/auth/qoder.json'),JSON.stringify({type:'qoder',uid:'fixture-selected-ide',access_token:'fixture-selected-token',refresh_token:'fixture-selected-refresh',expired:'2035-01-01T00:00:00Z'}));
 service=await createDesktopService({root,binary:fixture,token:'fixture-admin',localKey:'fixture-internal',proxyPort:port,agentPaths:paths,agentProcesses:async()=>[],desktopProcesses:async()=>[],desktopAccounts:{paths:loginPaths,crypto:async(op,value)=>op==='decrypt'?Buffer.from(value,'base64').toString():Buffer.from(value).toString('base64')},qoderIde:{path:idePath,crypto:async(op,value)=>op==='encrypt'?Buffer.from(value).toString('base64'):Buffer.from(value,'base64').toString(),fetch:async()=>new Response(JSON.stringify({id:'fixture-selected-ide',email:'selected@example.test',whitelistStatus:'PASS'}))},desktopAccountChange:async(target,work)=>{assert.equal(target,'qoder-ide');await work();},nativeProcesses:async()=>[],claudeCredentialStore:null,claudeDesktop:{directory:join(root,'Claude-3p'),processes:async()=>[],policy:async()=>{}},claudeDesktopChange:async work=>work(),antigravityPath:join(root,'antigravity'),secrets,uiRoot:join(archive,'dist/console')});
 await service.proxy.start();
 // Match desktop startup: onListen observes the login and keeps its five-second
 // sampling timer running, including during slower emulated-runtime checks.
 await service.app.listen({host:'127.0.0.1',port:0});
 await writeFile(join(root,'claude/projects/fixture.jsonl'),JSON.stringify({type:'assistant',timestamp:new Date().toISOString(),message:{id:'fixture-claude-response',model:'claude-sonnet-4-6',usage:{input_tokens:40,cache_read_input_tokens:60,output_tokens:20}}}));
 const headers={host:'127.0.0.1:9527',authorization:'Bearer fixture-admin'};
 const request=async(url,method='GET',payload)=>{const response=await service.app.inject({url,method,headers,payload});assert.equal(response.statusCode,200,response.body);return response.json();};
 // Bracket the new fixture timestamp before long maintenance/SDK checks run.
 await request('/api/usage/overview?days=0');
 for(const provider of ['workbuddy','workbuddy-ai','qoder','qoder-ide']){const state=await request('/api/native-accounts/'+provider);assert.equal(state.accountId,provider+'-native');assert.equal(state.loginState,'signed-in');assert.equal(state.backup,null);}
 const ui=await service.app.inject({url:'/',headers});assert.equal(ui.statusCode,200);assert.match(ui.body,/<html/);
 const source=service.proxy.snapshot().accounts.find(a=>a.provider==='qoder');assert.ok(source);
 const standaloneBefore=await readFile(loginPaths.qoder),ideBefore=await request('/api/native-accounts/qoder-ide');const ideSwitched=await request('/api/native-accounts/qoder-ide/switch','POST',{sourceId:source.id,revision:ideBefore.revision});assert.equal(ideSwitched.accountId,'fixture-selected-ide');assert.equal(ideSwitched.backup.state,'applied');const ideRestored=await request('/api/native-accounts/qoder-ide/restore','POST',{revision:ideSwitched.revision});assert.equal(ideRestored.accountId,ideBefore.accountId);assert.equal(ideRestored.backup,null);assert.deepEqual(await readFile(loginPaths.qoder),standaloneBefore);
 const key=await request('/api/gateway-keys','POST',{name:'packaged check',sourceId:source.id,models:['qoder/kmodel_latest']});
 const response=await service.app.inject({url:'/v1/responses',method:'POST',headers:{...headers,authorization:`Bearer ${key.apiKey}`},payload:{model:'qoder/kmodel_latest',input:'OK'}});assert.equal(response.statusCode,200,response.body);
 const selected=await request('/api/maintenance','PUT',{sourceId:source.id,model:'qoder/kmodel_latest'});
 assert.equal(selected.readiness.status,'unchecked');
 await request('/api/maintenance/check','POST',{});
 const until=async(check)=>{for(let i=0;i<100;i++){const value=await request('/api/maintenance');if(check(value))return value;await new Promise(r=>setTimeout(r,100));}throw Error('Maintenance timed out');};
 await until(value=>value.readiness.status==='ready');
 await request('/api/maintenance/run','POST',{prompt:'今天的模型速度',context:{page:'proxy',range:'today',keyId:key.key.id,origin:'gateway'}});
 const result=await until(value=>value.status==='completed');
 const preflight=result.messages.find(m=>m.text.startsWith('只读预检: '));assert.ok(preflight);
 const data=JSON.parse(preflight.text.slice(6));assert.equal(data.pageData.usage.requests,1);assert.equal(data.pageData.usage.models[0].tokensPerSecond,null);assert.ok(!preflight.text.includes(key.apiKey));
 const hasCodexUsage=value=>value.nativeRows.some(row=>row.model==='isolated-native-model'&&row.inputTokens===100&&row.outputTokens===20);
 const hasClaudeAttribution=value=>value.nativeRows.some(row=>row.nativeAccountLabel==='claude-native@example.test'&&row.nativeAccountEvidence==='login-snapshot'&&row.inputTokens===100&&row.outputTokens===20);
 let overview;const usageDeadline=Date.now()+60000;do{overview=await request('/api/usage/overview?days=0');if(!overview.scanning&&hasCodexUsage(overview)&&hasClaudeAttribution(overview))break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<usageDeadline);
 assert.ok(overview.nativeRows.some(row=>row.model==='isolated-native-model'&&row.inputTokens===100&&row.outputTokens===20),'Packaged worker must index the isolated native history');
 assert.ok(overview.nativeRows.some(row=>row.nativeAccountLabel==='claude-native@example.test'&&row.nativeAccountEvidence==='login-snapshot'&&row.inputTokens===100&&row.outputTokens===20),'Packaged worker must associate new Claude usage without switching or importing its account');
 // Run additional generations only after the selected-usage and maintenance assertions above.
 const scripts=[...ui.body.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"/g)].map(match=>match[1]);assert.ok(scripts.length,'Packaged UI must include a JavaScript bundle');
 const javascript=(await Promise.all(scripts.map(async url=>{const asset=await service.app.inject({url,headers});assert.equal(asset.statusCode,200);return asset.body;}))).join('\n');
 for(const label of ['访问范围','仅本机','局域网','复制完整信息','Key 已创建','来源 IP 限定'])assert.ok(javascript.includes(label),`Packaged UI must include ${label}`);
 const accessBefore=await request('/api/gateway/access');assert.equal(accessBefore.enabled,false);assert.equal(accessBefore.running,false);
 const allocator=createServer();await new Promise(r=>allocator.listen(0,'127.0.0.1',r));const lanPort=allocator.address().port;await new Promise(r=>allocator.close(r));
 await request('/api/gateway/access','PUT',{enabled:false,port:lanPort,allowedIPs:[]});
 const lanKey=await request('/api/gateway-keys','POST',{name:'packaged LAN check',access:'lan',allowedIPs:['127.0.0.1'],sourceId:source.id,models:['qoder/kmodel_latest']});assert.equal(lanKey.key.access,'lan');assert.equal(lanKey.gatewayAccess.running,true);
 const origin=`http://127.0.0.1:${lanPort}`,lanHeaders={authorization:`Bearer ${lanKey.apiKey}`};
 const localDenied=await fetch(`${origin}/v1/models`,{headers:{authorization:`Bearer ${key.apiKey}`}});assert.equal(localDenied.status,401);await localDenied.text();
 const listed=await fetch(`${origin}/v1/models`,{headers:lanHeaders});assert.equal(listed.status,200);assert.deepEqual((await listed.json()).data.map(model=>model.id),['qoder/kmodel_latest']);
 const lanResponse=await fetch(`${origin}/v1/responses`,{method:'POST',headers:{...lanHeaders,'content-type':'application/json'},body:JSON.stringify({model:'qoder/kmodel_latest',input:'Packaged LAN check'})});assert.equal(lanResponse.status,200);assert.equal((await lanResponse.json()).output[0].content[0].text,'qoder');
 for(const path of ['/api/settings','/api/gateway-keys','/api/gateway/access','/v0/management/auth-files']){const denied=await fetch(`${origin}${path}`,{headers:lanHeaders});assert.equal(denied.status,404);await denied.text();}
 const modelDenied=await fetch(`${origin}/v1/responses`,{method:'POST',headers:{...lanHeaders,'content-type':'application/json'},body:JSON.stringify({model:'qoder/not-authorized',input:'Denied model check'})});assert.equal(modelDenied.status,403);await modelDenied.text();
 await request(`/api/gateway-keys/${lanKey.key.id}/models`,'PUT',{allowedIPs:['192.0.2.1'],selections:[{sourceId:source.id,model:'qoder/kmodel_latest'}]});
 const ipDenied=await fetch(`${origin}/v1/models`,{headers:lanHeaders});assert.equal(ipDenied.status,403);await ipDenied.text();
 const localized=await request(`/api/gateway-keys/${lanKey.key.id}/models`,'PUT',{access:'local',selections:[{sourceId:source.id,model:'qoder/kmodel_latest'}]});assert.equal(localized.access,'local');
 assert.equal((await request('/api/gateway/access')).running,false);
 await assert.rejects(fetch(`${origin}/v1/models`,{headers:lanHeaders}));
 const accessDisabled=await request('/api/gateway/access','PUT',{enabled:false,port:lanPort,allowedIPs:[]});assert.equal(accessDisabled.running,false);assert.equal(service.access.app.server.listening,false);
 const desktopSelections=['kmodel_latest',...Array.from({length:10},(_,i)=>`extra-${i}`)].map(model=>({sourceId:source.id,model:`qoder/${model}`}));
 const desktopBefore=await request('/api/claude-desktop');
 await request('/api/claude-desktop/connect','POST',{revision:desktopBefore.revision,selections:desktopSelections,fast:desktopSelections[10]});
 const desktopJournal=JSON.parse(await secrets.get('native-login-claude-desktop')),desktopProfile=JSON.parse(desktopJournal.after.profile);
 assert.ok(desktopProfile.inferenceModels[10].name.includes('-tokenflow-'));
 for(const [alias,model] of [['claude-opus-4-8','qoder/kmodel_latest'],['claude-haiku-5-5','qoder/extra-9'],[desktopProfile.inferenceModels[10].name,'qoder/extra-9']]){
  const response=await service.app.inject({url:'/v1/messages',method:'POST',headers:{...headers,authorization:`Bearer ${desktopProfile.inferenceGatewayApiKey}`},payload:{model:alias,max_tokens:16,messages:[{role:'user',content:'Packaged subagent check'}]}});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().model,model);
 }
 const profilePath=join(root,'Claude-3p/configLibrary',`${desktopJournal.id}.json`);
 await writeFile(profilePath,JSON.stringify({...desktopProfile,inferenceGatewayBaseUrl:'http://127.0.0.1:15721/claude-desktop'}));
 const changedDesktop=await request('/api/claude-desktop');assert.equal(changedDesktop.connected,false);assert.equal(changedDesktop.configurationChanged,true);
 // Exercise compaction through the packaged gateway, including immediate retry.
 const originalFetch=globalThis.fetch;let summaryCalls=0;
 const compactInput=[{role:'user',content:'Preserve the original requirement.'},{role:'assistant',content:'Archived tool findings. '.repeat(1500)},...Array.from({length:8},(_,i)=>({role:i%2?'assistant':'user',content:'Recent '+i}))];
 globalThis.fetch=async(url,init)=>{
  const target=new URL(String(url));
  if(target.port===String(port)&&target.pathname==='/v1/responses'){
   const body=JSON.parse(String(init?.body));
   if(body.instructions?.startsWith('Summarize the supplied')){
    summaryCalls++;
    return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:summaryCalls===1?'':'Valid checkpoint larger than the excerpt. '.repeat(100)}]}],usage:{input_tokens:7,output_tokens:3}});
   }
  }
  return originalFetch(url,init);
 };
 try{
  const compact=()=>service.app.inject({method:'POST',url:'/v1/responses/compact',headers:{...headers,authorization:`Bearer ${key.apiKey}`},payload:{model:'qoder/kmodel_latest',input:compactInput}});
  assert.equal((await compact()).statusCode,422);
  const recovered=await compact();assert.equal(recovered.statusCode,200,recovered.body);assert.equal(summaryCalls,2,'A failed summary must not be cached');
  assert.equal((await compact()).statusCode,200);assert.equal(summaryCalls,2,'A successful expanding summary must remain reusable');
  const resumed=await service.app.inject({method:'POST',url:'/v1/responses',headers:{...headers,authorization:`Bearer ${key.apiKey}`},payload:{model:'qoder/kmodel_latest',input:[...recovered.json().output,{role:'user',content:'Continue.'}]}});
  assert.equal(resumed.statusCode,200,resumed.body);
  // Production A2A wiring: switching makes no model call; only the requested
  // gateway-born thread waits for Codex's trigger, even with large input.
  const a2a=await request('/api/a2a'),target=a2a.targets.find(item=>item.id==='codex');
  await request('/api/a2a/connect','POST',{target:'codex',sourceId:source.id,model:'qoder/kmodel_latest',revision:target.revision,tokenLimit:null});
  assert.equal(summaryCalls,2,'Switching Codex must not generate summaries');
  const config=await readFile(paths.codex,'utf8'),match=config.match(/experimental_bearer_token\s*=\s*("[^"\n]+")/);assert.ok(match);
  const managedHeaders={...headers,authorization:'Bearer '+JSON.parse(match[1]),session_id:'d0783e2e-6dfb-4e7b-8bb3-3704eafc9c23'};
  const longInput=[{role:'user',content:'Keep current task'},{role:'assistant',content:'Archived findings. '.repeat(20000)},{role:'user',content:'Continue current task'}];
  const continuation=input=>service.app.inject({method:'POST',url:'/v1/responses',headers:managedHeaders,payload:{model:'qoder/kmodel_latest',input}});
  const firstManaged=await continuation(longInput);assert.equal(firstManaged.statusCode,200,firstManaged.body);assert.equal(summaryCalls,2,'A gateway-born thread must not bootstrap without imported history');const firstManagedSummaryCalls=summaryCalls;
  assert.equal((await continuation(longInput)).statusCode,200);assert.equal(summaryCalls,firstManagedSummaryCalls,'Replay must not invent a migration checkpoint');
  const grown=[...longInput,{role:'assistant',content:'Later tool work. '.repeat(20000)},{role:'user',content:'Next step'}];
  assert.equal((await continuation(grown)).statusCode,200);assert.equal(summaryCalls,firstManagedSummaryCalls,'Later growth must wait for Codex');
  assert.equal((await continuation([...grown,{type:'compaction_trigger'}])).statusCode,200);assert.ok(summaryCalls>firstManagedSummaryCalls,'Explicit compaction must summarize new history');
 }finally{globalThis.fetch=originalFetch;}
 const zstd=await service.app.inject({method:'POST',url:'/v1/responses',headers:{...headers,authorization:`Bearer ${key.apiKey}`,'content-type':'application/json','content-encoding':'zstd'},payload:zstdCompressSync(Buffer.from(JSON.stringify({model:'qoder/kmodel_latest',input:'Packaged zstd complete history 首🙂尾',store:false})))});
 assert.equal(zstd.statusCode,200,zstd.body);assert.equal(zstd.json().output[0].content[0].text,'qoder');
 console.log(JSON.stringify({passed:true,electron:process.versions.electron,platform:process.platform,arch:process.arch,checks:['native zstd request decoded by the packaged gateway','no switch-time or gateway-born bootstrap; explicit Codex compaction','valid expanding summaries, immediate failed-summary retry and cached continuation','production dependencies','bundled licenses','Cursor native SDK','WorkBuddy SDK import','WorkBuddy original-schema validation and draft metadata','static UI','Responses gateway','Pi repair conversation','selected usage evidence','local usage worker','Claude native account attribution','existing Qoder and both WorkBuddy edition identities','Qoder IDE switch, restore and standalone isolation','automatic LAN listener, per-key source IPs and isolated model routes','Claude Desktop subagent roles and independent menu routes','Claude Desktop external gateway drift detection']},null,2));
}finally{await service?.app.close();await rm(root,{recursive:true,force:true});}
