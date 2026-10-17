import {createHash} from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm,realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { CLIProxyManager, validateAuthorizationURL } from '../packages/core/src/cliproxy.js';
import { createDesktopService } from '../packages/core/src/service.js';
import {quotaProviders} from '../packages/core/src/quota/index.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const fn of cleanup.splice(0).reverse()) await fn();});
const binary = resolve('tests/fixtures/fake-cliproxy.mjs');
it('preserves official image capabilities and keeps image-dropping adapters text-only',async()=>{
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
 expect(models.find(m=>m.id==='qoder/vision-base-model')?.capabilities?.images).toBe(false);
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
  expect(validateAuthorizationURL('https://bigmodel.cn/login?redirect_uri=https%3A%2F%2Fzcode.z.ai%2Fapi%2Fv1%2Foauth%2Fcli%2Fcallback%2Fbigmodel','zcode-bigmodel').hostname).toBe('bigmodel.cn');
  expect(() => validateAuthorizationURL('https://bigmodel.cn/login?redirect_uri=https%3A%2F%2Fevil.test%2Fcb','zcode-bigmodel')).toThrow();
  expect(() => validateAuthorizationURL('https://bigmodel.cn.evil.test/login','zcode-bigmodel')).toThrow();

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
it('archives and removes explicitly revoked credentials while retaining quota errors and duplicate valid accounts',async()=>{
 const {manager,root}=await setup();const {readFile,readdir,realpath}=await import('node:fs/promises');
 // safe credential reads reject symlink ancestors; use the canonical temp path.
 await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 const files=[{name:'revoked.json',provider:'codex',email:'same@example.test',status:'error',status_message:'refresh_token_revoked'},{name:'valid.json',provider:'codex',email:'same@example.test',status:'active'},{name:'quota.json',provider:'codex',email:'quota@example.test',status:'error',status_message:'HTTP 401'}];
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify(files));await writeFile(join(root,'cliproxy/auth/revoked.json'),'{"refresh_token":"fixture-secret"}');
 const canonical=await realpath(root);const clean=new CLIProxyManager(canonical,binary,'fixture-key',manager.port);cleanup.push(()=>clean.shutdown());await clean.start();
 expect(clean.snapshot().accounts.map(a=>a.label).sort()).toEqual(['quota@example.test','same@example.test']);
 const archive=await readdir(join(root,'revoked-credentials'));expect(archive).toHaveLength(1);expect(await readFile(join(root,'revoked-credentials',archive[0]),'utf8')).toBe('{"refresh_token":"fixture-secret"}');expect(JSON.stringify(clean.snapshot())).not.toContain('fixture-secret');
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
