import {mapNativeAccounts} from '../packages/core/src/usage-attribution.js';
import {nativeIdentity,type LocalUsageRow} from '../packages/core/src/local-usage.js';
import {createHash} from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm,realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { CLIProxyManager, validateAuthorizationURL } from '../packages/core/src/cliproxy.js';
import { createDesktopService } from '../packages/core/src/service.js';
import {quotaProviders} from '../packages/core/src/quota/index.js';
import {loginProviderSchema} from '../packages/core/src/login/index.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const fn of cleanup.splice(0).reverse()) await fn();});
const binary = resolve('tests/fixtures/fake-cliproxy.mjs');
it('preserves shared context capacity fields without inferring unknown or malformed windows',async()=>{
 const {manager,root}=await setup();await mkdir(join(root,'cliproxy'),{recursive:true});
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([
  {name:'capacity.json',provider:'workbuddy',status:'active',models:[{id:'canonical',context_length:123456,context_window:234567,inputTokenLimit:345678},{id:'legacy',context_window:234567},{id:'gemini-shape',inputTokenLimit:345678},{id:'unknown'},{id:'malformed',context_length:0,context_window:'bad',inputTokenLimit:-1}]},
 ]));
 await manager.start();const models=manager.snapshot().models;
 for(const [id,window] of [['canonical',123456],['legacy',234567],['gemini-shape',345678],['unknown',undefined],['malformed',undefined]] as const){
  expect(models.find(m=>m.id===`workbuddy/${id}`),id).toBeDefined();expect(models.find(m=>m.id===`workbuddy/${id}`)?.contextWindow,id).toBe(window);
 }
});
it('preserves official image declarations without overriding Qoder as text-only',async()=>{
 const {manager,root}=await setup();
 await mkdir(join(root,'cliproxy'),{recursive:true});
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([
  {name:'workbuddy.json',provider:'workbuddy',status:'active',auth_index:'wb',models:[{id:'deepseek-v4.1-flash',supportedInputModalities:['TEXT','IMAGE']},{id:'text-only',supportedInputModalities:['text']},{id:'unknown'}]},
  {name:'qoder.json',provider:'qoder',status:'active',auth_index:'qd',models:[{id:'vision-base-model',supportedInputModalities:['text','image']}]},
 ]));
 await manager.start();const models=manager.snapshot().models;
 expect(models.find(m=>m.id==='workbuddy/deepseek-v4.1-flash')?.capabilities?.images).toBe(true);
 expect(models.find(m=>m.id==='workbuddy/text-only')?.capabilities?.images).toBe(false);
 expect(models.find(m=>m.id==='workbuddy/unknown')?.capabilities).toBeUndefined();
 expect(models.find(m=>m.id==='qoder/vision-base-model')?.capabilities?.images).toBe(true);
});
it('identifies WorkBuddy and Qoder accounts from safe stored metadata when sidecar labels are generic',async()=>{
 const {manager,root}=await setup();
 await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 const files=[{name:'workbuddy.json',provider:'workbuddy',label:'workbuddy',status:'active',auth_index:'wb'},{name:'qoder.json',provider:'qoder',label:'qoder',status:'active',auth_index:'qd'}];
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify(files));
 await writeFile(join(root,'cliproxy/auth/workbuddy.json'),JSON.stringify({nickname:'测试用户',uid:'wb-account',access_token:'private-token-not-for-display'}));
 await writeFile(join(root,'cliproxy/auth/qoder.json'),JSON.stringify({uid:'019eaf51-474e-76c9-b09f-78bb444e8b1b',access_token:'private-token-not-for-display'}));
 await manager.start();
 expect(manager.snapshot().accounts.find(a=>a.provider==='workbuddy')?.label).toBe('测试用户');
 expect(manager.snapshot().accounts.find(a=>a.provider==='qoder')?.label).toBe('账号 019eaf51…444e8b1b');
 expect(manager.snapshot().accounts.find(a=>a.provider==='qoder')?.nativeClients).toEqual(['qoder','qoder-ide']);
 expect(manager.snapshot().accounts.find(a=>a.provider==='workbuddy')?.nativeClients).toEqual(['workbuddy']);
 expect(JSON.stringify(manager.snapshot().accounts)).not.toContain('private-token-not-for-display');
 const qoder=manager.snapshot().accounts.find(a=>a.provider==='qoder')!;
 await writeFile(join(root,'account-labels.json'),JSON.stringify({[qoder.id]:'personal@example.test'}));
 await manager.refreshAccounts();
 expect(manager.snapshot().accounts.find(a=>a.id===qoder.id)?.label).toBe('personal@example.test');
 expect(JSON.parse(await readFile(join(root,'cliproxy/auth/qoder.json'),'utf8')).email).toBeUndefined();
});
it('keeps product eligibility independent of enabled state and local client login',async()=>{
 const {manager,root}=await setup();
 await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 const files=[{name:'cn.json',provider:'workbuddy',status:'active',disabled:true},{name:'ai.json',provider:'workbuddy',status:'active'},{name:'unknown.json',provider:'workbuddy',status:'active'}];
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify(files));
 for(const [name,domain] of [['cn','https://www.workbuddy.cn/'],['ai','www.workbuddy.ai'],['unknown','unknown.test']])await writeFile(join(root,'cliproxy/auth',`${name}.json`),JSON.stringify({email:`${name}@example.test`,domain}));
 await manager.start();
 const accounts=manager.snapshot().accounts;
 expect(accounts.find(a=>a.label==='cn@example.test')).toMatchObject({disabled:true,nativeClients:['workbuddy']});
 expect(accounts.find(a=>a.label==='ai@example.test')?.nativeClients).toEqual(['workbuddy-ai']);
 expect(accounts.find(a=>a.label==='unknown@example.test')?.nativeClients).toEqual([]);
});
async function setup(timeout = 5000) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cliproxy-login-')));
  cleanup.push(() => rm(root, {recursive: true, force: true}));
  const server = createServer();await new Promise<void>((r,j) => {server.once('error',j);server.listen(0,'127.0.0.1',r);});
  const port=(server.address() as {port:number}).port;await new Promise<void>(r => server.close(() => r()));
  const opened: string[] = [];
  const manager=new CLIProxyManager(root,binary,'fixture-key',port,{openExternal:async url => {opened.push(url);},pollIntervalMs:20,loginTimeoutMs:timeout});
  cleanup.push(() => manager.shutdown());
  const fixture=async(body?: unknown) => (await fetch(`http://127.0.0.1:${port}/fixture`, {method:body?'POST':'GET',body:body?JSON.stringify(body):undefined})).json();
  return {manager,root,port,opened,fixture};
}
it('resolves Qoder email from its own official profile without changing credentials or accepting another account',async()=>{
 const {manager,root,fixture}=await setup();
 await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 const files=[
  {name:'qoder-personal.json',provider:'qoder',label:'qoder',status:'active',auth_index:'personal',profile:{id:'personal-id',email:'personal@example.test',access_token:'must-not-persist'}},
  {name:'qoder-other.json',provider:'qoder',label:'qoder',status:'active',auth_index:'other',profile:{id:'wrong-id',email:'wrong@example.test'}},
  {name:'qoder-personal-disabled.json',provider:'qoder',label:'qoder',status:'active',disabled:true,auth_index:'personal-disabled',profile:{}},
 ];
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify(files));
 const credential=JSON.stringify({uid:'personal-id',access_token:'private-token-not-for-display'});
 await writeFile(join(root,'cliproxy/auth/qoder-personal.json'),credential);
 await writeFile(join(root,'cliproxy/auth/qoder-personal-disabled.json'),credential);
 await writeFile(join(root,'cliproxy/auth/qoder-other.json'),JSON.stringify({uid:'other-id',access_token:'other-token'}));
 await manager.start();
 expect(manager.snapshot().accounts.map(a=>a.label)).toEqual(['personal@example.test','账号 other-id','personal@example.test']);
 expect(await readFile(join(root,'cliproxy/auth/qoder-personal.json'),'utf8')).toBe(credential);
 const cached=await readFile(join(root,'qoder-profiles.json'),'utf8');
 expect(cached).toContain('personal@example.test');expect(cached).not.toMatch(/must-not-persist|private-token|wrong@example/);
 const usageAccounts=await manager.nativeUsageAccounts(),personal=usageAccounts.find(a=>a.accountId==='personal-id')!;
 expect(personal.email).toBe('personal@example.test');
 const native:LocalUsageRow={day:'2026-10-21',target:'qoder-ide',keyId:'native:fixture',keyName:'官方登录',sourceId:'',model:'qoder/model',origin:'native',provider:'qoder',channel:'official',nativeAccountId:nativeIdentity('qoder','personal-id'),nativeEmailHash:nativeIdentity('email','personal@example.test'),nativeAccountEvidence:'login-snapshot',requests:1,failed:0,unmeasured:0,inputTokens:100,cachedTokens:80,cacheBaseTokens:100,outputTokens:10,durationMs:0,last:'2026-10-21T01:00:00Z'};
 expect(mapNativeAccounts([native],usageAccounts)[0].sourceId).toBe(personal.id);
 for(const changed of [{nativeEmailHash:nativeIdentity('email','different@example.test')},{nativeAccountId:nativeIdentity('qoder','different-uid')},{provider:'claude',nativeAccountId:nativeIdentity('claude','personal-id')}])expect(mapNativeAccounts([{...native,...changed}],usageAccounts)[0].sourceId).toBe('');
 await writeFile(join(root,'qoder-profiles.json'),'{invalid');
 expect(mapNativeAccounts([native],await manager.nativeUsageAccounts())[0].sourceId).toBe('');
 await writeFile(join(root,'qoder-profiles.json'),JSON.stringify({'different-uid':{email:'personal@example.test',checkedAt:Date.now()}}));
 expect(mapNativeAccounts([native],await manager.nativeUsageAccounts())[0].sourceId).toBe('');
 await writeFile(join(root,'qoder-profiles.json'),cached);

 const calls=(await fixture()).apiCalls.filter((c:{url:string})=>c.url.endsWith('/userinfo')).length;
 await manager.refreshAccounts();
 expect((await fixture()).apiCalls.filter((c:{url:string})=>c.url.endsWith('/userinfo'))).toHaveLength(calls);
 await manager.stop();
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify(files.map(file=>({...file,profile:{}}))));
 await manager.start();
 expect(manager.snapshot().accounts.find(a=>a.label==='personal@example.test')).toBeDefined();
});
it('auto-starts, opens only official OAuth, confirms automatic callback and restores saved accounts on restart',async () => {
  const {manager,opened,fixture}=await setup();
  let snapshot=await manager.login('codex');expect(snapshot.state).toBe('running');expect(snapshot.loginState).toBe('waiting_for_browser');expect(opened[0]).toMatch(/^https:\/\/auth.openai.com\/oauth\/authorize/);
  await expect(manager.login('claude')).rejects.toThrow('已有授权');
  await manager.openLogin(snapshot.login!.id);expect(opened).toHaveLength(2);
  const state=new URL(snapshot.login!.url!).searchParams.get('state');
  expect((await fetch('http://127.0.0.1:1455/auth/callback?state=wrong&code=nope')).status).toBe(400);
  const callback=await fetch(`http://127.0.0.1:1455/auth/callback?state=${state}&code=fixture-code`);expect(callback.ok).toBe(true);expect(callback.headers.get('content-type')).toContain('text/html');const confirmation=await callback.text();expect(confirmation).toContain('授权回调已收到');expect(confirmation).not.toContain('fixture-code');expect(confirmation).not.toContain(state);expect(callback.headers.get('cache-control')).toBe('no-store');
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  snapshot=manager.snapshot();expect(snapshot.accounts[0].label).toBe('user@example.test');expect(snapshot.models[0].id).toBe('codex/fixture-codex-model');
  expect(JSON.stringify(snapshot)).not.toMatch(/never-expose|private\/credentials|fixture-key|code_challenge/);
  await manager.setAccountEnabled(snapshot.accounts[0].id,false);expect(manager.snapshot().accounts[0].disabled).toBe(true);expect(manager.snapshot().models).toEqual([]);
  await manager.setAccountEnabled(snapshot.accounts[0].id,true);await manager.stop();await manager.start();expect(manager.snapshot().accounts).toHaveLength(1);
});
it('validates manual callback origin, session and provider, without persisting callback secrets in snapshots',async () => {
  const {manager,fixture}=await setup();const started=await manager.login('claude');const id=started.login!.id;const state=new URL(started.login!.url!).searchParams.get('state');
  await expect(manager.submitCallback(id,`http://localhost:54545/callback?state=stale&code=callback-secret`)).rejects.toThrow('旧会话');
  await expect(manager.submitCallback(id,`https://evil.test/callback?state=${state}&code=callback-secret`)).rejects.toThrow();
  await expect(manager.submitCallback('stale',`http://localhost:54545/callback?state=${state}&code=callback-secret`)).rejects.toThrow('过期');
  expect((await fixture()).callbackCount).toBe(0);
  await manager.submitCallback(id,`http://localhost:54545/callback?state=${state}&code=callback-secret`);
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  expect(manager.snapshot().accounts[0].provider).toBe('claude');expect(JSON.stringify(manager.snapshot())).not.toContain('callback-secret');
  await expect(manager.submitCallback(id,`http://localhost:54545/callback?state=${state}&code=callback-secret`)).rejects.toThrow();
});
it('signs in to Claude by pasting the code#state shown on the official page, without a loopback port',async () => {
  const {manager,fixture}=await setup();const started=await manager.login('claude-manual');const login=started.login!;
  expect(login.flow).toBe('code');expect(new URL(login.url!).searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
  const state=new URL(login.url!).searchParams.get('state');
  await expect(manager.submitCallback(login.id,'manual-secret#stale')).rejects.toThrow('旧会话');
  await expect(manager.submitCallback(login.id,'manual-secret')).rejects.toThrow('完整授权码');
  expect((await fixture()).callbackCount).toBe(0);
  await manager.submitCallback(login.id,` manual-secret#${state} `);
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  expect(manager.snapshot().accounts[0].provider).toBe('claude');expect(JSON.stringify(manager.snapshot())).not.toContain('manual-secret');
  expect(manager.snapshot().providers.map(p=>p.id)).not.toContain('claude-manual');
});
it('accepts both official Claude authorization pages but only with the expected redirect',()=>{
  const redirect='&redirect_uri='+encodeURIComponent('http://localhost:54545/callback');
  expect(validateAuthorizationURL('https://claude.com/cai/oauth/authorize?state=s'+redirect,'claude').hostname).toBe('claude.com');
  expect(validateAuthorizationURL('https://claude.ai/oauth/authorize?state=s'+redirect,'claude').hostname).toBe('claude.ai');
  expect(()=>validateAuthorizationURL('https://claude.ai/oauth/authorize?state=s&redirect_uri=http%3A%2F%2Fevil.test%2Fcb','claude')).toThrow();
  expect(()=>validateAuthorizationURL('https://claude.com/oauth/authorize?state=s'+redirect,'claude')).toThrow();
  expect(()=>validateAuthorizationURL('https://claude.ai/oauth/authorize?state=s'+redirect,'claude-manual')).toThrow();
});
it('cancels upstream OAuth sessions, retries, times out, and never treats provider errors as successful login',async () => {
  const {manager,fixture}=await setup(600);
  const first=await manager.login('codex');await manager.cancelLogin(first.login!.id);expect(manager.snapshot().loginState).toBe('cancelled');expect((await fixture()).cancelCount).toBe(1);
  await fixture({mode:'error'});await manager.login('codex');await expect.poll(() => manager.snapshot().loginState).toBe('failed');expect(JSON.stringify(manager.snapshot())).not.toContain('opaque-error-secret');
  await fixture({mode:'wait'});await manager.login('codex');await expect.poll(() => manager.snapshot().loginState).toBe('expired');expect((await fixture()).cancelCount).toBe(2);
});
it('rejects non-official authorization links and cancels the upstream session before opening anything',async () => {
  const {manager,fixture,opened}=await setup();await manager.start();await fixture({mode:'unsafe'});await manager.login('codex');expect(manager.snapshot().loginState).toBe('failed');expect(opened).toEqual([]);expect((await fixture()).cancelCount).toBe(1);
  expect(() => validateAuthorizationURL('https://auth.openai.com.evil.test/oauth/authorize','codex')).toThrow();
});
it('serves protected desktop login actions and never returns management credentials',async () => {
  const {root,port}=await setup();
  const service=await createDesktopService({root,proxyPort:port,binary,token:'desktop-token',localKey:'fixture-key',secrets:{get:async()=>'',set:async()=>{}}});cleanup.push(() => service.app.close());
  const headers={host:'127.0.0.1:9527',authorization:'Bearer desktop-token'};
  const unauthorized=await service.app.inject({method:'POST',url:'/api/local-agent/codex',payload:{},headers:{host:headers.host}});expect(unauthorized.statusCode).toBe(401);
  const start=await service.app.inject({method:'POST',url:'/api/local-agent/codex',headers,payload:{}});expect(start.statusCode).toBe(200);const login=start.json().login;expect(login.status).toBe('waiting_for_browser');expect(start.body).not.toContain('fixture-key');
  expect((await service.app.inject({method:'POST',url:'/api/local-agent/login/cancel',headers,payload:{id:login.id}})).json().login.status).toBe('cancelled');
});

it('connects Antigravity through the Google authorization endpoint and validates its own callback',async () => {
  const {manager,opened}=await setup();const snapshot=await manager.login('antigravity');
  expect(opened[0]).toMatch(/^https:\/\/accounts.google.com\/o\/oauth2\/v2\/auth/);
  const state=new URL(snapshot.login!.url!).searchParams.get('state');
  await expect(manager.submitCallback(snapshot.login!.id,`http://localhost:1455/auth/callback?state=${state}&code=test`)).rejects.toThrow();
  expect((await fetch(`http://[::1]:51121/oauth-callback?state=${state}&code=test`)).ok).toBe(true);
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  expect(manager.snapshot().accounts[0].provider).toBe('antigravity');
  expect(() => validateAuthorizationURL('https://accounts.google.com.evil.test/o/oauth2/v2/auth','antigravity')).toThrow();
});
it('connects Kimi through the device-code flow: shows the user code, has no callback, routes models to the login provider',async () => {
  const {manager,opened,fixture}=await setup();
  expect(manager.snapshot().providers.map(p => p.id)).toEqual(['codex','claude','antigravity','kimi','xai','qoder','workbuddy','zcode','trae','cursor']);
  const snapshot=await manager.login('kimi');const login=snapshot.login!;
  expect(login.flow).toBe('device');expect(login.userCode).toBe('FIXT-CODE');expect(login.status).toBe('waiting_for_browser');
  expect(opened[0]).toBe('https://www.kimi.com/code/authorize_device?user_code=FIXT-CODE');
  await expect(manager.submitCallback(login.id,`http://localhost:1455/auth/callback?state=x&code=y`)).rejects.toThrow('设备码');
  expect((await fixture()).callbackCount).toBe(0);
  await fixture({complete:true});
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  const done=manager.snapshot();
  expect(done.accounts[0].provider).toBe('kimi');expect(done.models).toEqual([{id:'kimi/fixture-kimi-model',provider:'kimi'}]);
  expect(done.login!.userCode).toBeUndefined();expect(JSON.stringify(done)).not.toMatch(/never-expose|FIXT-CODE/);
  expect(() => validateAuthorizationURL('https://www.kimi.com.evil.test/code/authorize_device','kimi')).toThrow();
  expect(() => validateAuthorizationURL('https://www.kimi.com/other','kimi')).toThrow();
});
it('connects xAI through the device-code flow, cancels upstream on unsafe links and expires by the shorter limit',async () => {
  const {manager,opened,fixture}=await setup(600);await manager.start();
  await fixture({mode:'unsafe'});await manager.login('xai');expect(manager.snapshot().loginState).toBe('failed');expect(opened).toEqual([]);expect((await fixture()).cancelCount).toBe(1);
  await fixture({mode:'wait'});const snapshot=await manager.login('xai');
  expect(opened[0]).toBe('https://accounts.x.ai/oauth2/device?user_code=FIXT-CODE');
  // Upstream reports expires_in 1800s; the explicit test limit (600ms) must win.
  expect(Date.parse(snapshot.login!.expiresAt!)-Date.now()).toBeLessThan(5000);
  await expect.poll(() => manager.snapshot().loginState).toBe('expired');expect((await fixture()).cancelCount).toBe(2);
  await manager.login('xai');await fixture({complete:true});
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  expect(manager.snapshot().accounts.map(a => a.provider)).toEqual(['xai']);expect(manager.snapshot().models[0]).toEqual({id:'xai/fixture-xai-model',provider:'xai'});
  expect(() => validateAuthorizationURL('https://accounts.x.ai.evil.test/oauth2/device','xai')).toThrow();
});
it('queries per-account quota through upstream api-call without handling tokens, and keeps failures opaque',async () => {
  const {manager,fixture}=await setup();
  for (const provider of ['kimi','xai'] as const) {await manager.login(provider);await fixture({complete:true});await expect.poll(() => manager.snapshot().loginState).toBe('completed');}
  let snapshot=await manager.refreshQuota();
  const byProvider=Object.fromEntries(Object.values(snapshot.quotas).map(q => [q.provider,q]));
  expect(byProvider.kimi.status).toBe('ok');expect(byProvider.kimi.windows.map(w => w.label)).toEqual(['5h window','1 周','周用量']);
  expect(byProvider.xai.status).toBe('ok');expect(byProvider.xai.plan).toBe('subscription');expect(byProvider.xai.windows.map(w => w.id)).toEqual(['credits','product-0','monthly','on-demand']);
  const calls=(await fixture()).apiCalls as {authIndex:string;url:string;rawToken:boolean}[];
  expect(calls.length).toBeGreaterThanOrEqual(3);expect(calls.every(c => c.rawToken)).toBe(true);expect(new Set(calls.map(c => c.authIndex))).toEqual(new Set(['idx-kimi','idx-xai']));
  expect(JSON.stringify(snapshot)).not.toMatch(/idx-|never-expose|\$TOKEN\$/);
  await manager.setAccountEnabled(snapshot.accounts.find(a => a.provider==='xai')!.id,false);
  await fixture({mode:'quota-error'});snapshot=await manager.refreshQuota();
  const kimi=Object.values(snapshot.quotas).find(q => q.provider==='kimi')!;
  expect(kimi.status).toBe('error');expect(kimi.error).toMatch(/HTTP 429/);expect(JSON.stringify(snapshot)).not.toContain('upstream-secret');
  expect(Object.values(snapshot.quotas).find(q => q.provider==='xai')!.status).toBe('ok');
  await fixture({mode:'quota-bridge-error'});const failed=await manager.refreshQuota();const cached=Object.values(failed.quotas).find(q=>q.provider==='kimi')!;expect(cached.error).toContain('额度上游连接失败');expect(cached.error).not.toContain('回调端口');expect(cached.windows).toEqual(byProvider.kimi.windows);expect(cached.lastSuccessfulAt).toBe(byProvider.kimi.observedAt);expect(failed.accounts.find(a=>a.provider==='kimi')?.unavailable).toBe(false);
  await fixture({mode:'wait'});const recovered=Object.values((await manager.refreshQuota()).quotas).find(q=>q.provider==='kimi')!;expect(recovered.status).toBe('ok');expect(recovered.lastSuccessfulAt).toBeUndefined();
  expect((await fixture()).apiCalls.length).toBeGreaterThanOrEqual(calls.length+1);
});
it('exposes Kimi and xAI login actions through the desktop API',async () => {
  const {root,port}=await setup();
  const service=await createDesktopService({root,proxyPort:port,binary,token:'desktop-token',localKey:'fixture-key',secrets:{get:async()=>'',set:async()=>{}}});cleanup.push(() => service.app.close());
  const headers={host:'127.0.0.1:9527',authorization:'Bearer desktop-token'};
  const start=await service.app.inject({method:'POST',url:'/api/local-agent/kimi',headers,payload:{}});expect(start.statusCode).toBe(200);
  const login=start.json().login;expect(login.flow).toBe('device');expect(login.userCode).toBe('FIXT-CODE');
  expect((await service.app.inject({method:'POST',url:'/api/local-agent/login/callback',headers,payload:{id:login.id,redirectURL:'http://localhost:1455/auth/callback?state=x&code=y'}})).statusCode).toBe(400);
  expect((await service.app.inject({method:'POST',url:'/api/local-agent/login/cancel',headers,payload:{id:login.id}})).json().login.status).toBe('cancelled');
  expect((await service.app.inject({method:'POST',url:'/api/local-agent/grok',headers,payload:{}})).statusCode).toBe(400);
  expect((await service.app.inject({method:'POST',url:'/api/local-agent/xai',headers,payload:{}})).json().login.provider).toBe('xai');
  const quota=await service.app.inject({method:'POST',url:'/api/local-agent/quota',headers,payload:{}});expect(quota.statusCode).toBe(200);expect(quota.json().quotas).toEqual({});
});

it('connects Qoder and WorkBuddy through device/web flow without required user code',async () => {
  const {manager,opened,fixture}=await setup();
  // Qoder
  const qoderSnap=await manager.login('qoder');const qLogin=qoderSnap.login!;
  expect(qLogin.flow).toBe('device');expect(qLogin.userCode).toBeUndefined();
  expect(opened[0]).toMatch(/^https:\/\/qoder.com\/device\/selectAccounts/);
  await fixture({complete:true});
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  expect(manager.snapshot().accounts[0].provider).toBe('qoder');
  expect(manager.snapshot().models[0]).toEqual({id:'qoder/fixture-qoder-model',provider:'qoder'});
  await fixture({modelSets:{qoder:[{id:'kmodel_latest',display_name:'Kimi K3 (Qoder)'},'auto']}});
  await manager.refreshAccounts();await manager.refreshAccounts();
  expect(manager.snapshot().models).toContainEqual({id:'qoder/kmodel_latest',provider:'qoder',displayName:'Kimi K3 (Qoder)'});
  expect(manager.snapshot().accounts[0].models).toContain('qoder/kmodel_latest');
  expect(manager.snapshot().models.some(m=>m.id==='qoder/Kimi-K3')).toBe(false);
  expect(manager.sourceAuth(manager.snapshot().accounts[0].id,'qoder/kmodel_latest')).toBeTruthy();
  expect(() => validateAuthorizationURL('https://qoder.com.evil.test/device/selectAccounts','qoder')).toThrow();

  // WorkBuddy
  const wbSnap=await manager.login('workbuddy');const wbLogin=wbSnap.login!;
  expect(wbLogin.flow).toBe('device');expect(wbLogin.userCode).toBeUndefined();
  expect(opened[1]).toMatch(/^https:\/\/copilot.tencent.com\/login/);
  await fixture({complete:true});
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  expect(manager.snapshot().accounts.some(a => a.provider==='workbuddy')).toBe(true);
  expect(manager.snapshot().models.some(m => m.provider==='workbuddy')).toBe(true);
  expect(() => validateAuthorizationURL('https://copilot.tencent.com.evil.test/login','workbuddy')).toThrow();
});

it('connects ZCode through polling and Trae through its separate callback flow',async () => {
  const {manager,opened,fixture}=await setup();
  // ZCode
  const zSnap=await manager.login('zcode');
  expect(opened[0]).toMatch(/^https:\/\/chat.z.ai\/api\/oauth\/authorize/);
  expect(zSnap.login!.flow).toBe('device');
  await fixture({complete:true});
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  expect(manager.snapshot().accounts.some(a => a.provider==='zcode')).toBe(true);
  expect(manager.snapshot().models.some(m => m.provider==='zcode')).toBe(true);
  expect(() => validateAuthorizationURL('https://chat.z.ai.evil.test/api/oauth/authorize','zcode')).toThrow();
  expect(loginProviderSchema.safeParse('zcode-bigmodel').success).toBe(false);

  // Trae (validates nested state in redirect_url)
  const traeSnap=await manager.login('trae');
  expect(opened[1]).toMatch(/^https:\/\/www.trae.ai\/login\?redirect_url=/);
  const traeState=new URL(new URL(traeSnap.login!.url!).searchParams.get('redirect_url')!).searchParams.get('login_trace_id');
  expect((await fetch(`http://127.0.0.1:1455/authorize?loginTraceID=${traeState}&userJwt=fixture-jwt&refreshToken=fixture-refresh&host=https%3A%2F%2Fapi-us-east.trae.ai`)).ok).toBe(true);
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  expect(manager.snapshot().accounts.some(a => a.provider==='trae')).toBe(true);
  expect(manager.snapshot().models.some(m => m.provider==='trae')).toBe(true);
  expect(() => validateAuthorizationURL('https://www.trae.ai.evil.test/login','trae')).toThrow();
});

it('loads saved account models after delayed registration without navigating or manually refreshing',async()=>{
 const {root,manager}=await setup();await mkdir(join(root,'cliproxy'),{recursive:true});
 await writeFile(join(root,'cliproxy','fixture-options.json'),JSON.stringify({modelDelayMs:700}));
 await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify([{name:'codex-saved.json',provider:'codex',status:'active',auth_index:'saved',models:['gpt-6-astra']}]));
 await manager.start();
 expect(manager.snapshot().accounts).toHaveLength(1);
 await expect.poll(()=>manager.snapshot().accounts[0]?.models,{timeout:5000}).toContain('codex/gpt-6-astra');
 expect(manager.snapshot().models.some(m=>m.id==='codex/gpt-6-astra')).toBe(true);
});

it('publishes account models and callable routes together after namespace registration',async()=>{
 const {root,manager}=await setup();await mkdir(join(root,'cliproxy'),{recursive:true});
 await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify([{name:'codex-saved.json',provider:'codex',status:'active',models:['gpt-6-astra']}]));
 const originalFetch=globalThis.fetch;let release!:()=>void;let registrationStarted!:()=>void;
 const pending=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{registrationStarted=resolve;});
 const intercepted=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  if(String(input).endsWith('/oauth-model-alias')&&init?.method==='PUT'){registrationStarted();await pending;}
  return originalFetch(input,init);
 });
 const starting=manager.start();
 try{
  await started;const during=manager.snapshot();
  expect(during.accounts.flatMap(account=>account.models??[]).every(id=>during.models.some(model=>model.id===id))).toBe(true);
 }finally{release();await starting;intercepted.mockRestore();}
 expect(manager.snapshot().accounts[0].models).toContain('codex/gpt-6-astra');
 expect(manager.snapshot().models.some(model=>model.id==='codex/gpt-6-astra')).toBe(true);
});

it('retries failed namespace registration instead of caching it as successful',async()=>{
 const {root,manager}=await setup();await mkdir(join(root,'cliproxy'),{recursive:true});
 await writeFile(join(root,'cliproxy','fixture-options.json'),JSON.stringify({failAliasWrites:1}));
 await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify([{name:'codex-saved.json',provider:'codex',status:'active',models:['gpt-6-astra']}]));
 await manager.start();expect(manager.snapshot().models).toEqual([]);
 await expect.poll(()=>manager.snapshot().models.map(m=>m.id),{timeout:5000}).toContain('codex/gpt-6-astra');
 expect(manager.snapshot().accountError).toBeUndefined();
});
it('keeps explicitly revoked credentials visible for confirmation without treating quota errors as expired',async()=>{
 const {manager,root}=await setup();const {readFile,readdir,realpath}=await import('node:fs/promises');
 // safe credential reads reject symlink ancestors; use the canonical temp path.
 await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 const files=[{name:'revoked.json',provider:'codex',email:'same@example.test',status:'error',status_message:'refresh_token_revoked'},{name:'valid.json',provider:'codex',email:'same@example.test',status:'active'},{name:'quota.json',provider:'codex',email:'quota@example.test',status:'error',status_message:'HTTP 401'}];
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify(files));await writeFile(join(root,'cliproxy/auth/revoked.json'),'{"refresh_token":"fixture-secret"}');
 const canonical=await realpath(root);const clean=new CLIProxyManager(canonical,binary,'fixture-key',manager.port);cleanup.push(()=>clean.shutdown());await clean.start();
 expect(clean.snapshot().accounts).toHaveLength(3);
 const revoked=clean.snapshot().accounts.find(a=>a.authenticationRequired)!;expect(revoked).toBeDefined();
 expect(clean.snapshot().accounts.find(a=>a.label==='quota@example.test')?.authenticationRequired).not.toBe(true);
 expect(await readFile(join(root,'cliproxy/auth/revoked.json'),'utf8')).toBe('{"refresh_token":"fixture-secret"}');expect(JSON.stringify(clean.snapshot())).not.toContain('fixture-secret');
});

it('recognizes explicit Codex quota revocation, preserves confirmation evidence across refresh and clears it for a new token',async()=>{
 const {manager,root,fixture}=await setup();
 await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 const path=join(root,'cliproxy/auth/codex.json');
 const credential={access_token:'fixture-old-access',refresh_token:'fixture-refresh',expired:'2035-01-01T00:00:00Z',email:'revoked@example.test',account_id:'fixture-account'};
 await writeFile(path,JSON.stringify(credential));
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'codex.json',provider:'codex',email:credential.email,auth_index:'codex',status:'active',models:['model']}]));
 await manager.start();await manager.refreshQuota();
 const id=manager.snapshot().accounts[0].id;
 await fixture({mode:'quota-401'});await manager.refreshQuota('codex');
 expect(manager.snapshot().accounts[0].authenticationRequired).not.toBe(true);
 await fixture({mode:'quota-token-revoked'});await manager.refreshQuota('codex');
 expect(manager.snapshot().accounts[0]).toMatchObject({authenticationRequired:true,unavailable:true,retryable:false,models:[]});
 expect(manager.snapshot().quotas[id].error).toContain('登录授权已失效');
 expect(JSON.stringify(manager.snapshot())).not.toMatch(/fixture-old-access|fixture-refresh|upstream-secret/);
 await manager.refreshAccounts('codex',false);
 expect(manager.snapshot().accounts[0].authenticationRequired).toBe(true);
 expect(JSON.parse(await readFile(path,'utf8'))).toEqual(credential);
 await writeFile(path,JSON.stringify({...credential,access_token:'fixture-new-access'}));
 await manager.refreshAccounts('codex',false);
 expect(manager.snapshot().accounts[0].authenticationRequired).toBe(false);
 // An old in-flight response must not revoke a replacement saved during the query.
 const originalFetch=globalThis.fetch;
 let entered!:()=>void,release!:()=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
 const intercepted=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  const response=await originalFetch(input,init);
  if(String(input).endsWith('/api-call')){entered();await blocked;}
  return response;
 });
 const pending=manager.refreshQuota('codex');
 try{await ready;await writeFile(path,JSON.stringify({...credential,access_token:'fixture-replacement-access'}));}
 finally{release();await pending;intercepted.mockRestore();}
 expect(manager.snapshot().accounts[0].authenticationRequired).toBe(false);
 await manager.refreshAccounts('codex',false);
 await manager.refreshQuota('codex');
 expect(manager.snapshot().accounts[0].authenticationRequired).toBe(true);
 await manager.removeExpiredAccount(id);
 expect(manager.snapshot().accounts).toEqual([]);
});

it('does not reimport a browser-authorized Codex account under a second filename on startup',async()=>{
 const {manager,root}=await setup();const {realpath}=await import('node:fs/promises');
 await mkdir(join(root,'cliproxy/auth'),{recursive:true});await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'browser-codex.json',provider:'codex',email:'same@example.test',status:'active',models:['model']}]));
 const credential={account_id:'same-account',access_token:'fixture-access',refresh_token:'fixture-refresh',id_token:'x.e30.x'};
 await writeFile(join(root,'cliproxy/auth/browser-codex.json'),JSON.stringify(credential));
 const canonical=await realpath(root);const proxy=new CLIProxyManager(canonical,binary,'fixture-key',manager.port);cleanup.push(()=>proxy.shutdown());await proxy.start();
 await proxy.importCredential('codex',credential,true);expect(proxy.snapshot().accounts).toHaveLength(1);
});

it('automatically recovers Codex quota after two transient bridge 502s without toggling the account',async()=>{
 const {manager,fixture}=await setup();await manager.login('codex');await fixture({complete:true});await expect.poll(()=>manager.snapshot().loginState).toBe('completed');
 await manager.refreshQuota();const original=manager.snapshot().accounts;
 await fixture({quotaBridgeFailures:2});const pending=manager.refreshQuota();expect(manager.refreshQuota()).toBe(pending);
 const recovered=await pending;
 expect(Object.values(recovered.quotas).find(q=>q.provider==='codex')?.status).toBe('ok');
 expect((await fixture()).quotaBridgeAttempts).toBe(3);expect(recovered.accounts).toEqual(original);expect(recovered.state).toBe('running');
});

it('refreshes only the selected platform models and quota, preserving every other platform snapshot',async()=>{
 const {manager,root,fixture}=await setup();await mkdir(join(root,'cliproxy'),{recursive:true});
 const entries=[{name:'codex-one.json',provider:'codex',email:'one@example.test',auth_index:'codex-one',status:'active',models:['old-codex']},{name:'codex-two.json',provider:'codex',email:'two@example.test',auth_index:'codex-two',status:'active',models:['old-codex']},{name:'claude.json',provider:'claude',email:'dev@example.test',auth_index:'claude-one',status:'active',models:['old-claude']}];
 await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify(entries));await manager.start();await manager.refreshQuota();
 const before=manager.snapshot(),beforeCalls=await fixture();const other=before.accounts.find(a=>a.provider==='claude')!;
 await fixture({modelSets:{codex:['new-codex'],claude:['new-claude']}});
 const cursor=vi.spyOn(manager.cursor,'refresh');
 const next=await manager.refreshProvider('codex');
 expect(next.accounts.filter(a=>a.provider==='codex').map(a=>a.models)).toEqual([['codex/new-codex'],['codex/new-codex']]);
 expect(next.accounts.find(a=>a.id===other.id)).toEqual(other);expect(next.quotas[other.id]).toEqual(before.quotas[other.id]);expect(next.models.filter(m=>m.provider==='claude')).toEqual(before.models.filter(m=>m.provider==='claude'));
 const calls=await fixture();expect(calls.modelCalls.slice(beforeCalls.modelCalls.length).sort()).toEqual(['codex-one.json','codex-two.json']);
 expect(new Set(calls.apiCalls.slice(beforeCalls.apiCalls.length).map((call:{authIndex:string})=>call.authIndex))).toEqual(new Set(['codex-one','codex-two']));expect(cursor).not.toHaveBeenCalled();
 const cursorStart=await fixture();await manager.refreshProvider('cursor');const cursorEnd=await fixture();expect(cursor).toHaveBeenCalledTimes(1);expect(cursorEnd.modelCalls).toEqual(cursorStart.modelCalls);expect(cursorEnd.apiCalls).toEqual(cursorStart.apiCalls);
 cursor.mockRestore();
 // Distinct simultaneous platform refreshes must not accidentally coalesce to one platform.
 const start=await fixture();await fixture({modelSets:{codex:['latest-codex'],claude:['latest-claude']}});
 await Promise.all([manager.refreshProvider('codex'),manager.refreshProvider('claude')]);
 expect(manager.snapshot().accounts.find(a=>a.id===other.id)?.models).toEqual(['claude/latest-claude']);
 expect(manager.snapshot().accounts.filter(a=>a.provider==='codex').every(a=>a.models?.includes('codex/latest-codex'))).toBe(true);
 expect((await fixture()).modelCalls.slice(start.modelCalls.length).sort()).toEqual(['claude.json','codex-one.json','codex-two.json']);
});

it('validates platform refresh requests and keeps the management endpoint administrator-only',async()=>{
 const {root,port}=await setup();const service=await createDesktopService({root,proxyPort:port,binary,token:'refresh-admin',localKey:'fixture-key',secrets:{get:async()=>'',set:async()=>{}}});cleanup.push(()=>service.app.close());await service.proxy.start();await service.proxy.refreshQuota();
 const headers={host:'127.0.0.1:9527',authorization:'Bearer refresh-admin'},url='/api/local-agent/providers/codex/refresh';
 expect((await service.app.inject({method:'POST',url,headers:{host:headers.host},payload:{}})).statusCode).toBe(401);
 expect((await service.app.inject({method:'POST',url,headers:{...headers,origin:'https://untrusted.test'},payload:{}})).statusCode).toBe(403);
 expect((await service.app.inject({method:'POST',url:'/api/local-agent/providers/unknown/refresh',headers,payload:{}})).statusCode).toBe(400);
 expect((await service.app.inject({method:'POST',url,headers,payload:{provider:'claude'}})).statusCode).toBe(400);
 const refreshed=await service.app.inject({method:'POST',url,headers,payload:{}});expect(refreshed.statusCode,refreshed.body).toBe(200);expect(refreshed.json().state).toBe('running');expect(refreshed.body).not.toContain('fixture-key');
 const refresh=vi.spyOn(service.proxy,'refreshProvider');
 expect((await service.app.inject({method:'POST',url,headers,payload:{force:false}})).statusCode).toBe(200);expect(refresh).toHaveBeenLastCalledWith('codex',false);
 expect((await service.app.inject({method:'POST',url,headers,payload:{force:'false'}})).statusCode).toBe(400);refresh.mockRestore();
});


it('finishes a platform refresh while another platform is still querying quota in the background',async()=>{
 const {manager,root}=await setup();await mkdir(join(root,'cliproxy'),{recursive:true});
 await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify(['codex','claude'].map(provider=>({name:`${provider}.json`,provider,auth_index:`idx-${provider}`,status:'active',models:['shared']}))));
 await manager.start();await manager.refreshQuota();
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
 const original=quotaProviders.codex.fetch.bind(quotaProviders.codex);
 const held=vi.spyOn(quotaProviders.codex,'fetch').mockImplementation(async(...args)=>{entered();await gate;return original(...args);});
 const global=manager.refreshQuota();await started;
 try{
  const result=await Promise.race([manager.refreshProvider('claude'),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Scoped refresh waited for the other provider')),1500))]);
  expect(result.quotas[result.accounts.find(a=>a.provider==='claude')!.id].status).toBe('ok');expect(result.quotaBusy).toBe(true);
 }finally{release();await global;held.mockRestore();}
 expect(manager.snapshot().quotaBusy).toBe(false);
});

it('restricts overseas WorkBuddy login to the official overseas site',()=>{
 expect(validateAuthorizationURL('https://www.workbuddy.ai/login?state=fixture','workbuddy-overseas').hostname).toBe('www.workbuddy.ai');
 expect(()=>validateAuthorizationURL('https://copilot.tencent.com/login','workbuddy-overseas')).toThrow();
 expect(()=>validateAuthorizationURL('https://www.workbuddy.ai.evil.test/login','workbuddy-overseas')).toThrow();
});

it('does not reintroduce stale gateway routes absent from every discovered account catalog',async()=>{
 const {manager,root}=await setup();await mkdir(join(root,'cliproxy'),{recursive:true});
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'ag.json',provider:'antigravity',status:'active',models:['current']} ]));
 await manager.start();
 const original=(manager as any).request.bind(manager);
 vi.spyOn(manager as any,'request').mockImplementation(async (...args:any[])=>{const value=await original(...args);return args[0]==='/models'?{...value,data:[...value.data,{id:'antigravity/gemini-pro-agent',type:'antigravity',owned_by:'antigravity'}]}:value;});
 await manager.refreshAccounts('antigravity');
 expect(manager.snapshot().models.map(m=>m.id)).toEqual(['antigravity/current']);
});

it('hides unverified provider models and displays catalog failure separately from login state',async()=>{
 const {manager,root}=await setup();await mkdir(join(root,'cliproxy'),{recursive:true});
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'kimi.json',provider:'kimi',status:'active',models:['obsolete']} ]));
 const original=(manager as any).request.bind(manager);
 vi.spyOn(manager as any,'request').mockImplementation(async (...args:any[])=>{const value=await original(...args);if(String(args[0]).startsWith('/auth-files/models')){expect(args[4]).toBeGreaterThan(8000);return {...value,catalog:{status:'unavailable'}};}return value;});
 await manager.start();const state=manager.snapshot();expect(state.models).toEqual([]);expect(state.accounts[0].models).toEqual([]);expect(state.accounts[0].status).toBe('active');expect(state.accounts[0].modelError).toContain('官方模型目录');
});

it('caches platform visits for five minutes, coalesces concurrent visits, and always permits manual refresh',async()=>{
 const {manager,root,fixture}=await setup();await mkdir(join(root,'cliproxy'),{recursive:true});
 await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify([{name:'codex.json',provider:'codex',auth_index:'codex',status:'active',models:['fixture']}]));
 await manager.start();await manager.refreshQuota();const initial=await fixture();const now=Date.now();const clock=vi.spyOn(Date,'now').mockReturnValue(now+299000);
 try{
  await manager.refreshProvider('codex',false);expect((await fixture()).modelCalls).toEqual(initial.modelCalls);expect((await fixture()).apiCalls).toEqual(initial.apiCalls);
  clock.mockReturnValue(now+301000);const first=manager.refreshProvider('codex',false);expect(manager.refreshProvider('codex',false)).toBe(first);await first;
  const after=await fixture();expect(after.modelCalls.length).toBe(initial.modelCalls.length+1);expect(after.apiCalls.length).toBeGreaterThan(initial.apiCalls.length);
  await manager.refreshProvider('codex',false);expect((await fixture()).modelCalls).toEqual(after.modelCalls);
  await manager.refreshProvider('codex');expect((await fixture()).modelCalls.length).toBe(after.modelCalls.length+1);
 }finally{clock.mockRestore();}
});
it('does not periodically refresh a stable account catalog while the page is idle',async()=>{
 const {manager}=await setup();await manager.start();await manager.refreshQuota();
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
 const refresh=vi.spyOn(manager,'refreshAccounts');
 try{await manager.refreshAccounts(undefined,false);await vi.advanceTimersByTimeAsync(10*60*1000);expect(refresh).toHaveBeenCalledOnce();}
 finally{vi.useRealTimers();refresh.mockRestore();}
});
it('groups grants by real identity, preserves files, and routes an existing pinned account through its newest usable grant',async()=>{
 const {manager,root}=await setup();await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 const rows=[
  {name:'old.json',provider:'codex',status:'active',models:['m','old-only'],email:'one@example.test'},
  {name:'new.json',provider:'codex',status:'active',models:['m'],email:'ONE@example.test'},
  {name:'other-person.json',provider:'codex',status:'active',models:['m'],email:'two@example.test'},
  {name:'expired.json',provider:'codex',status:'active',models:['m'],email:'one@example.test'},
 ];
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify(rows));
 for(const [index,row] of rows.entries())await writeFile(join(root,'cliproxy/auth',row.name),JSON.stringify({type:'codex',email:row.email,account_id:'shared-team',access_token:`private-access-${index}`,refresh_token:index===3?undefined:`private-refresh-${index}`,last_refresh:`2026-10-${index===3?'16':index===1?'15':'01'}T00:00:00Z`,expired:index===3?'2000-01-01':'2035-01-01'}));
 await manager.start();const accounts=manager.snapshot().accounts,old=accounts.find(a=>a.id===createHashForTest('old.json'))!,newest=accounts.find(a=>a.id===createHashForTest('new.json'))!,other=accounts.find(a=>a.id===createHashForTest('other-person.json'))!;
 expect(old).toMatchObject({isDuplicate:true,preferredCredentialId:newest.id,credentialCount:3});expect(newest.isDuplicate).toBe(false);expect(other.isDuplicate).toBeUndefined();
 expect(manager.sourceAuth(old.id,'codex/m')).toBe('new.json');expect(newest.models).toContain('codex/old-only');expect(manager.sourceAuth(newest.id,'codex/old-only')).toBe('old.json');expect(manager.sourceAuth(other.id,'codex/m')).toBe('other-person.json');
 expect(JSON.stringify(manager.snapshot())).not.toMatch(/private-access|private-refresh/);
 for(const row of rows)expect(await readFile(join(root,'cliproxy/auth',row.name),'utf8')).toContain('private-access');
 await manager.refreshAccount(newest.id);expect(manager.sourceAuth(old.id,'codex/m')).toBe('new.json');expect(manager.sourceAuth(newest.id,'codex/old-only')).toBe('old.json');
 await manager.setAccountEnabled(old.id,false);expect(manager.snapshot().accounts.filter(a=>a.credentialCount===3).every(a=>a.disabled)).toBe(true);expect(()=>manager.sourceAuth(old.id,'codex/m')).toThrow();
});
function createHashForTest(name:string){return createHash('sha256').update(name).digest('hex').slice(0,24);}
it('imports two members of one Codex workspace independently and keeps separate grants without overwriting an earlier one',async()=>{
 const {manager,root}=await setup();await manager.start();
 const grant=(email:string,refresh:string,date:string)=>({account_id:'shared-team',email,access_token:'private-access',refresh_token:refresh,id_token:'opaque-id-token',expired:'2035-01-01',last_refresh:date});
 const first=grant('one@example.test','first-grant','2026-10-01');await manager.importCredential('codex',first,true);
 await manager.importCredential('codex',grant('two@example.test','other-member-grant','2026-10-02'),true);
 await manager.importCredential('codex',grant('ONE@example.test','new-grant','2026-10-15'),true);
 const names=(await import('node:fs/promises')).readdir;const files=(await names(join(root,'cliproxy/auth'))).filter(n=>n.startsWith('local-codex-'));
 expect(files).toHaveLength(3);expect(manager.snapshot().accounts.filter(a=>a.provider==='codex'&&!a.isDuplicate)).toHaveLength(2);
 await manager.importCredential('codex',first,true);expect((await names(join(root,'cliproxy/auth'))).filter(n=>n.startsWith('local-codex-'))).toHaveLength(3);
});

it.each(['timeout','tls','unknown'])('distinguishes an authorization %s failure from a stopped local agent',async kind=>{
 const {manager}=await setup();await manager.start();const realFetch=globalThis.fetch;
 const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
  if(String(url).includes('/workbuddy-auth-url')){
   if(kind==='timeout')throw new DOMException('The operation timed out','TimeoutError');
   if(kind==='unknown')return Response.json({error:'opaque-failure secret-token'},{status:502});
   return Response.json({error:'Client network socket disconnected before secure TLS connection was established secret-token'},{status:502});
  }
  return realFetch(url,init);
 });
 try{const state=await manager.login('workbuddy-overseas');expect(state.state).toBe('running');expect(state.login?.status).toBe('failed');expect(state.login?.message).toContain(kind==='timeout'?'超时':kind==='tls'?'TLS':'HTTP 502');expect(state.login?.message).not.toContain('无法连接 Local Agent');expect(state.login?.message).not.toContain('secret-token');if(kind==='unknown'){expect(state.login?.message).toContain('尚未生成授权链接');expect(state.login?.message).not.toContain('请检查对应厂商的网络与代理');}}finally{mock.mockRestore();}
});

it('retries an unavailable official catalog twice, forcing a fresh lookup after the cached failure',async()=>{
 const {manager,root}=await setup();await mkdir(join(root,'cliproxy'),{recursive:true});
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'kimi.json',provider:'kimi',status:'active',models:['current']}]));
 const original=(manager as any).request.bind(manager);const paths:string[]=[];
 vi.spyOn(manager as any,'request').mockImplementation(async (...args:any[])=>{
  const value=await original(...args);if(String(args[0]).startsWith('/auth-files/models')){paths.push(args[0]);return {...value,catalog:{status:paths.length<3?'unavailable':'live'}};}return value;
 });
 await manager.start();expect(paths).toHaveLength(3);expect(paths.slice(1).every(path=>path.endsWith('refresh=true'))).toBe(true);
 expect(manager.snapshot().accounts[0].models).toEqual(['kimi/current']);expect(manager.snapshot().accounts[0].modelError).toBeUndefined();
});

it('repairs missing Qoder uid from verified userinfo before model discovery and persists the identity',async()=>{
 const {manager,root}=await setup();await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 await writeFile(join(root,'cliproxy/auth/pat.json'),JSON.stringify({type:'qoder',access_token:'fixture-pat'}));
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'pat.json',provider:'qoder',status:'error',unavailable:true,auth_index:'pat',profile:{id:'verified-user',email:'verified@example.test'},models:['fixture']} ]));
 await manager.start();
 const credential=JSON.parse(await readFile(join(root,'cliproxy/auth/pat.json'),'utf8'));
 expect(manager.snapshot().accounts[0].unavailable).toBe(false);expect(credential.uid).toBe('verified-user');expect(credential.email).toBe('verified@example.test');
 expect(manager.snapshot().accounts[0].authenticationRequired).toBe(false);
 expect(manager.snapshot().accounts[0].models?.length).toBeGreaterThan(0);
 expect(JSON.stringify(manager.snapshot())).not.toContain('fixture-pat');
});

it.each([401,503,429,200])('keeps failed Qoder identity recovery visible, distinguishes retry from reauthorization (%s)',async status=>{
 const {manager,root,fixture}=await setup();await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 const original=JSON.stringify({type:'qoder',access_token:'fixture-pat'});await writeFile(join(root,'cliproxy/auth/pat.json'),original);
 const row={name:'pat.json',provider:'qoder',status:'active',auth_index:'pat',profileStatus:status,profile:{},models:['fixture']};
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([row]));await manager.start();
 let account=manager.snapshot().accounts[0];expect(manager.snapshot().models.filter(m=>m.provider==='qoder')).toEqual([]);expect(account.models??[]).toEqual([]);expect(account.unavailable).toBe(true);
 expect(account.authenticationRequired).toBe(false); // Missing identity alone must not trigger expired-grant removal.
 expect(account.modelError).toContain(status===401||status===200?'重新授权':'刷新');expect(await readFile(join(root,'cliproxy/auth/pat.json'),'utf8')).toBe(original);
 await fixture({accounts:[{...row,profileStatus:200,profile:{id:'recovered',email:'recovered@example.test'}}]});
 await manager.refreshAccounts('qoder',true);account=manager.snapshot().accounts[0];expect(account.authenticationRequired).toBe(false);expect(account.unavailable).toBe(false);expect(account.models).toContain('qoder/fixture');
});
it('does not overwrite an access token refreshed during Qoder profile lookup and recovers on retry',async()=>{
 const {manager,root}=await setup();await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 await writeFile(join(root,'cliproxy/auth/pat.json'),JSON.stringify({type:'qoder',access_token:'fixture-old'}));
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'pat.json',provider:'qoder',status:'active',auth_index:'pat',refreshOnProfile:true,profile:{id:'verified'},models:['fixture']}]));
 await manager.start();expect(JSON.parse(await readFile(join(root,'cliproxy/auth/pat.json'),'utf8')).access_token).toBe('fixture-refreshed');
 await manager.refreshAccounts('qoder',true);expect(JSON.parse(await readFile(join(root,'cliproxy/auth/pat.json'),'utf8'))).toMatchObject({uid:'verified',access_token:'fixture-refreshed'});
});


it('keeps explicit revocation evidence when sidecar status clears before removal',async()=>{
 const {manager,root}=await setup();
 await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 await writeFile(join(root,'cliproxy/auth/revoked.json'),JSON.stringify({access_token:'fixture-revoked',refresh_token:'fixture-refresh',expired:'2035-01-01T00:00:00Z'}));
 const entry={name:'revoked.json',provider:'codex',email:'revoked@example.test',status:'error',status_message:'refresh_token_revoked'};
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([entry]));await manager.start();await manager.refreshQuota();
 const account=manager.snapshot().accounts[0];expect(account.authenticationRequired).toBe(true);
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{...entry,status:'active',status_message:''}]));
 await manager.removeExpiredAccount(account.id);
 expect(manager.snapshot().accounts).toEqual([]);
});

it('refreshes one account without querying its siblings or other providers',async()=>{
 const {manager,root,fixture}=await setup();await mkdir(join(root,'cliproxy'),{recursive:true});
 const entries=[{name:'codex-one.json',provider:'codex',email:'one@example.test',auth_index:'codex-one',status:'active',models:['old-codex']},{name:'codex-two.json',provider:'codex',email:'two@example.test',auth_index:'codex-two',status:'active',models:['old-codex']},{name:'claude.json',provider:'claude',email:'dev@example.test',auth_index:'claude-one',status:'active',models:['old-claude']}];
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify(entries));await manager.start();await manager.refreshQuota();
 const before=manager.snapshot(),beforeCalls=await fixture(),chosen=before.accounts.find(a=>a.label==='one@example.test')!;
 await fixture({modelSets:{codex:['new-codex'],claude:['new-claude']}});
 const next=await manager.refreshAccount(chosen.id);
 expect(next.accounts.find(a=>a.id===chosen.id)?.models).toEqual(['codex/new-codex']);
 for(const account of before.accounts.filter(a=>a.id!==chosen.id)){expect(next.accounts.find(a=>a.id===account.id)).toEqual(account);expect(next.quotas[account.id]).toEqual(before.quotas[account.id]);}
 expect(next.models.map(m=>m.id)).toEqual(expect.arrayContaining(['codex/old-codex','codex/new-codex','claude/old-claude']));
 const calls=await fixture();expect(calls.modelCalls.slice(beforeCalls.modelCalls.length)).toEqual(['codex-one.json']);
 expect(new Set(calls.apiCalls.slice(beforeCalls.apiCalls.length).map((call:{authIndex:string})=>call.authIndex))).toEqual(new Set(['codex-one']));
});


it('routes account refresh requests to the selected account',async()=>{
 const {root,port}=await setup();const service=await createDesktopService({root,proxyPort:port,binary,token:'refresh-admin',localKey:'fixture-key',secrets:{get:async()=>'',set:async()=>{}}});cleanup.push(()=>service.app.close());
 const id='a'.repeat(24),refresh=vi.spyOn(service.proxy,'refreshAccount').mockResolvedValue(service.proxy.snapshot());
 const result=await service.app.inject({method:'POST',url:`/api/local-agent/accounts/${id}/refresh`,headers:{host:'127.0.0.1:9527',authorization:'Bearer refresh-admin'},payload:{}});
 expect(result.statusCode,result.body).toBe(200);expect(refresh).toHaveBeenCalledWith(id);
});

it.each(['workbuddy','workbuddy-ai','trae'] as const)('discovers a new native %s identity even with an existing pool and keeps repeated imports idempotent',async target=>{
 const {manager,root}=await setup();const provider=target==='workbuddy-ai'?'workbuddy':target;
 const domain=target==='workbuddy-ai'?'www.workbuddy.ai':'copilot.tencent.com';
 const scope=provider==='workbuddy'?{domain}:provider==='trae'?{host:'https://api-sg-central.trae.ai'}:{provider:'zai'};
 const native={type:provider,uid:'new-person',access_token:'native-secret',refresh_token:'native-refresh',expired:'2035-01-01T00:00:00Z',...scope};
 await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 await writeFile(join(root,'cliproxy/auth/old.json'),JSON.stringify({...native,uid:'old-person',refresh_token:'old-refresh'}));
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'old.json',provider,status:'active',models:['old-model']}]));
 await writeFile(join(root,'cliproxy/fixture-options.json'),JSON.stringify({localCredentials:{[target]:native}}));
 await manager.start();await manager.importLocal(target,true);
 let accounts=manager.snapshot().accounts.filter(a=>a.provider===provider);expect(accounts).toHaveLength(2);
 expect(accounts.some(a=>a.models?.includes(provider+'/imported-model'))).toBe(true);
 const filesBefore=await readdir(join(root,'cliproxy/auth'));
 await manager.importLocal(target,true);await manager.importLocal(target);
 expect(manager.snapshot().accounts.filter(a=>a.provider===provider)).toHaveLength(2);
 expect(await readdir(join(root,'cliproxy/auth'))).toEqual(filesBefore);
 expect(JSON.stringify(manager.snapshot())).not.toMatch(/native-secret|native-refresh/);
});

it.each(['workbuddy','workbuddy-ai','trae'] as const)('preserves a newer pooled %s grant when the native client still has its old token',async target=>{
 const {manager,root}=await setup();const provider=target==='workbuddy-ai'?'workbuddy':target;
 const native={type:provider,uid:'same-user',access_token:'old-native',refresh_token:'same-refresh',expired:'2030-01-01T00:00:00Z',domain:target==='workbuddy-ai'?'www.workbuddy.ai':'copilot.tencent.com'};
 const saved=JSON.stringify({...native,access_token:'newer-pooled',expired:'2035-01-01T00:00:00Z',disabled:true});
 await mkdir(join(root,'cliproxy/auth'),{recursive:true});await writeFile(join(root,'cliproxy/auth/saved.json'),saved);
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'saved.json',provider,status:'active',disabled:true}]));
 await writeFile(join(root,'cliproxy/fixture-options.json'),JSON.stringify({localCredentials:{[target]:native}}));
 await manager.start();await manager.importLocal(target,true);await manager.importLocal(target);
 expect(await readFile(join(root,'cliproxy/auth/saved.json'),'utf8')).toBe(saved);
 expect(await readdir(join(root,'cliproxy/auth'))).toEqual(['saved.json']);
 expect(manager.snapshot().accounts[0].disabled).toBe(true);
});
it.each(['trae'] as const)('detects native %s without writing credentials and maps its imported identity',async provider=>{
 const {manager,root}=await setup();await mkdir(join(root,'cliproxy'),{recursive:true});
 await writeFile(join(root,'cliproxy/fixture-options.json'),JSON.stringify({localCredentials:{[provider]:{type:provider,uid:'native-user',access_token:'private-native',refresh_token:'private-refresh'}}}));
 await manager.start();const before=await readdir(join(root,'cliproxy/auth'));
 const status=await manager.localImportStatus(provider);expect(status).toMatchObject({readOnly:true,loginState:'signed-in',accounts:[]});expect(await readdir(join(root,'cliproxy/auth'))).toEqual(before);
 await manager.importLocal(provider);const imported=await manager.localImportStatus(provider);
 expect(imported.accounts).toHaveLength(1);expect(imported.accounts[0].accountId).toBe(imported.loginState==='signed-in'?imported.accountId:undefined);
 expect(JSON.stringify(imported)).not.toMatch(/private-native|private-refresh|access_token|refresh_token/);
});
it('keeps the saved disabled flag when a native import updates the same grant',async()=>{
 const {manager,root}=await setup();const native={type:'workbuddy',uid:'same-user',access_token:'newer-native',refresh_token:'same-refresh',expired:'2035-01-01T00:00:00Z',domain:'copilot.tencent.com'};
 await mkdir(join(root,'cliproxy/auth'),{recursive:true});await writeFile(join(root,'cliproxy/auth/saved.json'),JSON.stringify({...native,access_token:'old-pooled',expired:'2030-01-01T00:00:00Z',disabled:true}));
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'saved.json',provider:'workbuddy',status:'active',disabled:true}]));
 await writeFile(join(root,'cliproxy/fixture-options.json'),JSON.stringify({localCredentials:{workbuddy:native}}));
 await manager.start();await manager.importLocal('workbuddy',true);
 expect(JSON.parse(await readFile(join(root,'cliproxy/auth/saved.json'),'utf8'))).toMatchObject({access_token:'newer-native',disabled:true});
});
it('rejects native ZCode imports and leaves legacy native grants untouched without reading or exchanging credentials',async()=>{
 const {manager,root}=await setup();await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 const native={type:'zcode',native_oauth:true,native_project:{organizationId:'org',projectId:'project',apiKeyId:'key'},provider:'bigmodel',uid:'native-person',access_token:'native-login-token'};
 const saved=JSON.stringify(native);await writeFile(join(root,'cliproxy/auth/local-zcode-native.json'),saved);
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'local-zcode-native.json',provider:'zcode',status:'active',models:['legacy-model']}]));
 const realFetch=globalThis.fetch;let nativeReads=0,exchanges=0;
 vi.stubGlobal('fetch',async(input:any,init?:RequestInit)=>{
  if(String(input).includes('/zcode-local-credential'))nativeReads++;
  if(String(input).startsWith('https://bigmodel.cn/')){exchanges++;throw Error('must not exchange native ZCode credentials');}
  return realFetch(input,init);
 });
 try{
  await manager.start();await expect(manager.importLocal('zcode')).rejects.toThrow('官网授权');await expect(manager.importCredential('zcode',native)).rejects.toThrow('官网授权');
  await manager.refreshAccounts('zcode',false);expect(nativeReads).toBe(0);expect(exchanges).toBe(0);expect(await readFile(join(root,'cliproxy/auth/local-zcode-native.json'),'utf8')).toBe(saved);
  expect(manager.snapshot().accounts[0]).toMatchObject({unavailable:true,models:[]});expect(manager.snapshot().accounts[0].modelError).toContain('官网授权');
 }finally{vi.unstubAllGlobals();}
});
it('automatically removes only terminal Qoder grants with a verified sibling and preserves old source IDs across restart',async()=>{
 const {manager,root,port}=await setup();await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 const valid={type:'qoder',uid:'person',email:'person@example.test',access_token:'valid',expired:'2035-01-01'};
 for(const [name,extra] of Object.entries({'valid.json':{},'also-valid.json':{access_token:'other-valid'},'expired.json':{access_token:'expired',expired:'2020-01-01'},'refreshable.json':{access_token:'refreshable',expired:'2020-01-01',refresh_token:'can-refresh'}}))await writeFile(join(root,'cliproxy/auth',name),JSON.stringify({...valid,...extra}));
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify(['valid.json','also-valid.json','expired.json','refreshable.json'].map(name=>({name,provider:'qoder',status:'active',models:['shared']}))));
 await manager.start();const oldId=createHash('sha256').update('expired.json').digest('hex').slice(0,24);
 expect(await readdir(join(root,'cliproxy/auth'))).not.toContain('expired.json');expect(await readdir(join(root,'cliproxy/auth'))).toEqual(expect.arrayContaining(['valid.json','also-valid.json','refreshable.json']));
 expect(manager.snapshot().accounts.filter(a=>!a.isDuplicate)).toHaveLength(1);expect(manager.snapshot().accounts.find(a=>!a.isDuplicate)?.authorizations).toHaveLength(3);expect(manager.sourceAuth(oldId,'qoder/shared')).toBeTruthy();
 expect(await readFile(join(root,'cliproxy/auth/valid.json'),'utf8')).toBe(JSON.stringify(valid));
 await manager.stop();const restarted=new CLIProxyManager(root,binary,'fixture-key',port);cleanup.push(()=>restarted.shutdown());await restarted.start();expect(restarted.sourceAuth(oldId,'qoder/shared')).toBeTruthy();
 for(const name of ['valid.json','also-valid.json','refreshable.json']){const path=join(root,'cliproxy/auth',name),raw=JSON.parse(await readFile(path,'utf8'));await writeFile(path,JSON.stringify({...raw,uid:'different-person'}));}
 await restarted.refreshAccounts('qoder',false);expect(()=>restarted.sourceAuth(oldId,'qoder/shared')).toThrow();
});
it('retains uncertain failures and requires an enabled verified sibling before automatic cleanup',async()=>{
 const {manager,root}=await setup();await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 const native={type:'qoder',uid:'person',access_token:'valid',expired:'2035-01-01'};
 const files=[{name:'uncertain.json',provider:'qoder',status:'error',unavailable:true},{name:'expired.json',provider:'qoder',status:'active'},{name:'disabled.json',provider:'qoder',status:'active',disabled:true},{name:'other-person.json',provider:'qoder',status:'active',models:['shared']}];
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify(files));
 for(const file of files)await writeFile(join(root,'cliproxy/auth',file.name),JSON.stringify({...native,uid:file.name==='other-person.json'?'other':native.uid,expired:file.name==='expired.json'?'2020-01-01':native.expired,disabled:file.disabled}));
 await manager.start();expect(await readdir(join(root,'cliproxy/auth'))).toEqual(expect.arrayContaining(files.map(f=>f.name)));expect(manager.snapshot().accounts.some(a=>a.authenticationRequired)).toBe(true);
});
it('does not delete a Qoder grant replaced during model verification',async()=>{
 const {manager,root}=await setup();await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 const native={type:'qoder',uid:'person',access_token:'valid',expired:'2035-01-01'};
 for(const name of ['valid.json','expired.json'])await writeFile(join(root,'cliproxy/auth',name),JSON.stringify({...native,expired:name==='expired.json'?'2020-01-01':'2035-01-01'}));
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify(['valid.json','expired.json'].map(name=>({name,provider:'qoder',status:'active',models:['shared']}))));
 const realFetch=globalThis.fetch;const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{const response=await realFetch(input,init);if(String(input).includes('/auth-files/models?name=valid.json'))await writeFile(join(root,'cliproxy/auth/expired.json'),JSON.stringify({...native,access_token:'new-valid-token'}));return response;});
 try{await manager.start();expect(await readdir(join(root,'cliproxy/auth'))).toContain('expired.json');await manager.refreshAccounts('qoder',false);expect(manager.snapshot().accounts.filter(a=>a.authenticationRequired)).toEqual([]);}finally{spy.mockRestore();}
});
it('keeps all expired grants for user confirmation and rechecks a recovered grant before deletion',async()=>{
 const {manager,root}=await setup();await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 const expired={type:'qoder',uid:'person',access_token:'expired',expired:'2020-01-01'};
 await writeFile(join(root,'cliproxy/auth/expired.json'),JSON.stringify(expired));await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'expired.json',provider:'qoder',status:'active',models:['shared']}]));
 await manager.start();const id=manager.snapshot().accounts[0].id;expect(manager.snapshot().accounts[0].authenticationRequired).toBe(true);expect(await readdir(join(root,'cliproxy/auth'))).toContain('expired.json');
 await writeFile(join(root,'cliproxy/auth/expired.json'),JSON.stringify({...expired,access_token:'recovered',expired:'2035-01-01'}));await expect(manager.removeExpiredAccount(id)).rejects.toMatchObject({statusCode:409});
 await writeFile(join(root,'cliproxy/auth/expired.json'),JSON.stringify(expired));const next=await manager.removeExpiredAccount(id);expect(next.accounts).toEqual([]);
});
it('presents Qoder grants with the same UID as one account while keeping both native authorizations',async()=>{
 const {manager,root}=await setup();await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'standalone.json',provider:'qoder',status:'active',models:['one']},{name:'ide.json',provider:'qoder',status:'active',models:['two']}]));
 for(const [name,email] of [['standalone.json','person@example.test'],['ide.json',undefined]])await writeFile(join(root,'cliproxy/auth',name!),JSON.stringify({type:'qoder',uid:'same-user',email,access_token:`access-${name}`,refresh_token:`refresh-${name}`,expired:'2035-01-01T00:00:00Z'}));
 await manager.start();const pool=manager.snapshot().accounts.filter(a=>a.provider==='qoder');expect(pool).toHaveLength(2);expect(pool.filter(a=>!a.isDuplicate)).toHaveLength(1);expect(pool.every(a=>a.credentialCount===2)).toBe(true);
 const native=await manager.desktopNativeAccounts('qoder');expect(native).toHaveLength(2);expect(native.every(a=>a.accountId==='same-user'&&a.switchable)).toBe(true);expect((await readdir(join(root,'cliproxy/auth'))).filter(n=>n.endsWith('.json'))).toHaveLength(2);
});
it('selects a verified Qoder grant by freshness and model support, then skips expired or officially revoked grants',async()=>{
 const {manager,root}=await setup();await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 const files=[{name:'new.json',provider:'qoder',status:'active',models:['shared']},{name:'backup.json',provider:'qoder',status:'active',modtime:'2050-01-01T00:00:00Z',models:['shared','backup-only']},{name:'expired.json',provider:'qoder',status:'active',models:['shared']}];
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify(files));
 for(const name of ['new.json','backup.json','expired.json'])await writeFile(join(root,'cliproxy/auth',name),JSON.stringify({type:'qoder',uid:'same-user',email:'person@example.test',access_token:`access-${name}`,expired:name==='expired.json'?'2020-01-01':'2035-01-01',authorizedAt:name==='new.json'?'2026-10-21T00:00:00Z':undefined}));
 await manager.start();const id=(name:string)=>createHash('sha256').update(name).digest('hex').slice(0,24);
 expect(manager.sourceAuth(id('expired.json'),'qoder/shared')).toBe('new.json');expect(manager.sourceAuth(id('new.json'),'qoder/backup-only')).toBe('backup.json');
 const details=manager.snapshot().accounts.find(a=>a.id===id('new.json'))!.authorizations!;expect(details).toHaveLength(2);expect(details.find(g=>g.id===id('new.json'))).toMatchObject({preferred:true,authorizedAt:'2026-10-21T00:00:00.000Z'});expect(details.find(g=>g.id===id('expired.json'))).toBeUndefined();
 // Update the same saved grant through the management seam.
 await (manager as any).request('/auth-files?name=new.json','POST',{type:'qoder',uid:'same-user',email:'person@example.test',access_token:'access-new.json',expired:'2020-01-01'});
 await manager.refreshAccounts('qoder',false);expect(manager.sourceAuth(id('new.json'),'qoder/shared')).toBe('backup.json');
 await (manager as any).request('/auth-files?name=new.json','POST',{type:'qoder',uid:'same-user',email:'person@example.test',access_token:'access-new.json',expired:'2035-01-01',authorizedAt:'2026-10-21T00:00:00Z'});
 const original=(manager as any).request.bind(manager),request=vi.spyOn(manager as any,'request').mockImplementation(async(...args:any[])=>{const result=await original(...args);return args[0]==='/auth-files'?{...result,files:result.files.map((f:any)=>f.name==='new.json'?{...f,status:'error',status_message:'invalid_grant',unavailable:true}:f)}:result;});
 try{await manager.refreshAccounts('qoder',false);expect(manager.sourceAuth(id('new.json'),'qoder/shared')).toBe('backup.json');}finally{request.mockRestore();}
});
