import {expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {parse} from 'smol-toml';
import {createDesktopService} from '../packages/core/src/service';

it('applies and restores Codex with duplicate TOML through HTTP, without leaking the malformed preimage',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'client-config-repair-'));
 const allocator=createServer();await new Promise<void>(done=>allocator.listen(0,'127.0.0.1',done));const port=(allocator.address() as {port:number}).port;await new Promise<void>(done=>allocator.close(()=>done()));
 const paths={codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),qoder:join(root,'qoder/settings.json'),workbuddy:join(root,'workbuddy/models.json')};
 await mkdir(join(root,'cliproxy'),{recursive:true});await mkdir(dirname(paths.codex),{recursive:true});
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'fixture.json',provider:'codex',status:'active',models:['shared-model']}]));
 const malformed='model="bad"\n[model_providers.fixture]\nexperimental_bearer_token="private-damaged-key"\n[model_providers.fixture]\nbase_url="https://fixture.invalid"\n';
 await writeFile(paths.codex,malformed);
 const service=await createDesktopService({root,antigravityPath:join(root,'isolated-antigravity.db'),proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:paths,agentProcesses:async()=>[]});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'};
 const state=async()=>(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((item:{id:string})=>item.id==='codex');
 try{
  await service.proxy.start();const sourceId=service.proxy.snapshot().accounts[0].id,model='codex/shared-model';
  const connected=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target:'codex',revision:(await state()).revision,sourceId,model}});
  expect(connected.statusCode,connected.body).toBe(200);expect(connected.json().recovery.strategy).toBe('minimal');expect(connected.body).not.toContain('private-damaged-key');expect(connected.json().verification.checks.every((check:{ok:boolean})=>check.ok)).toBe(true);
  expect(parse(await readFile(paths.codex,'utf8'))).toMatchObject({model_provider:'token_flow',model});
  await writeFile(paths.codex,malformed);
  const preview=await service.app.inject({url:`/api/a2a/restore-preview/${connected.json().id}`,headers});
  expect(preview.json()).toMatchObject({canRestore:true,recovery:{strategy:'backup'},destination:{kind:'official',provider:'openai'}});expect(preview.body).not.toContain('private-damaged-key');
  const restored=await service.app.inject({method:'POST',url:'/api/a2a/restore',headers,payload:{id:connected.json().id,revision:preview.json().revision,allowRunning:true,restoreHistory:false}});
  expect(restored.statusCode,restored.body).toBe(200);expect(parse(await readFile(paths.codex,'utf8')).model_provider).toBe('openai');expect((await state()).connection).toBeNull();
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});

it('keeps the official account restore HTTP entry available when current Codex TOML is malformed',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'client-login-repair-'));
 const paths={codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),qoder:join(root,'qoder/settings.json'),workbuddy:join(root,'workbuddy/models.json')};await mkdir(dirname(paths.codex),{recursive:true});
 const original='model="native"\napproval_policy="on-request"\n';await writeFile(paths.codex,original);
 const {CodexAccounts}=await import('../packages/core/src/codex-accounts');
 const manager=new CodexAccounts(root,paths.codex,async()=>[],{managed:async()=>[],loginStatus:async()=>'ok'});
 const token=`x.${Buffer.from(JSON.stringify({email:'fixture@example.test'})).toString('base64url')}.x`;
 await manager.switch({revision:(await manager.status()).revision,allowRunning:false,model:'codex/selected'},{account_id:'fixture',access_token:'fixture-access',refresh_token:'fixture-refresh',id_token:token});
 const malformed='[duplicate]\nx=1\n[duplicate]\nx=2\n';await writeFile(paths.codex,malformed);
 const service=await createDesktopService({root,antigravityPath:join(root,'isolated-antigravity.db'),binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:paths,agentProcesses:async()=>[]});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'};
 try{
  const status=await service.app.inject({url:'/api/codex-accounts',headers});expect(status.statusCode,status.body).toBe(200);expect(status.json()).toMatchObject({loginState:'unreadable',backup:{state:'applied'}});
  const restored=await service.app.inject({method:'POST',url:'/api/codex-accounts/restore',headers,payload:{revision:status.json().revision,restoreHistory:false}});
  expect(restored.statusCode,restored.body).toBe(200);expect(parse(await readFile(paths.codex,'utf8'))).toEqual(parse(original));expect(restored.json().backup).toBeNull();expect(restored.body).not.toContain('fixture-refresh');
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});
