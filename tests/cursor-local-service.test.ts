import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {expect,it,vi} from 'vitest';
import {createDesktopService} from '../packages/core/src/service.js';
it('protects local Cursor detection, shows reusable accounts and never exposes or creates credentials',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'cursor-status-api-')),path=join(root,'state.vscdb');
 const db=new DatabaseSync(path);db.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT)');db.prepare('INSERT INTO ItemTable VALUES (?,?)').run('cursorAuth/accessToken','private-native-token');db.close();
 const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async url=>{expect(String(url)).toBe('https://api2.cursor.sh/aiserver.v1.DashboardService/GetMe');return Response.json({email:'local@example.test'});});
 const service=await createDesktopService({root,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'internal',secrets:{get:async()=>'',set:async()=>{throw Error('Detection must never write credentials');}},cursorLocalPath:path,claudeCredentialStore:null});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'},url='/api/native-accounts/cursor';
 try{
  vi.spyOn(service.proxy.cursor,'snapshot').mockReturnValue({accounts:[{id:'a'.repeat(24),provider:'cursor',label:'local@example.test',status:'active',disabled:false,unavailable:false,models:[]}],models:[],quotas:{},login:undefined});
  expect((await service.app.inject({url,headers:{host:headers.host}})).statusCode).toBe(401);expect(fetcher).not.toHaveBeenCalled();
  const result=await service.app.inject({url,headers});expect(result.statusCode,result.body).toBe(200);expect(result.json()).toMatchObject({loginState:'signed-in',email:'local@example.test',readOnly:true,accounts:[{email:'local@example.test',switchable:false}]});expect(result.body).not.toMatch(/private-native-token|apiKey|accessToken/);
  await service.app.inject({url,headers});expect(fetcher).toHaveBeenCalledOnce();await service.app.inject({url:url+'?refresh=1',headers});expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await service.app.inject({url:url+'/switch',method:'POST',headers,payload:{}})).statusCode).toBe(400);
 }finally{await service.app.close();vi.restoreAllMocks();await rm(root,{recursive:true,force:true});}
});

it.each(['trae'] as const)('protects %s native detection and import while exposing only identity and models',async provider=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'native-readonly-api-'));
 const {createServer}=await import('node:net');const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 await mkdir(join(root,'cliproxy'));await writeFile(join(root,'cliproxy/fixture-options.json'),JSON.stringify({localCredentials:{[provider]:{type:provider,uid:'local-user',access_token:'private-native',refresh_token:'private-refresh'}}}));
 const service=await createDesktopService({root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'internal',secrets:{get:async()=>'',set:async()=>{}},claudeCredentialStore:null});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'},url='/api/native-accounts/'+provider;
 try{
  await service.proxy.start();expect((await service.app.inject({url,headers:{host:headers.host}})).statusCode).toBe(401);
  const before=await service.app.inject({url,headers});expect(before.json()).toMatchObject({readOnly:true,loginState:'signed-in',accounts:[]});expect(before.body).not.toMatch(/private-native|private-refresh|access_token|refresh_token/);
  const imported=await service.app.inject({url:'/api/local-agent/import-local/'+provider,method:'POST',headers,payload:{}});expect(imported.statusCode,imported.body).toBe(200);expect(imported.json().accounts[0].models).toEqual([provider+'/imported-model']);
  const after=await service.app.inject({url,headers});expect(after.json().accounts[0].accountId).toBe(after.json().accountId);expect(after.json().revision).toBe(before.json().revision);
  expect((await service.app.inject({url:url+'/switch',method:'POST',headers,payload:{}})).statusCode).toBe(400);
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});

it('rejects unsupported native ZCode detection and import before reading credentials or starting the gateway',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'zcode-native-unsupported-'));
 const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Native ZCode must not contact a provider'));
 const service=await createDesktopService({root,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'internal',secrets:{get:async()=>'',set:async()=>{throw Error('Unsupported native imports must not store credentials');}},claudeCredentialStore:null});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'},url='/api/native-accounts/zcode';
 try{
  expect((await service.app.inject({url,headers:{host:headers.host}})).statusCode).toBe(401);
  const detection=await service.app.inject({url,headers});expect(detection.statusCode).toBe(410);expect(detection.json().error).toContain('ZCode');
  const imported=await service.app.inject({url:'/api/local-agent/import-local/zcode',method:'POST',headers,payload:{}});expect(imported.statusCode,imported.body).toBe(400);expect(imported.json().code).toBe('local_agent_error');
  expect(imported.body).not.toMatch(/access_token|refresh_token|apiKey/);expect(service.proxy.snapshot().state).toBe('stopped');expect(fetcher).not.toHaveBeenCalled();
 }finally{await service.app.close();vi.restoreAllMocks();await rm(root,{recursive:true,force:true});}
});
