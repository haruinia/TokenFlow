import {CodexSwitchLifecycle} from '../packages/core/src/codex-switch-lifecycle.js';
import {CodexContext} from '../packages/core/src/codex-context.js';
import {parse,stringify} from 'smol-toml';
import {CodexThreadMigration} from '../packages/core/src/codex-thread-migration.js';
import {DatabaseSync} from 'node:sqlite';
import { it,expect,vi,type MockInstance } from 'vitest';
import { mkdtemp,mkdir,writeFile,readFile,rm,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:net';
import {PiTerminalLifecycle} from '../packages/core/src/pi-terminal-lifecycle.js';
import {ClaudeTerminalLifecycle} from '../packages/core/src/claude-terminal-lifecycle.js';
import { QoderLifecycle } from '../packages/core/src/agent-lifecycle.js';
import { createDesktopService } from '../packages/core/src/service.js';
it('releases the configuration lock after a disconnected handler settles, but never during the write',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'a2a-disconnect-'));
 const service=await createDesktopService({root,antigravityPath:join(root,'isolated-antigravity.db'),binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),qoder:join(root,'qoder/settings.json'),workbuddy:join(root,'workbuddy/models.json')},agentProcesses:async()=>[]});
 let release!:()=>void;
 const restart=vi.spyOn(QoderLifecycle.prototype,'restart').mockResolvedValue({message:'opened'}).mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({message:'opened'});}));
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'};
 const invoke=()=>service.app.inject({method:'POST',url:'/api/a2a/restart',headers,payload:{target:'qoder'}});
 try{
  const url=await service.app.listen({port:0,host:'127.0.0.1'});
  const {request}=await import('node:http');
  const client=request(`${url}/api/a2a/restart`,{method:'POST',headers:{authorization:'Bearer admin','content-type':'application/json'}});
  client.on('error',()=>{});client.end(JSON.stringify({target:'qoder'}));
  await vi.waitFor(()=>expect(restart).toHaveBeenCalledTimes(1));
  const closed=new Promise<void>(resolve=>client.on('close',resolve));client.destroy();await closed;
  const blocked=await invoke();expect(blocked.statusCode).toBe(409);expect(blocked.json().code).toBe('configuration_busy');expect(restart).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(async()=>expect((await invoke()).statusCode).toBe(200));
  expect(restart).toHaveBeenCalledTimes(2);
 }finally{release?.();restart.mockRestore();await service.app.close();await rm(root,{recursive:true,force:true});}
});
it.each(['codex','claude'] as const)('%s reapplies explicitly over third-party routing with an exact backup and stale-write protection',async target=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'a2a-reapply-'));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const paths={codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),qoder:join(root,'qoder/settings.json'),workbuddy:join(root,'workbuddy/models.json')};
 await mkdir(join(root,'cliproxy'));await mkdir(join(root,target));
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'codex.json',provider:'codex',status:'active',models:['shared-model']}]));
 await writeFile(paths[target],target==='codex'?'model = "original"\n':'{}');
 const service=await createDesktopService({root,antigravityPath:join(root,'isolated-antigravity.db'),proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin-token',localKey:'internal-key',secrets:{get:async()=>'',set:async()=>{}},agentPaths:paths,agentProcesses:async()=>[]});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin-token'};
 const state=async()=>(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((item:{id:string})=>item.id===target);
 const connect=(payload:object)=>service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload});
 try{
  await service.proxy.start();const sourceId=service.proxy.snapshot().accounts[0].id,model='codex/shared-model';
  const first=await connect({target,sourceId,model,revision:(await state()).revision});expect(first.statusCode,first.body).toBe(200);
  const thirdParty=target==='codex'?{model:'third-party-model',model_provider:'third_party',approval_policy:'on-request',model_providers:{third_party:{name:'Third party',base_url:'https://fixture.invalid/v1',experimental_bearer_token:'third-party-secret'}},mcp_servers:{fixture:{command:'fixture-mcp'}}}:{model:'third-party-model',env:{ANTHROPIC_BASE_URL:'https://fixture.invalid',ANTHROPIC_AUTH_TOKEN:'third-party-secret',KEEP:'local-preference'},permissions:{defaultMode:'default'},mcpServers:{fixture:{command:'fixture-mcp'}}};
  const external=target==='codex'?stringify(thirdParty):JSON.stringify(thirdParty,null,2);
  await writeFile(paths[target],external);const changed=await state();expect(changed.configurationState).toBe('changed');
  if(target==='codex'){
   const previewURL=`/api/a2a/restore-preview/${first.json().id}`;
   expect((await service.app.inject({url:previewURL,headers:{host:headers.host}})).statusCode).toBe(401);
   const preview=await service.app.inject({url:previewURL,headers});
   expect(preview.json()).toMatchObject({canRestore:true,revision:changed.revision,destination:{kind:'official',provider:'openai'}});
   expect(preview.body).not.toContain('third-party-secret');
   const context=vi.spyOn(CodexContext.prototype,'prepareOfficial').mockResolvedValue({changed:0} as any);
   const history=vi.spyOn(CodexThreadMigration.prototype,'restore').mockResolvedValue({migrated:1});
   const lifecycle=vi.spyOn(CodexSwitchLifecycle.prototype,'change');
   try{
    const refused=await service.app.inject({method:'POST',url:'/api/a2a/restore',headers,payload:{id:first.json().id,revision:'0'.repeat(64),allowRunning:true,restartCodex:true}});
    expect(refused.statusCode,refused.body).toBe(409);
    expect(context).not.toHaveBeenCalled();expect(history).not.toHaveBeenCalled();expect(lifecycle).not.toHaveBeenCalled();
    expect(await readFile(paths[target],'utf8')).toBe(external);
   }finally{context.mockRestore();history.mockRestore();lifecycle.mockRestore();}
  }
  const payload={target,sourceId,model,replaceId:first.json().id,revision:changed.revision};
  const keysBefore=(await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.length;
  await writeFile(paths[target],external+'\n');
  expect((await connect({...payload,rewrite:true})).statusCode).toBe(409);
  expect(await readFile(paths[target],'utf8')).toBe(external+'\n');
  expect((await service.app.inject({url:'/api/gateway-keys',headers})).json().keys).toHaveLength(keysBefore);
  await writeFile(paths[target],external);
  // A background quota refresh must not block an explicit configuration repair.
  let release!:()=>void;
  const quota=vi.spyOn(service.proxy,'refreshQuota').mockImplementation(()=>new Promise(resolve=>{release=()=>resolve(service.proxy.snapshot());}));
  const refreshing=service.app.inject({method:'POST',url:'/api/local-agent/quota',headers}).then(value=>value);
  await vi.waitFor(()=>expect(quota).toHaveBeenCalled());
  let applied:Awaited<ReturnType<typeof connect>>;
  try{applied=await connect(payload);expect(applied.statusCode,applied.body).toBe(200);}
  finally{release();await refreshing;quota.mockRestore();}
  expect(applied.body).not.toContain('third-party-secret');expect(applied.body).not.toContain('tfl_');
  expect((await state()).configurationState).toBe('configured');
  const after=target==='codex'?parse(await readFile(paths[target],'utf8')):JSON.parse(await readFile(paths[target],'utf8'));
  if(target==='codex')expect(after).toMatchObject({model,model_provider:'token_flow',approval_policy:'on-request',model_providers:{third_party:thirdParty.model_providers!.third_party},mcp_servers:thirdParty.mcp_servers});
  else expect(after).toMatchObject({model,permissions:thirdParty.permissions,mcpServers:thirdParty.mcpServers,env:{KEEP:'local-preference',ANTHROPIC_BASE_URL:'http://127.0.0.1:9527'}});
  const backup=JSON.parse(await readFile(join(root,'agent-backups',`${applied.json().id}.json`),'utf8'));expect(backup.previousConfig).toBe(external);
  expect((await service.app.inject({url:'/api/gateway-keys',headers})).json().keys).toHaveLength(1);
  // Even a later third-party switch exits to native mode, never the pre-connection interface.
  await writeFile(paths[target],external);const leaving=await state();
  const restored=await service.app.inject({method:'POST',url:'/api/a2a/restore',headers,payload:{id:applied.json().id,revision:leaving.revision,allowRunning:true}});
  expect(restored.statusCode,restored.body).toBe(200);
  const native=target==='codex'?parse(await readFile(paths[target],'utf8')):JSON.parse(await readFile(paths[target],'utf8'));
  if(target==='codex'){expect(native.model_provider).toBe('openai');expect(native.model).toBeUndefined();expect(native.approval_policy).toBe('on-request');}
  else expect(native).toMatchObject({env:{KEEP:'local-preference'},permissions:thirdParty.permissions});
  expect(JSON.stringify(native)).not.toContain('third-party-model');
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});
it('connects and restores a local Agent through admin APIs without exposing keys or original config',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'a2a-service-'));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 await mkdir(join(root,'cliproxy'));await mkdir(join(root,'claude'));
 await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify([{name:'codex.json',provider:'codex',status:'active',models:['shared-model']}]));
 const path=join(root,'claude','settings.json');const original='{"env":{"KEEP":"private-original","ANTHROPIC_SMALL_FAST_MODEL":"volcengine_kimi-k3"}}';await writeFile(path,original);
 const service=await createDesktopService({root,desktopAccounts:{paths:{workbuddy:join(root,'native-cn.json'),'workbuddy-ai':join(root,'native-ai.json'),qoder:join(root,'native-qoder.dat')}},antigravityPath:join(root,'isolated-antigravity.db'),proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin-token',localKey:'internal-key',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{qoder:join(root,'qoder/settings.json'),codex:join(root,'codex','config.toml'),claude:path,workbuddy:join(root,'workbuddy','models.json')},agentProcesses:async()=>[]});
 try{
  await service.proxy.start();const headers={host:'127.0.0.1:9527',authorization:'Bearer admin-token'};
  expect((await service.app.inject({url:'/api/a2a',headers:{host:headers.host}})).statusCode).toBe(401);
  expect((await service.app.inject({method:'POST',url:'/api/a2a/program',headers:{host:headers.host},payload:{target:'pi',action:'install'}})).statusCode).toBe(401);
  expect((await service.app.inject({method:'POST',url:'/api/a2a/program',headers:{...headers,origin:'https://untrusted.test'},payload:{target:'pi',action:'install'}})).statusCode).toBe(403);
  expect((await service.app.inject({method:'POST',url:'/api/a2a/program',headers,payload:{target:'invalid',action:'install'}})).statusCode).toBe(400);
  const restart=vi.spyOn(QoderLifecycle.prototype,'restart').mockResolvedValue({message:'Qoder 已重新打开'});
  try{
   expect((await service.app.inject({method:'POST',url:'/api/a2a/restart',headers:{host:headers.host},payload:{target:'qoder'}})).statusCode).toBe(401);
   expect((await service.app.inject({method:'POST',url:'/api/a2a/restart',headers:{...headers,origin:'https://untrusted.test'},payload:{target:'qoder'}})).statusCode).toBe(403);
   expect((await service.app.inject({method:'POST',url:'/api/a2a/restart',headers,payload:{target:'invalid'}})).statusCode).toBe(400);
   expect(restart).not.toHaveBeenCalled();
   expect((await service.app.inject({method:'POST',url:'/api/a2a/restart',headers,payload:{target:'qoder'}})).statusCode).toBe(200);
   expect(restart).toHaveBeenCalledTimes(1);
   for(const target of ['codex','workbuddy','claude','deepseek']){
    const payload={target,...(target==='claude'?{client:'vscode'}:{})};
    expect((await service.app.inject({method:'POST',url:'/api/a2a/restart',headers,payload})).statusCode).toBe(200);
    expect(restart).toHaveBeenLastCalledWith(target);
   }
   const claudeRestart=vi.spyOn(ClaudeTerminalLifecycle.prototype,'restart').mockResolvedValue({message:'Claude Code 已打开'});
   try{expect((await service.app.inject({method:'POST',url:'/api/a2a/restart',headers,payload:{target:'claude',client:'terminal'}})).statusCode).toBe(200);expect(claudeRestart).toHaveBeenCalledWith(undefined);}finally{claudeRestart.mockRestore();}
   const piRestart=vi.spyOn(PiTerminalLifecycle.prototype,'restart').mockResolvedValue({message:'Pi 已重新打开'});try{expect((await service.app.inject({method:'POST',url:'/api/a2a/restart',headers,payload:{target:'pi'}})).statusCode).toBe(200);}finally{piRestart.mockRestore();}
   expect((await service.app.inject({url:'/api/a2a/program-updates',headers:{host:headers.host}})).statusCode).toBe(401);
   expect((await service.app.inject({url:'/api/a2a/terminal-sessions',headers:{host:headers.host}})).statusCode).toBe(401);
  }finally{restart.mockRestore();}
  await mkdir(join(root,'codex'));const credentials=JSON.stringify({tokens:{access_token:'fixture-access',refresh_token:'fixture-refresh',id_token:'x.e30.x',account_id:'fixture-account'}});await writeFile(join(root,'codex','auth.json'),credentials);
  await service.discoverLocal();expect(service.proxy.snapshot().accounts).toHaveLength(2);
  await service.proxy.importCredential('codex',{account_id:'fixture-account',access_token:'stale-copy'},true);expect(await readFile(join(root,'cliproxy','fixture-accounts.json'),'utf8')).not.toContain('stale-copy');
  const imported=await service.app.inject({method:'POST',url:'/api/a2a/import',headers,payload:{target:'codex'}});expect(imported.statusCode).toBe(200);expect(imported.body).not.toContain('fixture-access');expect(await readFile(join(root,'codex','auth.json'),'utf8')).toBe(credentials);
  const state=(await service.app.inject({url:'/api/a2a',headers})).json();const sourceId=service.proxy.snapshot().accounts[0].id;
  expect((await service.app.inject({method:'PUT',url:'/api/maintenance',headers,payload:{sourceId,model:'codex/shared-model'}})).statusCode).toBe(200);
  expect((await service.app.inject({method:'POST',url:'/api/maintenance/check',headers,payload:{}})).statusCode).toBe(200);
  await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().readiness.status).toBe('ready');
  const failed=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target:'claude',sourceId,model:'codex/shared-model',revision:'0'.repeat(64)}});expect(failed.statusCode).toBe(409);
  const journalled=(await service.app.inject({url:'/api/a2a',headers})).json();
  expect(journalled.switchFailures[0]).toMatchObject({action:'connect',target:'claude',model:'codex/shared-model',sourceId,message:'配置已变更，请刷新接入预览。'});
  expect(JSON.stringify(journalled.switchFailures)).not.toContain('tfl_');
  const response=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target:'claude',sourceId,model:'codex/shared-model',revision:state.targets[1].revision}});expect(response.statusCode).toBe(200);expect(response.body).not.toContain('tfl_');expect(response.body).not.toContain('private-original');
  const record=response.json();
  expect((await service.app.inject({method:'POST',url:'/api/maintenance/run',headers,payload:{prompt:`请 review 刚完成的 ${record.target} 接入（记录 ${record.id}），仅做只读检查。`,interfaceAgent:'workbuddy',chain:{target:'claude',sourceId,model:'codex/shared-model',connectionId:record.id}}})).statusCode).toBe(200);
  await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().status).toBe('completed');
  const care=(await service.app.inject({url:'/api/maintenance',headers})).json();expect(care.engine).toBe('pi');expect(care.messages.some((m:{role:string;text:string})=>m.role==='tool'&&m.text.includes('主模型可切换，子代理继承会话'))).toBe(true);expect(JSON.stringify(care)).not.toContain('tfl_');
  expect(care.chain).toMatchObject({target:'claude',sourceId,model:'codex/shared-model'});
  const inspection=JSON.parse(care.messages.find((m:{text:string})=>m.text.startsWith('只读预检: ')).text.slice('只读预检: '.length));
  expect(inspection.targets.map((t:{id:string})=>t.id)).toEqual(['claude']);expect(inspection.chain.sourceAvailable).toBe(true);expect(inspection.chain.matchesInstalled).toBe(true);expect(inspection.chain.source.id).toBe(sourceId);
  expect(inspection.selectedAgent).toBe('workbuddy');expect(inspection.latestSwitchFailure).toMatchObject({action:'connect',target:'claude',message:'配置已变更，请刷新接入预览。'});expect(inspection.selectedAgentSwitchFailure).toBeNull();expect(inspection.switchFailures[0].message).toContain('配置已变更');expect(JSON.stringify(inspection)).not.toContain('tfl_');
  const invalid=await service.app.inject({method:'POST',url:'/api/maintenance/run',headers,payload:{chain:{target:'workbuddy',connectionId:response.json().id}}});expect(invalid.statusCode).toBe(400);
  const automatic=await service.app.inject({method:'POST',url:'/api/maintenance/run',headers,payload:{chain:{target:'workbuddy',sourceId,model:'codex/shared-model'}}});expect(automatic.statusCode).toBe(200);
  await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().status).toBe('completed');
  const switched=(await service.app.inject({url:'/api/maintenance',headers})).json();expect(switched.messages.filter((m:{role:string})=>m.role==='user')).toHaveLength(1);expect(switched.chain.target).toBe('workbuddy');
  const config=JSON.parse(await readFile(path,'utf8'));expect(config.env.KEEP).toBe('private-original');expect(config.env.ANTHROPIC_AUTH_TOKEN).toMatch(/^tfl_/);
  const clientHeaders={host:headers.host,authorization:`Bearer ${config.env.ANTHROPIC_AUTH_TOKEN}`};expect((await service.app.inject({url:'/v1/models',headers:clientHeaders})).statusCode).toBe(200);
  const fast=await service.app.inject({method:'POST',url:'/v1/messages',headers:clientHeaders,payload:{model:config.env.ANTHROPIC_SMALL_FAST_MODEL,messages:[{role:'user',content:'OK'}],max_tokens:16}});expect(fast.statusCode,fast.body).toBe(200);
  const restored=await service.app.inject({method:'POST',url:'/api/a2a/restore',headers,payload:{id:response.json().id}});expect(restored.statusCode).toBe(200);expect(JSON.parse(await readFile(path,'utf8'))).toEqual({env:{KEEP:'private-original'}});expect((await service.app.inject({url:'/v1/models',headers:clientHeaders})).statusCode).toBe(401);
  const history=(await service.app.inject({url:'/api/a2a',headers})).json().targets[1];expect(history.connection).toBeNull();expect(history.backups[0]).toMatchObject({sourceId,model:'codex/shared-model',state:'restored'});
  const again=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target:'claude',sourceId:history.backups[0].sourceId,model:history.backups[0].model,revision:history.revision}});expect(again.statusCode,again.body).toBe(200);
  const nextConfig=JSON.parse(await readFile(path,'utf8'));await writeFile(path,'{"model":"reinstalled","userSetting":true}');
  const changed=(await service.app.inject({url:'/api/a2a',headers})).json().targets[1];const deletion={id:again.json().id,revision:changed.revision};
  expect((await service.app.inject({method:'POST',url:'/api/a2a/delete',headers:{host:headers.host},payload:deletion})).statusCode).toBe(401);
  expect((await service.app.inject({method:'POST',url:'/api/a2a/delete',headers,payload:{...deletion,revision:'0'.repeat(64)}})).statusCode).toBe(409);
  const deleted=await service.app.inject({method:'POST',url:'/api/a2a/delete',headers,payload:deletion});expect(deleted.statusCode,deleted.body).toBe(200);expect(deleted.body).not.toContain('tfl_');
  expect(await readFile(path,'utf8')).toBe('{"model":"reinstalled","userSetting":true}');expect((await service.app.inject({url:'/api/a2a',headers})).json().targets[1].connection).toBeNull();
  expect((await service.app.inject({url:'/v1/models',headers:{host:headers.host,authorization:`Bearer ${nextConfig.env.ANTHROPIC_AUTH_TOKEN}`}})).statusCode).toBe(401);

 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});

it('restores a saved maintenance model after discovery without probing on startup or status polling',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'care-startup-'));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 await mkdir(join(root,'cliproxy'));await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'qoder.json',provider:'qoder',status:'active',models:['shared-model']}]));
 const options={root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin-token',localKey:'internal-key',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{qoder:join(root,'qoder/settings.json'),codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),workbuddy:join(root,'workbuddy/models.json')},agentProcesses:async()=>[]};
 let service=await createDesktopService(options);const headers={host:'127.0.0.1:9527',authorization:'Bearer admin-token'};
 try{
  await service.proxy.start();const sourceId=service.proxy.snapshot().accounts[0].id;
  await service.app.inject({method:'PUT',url:'/api/maintenance',headers,payload:{sourceId,model:'qoder/shared-model'}});
  expect((await service.app.inject({url:'/api/maintenance',headers})).json().readiness.status).toBe('unchecked');
  await service.app.close();service=await createDesktopService(options);
  const sourceAuth=vi.spyOn(service.proxy,'sourceAuth');
  await service.discoverLocal();
  for(let i=0;i<5;i++)expect((await service.app.inject({url:'/api/maintenance',headers})).json()).toMatchObject({selection:{sourceId,model:'qoder/shared-model'},readiness:{status:'unchecked'}});
  expect(sourceAuth).not.toHaveBeenCalled();
  expect((await service.app.inject({url:'/api/gateway-keys',headers})).json().keys).toEqual([]);
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});

it('queues the selected replacement model for approval, preserves stale edits and revokes the superseded key',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'repair-service-'));const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 await mkdir(join(root,'cliproxy'));await mkdir(join(root,'workbuddy'));await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'qoder.json',provider:'qoder',status:'active',models:['old','new']}]));const path=join(root,'workbuddy/models.json');await writeFile(path,'[]');
 let running=false;
 const service=await createDesktopService({root,antigravityPath:join(root,'isolated-antigravity.db'),proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin-token',localKey:'internal-key',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{qoder:join(root,'qoder/settings.json'),codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),workbuddy:path},agentProcesses:async()=>running?[123]:[]});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin-token'};const post=(url:string,payload:Record<string,unknown>)=>service.app.inject({method:'POST',url,headers,payload});
 try{
  await service.proxy.start();const sourceId=service.proxy.snapshot().accounts[0].id;const state=(await service.app.inject({url:'/api/a2a',headers})).json();
  const connected=await post('/api/a2a/connect',{target:'workbuddy',sourceId,model:'qoder/old',revision:state.targets[2].revision});expect(connected.statusCode,connected.body).toBe(200);const oldKey=JSON.parse(await readFile(path,'utf8'))[0].apiKey;
  await fetch(`http://127.0.0.1:${port}/fixture`,{method:'POST',body:JSON.stringify({mode:'truncated-stream'})});
  await service.app.inject({method:'POST',url:'/v1/responses',headers:{host:headers.host,authorization:`Bearer ${oldKey}`},payload:{model:'qoder/old',input:'fixture',stream:true}});
  const uncertain=(await service.app.inject({url:'/api/gateway-keys',headers})).json().keys.find((k:{id:string})=>k.id===connected.json().keyId);expect(uncertain.tokenLimit).toBe(null);expect(uncertain.unmeteredRequests).toBeGreaterThan(0);
  await fetch(`http://127.0.0.1:${port}/fixture`,{method:'POST',body:JSON.stringify({mode:'wait'})});
  await writeFile(path,'[]');const chain={target:'workbuddy',sourceId,model:'qoder/new',connectionId:connected.json().id};
  const proposed=await post('/api/maintenance/propose',{chain});expect(proposed.statusCode,proposed.body).toBe(200);expect(proposed.json().status).toBe('pending');expect(proposed.json().code).toContain('qoder/new');expect(JSON.parse(proposed.json().code).tokenLimit).toBe(null);expect(proposed.body).not.toContain('tfl_');expect(JSON.parse(await readFile(path,'utf8'))).toEqual([]);
  await writeFile(path,'[{"id":"user-edit"}]');const stale=await post('/api/maintenance/approve',{id:proposed.json().id,approve:true});expect(stale.json().proposal.status).toBe('failed');expect(await readFile(path,'utf8')).toContain('user-edit');
  await writeFile(path,'[]');const fresh=await post('/api/maintenance/propose',{chain});const approved=await post('/api/maintenance/approve',{id:fresh.json().id,approve:true});expect(approved.json().proposal.status).toBe('completed');expect(JSON.parse(await readFile(path,'utf8'))[0].id).toBe('qoder/new');
  expect((await service.app.inject({url:'/v1/models',headers:{host:headers.host,authorization:`Bearer ${oldKey}`}})).statusCode).toBe(401);
  expect((await post('/api/maintenance/approve',{id:fresh.json().id,approve:true})).statusCode).toBe(409);
  running=true;const current=(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:{id:string})=>t.id==='workbuddy');
  expect((await post('/api/a2a/restore',{id:current.connection.id,allowRunning:true})).statusCode).toBe(400);
  expect((await post('/api/a2a/restore',{id:current.connection.id,allowRunning:true,revision:'0'.repeat(64)})).statusCode).toBe(409);
  const restore=await post('/api/a2a/restore',{id:current.connection.id,revision:current.revision,allowRunning:true});expect(restore.statusCode,restore.body).toBe(200);expect(JSON.parse(await readFile(path,'utf8'))).toEqual([]);
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});

it('blocks Codex migration while desktop runs, before creating a gateway key or modifying configuration',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'codex-migration-api-'));
 await mkdir(join(root,'codex'));await mkdir(join(root,'cliproxy'));await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'codex.json',provider:'codex',status:'active',models:['shared-model']} ]));
 const path=join(root,'codex/config.toml');await writeFile(path,'model="native-model"');
 const db=new DatabaseSync(join(root,'codex/state_5.sqlite'));db.exec("CREATE TABLE threads(id TEXT,model_provider TEXT,model TEXT,rollout_path TEXT,source TEXT,archived INTEGER);INSERT INTO threads VALUES ('old','openai','native-model','/unused','vscode',0)");db.close();
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const service=await createDesktopService({root,antigravityPath:join(root,'isolated-antigravity.db'),proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{codex:path,claude:join(root,'claude/settings.json'),qoder:join(root,'qoder/settings.json'),workbuddy:join(root,'workbuddy/models.json')},agentProcesses:async target=>target==='codex'?[123]:[]});
 try{await service.proxy.start();const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'};
  const state=(await service.app.inject({url:'/api/a2a',headers})).json();const target=state.targets.find((t:{id:string})=>t.id==='codex');const sourceId=service.proxy.snapshot().accounts[0].id;
  const response=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target:'codex',sourceId,model:'codex/shared-model',revision:target.revision,allowRunning:true}});
  expect(response.statusCode).toBe(409);expect(response.json().code).toBe('codex_exit_required');expect(await readFile(path,'utf8')).toBe('model="native-model"');
  expect((await service.app.inject({url:'/api/a2a/codex-migration',headers})).json()).toMatchObject({backups:0,remaining:0});
  expect((await service.app.inject({method:'POST',url:'/api/a2a/codex-migration/restore',headers:{host:headers.host}})).statusCode).toBe(401);
  expect((await service.app.inject({method:'POST',url:'/api/a2a/codex-migration/restore',headers:{...headers,origin:'https://untrusted.test'}})).statusCode).toBe(403);
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});

it('passes the new key authorization set to Codex migration when replacing gateway selections',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'codex-model-replace-api-'));
 await mkdir(join(root,'codex'));await mkdir(join(root,'cliproxy'));
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'codex.json',provider:'codex',status:'active',models:['old','retained','replacement']}]));
 const path=join(root,'codex/config.toml');await writeFile(path,'model="native-model"');
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const service=await createDesktopService({root,antigravityPath:join(root,'isolated-antigravity.db'),proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{codex:path,claude:join(root,'claude/settings.json'),qoder:join(root,'qoder/settings.json'),workbuddy:join(root,'workbuddy/models.json')},agentProcesses:async()=>[]});
 const migrate=vi.spyOn(CodexThreadMigration.prototype,'migrate');
 try{await service.proxy.start();const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'};const sourceId=service.proxy.snapshot().accounts[0].id;
  const state=async()=>(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:{id:string})=>t.id==='codex');
  const connect=async(model:string,models:string[])=>{const target=await state();return service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target:'codex',sourceId,model,revision:target.revision,replaceId:target.connection?.id,selections:models.map(model=>({sourceId,model}))}});};
  const first=await connect('codex/old',['codex/old','codex/retained']);expect(first.statusCode,first.body).toBe(200);
  const clientKey=async()=>((parse(await readFile(path,'utf8')).model_providers as any).token_flow.experimental_bearer_token as string);
  const oldKey=await clientKey();
  const second=await connect('codex/replacement',['codex/replacement','codex/retained']);expect(second.statusCode,second.body).toBe(200);
  expect(migrate).toHaveBeenLastCalledWith('codex/replacement',['codex/replacement','codex/retained']);
  const models=await service.app.inject({url:'/v1/models',headers:{host:headers.host,authorization:`Bearer ${await clientKey()}`}});
  expect(models.statusCode).toBe(200);expect(models.json().data.map((m:{id:string})=>m.id).sort()).toEqual(['codex/replacement','codex/retained'].sort());
  const keyHeaders={host:headers.host,authorization:`Bearer ${await clientKey()}`};
  for(const model of ['replacement','retained']){
   const response=await service.app.inject({method:'POST',url:'/v1/responses',headers:keyHeaders,payload:{model,input:'hello'}});
   expect(response.statusCode,response.body).toBe(200);expect(response.headers['x-token-flow-model']).toBe(`codex/${model}`);
  }
  for(const model of ['old','unknown','other/retained'])expect((await service.app.inject({method:'POST',url:'/v1/responses',headers:keyHeaders,payload:{model,input:'hello'}})).statusCode).toBe(403);
  expect((await service.app.inject({url:'/v1/models',headers:{host:headers.host,authorization:`Bearer ${oldKey}`}})).statusCode).toBe(401);
 }finally{migrate.mockRestore();await service.app.close();await rm(root,{recursive:true,force:true});}
});


it('performs the confirmed Codex stop, backup, change and relaunch in a single admin request',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'codex-auto-switch-api-'));
 await mkdir(join(root,'codex'));await mkdir(join(root,'cliproxy'));
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'codex.json',provider:'codex',status:'active',models:['shared-model']}]));
 const path=join(root,'codex/config.toml');await writeFile(path,'model="native-model"');
 const authPath=join(root,'codex/auth.json'),auth=JSON.stringify({tokens:{access_token:'fixture-official',refresh_token:'fixture-refresh'}});await writeFile(authPath,auth);
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 let pids=[123];const events:string[]=[];
 const lifecycle=new CodexSwitchLifecycle(async()=>pids,async()=>{events.push('stop');pids=[];},async()=>{events.push('open');return {message:'opened'};},'darwin',async()=>{});
 const change=CodexSwitchLifecycle.prototype.change;
 const restart=vi.spyOn(CodexSwitchLifecycle.prototype,'change').mockImplementation(work=>change.call(lifecycle,work));
 const prepare=CodexThreadMigration.prototype.prepare;
 const backup=vi.spyOn(CodexThreadMigration.prototype,'prepare').mockImplementation(async function(this:CodexThreadMigration,...args){expect(pids).toEqual([]);events.push('backup');return prepare.apply(this,args);});
 const migrate=CodexThreadMigration.prototype.migrate;
 const migration=vi.spyOn(CodexThreadMigration.prototype,'migrate').mockImplementation(async function(this:CodexThreadMigration,...args){expect(pids).toEqual([]);events.push('migrate');return migrate.apply(this,args);});
 const service=await createDesktopService({root,antigravityPath:join(root,'isolated-antigravity.db'),proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{codex:path,claude:join(root,'claude/settings.json'),qoder:join(root,'qoder/settings.json'),workbuddy:join(root,'workbuddy/models.json')},agentProcesses:async target=>target==='codex'?pids:[]});
 try{
  await service.proxy.start();const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'};const sourceId=service.proxy.snapshot().accounts[0].id;
  const state=async()=>(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:{id:string})=>t.id==='codex');
  const target=await state();expect(target.codexRoutingMode).toBe('official');const payload={target:'codex',sourceId,model:'codex/shared-model',revision:target.revision,allowRunning:true,restartCodex:true,codexCoexist:false};
  const stale=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{...payload,revision:'0'.repeat(64)}});expect(stale.statusCode).toBe(409);expect(events).toEqual([]);
  const connected=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload});expect(connected.statusCode,connected.body).toBe(200);
  expect(events).toEqual(['stop','backup','migrate','open']);expect(await readFile(path,'utf8')).toContain('codex/shared-model');
  expect(await readFile(authPath,'utf8')).toBe(auth);
  const gatewayConfig=parse(await readFile(path,'utf8')) as any;
  expect(gatewayConfig.model_providers.token_flow).toMatchObject({base_url:'http://127.0.0.1:9527/v1',requires_openai_auth:false});
  expect(gatewayConfig.model_providers.token_flow.capabilities).toBeUndefined();
  pids=[123];events.length=0;const current=await state();expect(current.codexRoutingMode).toBe('gateway');
  const restored=await service.app.inject({method:'POST',url:'/api/a2a/restore',headers,payload:{id:current.connection.id,revision:current.revision,allowRunning:true,restartCodex:true}});
  expect(restored.statusCode,restored.body).toBe(200);expect(events).toEqual(['stop','open']);expect(parse(await readFile(path,'utf8'))).toEqual({model_provider:'openai'});
  expect(await readFile(authPath,'utf8')).toBe(auth);
  const direct=await state();expect(direct.codexRoutingMode).toBe('official');expect(direct.connection).toBeNull();expect(direct.backups[0].state).toBe('restored');
  // Restarting alone must not trigger history conversion or another backup.
  const session=join(root,'codex/sessions/rollout-legacy.jsonl');await mkdir(join(root,'codex/sessions'));
  await writeFile(session,JSON.stringify({type:'response_item',payload:{type:'reasoning',id:'rs_chatcmpl_legacy',encrypted_content:'',summary:[{type:'summary_text',text:'retained summary'}]}})+'\n');
  pids=[123];events.length=0;
  const reopened=await service.app.inject({method:'POST',url:'/api/a2a/restart',headers,payload:{target:'codex'}});
  expect(reopened.statusCode,reopened.body).toBe(200);expect(events).toEqual(['stop','open']);expect(await readFile(session,'utf8')).toContain('encrypted_content');expect(await readFile(session,'utf8')).toContain('retained summary');
 }finally{restart.mockRestore();backup.mockRestore();migration.mockRestore();await service.app.close();await rm(root,{recursive:true,force:true});}
});

it.each(['/api/a2a/restore','/api/a2a/codex-migration/restore'])('never removes the provider through %s until persisted routes have been restored',async route=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'config-only-restore-'));
 await mkdir(join(root,'codex'));await mkdir(join(root,'cliproxy'));
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'codex.json',provider:'codex',status:'active',models:['shared-model']}]));
 const path=join(root,'codex/config.toml'),original='model="native-model"';await writeFile(path,original);
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const service=await createDesktopService({root,antigravityPath:join(root,'isolated-antigravity.db'),proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{codex:path,claude:join(root,'claude/settings.json'),qoder:join(root,'qoder/settings.json'),workbuddy:join(root,'workbuddy/models.json')},agentProcesses:async()=>[]});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'};
 let history:MockInstance<CodexThreadMigration['restore']>|undefined,context:MockInstance<CodexContext['prepareOfficial']>|undefined;
 try{
  await service.proxy.start();
  const state=async()=>(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:{id:string})=>t.id==='codex');
  const target=await state();
  const connected=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target:'codex',sourceId:service.proxy.snapshot().accounts[0].id,model:'codex/shared-model',revision:target.revision}});
  expect(connected.statusCode,connected.body).toBe(200);
  history=vi.spyOn(CodexThreadMigration.prototype,'restore').mockRejectedValue(new Error('history unavailable'));
  context=vi.spyOn(CodexContext.prototype,'prepareOfficial').mockRejectedValue(new Error('cannot back up history'));
  const current=await state();
  // A failed compatibility pass or route migration keeps the provider definition.
  const optional=await service.app.inject({method:'POST',url:route,headers,payload:{...(route==='/api/a2a/restore'?{id:current.connection.id,revision:current.revision}:{}),restoreHistory:true}});
  expect(optional.statusCode).toBe(500);expect((await state()).connection.id).toBe(current.connection.id);
  context.mockClear();history.mockClear();
  const payload={...(route==='/api/a2a/restore'?{id:current.connection.id,revision:current.revision}:{}),restoreHistory:false};
  const failed=await service.app.inject({method:'POST',url:route,headers,payload});
  expect(failed.statusCode).toBe(500);expect((await state()).connection.id).toBe(current.connection.id);
  expect(await readFile(path,'utf8')).toContain('token_flow');expect(context).not.toHaveBeenCalled();expect(history).toHaveBeenCalled();
  history.mockResolvedValue({migrated:1});
  const restored=await service.app.inject({method:'POST',url:route,headers,payload});
  expect(restored.statusCode,restored.body).toBe(200);expect(parse(await readFile(path,'utf8'))).toEqual({model_provider:'openai'});expect((await state()).connection).toBeNull();
 }finally{history?.mockRestore();context?.mockRestore();await service.app.close();await rm(root,{recursive:true,force:true});}
});

it('records the real switch error when the client only sees an internal failure',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'switch-failure-'));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const restore=vi.spyOn(CodexThreadMigration.prototype,'restore').mockRejectedValue(Object.assign(new Error('旧对话缺失 tfl_secretvalue Bearer raw-token\n    at hidden'),{code:'ENOENT'}));
 const service=await createDesktopService({root,antigravityPath:join(root,'isolated-antigravity.db'),proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),qoder:join(root,'qoder/settings.json'),workbuddy:join(root,'workbuddy/models.json')},agentProcesses:async()=>[]});
 try{
  const headers={host:'127.0.0.1:9527',authorization:'Bearer admin'};
  const response=await service.app.inject({method:'POST',url:'/api/a2a/codex-migration/restore',headers,payload:{restoreHistory:true}});
  expect(response.statusCode).toBe(500);expect(response.json().error).toBe('Internal runner error');
  const failures=(await service.app.inject({url:'/api/a2a',headers})).json().switchFailures;
  expect(failures[0]).toMatchObject({action:'migration-restore',target:'codex',code:'ENOENT',message:'旧对话缺失 [key] Bearer [token]'});
  expect(JSON.stringify(failures)).not.toContain('tfl_');expect(JSON.stringify(failures)).not.toContain('raw-token');expect(JSON.stringify(failures)).not.toContain('at hidden');
 }finally{restore.mockRestore();await service.app.close();await rm(root,{recursive:true,force:true});}
});

it('repairs disconnected gateway conversations using the currently selected official model',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'disconnected-repair-'));
 const configPath=join(root,'codex/config.toml');await mkdir(join(root,'codex'));await writeFile(configPath,'model_provider = "openai"\nmodel = "official-selected"\n');
 const restore=vi.spyOn(CodexThreadMigration.prototype,'restore').mockImplementation(async model=>{expect(typeof model).toBe('function');expect(await (model as ()=>Promise<string>)()).toBe('official-selected');return {migrated:2};});
 const service=await createDesktopService({root,antigravityPath:join(root,'isolated-antigravity.db'),binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin',localKey:'internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{codex:configPath},agentProcesses:async()=>[]});
 try{const response=await service.app.inject({method:'POST',url:'/api/a2a/codex-migration/restore',headers:{host:'127.0.0.1:9527',authorization:'Bearer admin'},payload:{restoreHistory:true}});expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({migrated:2});expect(await readFile(configPath,'utf8')).toContain('official-selected');}
 finally{restore.mockRestore();await service.app.close();await rm(root,{recursive:true,force:true});}
});

it('applies retained models while their source is unavailable without moving them to another account',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'a2a-optional-cleanup-'));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 await mkdir(join(root,'cliproxy'));await mkdir(join(root,'claude'));
 const accounts=[{name:'codex.json',provider:'codex',status:'active',models:['retained-model','new-model']}];
 await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify(accounts));
 await writeFile(join(root,'claude','settings.json'),'{}');
 const service=await createDesktopService({root,antigravityPath:join(root,'isolated-antigravity.db'),proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin-token',localKey:'internal-key',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{qoder:join(root,'qoder/settings.json'),codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),workbuddy:join(root,'workbuddy/models.json')},agentProcesses:async()=>[]});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin-token'};
 try{
  await service.proxy.start();const sourceId=service.proxy.snapshot().accounts[0].id;
  const apply=async(selections:Array<{sourceId:string;model:string}>)=>{
   const state=(await service.app.inject({url:'/api/a2a',headers})).json();const target=state.targets.find((item:{id:string})=>item.id==='claude');
   return service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target:'claude',...selections[0],selections,revision:target.revision,replaceId:target.connection?.id}});
  };
  const original={sourceId,model:'codex/retained-model'};
  expect((await apply([original])).statusCode).toBe(200);
  await fetch(`http://127.0.0.1:${port}/fixture`,{method:'POST',body:JSON.stringify({accounts:accounts.map(account=>({...account,unavailable:true}))})});
  await service.proxy.refreshAccounts();
  const exported=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'offline selection',models:[original.model],modelSources:{[original.model]:sourceId},agents:['openai'],tokenLimit:null}});
  expect(exported.statusCode,exported.body).toBe(200);
  const expanded=await apply([original,{sourceId,model:'codex/new-model'}]);
  expect(expanded.statusCode,expanded.body).toBe(200);
  await fetch(`http://127.0.0.1:${port}/fixture`,{method:'POST',body:JSON.stringify({accounts:[]})});await service.proxy.refreshAccounts();
  const keptKey=await service.app.inject({method:'PUT',url:`/api/gateway-keys/${exported.json().key.id}/models`,headers,payload:{selections:[original]}});
  expect(keptKey.statusCode,keptKey.body).toBe(200);expect(keptKey.json().modelSources).toEqual({[original.model]:sourceId});
  const retained=await apply([original]);expect(retained.statusCode,retained.body).toBe(200);expect(retained.json().selections).toEqual([original]);
  const state=(await service.app.inject({url:'/api/a2a',headers})).json();expect(state.targets.find((item:{id:string})=>item.id==='claude').connection.selections).toEqual([original]);
  const saved=JSON.parse(await readFile(join(root,'claude/settings.json'),'utf8'));
  const unavailable=await service.app.inject({method:'POST',url:'/v1/messages',headers:{host:headers.host,authorization:`Bearer ${saved.env.ANTHROPIC_AUTH_TOKEN}`},payload:{model:original.model,messages:[{role:'user',content:'hello'}],max_tokens:10}});
  expect(unavailable.statusCode).toBe(503);
  const forged=await apply([{sourceId:'f'.repeat(24),model:original.model}]);expect(forged.statusCode).toBe(409);
  const unknown=await apply([{sourceId,model:'codex/never-authorized'}]);expect(unknown.statusCode).toBe(409);
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
},30000);
