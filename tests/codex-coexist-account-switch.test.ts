import {CodexBridgeInstallation} from '../packages/core/src/codex-bridge-installation.js';
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {parse} from 'smol-toml';
import {createDesktopService} from '../packages/core/src/service.js';
import {CodexAccounts} from '../packages/core/src/codex-accounts.js';
import {AgentConnections} from '../packages/core/src/agent-connections.js';
import {CodexContext} from '../packages/core/src/codex-context.js';
import {CodexThreadMigration} from '../packages/core/src/codex-thread-migration.js';
import {CodexSwitchLifecycle} from '../packages/core/src/codex-switch-lifecycle.js';
import {GatewayContext} from '../packages/core/src/gateway-context.js';
const clean:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const fn of clean.splice(0).reverse())await fn();});
const oauth=(id:string)=>({account_id:id,access_token:`fixture-access-${id}`,refresh_token:`fixture-refresh-${id}`,id_token:`x.${Buffer.from(JSON.stringify({email:`${id}@example.test`})).toString('base64url')}.x`});
const catalog=(slug:string)=>({models:[{slug,display_name:slug,visibility:'list',truncation_policy:{mode:'bytes',limit:1000}}]});
async function setup(hybrid=false){
 if(hybrid)vi.spyOn(CodexBridgeInstallation.prototype,'preflight').mockResolvedValue({app:'/fixture/Codex.app',binary:'/fixture/codex',node:'/fixture/node'});
 const root=await realpath(await mkdtemp(join(tmpdir(),'coexist-account-')));clean.push(()=>rm(root,{recursive:true,force:true}));
 const config=join(root,'codex/config.toml'),auth=join(root,'codex/auth.json');await mkdir(join(root,'codex'));await mkdir(join(root,'cliproxy/auth'),{recursive:true});await writeFile(config,'model="original"\n');const originalAuth=JSON.stringify({auth_mode:'chatgpt',tokens:oauth('original')});await writeFile(auth,originalAuth);
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify(['a','b'].map(id=>({name:`${id}.json`,provider:'codex',status:'active',models:[`model-${id}`]}))));for(const id of ['a','b'])await writeFile(join(root,`cliproxy/auth/${id}.json`),JSON.stringify(oauth(id)));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 let fail=false;let onFetch:undefined|(()=>Promise<void>);const fetcher=vi.fn(async(_url:string,init:RequestInit)=>{await onFetch?.();return fail?Response.json({error:'unavailable'},{status:403}):Response.json(catalog(`official-${(init.headers as Record<string,string>)['chatgpt-account-id']}`));});
 const options={codexBridgeRuntime:resolve('tests/fixtures/fake-cliproxy.mjs'),root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'private',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{codex:config,qoder:join(root,'qoder.json'),claude:join(root,'claude.json'),workbuddy:join(root,'workbuddy.json')},agentProcesses:async()=>[],codexOfficialFetch:fetcher};let service=await createDesktopService(options);clean.push(()=>service.app.close());
 vi.spyOn(CodexContext.prototype,'prepareOfficial').mockResolvedValue({changed:0} as any);vi.spyOn(CodexThreadMigration.prototype,'restore').mockResolvedValue({migrated:0} as any);
 await service.proxy.start();const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'},get=async(url:string)=>(await service.app.inject({url,headers})).json(),post=(url:string,payload:unknown)=>service.app.inject({url,method:'POST',headers,payload:payload as any});
 const target=(await get('/api/a2a')).targets.find((t:any)=>t.id==='codex'),source=service.proxy.snapshot().accounts.find(a=>a.models?.includes('codex/model-a'))!;
 const connected=await post('/api/a2a/connect',{target:'codex',sourceId:source.id,model:'codex/model-a',selections:[{sourceId:source.id,model:'codex/model-a'}],revision:target.revision,codexCoexist:!hybrid,codexDirectHybrid:hybrid});expect(connected.statusCode,connected.body).toBe(200);
 return {root,config,auth,originalAuth,get service(){return service;},restart:async()=>{await service.app.close();service=await createDesktopService(options);await service.proxy.start();},get,post,fetcher,fail:(value:boolean)=>fail=value,onFetch:(value:()=>Promise<void>)=>onFetch=value};
}
it('keeps the existing hybrid connection intact and never stops Codex when repeated application cannot discover official models',async()=>{
 const f=await setup(true),target=(await f.get('/api/a2a')).targets.find((t:any)=>t.id==='codex'),record=target.connection;
 const config=await readFile(f.config,'utf8'),auth=await readFile(f.auth,'utf8'),catalogPath=(parse(config) as any).model_catalog_json;
 const catalogBefore=await readFile(catalogPath,'utf8'),bridgePath=join(f.root,'codex-direct-bridge/settings.json'),bridgeBefore=await readFile(bridgePath,'utf8');
 const keys=await f.get('/api/gateway-keys'),lifecycle=vi.spyOn(CodexSwitchLifecycle.prototype,'change');
 f.onFetch(async()=>{throw new DOMException('fixture timeout','TimeoutError');});
 for(let i=0;i<2;i++){
  const result=await f.post('/api/a2a/connect',{target:'codex',sourceId:record.sourceId,model:record.model,selections:record.selections,revision:target.revision,replaceId:record.id,rewrite:true,restartCodex:true,codexCoexist:false,codexDirectHybrid:true});
  expect(result.statusCode,result.body).toBe(409);expect(result.json().code).toBe('codex_coexist_unavailable');
 }
 expect(lifecycle).not.toHaveBeenCalled();expect(await readFile(f.config,'utf8')).toBe(config);expect(await readFile(f.auth,'utf8')).toBe(auth);
 expect(await readFile(catalogPath,'utf8')).toBe(catalogBefore);expect(await readFile(bridgePath,'utf8')).toBe(bridgeBefore);
 expect(await f.get('/api/gateway-keys')).toEqual(keys);
 const after=(await f.get('/api/a2a')).targets.find((t:any)=>t.id==='codex');expect(after.connection).toEqual(record);expect(after.backups).toEqual(target.backups);expect(after.configurationState).toBe('configured');
});
it('enables inherited history preparation only on the managed hybrid route and retains it after service restart',async()=>{
 const f=await setup(true),config=parse(await readFile(f.config,'utf8')) as any;
 const context=vi.spyOn(GatewayContext.prototype,'response').mockImplementation(async()=>Response.json({id:'fixture',status:'completed',output:[],usage:{input_tokens:1,output_tokens:0}}));
 for(let n=0;n<2;n++){
  const result=await f.service.app.inject({method:'POST',url:'/v1/responses',headers:{host:'127.0.0.1:9527',authorization:'Bearer '+config.model_providers.token_flow.experimental_bearer_token,session_id:'hybrid-thread'},payload:{model:'codex/model-a',input:'fixture'}});
  expect(result.statusCode,result.body).toBe(200);expect(context.mock.calls.at(-1)?.[5]).toMatchObject({prepareHybridHistory:true,threadId:'hybrid-thread'});
  if(n===0)await f.restart();
 }
});
it('preserves gateway routing and its key while switching and restoring official identities and refreshes account-scoped models',async()=>{
 const f=await setup();const initial=(await f.get('/api/a2a')).targets.find((t:any)=>t.id==='codex').connection;const initialConfig=parse(await readFile(f.config,'utf8')) as any;const key=initialConfig.model_providers.token_flow.http_headers['x-tokenflow-client-key'];
 for(const id of ['a','b']){const status=await f.get('/api/codex-accounts'),source=f.service.proxy.snapshot().accounts.find(a=>a.models?.includes(`codex/model-${id}`))!;const result=await f.post('/api/codex-accounts/switch',{revision:status.revision,sourceId:source.id,model:`codex/model-${id}`,restoreHistory:false});expect(result.statusCode,result.body).toBe(200);expect(result.json()).toMatchObject({gatewayConnected:true,codexCoexist:true,accountId:id,provider:'token_flow'});
 const target=(await f.get('/api/a2a')).targets.find((t:any)=>t.id==='codex');expect(target.connection).toMatchObject({id:initial.id,keyId:initial.keyId,officialModelSlugs:[`official-${id}`]});const config=parse(await readFile(f.config,'utf8')) as any;expect(config.model_providers).toEqual(initialConfig.model_providers);expect(JSON.parse(await readFile(config.model_catalog_json,'utf8')).models.map((m:any)=>m.slug)).toEqual([`official-${id}`,'codex/model-a']);
 const ask=await f.service.app.inject({url:'/codex/v1/responses',method:'POST',headers:{host:'127.0.0.1:9527',authorization:'Bearer fixture','x-tokenflow-client-key':key},payload:{model:'official-original',input:'fixture'}});expect(ask.statusCode).toBe(403);
 }
 const restored=await f.post('/api/codex-accounts/restore',{revision:(await f.get('/api/codex-accounts')).revision,restoreHistory:false});expect(restored.statusCode,restored.body).toBe(200);expect(restored.json()).toMatchObject({gatewayConnected:true,codexCoexist:true,accountId:'original',provider:'token_flow',backup:null});expect(await readFile(f.auth,'utf8')).toBe(f.originalAuth);expect((await f.get('/api/a2a')).targets.find((t:any)=>t.id==='codex').connection).toMatchObject({id:initial.id,keyId:initial.keyId,officialModelSlugs:['official-original']});
});
it('keeps the working identity and gateway untouched when fresh account discovery fails',async()=>{
 const f=await setup(),before={config:await readFile(f.config,'utf8'),auth:await readFile(f.auth,'utf8'),target:(await f.get('/api/a2a')).targets.find((t:any)=>t.id==='codex')};f.fail(true);const status=await f.get('/api/codex-accounts'),source=f.service.proxy.snapshot().accounts[0];const result=await f.post('/api/codex-accounts/switch',{revision:status.revision,sourceId:source.id,model:source.models![0],restoreHistory:false});expect(result.statusCode,result.body).toBe(409);expect(await readFile(f.config,'utf8')).toBe(before.config);expect(await readFile(f.auth,'utf8')).toBe(before.auth);expect((await f.get('/api/a2a')).targets.find((t:any)=>t.id==='codex').connection).toEqual(before.target.connection);
});

it.each(['switch','restore'] as const)('rolls back identity, config, record and allowed slugs when the %s journal commit fails',async action=>{
 const f=await setup(),source=f.service.proxy.snapshot().accounts.find(a=>a.models?.includes('codex/model-a'))!;
 const switchPayload=async()=>({revision:(await f.get('/api/codex-accounts')).revision,sourceId:source.id,model:'codex/model-a',restoreHistory:false});
 if(action==='restore')expect((await f.post('/api/codex-accounts/switch',await switchPayload())).statusCode).toBe(200);
 const before={auth:await readFile(f.auth,'utf8'),config:await readFile(f.config,'utf8'),connection:(await f.get('/api/a2a')).targets.find((t:any)=>t.id==='codex').connection,journal:await readFile(join(f.root,'codex-account-backup.json'),'utf8').catch(()=>null)};
 const original=(CodexAccounts.prototype as any).save;let failed=false;
 const spy=vi.spyOn(CodexAccounts.prototype as any,'save').mockImplementation(async function(this:unknown,value:any,...args:unknown[]){if(!failed&&value.state===(action==='switch'?'applied':'restored')){failed=true;throw Error('synthetic journal commit failure');}return original.call(this,value,...args);});
 const response=await f.post(`/api/codex-accounts/${action}`,action==='switch'?await switchPayload():{revision:(await f.get('/api/codex-accounts')).revision,restoreHistory:false});spy.mockRestore();expect(response.statusCode,response.body).toBe(500);expect(failed).toBe(true);
 expect(await readFile(f.auth,'utf8')).toBe(before.auth);expect(await readFile(f.config,'utf8')).toBe(before.config);expect((await f.get('/api/a2a')).targets.find((t:any)=>t.id==='codex').connection).toEqual(before.connection);expect(await readFile(join(f.root,'codex-account-backup.json'),'utf8').catch(()=>null)).toBe(before.journal);
 const config=parse(before.config) as any;const unknown=action==='switch'?'official-a':'official-original';expect((await f.service.app.inject({url:'/codex/v1/responses',method:'POST',headers:{host:'127.0.0.1:9527',authorization:'Bearer fixture','x-tokenflow-client-key':config.model_providers.token_flow.http_headers['x-tokenflow-client-key']},payload:{model:unknown,input:'fixture'}})).statusCode).toBe(403);
});
it('still restores auth and config when another rollback participant fails, and leaves a recoverable journal',async()=>{
 const f=await setup(),before={auth:await readFile(f.auth,'utf8'),config:await readFile(f.config,'utf8')},source=f.service.proxy.snapshot().accounts[0];
 const original=AgentConnections.prototype.prepareCodexIdentityCatalog;
 const spy=vi.spyOn(AgentConnections.prototype,'prepareCodexIdentityCatalog').mockImplementation(async function(this:AgentConnections,...args){const prepared=await original.apply(this,args);return {...prepared,apply:async()=>{throw Error('synthetic catalog apply failure');},rollback:async()=>{throw Error('synthetic rollback participant failure');}};});
 const response=await f.post('/api/codex-accounts/switch',{revision:(await f.get('/api/codex-accounts')).revision,sourceId:source.id,model:source.models![0],restoreHistory:false});spy.mockRestore();expect(response.statusCode).toBe(409);expect(await readFile(f.auth,'utf8')).toBe(before.auth);expect(await readFile(f.config,'utf8')).toBe(before.config);expect((await f.get('/api/codex-accounts')).backup.state).toBe('prepared');
 expect((await f.post('/api/codex-accounts/restore',{revision:(await f.get('/api/codex-accounts')).revision,restoreHistory:false})).statusCode).toBe(200);
});
it('detects external edits made during candidate account discovery without overwriting them',async()=>{
 const f=await setup(),before=await readFile(f.config,'utf8'),source=f.service.proxy.snapshot().accounts[0],external=JSON.stringify({tokens:oauth('external')});f.onFetch(()=>writeFile(f.auth,external));
 const response=await f.post('/api/codex-accounts/switch',{revision:(await f.get('/api/codex-accounts')).revision,sourceId:source.id,model:source.models![0],restoreHistory:false});expect(response.statusCode,response.body).toBe(409);expect(await readFile(f.auth,'utf8')).toBe(external);expect(await readFile(f.config,'utf8')).toBe(before);
});
it.each(['auth','config','record'] as const)('recovers a prepared identity switch interrupted after %s replacement, including after restart',async phase=>{
 const f=await setup(),initial=(await f.get('/api/a2a')).targets.find((t:any)=>t.id==='codex').connection,source=f.service.proxy.snapshot().accounts[0];
 const original=(CodexAccounts.prototype as any).save;const spy=vi.spyOn(CodexAccounts.prototype as any,'save').mockImplementation(async function(this:unknown,value:any,...args:unknown[]){await original.call(this,value,...args);if(value.state==='prepared'){
   const catalogPath=(parse(value.after.config) as any).model_catalog_json;expect(JSON.parse(await readFile(catalogPath,'utf8')).models[0].slug).toBe('official-a');
   await writeFile(f.auth,value.after.auth);if(phase!=='auth')await writeFile(f.config,value.after.config);if(phase==='record'){const path=join(f.root,`agent-backups/${initial.id}.json`),record=JSON.parse(await readFile(path,'utf8'));const {createHash}=await import('node:crypto');record.after=value.after.config;record.afterHash=createHash('sha256').update(`file:${record.after}`).digest('hex');record.officialModelSlugs=['official-a'];await writeFile(path,JSON.stringify(record));}throw Error('synthetic process interruption');
 }});
 const interrupted=await f.post('/api/codex-accounts/switch',{revision:(await f.get('/api/codex-accounts')).revision,sourceId:source.id,model:source.models![0],restoreHistory:false});spy.mockRestore();expect(interrupted.statusCode,interrupted.body).toBe(500);await f.restart();
 const response=await f.post('/api/codex-accounts/restore',{revision:(await f.get('/api/codex-accounts')).revision,restoreHistory:false});expect(response.statusCode,response.body).toBe(200);expect(await readFile(f.auth,'utf8')).toBe(f.originalAuth);expect(response.json()).toMatchObject({gatewayConnected:true,codexCoexist:true,backup:null,accountId:'original'});expect((await f.get('/api/a2a')).targets.find((t:any)=>t.id==='codex').connection).toMatchObject({id:initial.id,keyId:initial.keyId,officialModelSlugs:['official-original']});
});
it('serializes concurrent account changes with the shared Codex configuration lock and rejects stale previews',async()=>{
 const f=await setup(),source=f.service.proxy.snapshot().accounts[0],payload={revision:(await f.get('/api/codex-accounts')).revision,sourceId:source.id,model:source.models![0],restoreHistory:false};let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);f.onFetch(async()=>{entered();await gate;});const first=f.post('/api/codex-accounts/switch',payload);await ready;
 try{expect((await f.post('/api/codex-accounts/switch',payload)).statusCode).toBe(409);}finally{release();}expect((await first).statusCode).toBe(200);expect((await f.post('/api/codex-accounts/switch',payload)).statusCode).toBe(409);
});
it('keeps the switched login and gateway intact if the original account catalog cannot be refreshed',async()=>{
 const f=await setup(),source=f.service.proxy.snapshot().accounts[0];expect((await f.post('/api/codex-accounts/switch',{revision:(await f.get('/api/codex-accounts')).revision,sourceId:source.id,model:source.models![0],restoreHistory:false})).statusCode).toBe(200);const auth=await readFile(f.auth,'utf8'),config=await readFile(f.config,'utf8'),journal=await readFile(join(f.root,'codex-account-backup.json'),'utf8');f.fail(true);
 expect((await f.post('/api/codex-accounts/restore',{revision:(await f.get('/api/codex-accounts')).revision,restoreHistory:false})).statusCode).toBe(409);expect(await readFile(f.auth,'utf8')).toBe(auth);expect(await readFile(f.config,'utf8')).toBe(config);expect(await readFile(join(f.root,'codex-account-backup.json'),'utf8')).toBe(journal);
});
it.each(['auth','config','record'] as const)('recovers a prepared original-login restore interrupted after %s replacement with the lock released',async phase=>{
 const f=await setup(),initial=(await f.get('/api/a2a')).targets.find((t:any)=>t.id==='codex').connection,source=f.service.proxy.snapshot().accounts[0];expect((await f.post('/api/codex-accounts/switch',{revision:(await f.get('/api/codex-accounts')).revision,sourceId:source.id,model:source.models![0],restoreHistory:false})).statusCode).toBe(200);
 const original=(CodexAccounts.prototype as any).save;const spy=vi.spyOn(CodexAccounts.prototype as any,'save').mockImplementation(async function(this:unknown,value:any,...args:unknown[]){await original.call(this,value,...args);if(value.state==='prepared'&&value.restoring){await writeFile(f.auth,value.before.auth);if(phase!=='auth')await writeFile(f.config,value.restoring.config);if(phase==='record'){const path=join(f.root,`agent-backups/${initial.id}.json`),record=JSON.parse(await readFile(path,'utf8'));const {createHash}=await import('node:crypto');record.after=value.restoring.config;record.afterHash=createHash('sha256').update(`file:${record.after}`).digest('hex');record.officialModelSlugs=['official-original'];await writeFile(path,JSON.stringify(record));}throw Error('synthetic restore interruption');}});
 expect((await f.post('/api/codex-accounts/restore',{revision:(await f.get('/api/codex-accounts')).revision,restoreHistory:false})).statusCode).toBe(500);spy.mockRestore();await f.restart();const restored=await f.post('/api/codex-accounts/restore',{revision:(await f.get('/api/codex-accounts')).revision,restoreHistory:false});expect(restored.statusCode,restored.body).toBe(200);expect(restored.json()).toMatchObject({backup:null,gatewayConnected:true,accountId:'original'});expect(await readFile(f.auth,'utf8')).toBe(f.originalAuth);expect((await f.get('/api/a2a')).targets.find((t:any)=>t.id==='codex').connection).toMatchObject({id:initial.id,keyId:initial.keyId,officialModelSlugs:['official-original']});
});
it('replaces a selected official model lost by the next account with the configured gateway default',async()=>{
 const f=await setup(),sourceA=f.service.proxy.snapshot().accounts.find(a=>a.models?.includes('codex/model-a'))!,sourceB=f.service.proxy.snapshot().accounts.find(a=>a.models?.includes('codex/model-b'))!;expect((await f.post('/api/codex-accounts/switch',{revision:(await f.get('/api/codex-accounts')).revision,sourceId:sourceA.id,model:sourceA.models![0],restoreHistory:false})).statusCode).toBe(200);await writeFile(f.config,(await readFile(f.config,'utf8')).replace('model = "codex/model-a"','model = "official-a"'));
 const switched=await f.post('/api/codex-accounts/switch',{revision:(await f.get('/api/codex-accounts')).revision,sourceId:sourceB.id,model:sourceB.models![0],restoreHistory:false});expect(switched.statusCode,switched.body).toBe(200);expect(parse(await readFile(f.config,'utf8')).model).toBe('codex/model-a');
});
it('preserves settings added by Codex before an account change when the gateway is later disconnected',async()=>{
 const f=await setup(),source=f.service.proxy.snapshot().accounts[0];await writeFile(f.config,await readFile(f.config,'utf8')+'\n[projects.fixture]\ntrust_level = "trusted"\n');expect((await f.post('/api/codex-accounts/switch',{revision:(await f.get('/api/codex-accounts')).revision,sourceId:source.id,model:source.models![0],restoreHistory:false})).statusCode).toBe(200);const target=(await f.get('/api/a2a')).targets.find((t:any)=>t.id==='codex');const restored=await f.post('/api/a2a/restore',{id:target.connection.id,revision:target.revision,restoreHistory:false});expect(restored.statusCode,restored.body).toBe(200);expect(parse(await readFile(f.config,'utf8')).projects).toEqual({fixture:{trust_level:'trusted'}});
});
it('keeps native routing, gateway key and bridge model routing together during a hybrid official account switch and restore',async()=>{
 const f=await setup(true),initial=(await f.get('/api/a2a')).targets.find((t:any)=>t.id==='codex').connection,routePath=join(f.root,'codex-direct-bridge/settings.json');
 const before=parse(await readFile(f.config,'utf8')) as any;
 const source=f.service.proxy.snapshot().accounts.find(a=>a.models?.includes('codex/model-a'))!;
 const switched=await f.post('/api/codex-accounts/switch',{revision:(await f.get('/api/codex-accounts')).revision,sourceId:source.id,model:'codex/model-a',restoreHistory:false});expect(switched.statusCode,switched.body).toBe(200);
 const config=parse(await readFile(f.config,'utf8')) as any;expect(config.model_provider).toBe('openai');expect(config.model).toBe('official-a');expect(config.model_providers).toEqual(before.model_providers);expect(JSON.parse(await readFile(routePath,'utf8')).officialModels).toEqual(['official-a']);
 const current=(await f.get('/api/a2a')).targets.find((t:any)=>t.id==='codex');expect(current.connection).toMatchObject({id:initial.id,keyId:initial.keyId,codexDirectHybrid:true,codexCoexist:false});
 const restored=await f.post('/api/codex-accounts/restore',{revision:(await f.get('/api/codex-accounts')).revision,restoreHistory:false});expect(restored.statusCode,restored.body).toBe(200);expect(await readFile(f.auth,'utf8')).toBe(f.originalAuth);expect(JSON.parse(await readFile(routePath,'utf8')).officialModels).toEqual(['official-original']);expect(parse(await readFile(f.config,'utf8')).model_provider).toBe('openai');
});
