import {expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {createDesktopService} from '../packages/core/src/service.js';
import type {CredentialReadOptions} from '../packages/core/src/claude-accounts.js';
it('keeps automatic discovery passive after denied reads and exposes explicit native refresh/import retry',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'credential-retry-api-')),allocator=createServer();await new Promise<void>(yes=>allocator.listen(0,'127.0.0.1',yes));const port=(allocator.address() as {port:number}).port;await new Promise<void>(yes=>allocator.close(()=>yes()));
 const qoderPath=join(root,'auth.v1.dat'),idePath=join(root,'state.vscdb');await writeFile(qoderPath,JSON.stringify({schemaVersion:1,user:{id:'fixture-user'},token:'fixture-token'}));
 const db=new DatabaseSync(idePath);db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY,value TEXT)');db.prepare('INSERT INTO ItemTable VALUES (?,?)').run('secret://aicoding.auth.userInfo',JSON.stringify(Buffer.from(JSON.stringify({id:'fixture-user',token:'fixture-token'}))));db.close();
 await mkdir(join(root,'claude'));await writeFile(join(root,'claude','.claude.json'),JSON.stringify({oauthAccount:{emailAddress:'fixture@example.test',accountUuid:'fixture-user',organizationUuid:'fixture-org'}}));
 const crypto=vi.fn(async(_op:'encrypt'|'decrypt',data:string)=>{if(denied)throw Error('fixture denied');return Buffer.from(data,'base64').toString();});let denied=true;
 let claudeDenied=true;
 const claudeRead=vi.fn(async(options?:CredentialReadOptions)=>{if(options?.retry)claudeDenied=false;if(claudeDenied)throw Object.assign(Error('fixture denied'),{statusCode:409});return JSON.stringify({claudeAiOauth:{accessToken:'fixture-token',refreshToken:'fixture-refresh',expiresAt:Date.parse('2035-01-01'),scopes:['user:inference']}});});
 const service=await createDesktopService({root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'fixture-internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{codex:join(root,'codex','config.toml'),claude:join(root,'claude','settings.json'),qoder:join(root,'qoder','settings.json'),workbuddy:join(root,'workbuddy','settings.json')},agentProcesses:async()=>[],desktopProcesses:async()=>[],nativeProcesses:async()=>[],antigravityPath:join(root,'missing-antigravity.db'),cursorLocalPath:join(root,'missing-cursor'),claudeCredentialStore:{read:claudeRead,write:async()=>{throw Error('Unexpected fixture write');}},desktopAccounts:{paths:{qoder:qoderPath,workbuddy:join(root,'missing-cn'),'workbuddy-ai':join(root,'missing-ai')},crypto,fetch:async()=>new Response(JSON.stringify({id:'fixture-user'}))},qoderIde:{path:idePath,crypto,fetch:async()=>new Response(JSON.stringify({id:'fixture-user'}))}});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'};
 try{
  expect(crypto).toHaveBeenCalledTimes(2);await service.discoverLocal();expect(crypto).toHaveBeenCalledTimes(2);expect(claudeRead.mock.calls.every(([options])=>!options?.retry)).toBe(true);
  denied=false;
  for(const target of ['qoder','qoder-ide']){
   const passive=await service.app.inject({url:`/api/native-accounts/${target}`,headers});expect(passive.json().loginState).toBe('unreadable');
   const refreshed=await service.app.inject({url:`/api/native-accounts/${target}?refresh=1`,headers});expect(refreshed.json().loginState).toBe('signed-in');
   const imported=await service.app.inject({url:`/api/local-agent/import-local/${target}`,method:'POST',headers,payload:{}});expect(imported.statusCode,imported.body).toBe(200);expect(imported.body).not.toContain('fixture-token');
  }
  expect(crypto).toHaveBeenCalledTimes(4);
  expect((await service.app.inject({url:'/api/native-accounts/claude?refresh=1',headers})).statusCode).toBe(200);expect(claudeRead.mock.calls.some(([options])=>options?.retry)).toBe(true);
  claudeRead.mockClear();const imported=await service.app.inject({url:'/api/local-agent/import-local/claude',method:'POST',headers,payload:{}});expect(imported.statusCode,imported.body).toBe(200);expect(claudeRead.mock.calls.some(([options])=>options?.retry)).toBe(true);
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});
