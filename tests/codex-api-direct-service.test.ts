import {expect,it,vi} from 'vitest';
import {CodexThreadMigration} from '../packages/core/src/codex-thread-migration.js';
import {CodexApiAccess} from '../packages/core/src/codex-api-access.js';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {parse} from 'smol-toml';
import {createDesktopService} from '../packages/core/src/service.js';

it('applies API direct, restores official settings before unified gateway, and preserves login',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-direct-service-')),home=join(root,'codex');await mkdir(home);const config=join(home,'config.toml'),auth=join(home,'auth.json');
 await writeFile(config,'model="official-test"\nmodel_provider="openai"\n');
 const jwt=Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'synthetic'}})).toString('base64url');const authText=JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:`x.${jwt}.x`,id_token:`x.${jwt}.x`,account_id:'synthetic'}});await writeFile(auth,authText);
 let inferenceRequests=0;
 const upstream=createServer(async(req,res)=>{
  if(req.url==='/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'third-party',context_window:200000,supported_reasoning_levels:['low','max'],default_reasoning_level:'max'}]}));return;}
  inferenceRequests++;let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);const nonce=JSON.stringify(body.input).match(/value ([a-f0-9]{12})/)?.[1]??'OK';
  expect(req.headers.authorization).toBe('Bearer synthetic-api-key');
  const output=body.tools?.length&&!body.input.some((item:any)=>item.type==='function_call_output')?[{type:'function_call',name:'tokenflow_probe',call_id:'call_test',arguments:JSON.stringify({value:nonce})}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:nonce}]}];
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({type:'response.completed',response:{status:'completed',output,usage:{input_tokens:5,output_tokens:2,total_tokens:7}}})}\n\n`);
 });await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const proxyPort=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const secrets=new Map<string,string>();const service=await createDesktopService({root,token:'admin',localKey:'relay',proxyPort,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),agentProcesses:async()=>[],agentPaths:{codex:config,claude:join(root,'claude.json'),qoder:join(root,'qoder.json'),pi:join(root,'pi.json'),deepseek:join(root,'deepseek.yml'),workbuddy:join(root,'workbuddy.json'),'workbuddy-ai':join(root,'workbuddy-ai.json')},secrets:{persistent:true,get:async id=>secrets.get(id)??'',set:async(id,value)=>{secrets.set(id,value);},remove:async id=>{secrets.delete(id);}},codexOfficialFetch:async()=>Response.json({models:[{slug:'official-test',display_name:'Official',visibility:'list',supported_in_api:true,priority:0,context_window:272000,base_instructions:'Synthetic',truncation_policy:{mode:'bytes',limit:10000},supported_reasoning_levels:[]}]})});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'},post=(url:string,payload:any)=>service.app.inject({method:'POST',url,headers,payload});
 const status=async()=>(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:any)=>t.id==='codex');
 try{
  await service.proxy.start();const added=await post('/api/sources',{name:'Fixture',baseURL:`http://127.0.0.1:${(upstream.address() as {port:number}).port}`,protocol:'responses',models:['third-party'],apiKey:'synthetic-api-key'});expect(added.statusCode,added.body).toBe(200);const source=added.json(),selected={sourceId:source.id,model:'third-party'};
  expect((await post(`/api/sources/${source.id}/models`,{})).statusCode).toBe(200);
  expect((await service.app.inject({url:'/api/a2a/codex-api',headers})).json().choices).toContainEqual(expect.objectContaining({sourceId:source.id,models:['third-party'],available:true}));
  const apiState=async()=>(await service.app.inject({url:'/api/a2a/codex-api',headers})).json();
  const applied=await post('/api/a2a/codex-api/apply',{...selected,revision:(await apiState()).revision});expect(applied.statusCode,applied.body).toBe(200);
  expect(parse(await readFile(config,'utf8')).model_provider).toBe('custom');
  const direct:any=parse(await readFile(config,'utf8'));expect(direct.model_provider).toBe('custom');expect(direct.forced_login_method).toBeUndefined();expect(await readFile(auth,'utf8')).toBe(authText);
  expect(JSON.parse(await readFile(direct.model_catalog_json,'utf8')).models[0]).toMatchObject({context_window:200000,default_reasoning_level:'max',supported_reasoning_levels:[{effort:'low'},{effort:'max'}]});
  const gateway=await post('/api/a2a/connect',{target:'codex',...selected,model:`api-${source.id}/third-party`,revision:(await status()).revision,codexCoexist:true});expect(gateway.statusCode,gateway.body).toBe(200);
  const unified:any=parse(await readFile(config,'utf8'));expect(unified.model_provider).toBe('token_flow');expect(unified.model_providers.token_flow.requires_openai_auth).toBe(true);expect(unified.forced_login_method).toBeUndefined();expect(unified.preferred_auth_method).toBeUndefined();expect(JSON.stringify(unified)).not.toContain('synthetic-api-key');expect(await readFile(auth,'utf8')).toBe(authText);expect((await status()).codexApiDirect).toBeNull();
  expect(JSON.parse(await readFile(unified.model_catalog_json,'utf8')).models.find((m:any)=>m.slug===`api-${source.id}/third-party`)).toMatchObject({default_reasoning_level:'max',supported_reasoning_levels:[{effort:'low'},{effort:'max'}],multi_agent_version:'v1'});
  const historyRestore=vi.spyOn(CodexThreadMigration.prototype,'restore');
  const again=await post('/api/a2a/codex-api/apply',{sourceId:source.id,revision:(await apiState()).revision});expect(again.statusCode,again.body).toBe(200);expect((await status()).connection).not.toBeNull();
  expect(historyRestore).not.toHaveBeenCalled();historyRestore.mockRestore();
  const restored=await post('/api/a2a/codex-api/restore',{revision:(await apiState()).revision});expect(restored.statusCode,restored.body).toBe(200);expect(parse(await readFile(config,'utf8')).model_provider).toBe('openai');expect(await readFile(auth,'utf8')).toBe(authText);
  const inactive=await post('/codex/inactive/v1/responses',{model:'third-party',input:'synthetic private prompt'});
  expect(inactive.statusCode).toBe(400);expect(inactive.json().error.code).toBe('api_direct_inactive');expect(inactive.body).not.toContain('synthetic private prompt');
  const malformed=await service.app.inject({url:'/codex/inactive/v1/responses',method:'POST',headers:{...headers,'content-type':'application/json'},payload:'not-json'});
  expect(malformed.json().error.code).toBe('api_direct_inactive');
  expect(inferenceRequests).toBe(0);
  const second=(await post('/api/sources',{name:'Other',baseURL:'https://other.example.test/v1',protocol:'responses',models:['other'],apiKey:'other-fixture-key'})).json();
  const selections=[{...selected,model:`api-${source.id}/third-party`},{sourceId:second.id,model:`api-${second.id}/other`}];
  const mixed=await post('/api/a2a/connect',{target:'codex',...selections[0],selections,revision:(await status()).revision,codexCoexist:true});expect(mixed.statusCode,mixed.body).toBe(200);
  const blocked=await service.app.inject({method:'DELETE',url:`/api/sources/${source.id}`,headers,payload:{}});expect(blocked.statusCode).toBe(409);
  expect((await post('/api/a2a/codex-api/apply',{sourceId:second.id,revision:(await apiState()).revision})).statusCode).toBe(200);
  const removed=await service.app.inject({method:'DELETE',url:`/api/sources/${source.id}`,headers,payload:{cascade:true}});expect(removed.statusCode,removed.body).toBe(200);
  const activeApi:any=parse(await readFile(config,'utf8'));expect(activeApi.model_provider).toBe('custom');expect(activeApi.model_providers.custom.experimental_bearer_token).toBe('other-fixture-key');
  const overlay=new CodexApiAccess(root,config,async()=>[]);await overlay.restore(await overlay.revision());
  const retained=await status();expect(retained.connection.selections).toEqual([selections[1]]);expect(retained.drift).toBe(false);
  const retainedKey=(await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.find((key:any)=>key.id===retained.connection.keyId);
  expect(retainedKey.models).toContain(selections[1].model);expect(retainedKey.models).not.toContain(selections[0].model);expect(Object.values(retainedKey.modelSources??{})).not.toContain(source.id);
  const retainedConfig:any=parse(await readFile(config,'utf8')),retainedCatalog=JSON.parse(await readFile(retainedConfig.model_catalog_json,'utf8'));
  expect(retainedConfig.model).toBe(selections[1].model);expect(retainedCatalog.models.some((m:any)=>m.slug===selections[0].model)).toBe(false);expect(retainedCatalog.models.some((m:any)=>m.slug==='official-test')).toBe(true);
  expect(JSON.stringify(retainedConfig.developer_instructions)).not.toContain(selections[0].model);
  const retired:any=parse(await readFile(config,'utf8'));
  expect(JSON.stringify(retired)).not.toContain('synthetic-api-key');expect(retired.model_providers.custom.base_url).toContain('/codex/inactive/');
  expect((await post('/api/a2a/codex-api/apply',{sourceId:second.id,revision:(await apiState()).revision})).statusCode).toBe(200);
  const removeActive=await service.app.inject({method:'DELETE',url:`/api/sources/${second.id}`,headers,payload:{cascade:true}});expect(removeActive.statusCode,removeActive.body).toBe(200);
  expect((await apiState()).active).toBeNull();expect(await readFile(config,'utf8')).not.toContain('other-fixture-key');
  expect(inferenceRequests).toBe(0);
 }finally{await service.app.close();upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));await rm(root,{recursive:true,force:true});}
},60000);
