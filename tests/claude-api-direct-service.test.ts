import {expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {createDesktopService} from '../packages/core/src/service.js';

it('uses saved per-model Messages routes without probes and restores API, gateway and official account settings',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-claude-direct-')),home=join(root,'claude');await mkdir(home);
 const config=join(home,'settings.json'),profile=join(home,'.claude.json');const original={model:'sonnet',permissions:{allow:['Read']},env:{KEEP_ME:'yes'}};
 await writeFile(config,JSON.stringify(original));await writeFile(profile,JSON.stringify({oauthAccount:{emailAddress:'original@example.test',accountUuid:'original',organizationUuid:'org'}}));
 let credentials:string|null=JSON.stringify({claudeAiOauth:{accessToken:'original-access',refreshToken:'original-refresh',expiresAt:Date.parse('2035-01-01'),scopes:['user:inference']}});let calls=0;
 const originalCredentials=credentials,originalProfile=await readFile(profile,'utf8');
 const upstream=createServer((_req,res)=>{calls++;res.writeHead(500);res.end('Unexpected request');});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));const baseURL=`http://127.0.0.1:${(upstream.address() as {port:number}).port}`;
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const proxyPort=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const secrets=new Map<string,string>(),service=await createDesktopService({root,nativeCredentialsOnDemand:true,token:'admin',localKey:'relay',proxyPort,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),agentProcesses:async()=>[],nativeProcesses:async()=>[],claudeCredentialStore:{read:async()=>credentials,write:async value=>{credentials=value;}},agentPaths:{codex:join(root,'codex/config.toml'),claude:config,qoder:join(root,'qoder.json'),pi:join(root,'pi.json'),deepseek:join(root,'deepseek.yml'),workbuddy:join(root,'workbuddy.json'),'workbuddy-ai':join(root,'workbuddy-ai.json')},secrets:{persistent:true,get:async id=>secrets.get(id)??'',set:async(id,value)=>{secrets.set(id,value);},remove:async id=>{secrets.delete(id);}}});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'},post=(url:string,payload:Record<string,unknown>)=>service.app.inject({method:'POST',url,headers,payload});
 const status=async()=>(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:any)=>t.id==='claude');
 try{
  await service.proxy.start();
  const added=await post('/api/sources',{name:'Fixture',baseURL:baseURL+'/default/v1',protocol:'chat',models:['vendor/fast'],modelRoutes:{'vendor/fast':{protocol:'messages',baseURL:baseURL+'/tenant/anthropic/v1'}},apiKey:'synthetic-claude-key'});expect(added.statusCode,added.body).toBe(200);
  const source=added.json(),selection={sourceId:source.id,model:'vendor/fast'};
  const choices=await service.app.inject({url:'/api/a2a/claude-api',headers});expect(choices.json().choices).toContainEqual(expect.objectContaining({sourceId:selection.sourceId,models:['vendor/fast'],available:true}));expect(choices.body).not.toContain('synthetic-claude-key');
  const applied=await post('/api/a2a/claude-api/apply',{...selection,revision:(await status()).revision});expect(applied.statusCode,applied.body).toBe(200);
  const direct=JSON.parse(await readFile(config,'utf8'));expect(direct.env).toMatchObject({ANTHROPIC_BASE_URL:baseURL+'/tenant/anthropic',ANTHROPIC_API_KEY:'synthetic-claude-key',ANTHROPIC_AUTH_TOKEN:'',KEEP_ME:'yes'});expect(direct.model).toBe('vendor/fast');expect(direct.permissions).toEqual(original.permissions);expect(credentials).toBe(originalCredentials);expect(await readFile(profile,'utf8')).toBe(originalProfile);expect(calls).toBe(0);
  const stale=await post('/api/a2a/claude-api/apply',{...selection,revision:'0'.repeat(64)});expect(stale.statusCode).toBe(409);expect(JSON.parse(await readFile(config,'utf8'))).toEqual(direct);
  expect((await post('/api/a2a/claude-api/restore',{revision:(await status()).revision})).statusCode).toBe(200);expect(JSON.parse(await readFile(config,'utf8'))).toEqual(original);
  expect((await post('/api/a2a/claude-api/apply',{...selection,revision:(await status()).revision})).statusCode).toBe(200);
  const gateway=await post('/api/a2a/connect',{target:'claude',...selection,model:`api-${source.id}/vendor/fast`,revision:(await status()).revision,allowRunning:true});expect(gateway.statusCode,gateway.body).toBe(200);expect((await status()).claudeApiDirect).toBeNull();expect(JSON.stringify(JSON.parse(await readFile(config,'utf8')))).not.toContain('synthetic-claude-key');
  expect((await post('/api/a2a/claude-api/apply',{...selection,revision:(await status()).revision})).statusCode).toBe(200);expect((await status()).connection).toBeNull();
  expect((await post('/api/a2a/claude-api/restore',{revision:(await status()).revision})).statusCode).toBe(200);expect(JSON.parse(await readFile(config,'utf8'))).toEqual({permissions:original.permissions,env:original.env});
  await service.proxy.importCredential('claude',{type:'claude',email:'saved@example.test',account_uuid:'saved',organization_uuid:'org',access_token:'saved-access',refresh_token:'saved-refresh',expired:'2035-01-01T00:00:00Z'});
  const saved=service.proxy.snapshot().accounts.find(a=>a.provider==='claude')!;expect(saved).toBeDefined();
  expect((await post('/api/a2a/claude-api/apply',{...selection,revision:(await status()).revision})).statusCode).toBe(200);
  const native=(await post('/api/native-accounts/claude/inspect',{})).json();expect(native.gatewayConnected).toBe(true);
  const switched=await post('/api/native-accounts/claude/switch',{revision:native.revision,sourceId:saved.id});expect(switched.statusCode,switched.body).toBe(200);expect((await status()).claudeApiDirect).toBeNull();expect(await readFile(config,'utf8')).not.toContain('synthetic-claude-key');
  expect((await post('/api/a2a/claude-api/apply',{...selection,revision:(await status()).revision})).statusCode).toBe(200);
  const latest=(await post('/api/native-accounts/claude/inspect',{})).json();const restored=await post('/api/native-accounts/claude/restore',{revision:latest.revision});expect(restored.statusCode,restored.body).toBe(200);expect((await status()).claudeApiDirect).toBeNull();expect(JSON.parse(await readFile(profile,'utf8')).oauthAccount.accountUuid).toBe('original');expect(calls).toBe(0);
 }finally{await service.app.close();upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));await rm(root,{recursive:true,force:true});}
},30000);
