import {expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {createDesktopService} from '../packages/core/src/service.js';

it('keeps Desktop API/official/gateway separate, sends no probes, revokes relay keys and detaches deleted sources',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'tf-desktop-direct-')),directory=join(root,'Claude-3p'),cli=join(root,'claude/settings.json');await mkdir(join(root,'claude'));
 await writeFile(cli,'{"model":"cli-unchanged"}');let calls=0,failOpen=false,changes=0;
 const upstream=createServer((_req,res)=>{calls++;res.writeHead(500);res.end();});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));const baseURL=`http://127.0.0.1:${(upstream.address() as {port:number}).port}`;
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const proxyPort=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const vault=new Map<string,string>(),service=await createDesktopService({root,token:'admin',localKey:'relay',proxyPort,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),nativeCredentialsOnDemand:true,agentProcesses:async()=>[],nativeProcesses:async()=>[],claudeCredentialStore:null,antigravityPath:join(root,'anti.db'),agentPaths:{codex:join(root,'codex/config.toml'),claude:cli,qoder:join(root,'qoder.json'),workbuddy:join(root,'workbuddy.json')},claudeDesktop:{directory,processes:async()=>[],policy:async()=>{}},claudeDesktopChange:async work=>{changes++;await work();if(failOpen)throw Error('reopen failed');},secrets:{persistent:true,get:async n=>vault.get(n)??'',set:async(n,v)=>{vault.set(n,v);}}});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'},base='/api/a2a/claude-desktop-api';
 const get=async(url=base)=>(await service.app.inject({url,headers})).json(),post=(url:string,payload:unknown)=>service.app.inject({url,headers,method:'POST',payload:payload as any});
 try{
  await service.proxy.start();
  const saved=await post('/api/sources',{name:'Direct fixture',baseURL:baseURL+'/tenant/v1',protocol:'messages',models:['claude-sonnet-4-6','deepseek-chat','claude-haiku-4-5'],apiKey:'fixture-secret'});expect(saved.statusCode,saved.body).toBe(200);const sourceId=saved.json().id;
  const state=await get();expect(state.choices).toContainEqual(expect.objectContaining({sourceId,models:['claude-sonnet-4-6','claude-haiku-4-5'],available:true}));
  expect((await post(base+'/apply',{revision:state.revision,sourceId,model:'deepseek-chat'})).statusCode).toBe(409);expect(changes).toBe(0);
  expect((await service.app.inject({url:base,headers:{host:headers.host}})).statusCode).toBe(401);
  const apply=async()=>post(base+'/apply',{revision:(await get()).revision,sourceId});
  let response=await apply();expect(response.statusCode,response.body).toBe(200);expect(response.body).not.toContain('fixture-secret');expect(response.json().apiDirect.configured).toBe(true);
  let journal=JSON.parse(vault.get('native-login-claude-desktop')!),profile=JSON.parse(await readFile(join(directory,'configLibrary',journal.id+'.json'),'utf8'));
  expect(profile.inferenceModels.map((m:any)=>m.name)).toEqual(['claude-sonnet-4-6','claude-haiku-4-5']);expect(profile.inferenceGatewayBaseUrl).toBe(baseURL+'/tenant');
  expect((await get('/api/gateway-keys')).keys).toEqual([]);expect(calls).toBe(0);
  const stale=await post(base+'/apply',{revision:state.revision,sourceId});expect(stale.statusCode).toBe(409);expect(changes).toBe(1);
  response=await post('/api/claude-desktop/connect',{revision:(await get()).revision,selections:[{sourceId,model:`api-${sourceId}/claude-sonnet-4-6`}]});expect(response.statusCode,response.body).toBe(200);expect(response.json().apiDirect).toBeNull();expect((await get('/api/gateway-keys')).keys).toHaveLength(1);
  response=await apply();expect(response.statusCode,response.body).toBe(200);expect((await get('/api/gateway-keys')).keys).toEqual([]);
  response=await post('/api/claude-desktop/official',{revision:(await get()).revision});expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({mode:'1p',apiDirect:null});
  failOpen=true;response=await apply();expect(response.statusCode).toBe(409);expect(response.json().error).toContain('已保存');expect((await get()).active.configured).toBe(true);failOpen=false;
  response=await post(base+'/restore',{revision:(await get()).revision});expect(response.statusCode,response.body).toBe(200);expect((await get()).active).toBeNull();
  await apply();response=await service.app.inject({url:`/api/sources/${sourceId}`,headers,method:'DELETE',payload:{cascade:true}});expect(response.statusCode,response.body).toBe(200);expect((await get()).active).toBeNull();
  expect(await readFile(cli,'utf8')).toBe('{"model":"cli-unchanged"}');expect(calls).toBe(0);
  await expect(readFile(join(root,'codex/config.toml'))).rejects.toHaveProperty('code','ENOENT');
 }finally{await service.app.close();upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));await rm(root,{recursive:true,force:true});}
},30000);
