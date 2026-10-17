import {expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {createDesktopService} from '../packages/core/src/service.js';
it('authenticates desktop changes, scopes and revokes keys, and retains a recoverable config after reopening fails',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'claude-desktop-api-')),allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 await mkdir(join(root,'cliproxy/auth'),{recursive:true});await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'claude.json',provider:'claude',status:'active',models:['claude-sonnet-4-6','claude-opus-4-6']} ]));
 await writeFile(join(root,'cliproxy/auth/claude.json'),JSON.stringify({type:'claude',email:'fixture@example.test',access_token:'fixture-access',refresh_token:'fixture-refresh',expired:'2035-01-01T00:00:00Z'}));
 const vault=new Map<string,string>(),directory=join(root,'Claude-3p');let failOpen=false;
 const change=vi.fn(async(work:()=>Promise<unknown>)=>{await work();if(failOpen)throw Error('reopen fixture failure');});
 const service=await createDesktopService({root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'internal',secrets:{get:async n=>vault.get(n)??'',set:async(n,v)=>{vault.set(n,v);}},agentPaths:{qoder:join(root,'qoder/settings.json'),workbuddy:join(root,'workbuddy/models.json'),codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json')},agentProcesses:async()=>[],nativeProcesses:async()=>[],claudeCredentialStore:null,antigravityPath:join(root,'antigravity.db'),claudeDesktop:{directory,processes:async()=>[],policy:async()=>{}},claudeDesktopChange:change});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'},url='/api/claude-desktop';
 const status=async()=>(await service.app.inject({url,headers})).json();const keys=async()=>(await service.app.inject({url:'/api/gateway-keys',headers})).json().keys;
 try{
  await service.proxy.start();const sourceId=service.proxy.snapshot().accounts[0].id;const selections=[{sourceId,model:'claude/claude-sonnet-4-6'}];
  expect((await service.app.inject({url,headers:{host:headers.host}})).statusCode).toBe(401);
  let payload={revision:(await status()).revision,selections};
  expect((await service.app.inject({url:`${url}/connect`,method:'POST',headers:{...headers,origin:'https://evil.test'},payload})).statusCode).toBe(403);
  expect((await service.app.inject({url:`${url}/connect`,method:'POST',headers,payload:{...payload,selections:Array.from({length:201},(_,n)=>({sourceId,model:`claude/model-${n}`}))}})).statusCode).toBe(400);expect(change).not.toHaveBeenCalled();expect(await keys()).toEqual([]);
  expect((await service.app.inject({url:`${url}/connect`,method:'POST',headers,payload:{...payload,selections:[{sourceId,model:'codex/gpt-5'}]}})).statusCode).toBe(409);expect(change).not.toHaveBeenCalled();expect(await keys()).toEqual([]);
  const connected=await service.app.inject({url:`${url}/connect`,method:'POST',headers,payload});expect(connected.statusCode,connected.body).toBe(200);expect(connected.json().connected).toBe(true);expect(connected.body).not.toMatch(/fixture-access|fixture-refresh|tfl_/);
  const first=(await keys())[0];expect(first.agents).toEqual(['claude']);expect(first.models).toEqual(['claude/claude-sonnet-4-6']);expect(first.modelSources).toEqual({'claude/claude-sonnet-4-6':sourceId});
  const journal=JSON.parse(vault.get('native-login-claude-desktop')!),profile=JSON.parse(await readFile(join(directory,'configLibrary',`${journal.id}.json`),'utf8'));
  expect(profile.inferenceModels[0]).toMatchObject({name:'claude-sonnet-5',supports1m:true,prefer1m:true});expect(profile.inferenceGatewayBaseUrl).toBe('http://127.0.0.1:9527');expect(profile.coworkEgressAllowedHosts).toEqual(['*']);expect(profile.disableDeploymentModeChooser).toBe(true);expect(journal.modelAliases['claude-sonnet-5']).toBe('claude/claude-sonnet-4-6');expect(journal.modelAliases['claude-haiku-4-5']).toBe('claude/claude-sonnet-4-6');
  const inferenceHeaders={host:headers.host,authorization:`Bearer ${profile.inferenceGatewayApiKey}`,'user-agent':'Claude/2.42304.0','anthropic-version':'2023-06-01'};
  const message={model:'claude-sonnet-5',max_tokens:16,messages:[{role:'user',content:'fixture'}]};
  const inference=await service.app.inject({url:'/v1/messages',method:'POST',headers:inferenceHeaders,payload:message});expect(inference.statusCode,inference.body).toBe(200);expect(inference.json().content[0].text).toBe('claude');
  const stream=await service.app.inject({url:'/v1/messages',method:'POST',headers:inferenceHeaders,payload:{...message,stream:true}});expect(stream.statusCode,stream.body).toBe(200);expect(stream.body).toContain('message_stop');
  expect((await service.app.inject({url:'/v1/messages',method:'POST',headers:inferenceHeaders,payload:{...message,model:'claude-haiku-4-5'}})).statusCode).toBe(200);
  expect((await service.app.inject({url:'/v1/messages',method:'POST',headers:inferenceHeaders,payload:{...message,model:'claude/claude-opus-4-6'}})).statusCode).toBe(403);
  const usage=(await service.app.inject({url:'/api/gateway/usage?days=0',headers})).json().rows;expect(usage.length).toBeGreaterThan(0);expect(new Set(usage.map((row:{target:string})=>row.target))).toEqual(new Set(['claude-desktop']));
  expect((await service.app.inject({url:`${url}/connect`,method:'POST',headers,payload})).statusCode).toBe(409);expect(change).toHaveBeenCalledOnce();
  payload={revision:(await status()).revision,selections:[{sourceId,model:'claude/claude-opus-4-6'}]};failOpen=true;
  const replaced=await service.app.inject({url:`${url}/connect`,method:'POST',headers,payload});expect(replaced.statusCode,replaced.body).toBe(409);expect(replaced.json().error).toContain('已保存');expect((await status()).connected).toBe(true);expect(await keys()).toHaveLength(1);expect((await keys())[0].id).not.toBe(first.id);
  failOpen=false;const restored=await service.app.inject({url:`${url}/official`,method:'POST',headers,payload:{revision:(await status()).revision}});expect(restored.statusCode,restored.body).toBe(200);expect(restored.json()).toMatchObject({connected:false,backup:null,mode:'1p'});expect(restored.json().message).toContain('账号菜单');expect(await keys()).toEqual([]);await expect(readFile(join(directory,'claude_desktop_config.json'))).rejects.toHaveProperty('code','ENOENT');
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});
