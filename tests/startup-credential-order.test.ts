import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ServiceOptions} from '../packages/core/src/service.js';
import {rememberedCredentialAccess,rememberCredentialAccess} from '../apps/desktop/src/credential-access.js';

const fixture=vi.hoisted(()=>({
 root:'',events:[] as string[],available:true,decide:(_allowed:boolean)=>{},decision:Promise.resolve(false),
 paint:()=>{},painting:Promise.resolve(),openWorkspace:()=>{},workspaceReady:Promise.resolve(),
}));
const storage=vi.hoisted(()=>({
 isEncryptionAvailable:vi.fn(()=>{fixture.events.push('storage-available');return fixture.available;}),
 encryptString:vi.fn((value:string)=>{fixture.events.push('storage-encrypt');return Buffer.from(value);}),
 decryptString:vi.fn((value:Buffer)=>{fixture.events.push('storage-decrypt');return value.toString();}),
}));
const service=vi.hoisted(()=>vi.fn(async(_options:ServiceOptions)=>({
 app:{listen:async()=>{fixture.events.push('service-listen');return 'http://127.0.0.1:9527';},close:async()=>{}},
 discoverLocal:async()=>{fixture.events.push('discover');},
})));
const clientRead=vi.hoisted(()=>vi.fn(async()=>{fixture.events.push('client-credential');return null;}));
const errors=vi.hoisted(()=>vi.fn());
vi.mock('electron',()=>({
 app:{getPath:()=>fixture.root,setPath:vi.fn(),setName:vi.fn(),requestSingleInstanceLock:()=>true,whenReady:async()=>{},setAboutPanelOptions:vi.fn(),dock:{setIcon:vi.fn(),show:async()=>{}},on:vi.fn(),quit:vi.fn(),exit:vi.fn()},
 safeStorage:storage,session:{fromPartition:()=>({setProxy:async()=>{},resolveProxy:async()=>''}),defaultSession:{setProxy:async()=>{},cookies:{set:async()=>{fixture.events.push('session-cookie');}}}},
 Menu:{setApplicationMenu:vi.fn(),buildFromTemplate:()=>({})},nativeImage:{createFromPath:()=>({resize:()=>({setTemplateImage:vi.fn()})})},dialog:{showErrorBox:errors},
 BrowserWindow:class{
  constructor(){fixture.events.push('workspace-create');}
  webContents={setWindowOpenHandler:vi.fn(),on:vi.fn(),session:{setPermissionRequestHandler:vi.fn()}};
  on=vi.fn();
  async loadURL(){fixture.events.push('workspace-loading');await fixture.workspaceReady;fixture.events.push('workspace-loaded');}
  show(){fixture.events.push('workspace-show');}
  focus(){fixture.events.push('workspace-focus');}
 },
 shell:{},ipcMain:{handle:vi.fn()},clipboard:{},Tray:class{setToolTip=vi.fn();on=vi.fn();},
}));
vi.mock('../apps/desktop/src/profile.js',()=>({resolveProfile:()=>fixture.root}));
vi.mock('../apps/desktop/src/startup-window.js',()=>({createStartupWindow:async(_icon:string,mode:string)=>{fixture.events.push(`startup-mode:${mode}`);return {
 update:async(status:string)=>{
  fixture.events.push(`status:${status}`);
  if(status==='正在读取已保存的凭据…'||status==='正在准备本地工作台…')await fixture.painting;
  fixture.events.push(`painted:${status}`);
 },
 confirmCredentialAccess:()=>{fixture.events.push('confirm');return fixture.decision;},
 bounds:()=>({width:1320,height:900}),isMaximized:()=>false,
 close:()=>{fixture.events.push('startup-close');},
};}}));
vi.mock('../packages/core/src/network-proxy.js',()=>({createNetworkProxy:async()=>({url:'http://127.0.0.1:1',installFetch:()=>{},snapshot:()=>({}),close:async()=>{}})}));
vi.mock('../packages/core/src/service.js',()=>({createDesktopService:service}));
vi.mock('../apps/desktop/src/file-cleanup.js',()=>({desktopCleanupFiles:()=>({})}));
vi.mock('../apps/desktop/src/qoder-crypto.js',()=>({qoderCrypto:clientRead,qoderIdeCrypto:clientRead,runQoderCrypto:vi.fn(),closeQoderCrypto:vi.fn()}));
vi.mock('../packages/core/src/claude-accounts.js',()=>({claudeKeychain:()=>({read:clientRead,write:clientRead})}));
vi.mock('../packages/core/src/agent-connections.js',()=>({agentPaths:()=>({claude:join(fixture.root,'claude/settings.json'),codex:join(fixture.root,'codex/config.toml')})}));
const recorder=vi.hoisted(()=>({options:[] as {allowOfficial:boolean}[]}));
vi.mock('../packages/core/src/codex-reconciliation-monitor.js',()=>({CodexReconciliationMonitor:class {constructor(options:{allowOfficial:boolean}){recorder.options.push(options);}async start(){fixture.events.push('recorder-start');}async close(){fixture.events.push('recorder-stop');}}}));

beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();recorder.options=[];fixture.root=await mkdtemp(join(tmpdir(),'tokenflow-startup-order-'));fixture.events=[];
 await mkdir(join(fixture.root,'secrets'));await writeFile(join(fixture.root,'secrets/cliproxy.bin'),'fixture-local-key');
 fixture.decision=new Promise(resolve=>{fixture.decide=resolve;});
 fixture.painting=new Promise(resolve=>{fixture.paint=resolve;});
 fixture.workspaceReady=new Promise(resolve=>{fixture.openWorkspace=resolve;});
});
afterEach(async()=>{await rm(fixture.root,{recursive:true,force:true});});

for(const available of [true,false])it.each([true,false])(`completes startup after choice and painted loading (vault available: ${available}, client access: %s)`,async allowed=>{
 fixture.available=available;
 await import('../apps/desktop/src/main.js');
 await expect.poll(()=>fixture.events.includes('confirm')).toBe(true);
 expect(fixture.events).toContain('startup-mode:choice');
 expect(fixture.events.filter(event=>event.startsWith('storage-'))).toEqual([]);
 expect(service).not.toHaveBeenCalled();expect(clientRead).not.toHaveBeenCalled();
 const credentialStatus=allowed?'正在读取已保存的凭据…':'正在准备本地工作台…';
 fixture.events.push('choice-resolved');fixture.decide(allowed);
 await expect.poll(()=>fixture.events.includes(`status:${credentialStatus}`)).toBe(true);
 // A status update is not enough: wait until the loading UI has painted before entering synchronous OS storage.
 expect(fixture.events.filter(event=>event.startsWith('storage-'))).toEqual([]);
 fixture.paint();
 await expect.poll(()=>fixture.events.includes('workspace-loading')).toBe(true);
 expect(errors).not.toHaveBeenCalled();
 const before=(first:string,last:string)=>{
  expect(fixture.events).toContain(first);expect(fixture.events).toContain(last);
  expect(fixture.events.indexOf(first)).toBeLessThan(fixture.events.indexOf(last));
 };
 before('choice-resolved',`painted:${credentialStatus}`);
 if(allowed){before('painted:正在读取已保存的凭据…','storage-available');before('storage-available','service-listen');}
 else expect(fixture.events.filter(event=>event.startsWith('storage-'))).toEqual([]);
 before('service-listen','session-cookie');before('service-listen','recorder-start');expect(recorder.options[0].allowOfficial).toBe(allowed);
 before('session-cookie','workspace-create');before('painted:正在打开工作台…','workspace-create');
 expect(fixture.events).not.toContain('startup-close');expect(fixture.events).not.toContain('workspace-show');
 const options=service.mock.calls[0][0];
 const operations=[
  ()=>options.desktopAccounts!.crypto!('decrypt','fixture'),
  ()=>options.qoderIde!.crypto!('decrypt','fixture'),
  ...(process.platform==='darwin'?[
   ()=>options.claudeCredentialStore!.read(),()=>options.claudeCredentialStore!.write(null),
  ]:[]),
 ];
 for(const operation of operations){
  if(allowed)await operation();
  else await expect(operation()).rejects.toThrow('本次启动未允许');
 }
 expect(clientRead).toHaveBeenCalledTimes(allowed?operations.length:0);
 expect(options.credentialWarnings!().some(w=>w.includes('临时密钥'))).toBe(!allowed||!available);
 if(!allowed){
  for(let attempt=0;attempt<2;attempt++)expect(await options.secrets.get('cliproxy')).toBe('');
  await expect(options.secrets.set('cliproxy','replacement')).rejects.toThrow('本次启动已跳过');
  expect(fixture.events.filter(event=>event.startsWith('storage-'))).toEqual([]);
 }
 expect(storage.decryptString).toHaveBeenCalledTimes(allowed&&available?1:0);
 expect(await rememberedCredentialAccess(fixture.root)).toBe(allowed&&available);
 // Skipping must never touch the OS vault, including TokenFlow's own encrypted credentials.
 expect(await readFile(join(fixture.root,'secrets/cliproxy.bin'),'utf8')).toBe('fixture-local-key');
 expect(options.credentialWarnings!().some(w=>w.includes('已跳过所有安全存储'))).toBe(!allowed);
 fixture.openWorkspace();
 await expect.poll(()=>fixture.events.includes('startup-close')).toBe(true);
 before('workspace-loaded','workspace-show');before('workspace-show','workspace-focus');before('workspace-focus','startup-close');
 expect(fixture.events.filter(event=>event==='workspace-create')).toHaveLength(1);
 expect(errors).not.toHaveBeenCalled();
});

it.each([true,false])('uses remembered consent without asking again and clears it if the vault is unavailable (%s)',async available=>{
 fixture.available=available;await rememberCredentialAccess(fixture.root,true);
 await import('../apps/desktop/src/main.js');
 await expect.poll(()=>fixture.events.includes('status:正在读取已保存的凭据…')).toBe(true);
 expect(fixture.events).toContain('startup-mode:loading');expect(fixture.events).not.toContain('confirm');
 expect(storage.isEncryptionAvailable).not.toHaveBeenCalled();
 fixture.paint();
 await expect.poll(()=>fixture.events.includes('workspace-loading')).toBe(true);
 expect(await rememberedCredentialAccess(fixture.root)).toBe(available);
 expect(storage.decryptString).toHaveBeenCalledTimes(available?1:0);
 fixture.openWorkspace();await expect.poll(()=>fixture.events.includes('startup-close')).toBe(true);
 expect(errors).not.toHaveBeenCalled();
});

it('reuses the successful first launch choice and the same stored key on the second launch',async()=>{
 fixture.available=true;
 await import('../apps/desktop/src/main.js');await expect.poll(()=>fixture.events.includes('confirm')).toBe(true);
 fixture.decide(true);fixture.paint();fixture.openWorkspace();
 await expect.poll(()=>fixture.events.includes('startup-close')).toBe(true);
 expect(await rememberedCredentialAccess(fixture.root)).toBe(true);
 vi.resetModules();vi.clearAllMocks();fixture.events=[];
 await import('../apps/desktop/src/main.js');
 await expect.poll(()=>fixture.events.includes('startup-close')).toBe(true);
 expect(fixture.events).not.toContain('confirm');expect(fixture.events).toContain('startup-mode:loading');
 expect(service.mock.calls[0][0].localKey).toBe('fixture-local-key');
 expect(errors).not.toHaveBeenCalled();
});
