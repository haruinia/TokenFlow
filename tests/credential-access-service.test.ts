import {expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {createDesktopService} from '../packages/core/src/service.js';
import type {CredentialReadOptions} from '../packages/core/src/claude-accounts.js';
it.each([false,true])('scopes native reads to explicit import in on-demand mode (%s)',async onDemand=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'credential-retry-api-')),allocator=createServer();await new Promise<void>(yes=>allocator.listen(0,'127.0.0.1',yes));const port=(allocator.address() as {port:number}).port;await new Promise<void>(yes=>allocator.close(()=>yes()));
 const qoderPath=join(root,'auth.v1.dat'),idePath=join(root,'state.vscdb');await writeFile(qoderPath,JSON.stringify({schemaVersion:1,user:{id:'fixture-user'},token:'fixture-token'}));
 const db=new DatabaseSync(idePath);db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY,value TEXT)');db.prepare('INSERT INTO ItemTable VALUES (?,?)').run('secret://aicoding.auth.userInfo',JSON.stringify(Buffer.from(JSON.stringify({id:'fixture-user',token:'fixture-token'}))));db.close();
 await mkdir(join(root,'claude'));await writeFile(join(root,'claude','.claude.json'),JSON.stringify({oauthAccount:{emailAddress:'fixture@example.test',accountUuid:'fixture-user',organizationUuid:'fixture-org'}}));
 const crypto=vi.fn(async(_op:'encrypt'|'decrypt',data:string)=>{if(denied)throw Error('fixture denied');return Buffer.from(data,'base64').toString();});let denied=true;
 let claudeDenied=true;
 const claudeRead=vi.fn(async(options?:CredentialReadOptions)=>{if(options?.retry)claudeDenied=false;if(claudeDenied)throw Object.assign(Error('fixture denied'),{statusCode:409});return JSON.stringify({claudeAiOauth:{accessToken:'fixture-token',refreshToken:'fixture-refresh',expiresAt:Date.parse('2035-01-01'),scopes:['user:inference']}});});
 if(onDemand){
  // These grants already belong to TokenFlow, independent of the unreadable external clients above.
  const saved=[{name:'saved-codex.json',provider:'codex',account_id:'saved-codex'},{name:'saved-qoder.json',provider:'qoder',uid:'saved-qoder'},
   {name:'saved-workbuddy.json',provider:'workbuddy',uid:'saved-domestic',domain:'copilot.tencent.com'},
   {name:'saved-workbuddy-ai.json',provider:'workbuddy',uid:'saved-international',domain:'www.workbuddy.ai'}];
  await mkdir(join(root,'cliproxy/auth'),{recursive:true});
  await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify(saved.map(a=>({...a,status:'active',models:['fixture-model']}))));
  for(const a of saved)await writeFile(join(root,'cliproxy/auth',a.name),JSON.stringify({...a,type:a.provider,access_token:'fixture-saved-access',refresh_token:'fixture-saved-refresh',id_token:'fixture-saved-id',expired:'2035-01-01T00:00:00Z'}));
 }
 const service=await createDesktopService({nativeCredentialsOnDemand:onDemand,root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'fixture-internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{codex:join(root,'codex','config.toml'),claude:join(root,'claude','settings.json'),qoder:join(root,'qoder','settings.json'),workbuddy:join(root,'workbuddy','settings.json')},agentProcesses:async()=>[],desktopProcesses:async()=>[],nativeProcesses:async()=>[],antigravityPath:join(root,'missing-antigravity.db'),cursorLocalPath:join(root,'missing-cursor'),claudeCredentialStore:{read:claudeRead,write:async()=>{throw Error('Unexpected fixture write');}},desktopAccounts:{paths:{qoder:qoderPath,workbuddy:join(root,'missing-cn'),'workbuddy-ai':join(root,'missing-ai')},crypto,fetch:async()=>new Response(JSON.stringify({id:'fixture-user'}))},qoderIde:{path:idePath,crypto,fetch:async()=>new Response(JSON.stringify({id:'fixture-user'}))}});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'};
 try{
  expect(crypto).toHaveBeenCalledTimes(onDemand?0:2);await service.discoverLocal();expect(crypto).toHaveBeenCalledTimes(onDemand?0:2);expect(claudeRead.mock.calls.every(([options])=>!options?.retry)).toBe(true);
  if(onDemand){
   await service.app.listen({host:'127.0.0.1',port:0});
   for(const url of ['/api/codex-accounts','/api/native-accounts/claude','/api/native-accounts/antigravity','/api/native-accounts/workbuddy','/api/native-accounts/workbuddy-ai','/api/native-accounts/cursor','/api/native-accounts/trae']){
    const response=await service.app.inject({url,headers});expect(response.statusCode,response.body).toBe(200);expect(response.json().loginState).toBe('not-inspected');
   }
   expect((await service.app.inject({url:'/api/a2a/codex-coexist',headers})).json().inspectionRequired).toBe(true);
   for(const provider of ['codex','qoder','workbuddy','workbuddy-ai']){
    const url=provider==='codex'?'/api/codex-accounts':`/api/native-accounts/${provider}`;
    const response=await service.app.inject({url,headers}),status=response.json();
    expect(status.loginState).toBe('not-inspected');expect(status.accounts).toHaveLength(1);
    expect(status.accounts[0].switchable).toBe(true);expect(status.email).toBeNull();expect(status.accountId).toBeNull();
    expect(status.message).toContain('已加载 TokenFlow 保存的账号');expect(response.body).not.toContain('fixture-saved-access');
   }
   expect((await service.app.inject({url:'/api/usage/overview',headers})).statusCode).toBe(200);
   await new Promise(done=>setTimeout(done,5100)); // Include one actual background observation tick.
   expect(crypto).not.toHaveBeenCalled();expect(claudeRead).not.toHaveBeenCalled();
  }
  denied=false;
  for(const target of ['qoder','qoder-ide']){
   const passive=await service.app.inject({url:`/api/native-accounts/${target}`,headers});expect(passive.json().loginState).toBe(onDemand?'not-inspected':'unreadable');
   const refreshed=await service.app.inject({url:`/api/native-accounts/${target}?refresh=1`,headers});expect(refreshed.json().loginState).toBe(onDemand?'not-inspected':'signed-in');
   const imported=await service.app.inject({url:`/api/local-agent/import-local/${target}`,method:'POST',headers,payload:{}});expect(imported.statusCode,imported.body).toBe(200);expect(imported.body).not.toContain('fixture-token');
   expect((await service.app.inject({url:`/api/native-accounts/${target}`,headers})).json().loginState).toBe('signed-in');
   if(onDemand)expect(claudeRead).not.toHaveBeenCalled();
  }
  expect(crypto).toHaveBeenCalledTimes(onDemand?2:4);
  expect((await service.app.inject({url:'/api/native-accounts/claude?refresh=1',headers})).statusCode).toBe(200);expect(claudeRead.mock.calls.some(([options])=>options?.retry)).toBe(!onDemand);
  claudeRead.mockClear();const imported=await service.app.inject({url:'/api/local-agent/import-local/claude',method:'POST',headers,payload:{}});expect(imported.statusCode,imported.body).toBe(200);expect(claudeRead.mock.calls.some(([options])=>options?.retry)).toBe(true);
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
},15000);
