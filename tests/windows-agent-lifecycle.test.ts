import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,win32} from 'node:path';
import {createPackage} from '@electron/asar';
import {electronPackageName,electronDesktopIdentity,qoderIdeWindowsIdentity,codexCliWindowsIdentity,windowsAppIdentity,WindowsAgentLifecycle,type WindowsProcess,type WindowsTarget} from '../packages/core/src/windows-agent-lifecycle.js';
import {qoderIdeUserDataPath} from '../packages/core/src/qoder-ide-login.js';

const identities={'claude-desktop':'@ant/desktop',qoder:'qoder','qoder-ide':'qoder-ide',codex:'openai-codex-electron',workbuddy:'@genie/workbuddy-desktop','workbuddy-ai':'@genie/workbuddy-desktop:international',deepseek:'@deepseek-ai/dsh-desktop'};
const paths={'qoder-ide':'D:\\Apps\\Qoder IDE\\Qoder.exe','claude-desktop':'D:\\Apps\\Claude\\Claude.exe',qoder:'D:\\中文 程序\\Qoder\\Qoder.exe',codex:'D:\\Apps\\Codex\\Codex.exe',workbuddy:'D:\\Apps\\WorkBuddy\\WorkBuddy.exe','workbuddy-ai':'D:\\Apps\\WorkBuddy AI\\WorkBuddyAI.exe',deepseek:'D:\\Apps\\DeepSeek\\DeepSeek Harness.exe'};
const proc=(target:WindowsTarget='qoder',extra:Partial<WindowsProcess>={}):WindowsProcess=>({pid:100,parent:10,path:paths[target],started:'638000000000000000',...extra});
const decode=(args:string[])=>Buffer.from(args[args.indexOf('-EncodedCommand')+1],'base64').toString('utf16le');
function fixture(target:WindowsTarget='qoder'){
 const state={rows:[proc(target)] as unknown[],close:true,launch:true,store:[] as {path:string;appId:string}[],inspectCount:0,beforeInspect:undefined as undefined|(()=>void)};
 const identity=vi.fn(async(path:string):Promise<string|undefined>=>path.toLowerCase()===paths[target].toLowerCase()?identities[target]:path.includes('IDE')?'Qoder':undefined);
 const run=vi.fn(async(file:string,args:string[])=>{
  expect(file).toBe('powershell.exe');const script=decode(args);
  expect(script).not.toMatch(/taskkill|Stop-Process|\.Kill\(|Get-Process -Name/);
  if(script.includes('# tokenflow:inspect')){state.inspectCount++;state.beforeInspect?.();return {stdout:JSON.stringify(state.rows)};}
  if(script.includes('# tokenflow:store'))return {stdout:JSON.stringify(state.store)};
  if(script.includes('# tokenflow:close')){if(state.close)state.rows=[];return {stdout:''};}
  if(script.includes('# tokenflow:open')){if(state.launch)state.rows=[proc(target,{pid:200,started:'638000000000000010'})];return {stdout:''};}
  throw Error('unexpected script');
 });
 const lifecycle=new WindowsAgentLifecycle(run,async()=>{},identity);
 const scripts=()=>run.mock.calls.map(([,args])=>decode(args));
 return {state,identity,run,lifecycle,scripts};
}
it('attributes Claude Desktop managed Claude Code processes to the desktop, not a standalone CLI',async()=>{
 const previous=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA='D:\\Local';
 try{expect(await windowsAppIdentity(win32.join('D:\\Local','Claude-3p','claude-code','2.1.304','aed62990b91e','claude.exe'))).toBe('claude-desktop-helper');expect(await windowsAppIdentity('D:\\Apps\\Claude\\Claude.exe')).toBeUndefined();}
 finally{if(previous===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previous;}
});
it.each(['qoder','qoder-ide','codex','workbuddy','workbuddy-ai','deepseek','claude-desktop'] as const)('gracefully restarts the verified %s installation, including Electron helper processes',async target=>{
 const f=fixture(target);f.state.rows.push(proc(target,{pid:101,parent:100}));
 await expect(f.lifecycle.restart(target)).resolves.toHaveProperty('message');
 const close=f.scripts().find(s=>s.includes('# tokenflow:close'))!;
 expect(close).toContain('Get-Process -Id $e.pid');expect(close).toContain('$p.Handle');expect(close).toContain('StartTime.ToUniversalTime().Ticks');expect(close).toContain('[String]::Equals($p.Path,$e.path');
 expect(close.indexOf('foreach($p in $checked){if')).toBeGreaterThan(close.indexOf("throw 'Process changed'"));
 expect(f.scripts().filter(s=>s.includes('# tokenflow:open'))).toHaveLength(1);
 expect(f.scripts().find(s=>s.includes('# tokenflow:open'))).toContain(paths[target]);
});
it('never sends a close request to Qoder IDE, even when its executable is Qoder.exe',async()=>{
 const f=fixture();f.state.rows.push(proc('qoder',{pid:999,path:'C:\\Qoder IDE\\Qoder.exe'}));
 await f.lifecycle.restart('qoder');
 const close=f.scripts().find(s=>s.includes('# tokenflow:close'))!;
 const payload=JSON.parse(Buffer.from(close.match(/FromBase64String\('([^']+)'\)/)![1],'base64').toString());
 expect(payload.map((p:WindowsProcess)=>p.pid)).toEqual([100]);
});
it.each(['workbuddy','workbuddy-ai'] as const)('never closes the other WorkBuddy edition when restarting %s',async target=>{
 const f=fixture(target),other=target==='workbuddy'?'workbuddy-ai':'workbuddy';f.state.rows.push(proc(other,{pid:900}));f.identity.mockImplementation(async path=>path===paths[target]?identities[target]:identities[other]);
 await f.lifecycle.restart(target);const close=f.scripts().find(s=>s.includes('# tokenflow:close'))!,payload=JSON.parse(Buffer.from(close.match(/FromBase64String\('([^']+)'\)/)![1],'base64').toString());expect(payload.map((p:WindowsProcess)=>p.pid)).toEqual([100]);expect(f.scripts().find(s=>s.includes('# tokenflow:open'))).toContain(paths[target]);
});
it.each([
 proc('qoder',{path:'C:\\Unrelated\\Qoder.exe'}),
 {pid:999},
 proc('qoder',{started:''}),
 proc('qoder',{path:'relative.exe'}),
])('does not close any program when a same-name process cannot be verified: %j',async unknown=>{
 const f=fixture();f.state.rows.push(unknown);
 await expect(f.lifecycle.restart('qoder')).rejects.toThrow('无法确认');
 expect(f.scripts().every(s=>s.includes('# tokenflow:inspect'))).toBe(true);
});
it.each([false,true])('refuses multiple instances before closing anything (different installation: %s)',async different=>{
 const f=fixture();const path=different?'C:\\Second\\Qoder.exe':paths.qoder;f.state.rows.push(proc('qoder',{pid:300,parent:20,path}));f.identity.mockResolvedValue('qoder');
 await expect(f.lifecycle.restart('qoder')).rejects.toThrow('多个');
 expect(f.scripts()).toHaveLength(1);
});
it('aborts when a PID is reused between inspection and close',async()=>{
 const f=fixture();f.state.beforeInspect=()=>{if(f.state.inspectCount===2)f.state.rows=[proc('qoder',{started:'638000000000000001'})];};
 await expect(f.lifecycle.restart('qoder')).rejects.toThrow('进程已变化');
 expect(f.scripts().some(s=>s.includes('# tokenflow:close'))).toBe(false);
});
it('leaves tray and save-dialog processes alone after the grace period, without opening duplicates',async()=>{
 const f=fixture();f.state.close=false;
 await expect(f.lifecycle.restart('qoder')).rejects.toThrow('系统托盘');
 expect(f.scripts().filter(s=>s.includes('# tokenflow:close'))).toHaveLength(1);
 expect(f.scripts().some(s=>s.includes('# tokenflow:open'))).toBe(false);
});
it('does not retry a delayed launch',async()=>{
 const f=fixture();f.state.launch=false;
 await expect(f.lifecycle.restart('qoder')).rejects.toThrow('启动尚未确认');
 expect(f.scripts().filter(s=>s.includes('# tokenflow:open'))).toHaveLength(1);
});
it('does not launch after the executable identity changes',async()=>{
 const f=fixture();await f.lifecycle.stop('qoder');f.identity.mockResolvedValue('unrelated-app');
 await expect(f.lifecycle.open('qoder')).rejects.toThrow('身份已变化');expect(f.scripts().some(s=>s.includes('# tokenflow:open'))).toBe(false);
});
it('does not open duplicates when an app restarts itself',async()=>{
 const f=fixture();await f.lifecycle.stop('qoder');f.state.rows=[proc('qoder',{pid:300})];
 await expect(f.lifecycle.open('qoder')).rejects.toThrow('已重新运行');expect(f.scripts().some(s=>s.includes('# tokenflow:open'))).toBe(false);
});
it('cannot launch a different target using the previous selection',async()=>{
 const f=fixture();await f.lifecycle.stop('qoder');await expect(f.lifecycle.open('workbuddy')).rejects.toThrow('缺少');
});
it('uses verified Store package registration rather than a Start menu display name',async()=>{
 const f=fixture('codex');const path='C:\\Program Files\\WindowsApps\\OpenAI.Codex_1_x64_pub\\app\\Codex.exe';
 f.state.rows=[];f.state.store=[{path,appId:'OpenAI.Codex_publisher!App'}];f.identity.mockImplementation(async p=>p===path?identities.codex:undefined);
 await f.lifecycle.stop('codex');
 f.state.beforeInspect=()=>{if(f.scripts().some(s=>s.includes('# tokenflow:open')))f.state.rows=[proc('codex',{path})];};
 await f.lifecycle.open('codex');
 const script=f.scripts().find(s=>s.includes('# tokenflow:open'))!;expect(script).toContain('shell:AppsFolder\\OpenAI.Codex_publisher!App');expect(f.scripts().join('\n')).not.toContain('Get-StartApps');
});
it('refuses an unregistered running Store application before closing it',async()=>{
 const f=fixture('codex');f.state.rows=[proc('codex',{path:'C:\\Program Files\\WindowsApps\\Codex\\Codex.exe'})];f.identity.mockResolvedValue(identities.codex);
 await expect(f.lifecycle.stop('codex')).rejects.toThrow('启动入口');expect(f.scripts().some(s=>s.includes('# tokenflow:close'))).toBe(false);
});
it('uses verified Store package registration for the Microsoft Store Claude desktop',async()=>{
 const f=fixture('claude-desktop');const path='C:\\Program Files\\WindowsApps\\AnthropicPBC.Claude_3.1623.0.0_x64__fnn82j28hfe8t\\Claude.exe';
 f.state.rows=[];f.state.store=[{path,appId:'AnthropicPBC.Claude_fnn82j28hfe8t!Claude'}];f.identity.mockImplementation(async p=>p===path?identities['claude-desktop']:undefined);
 await f.lifecycle.stop('claude-desktop');
 f.state.beforeInspect=()=>{if(f.scripts().some(s=>s.includes('# tokenflow:open')))f.state.rows=[proc('claude-desktop',{path})];};
 await f.lifecycle.open('claude-desktop');
 const storeScript=f.scripts().find(s=>s.includes('# tokenflow:store'))!;
 expect(storeScript).toContain("Get-AppxPackage -Name 'AnthropicPBC.Claude'");
 expect(storeScript).not.toContain('OpenAI.Codex');
 const script=f.scripts().find(s=>s.includes('# tokenflow:open'))!;
 expect(script).toContain('shell:AppsFolder\\AnthropicPBC.Claude_fnn82j28hfe8t!Claude');
});

it('passes API isolation paths to only the verified Windows Codex process',async()=>{
 const f=fixture('codex');await f.lifecycle.stop('codex');
 await f.lifecycle.open('codex',{CODEX_HOME:"D:\\User's API\\home",CODEX_ELECTRON_USER_DATA_PATH:'D:\\API data'});
 const script=f.scripts().find(s=>s.includes('# tokenflow:open'))!;
 expect(script).toContain("$env:CODEX_HOME='D:\\User''s API\\home'");expect(script).toContain("$env:CODEX_ELECTRON_USER_DATA_PATH='D:\\API data'");
 expect(script).toContain("Start-Process -FilePath '"+paths.codex+"'");
});
it('fails closed on a process-query error or malformed response',async()=>{
 const f=fixture();f.run.mockResolvedValue({stdout:'private invalid output'});
 await expect(f.lifecycle.stop('qoder')).rejects.toThrow('无法可靠检查');expect(f.run).toHaveBeenCalledOnce();
});
it('quotes executable paths with apostrophes without injecting PowerShell syntax',async()=>{
 const f=fixture();const path="D:\\User's Apps\\Qoder.exe";f.state.rows=[proc('qoder',{path})];f.identity.mockResolvedValue('qoder');await f.lifecycle.stop('qoder');
 f.state.beforeInspect=()=>{if(f.scripts().some(s=>s.includes('# tokenflow:open')))f.state.rows=[proc('qoder',{path})];};
 await f.lifecycle.open('qoder');expect(f.scripts().find(s=>s.includes('# tokenflow:open'))).toContain("'D:\\User''s Apps\\Qoder.exe'");
});
const dirs:string[]=[];afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
it('reads real ASAR package identity and distinguishes standalone Qoder from Qoder IDE',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tokenflow-asar-'));dirs.push(dir);const source=join(dir,'source');await mkdir(source);
 for(const name of ['@ant/desktop','qoder','Qoder','openai-codex-electron','@genie/workbuddy-desktop','@deepseek-ai/dsh-desktop']){
  await writeFile(join(source,'package.json'),JSON.stringify({name}));const archive=join(dir,'app.asar');await createPackage(source,archive);expect(await electronPackageName(archive)).toBe(name);
 }
});
it('rejects oversized or truncated ASAR headers without allocating arbitrary sizes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tokenflow-asar-'));dirs.push(dir);const archive=join(dir,'app.asar');const buffer=Buffer.alloc(8);buffer.writeUInt32LE(4);buffer.writeUInt32LE(0xffffffff,4);await writeFile(archive,buffer);
 await expect(electronPackageName(archive)).rejects.toThrow('Invalid ASAR');await writeFile(archive,'bad');await expect(electronPackageName(archive)).rejects.toThrow('Truncated');
});
it('distinguishes WorkBuddy editions even though their ASAR package names are identical',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tokenflow-editions-'));dirs.push(dir);const source=join(dir,'source');await mkdir(source);
 for(const [productName,expected] of [['WorkBuddy','@genie/workbuddy-desktop'],['WorkBuddy AI','@genie/workbuddy-desktop:international'],['WorkBuddyAI','@genie/workbuddy-desktop:international'],['Another App',undefined]]){
  await writeFile(join(source,'package.json'),JSON.stringify({name:'@genie/workbuddy-desktop',productName}));const archive=join(dir,'app.asar');await createPackage(source,archive);expect(await electronDesktopIdentity(archive)).toBe(expected);
 }
});
it('ignores a known unrelated app without choosing a display-name launch fallback',async()=>{
 const f=fixture();f.state.rows=[proc('qoder',{path:'C:\\Qoder IDE\\Qoder.exe'})];
 await expect(f.lifecycle.restart('qoder')).rejects.toThrow('安装位置');
 expect(f.scripts().some(s=>s.includes('# tokenflow:close')||s.includes('# tokenflow:open'))).toBe(false);
});
it('does not close anything if native revalidation detects a changed PID',async()=>{
 const f=fixture();const original=f.run.getMockImplementation()!;
 f.run.mockImplementation(async(file,args)=>{if(decode(args).includes('# tokenflow:close'))throw Error('Process changed');return original(file,args);});
 await expect(f.lifecycle.restart('qoder')).rejects.toThrow('进程身份已变化');expect(f.scripts().some(s=>s.includes('# tokenflow:open'))).toBe(false);
});
it('compares Windows executable paths without case sensitivity',async()=>{
 const f=fixture();f.state.rows.push(proc('qoder',{pid:101,parent:100,path:paths.qoder.toUpperCase()}));
 await expect(f.lifecycle.restart('qoder')).resolves.toHaveProperty('message');
});
it('requires launch confirmation from the same installation',async()=>{
 const f=fixture();await f.lifecycle.stop('qoder');f.identity.mockResolvedValue('qoder');
 f.state.beforeInspect=()=>{if(f.scripts().some(s=>s.includes('# tokenflow:open')))f.state.rows=[proc('qoder',{path:'C:\\Other Installation\\Qoder.exe'})];};
 await expect(f.lifecycle.open('qoder')).rejects.toThrow('启动尚未确认');expect(f.scripts().filter(s=>s.includes('# tokenflow:open'))).toHaveLength(1);
});

it('restarts Qoder IDE without closing the independently logged-in standalone Qoder',async()=>{
 const f=fixture('qoder-ide');f.state.rows.push(proc('qoder',{pid:999}));f.identity.mockImplementation(async path=>path===paths['qoder-ide']?'qoder-ide':'qoder');
 await f.lifecycle.restart('qoder-ide');const close=f.scripts().find(s=>s.includes('# tokenflow:close'))!,payload=JSON.parse(Buffer.from(close.match(/FromBase64String\('([^']+)'\)/)![1],'base64').toString());expect(payload.map((p:WindowsProcess)=>p.pid)).toEqual([100]);expect(f.scripts().find(s=>s.includes('# tokenflow:open'))).toContain(paths['qoder-ide']);
});
it('validates the unpacked Windows Qoder IDE product instead of accepting the executable name',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'qoder-ide-product-'));dirs.push(dir);await writeFile(join(dir,'package.json'),JSON.stringify({name:'Qoder'}));
 const product={win32AppUserModelId:'AlibabaCloud.Qoder',applicationName:'qoder',dataFolderName:'.qoder'};await writeFile(join(dir,'product.json'),JSON.stringify(product));expect(await qoderIdeWindowsIdentity(dir)).toBe('qoder-ide');
 await writeFile(join(dir,'product.json'),JSON.stringify({...product,win32AppUserModelId:'Unrelated.Editor'}));expect(await qoderIdeWindowsIdentity(dir)).toBeUndefined();
});
it('accepts the package names Qoder IDE builds ship with next to the unchanged product identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'qoder-ide-names-'));dirs.push(dir);await writeFile(join(dir,'product.json'),JSON.stringify({win32AppUserModelId:'AlibabaCloud.Qoder',applicationName:'qoder',dataFolderName:'.qoder'}));
 // 1.106.3 ships "Qoder IDE"; keep accepting the older "Qoder" and Linux "qoder-ide" spellings.
 for(const name of ['Qoder','Qoder IDE','qoder-ide']){await writeFile(join(dir,'package.json'),JSON.stringify({name}));expect(await qoderIdeWindowsIdentity(dir)).toBe('qoder-ide');}
 await writeFile(join(dir,'package.json'),JSON.stringify({name:'SomeOtherEditor'}));expect(await qoderIdeWindowsIdentity(dir)).toBeUndefined();
});
it('restarts Qoder even though its crash reporter outlives the closed app',async()=>{
 // Electron's crashpad-handler keeps the app's image name and path after the main process
 // exits. Treating it as a live instance made every restart fail with "尚未退出".
 const f=fixture('qoder');
 f.state.rows=[proc('qoder',{pid:100}),proc('qoder',{pid:777,path:paths.qoder,crashReporter:true})];
 await f.lifecycle.restart('qoder');
 const close=f.scripts().find(s=>s.includes('# tokenflow:close'))!;
 const payload=JSON.parse(Buffer.from(close.match(/FromBase64String\('([^']+)'\)/)![1],'base64').toString());
 expect(payload.map((p:WindowsProcess)=>p.pid)).toEqual([100]);
});
it('treats the Qoder.exe bundled inside a running Qoder IDE as a known IDE helper',async()=>{
 // Qoder IDE runs its own Qoder.exe under resources/app/resources/bin. Sharing the standalone
 // app's file name must not block the standalone app as an unknown process.
 const bundled='C:\\Users\\user\\AppData\\Local\\Programs\\Qoder IDE\\resources\\app\\resources\\bin\\x86_64_windows\\Qoder.exe';
 expect(await windowsAppIdentity(bundled)).toBe('qoder-ide-helper');
 // A bare Qoder.exe with no package metadata stays unknown rather than being guessed.
 expect(await windowsAppIdentity('D:\\Unrelated\\Qoder\\Qoder.exe')).toBeUndefined();
 const f=fixture('qoder');
 f.state.rows.push(proc('qoder',{pid:999,parent:10,path:bundled}));
 f.identity.mockImplementation(async path=>path===bundled?'qoder-ide-helper':'qoder');
 await f.lifecycle.restart('qoder');
 const close=f.scripts().find(s=>s.includes('# tokenflow:close'))!;
 const payload=JSON.parse(Buffer.from(close.match(/FromBase64String\('([^']+)'\)/)![1],'base64').toString());
 expect(payload.map((p:WindowsProcess)=>p.pid)).toEqual([100]);
});
it('resolves Qoder IDE from its current Qoder IDE.exe as well as the legacy Qoder.exe',async()=>{
 for(const exe of ['Qoder IDE.exe','Qoder.exe']){
  const root=await mkdtemp(join(tmpdir(),'qoder-ide-exe-'));dirs.push(root);
  const app=join(root,'resources','app');await mkdir(app,{recursive:true});
  await writeFile(join(app,'package.json'),JSON.stringify({name:'Qoder IDE'}));
  await writeFile(join(app,'product.json'),JSON.stringify({win32AppUserModelId:'AlibabaCloud.Qoder',applicationName:'qoder',dataFolderName:'.qoder'}));
  expect(await windowsAppIdentity(join(root,exe))).toBe('qoder-ide');
 }
});

it('does not close an IDE whose profile is outside the default user-data directory',async()=>{
 const f=fixture('qoder-ide');f.state.rows=[proc('qoder-ide',{profile:'D:\\Portable\\QoderData'})];await expect(f.lifecycle.stop('qoder-ide')).rejects.toThrow('自定义配置');expect(f.scripts().some(s=>s.includes('# tokenflow:close'))).toBe(false);
});
it('restarts Qoder IDE although every Electron child carries the default user-data flag',async()=>{
 // Qoder IDE passes --user-data-dir to each child process; the default path is not a custom profile.
 const f=fixture('qoder-ide');
 f.state.rows=[proc('qoder-ide',{pid:100,profile:qoderIdeUserDataPath('win32')})];
 await f.lifecycle.restart('qoder-ide');
 const close=f.scripts().find(s=>s.includes('# tokenflow:close'))!;
 const payload=JSON.parse(Buffer.from(close.match(/FromBase64String\('([^']+)'\)/)![1],'base64').toString());
 expect(payload.map((p:WindowsProcess)=>p.pid)).toEqual([100]);
});
it('identifies official OpenAI Codex CLI binaries and ignores them during desktop close',async()=>{
 expect(codexCliWindowsIdentity('C:\\Users\\user\\AppData\\Local\\OpenAI\\Codex\\bin\\hash123\\codex.exe')).toBe('openai-codex-cli');
 expect(codexCliWindowsIdentity('C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64__abc\\app\\resources\\codex.exe')).toBe('openai-codex-cli');
 expect(codexCliWindowsIdentity('C:\\Unrelated\\codex.exe')).toBeUndefined();
 const f=fixture('codex');
 f.state.rows.push(proc('codex',{pid:888,parent:100,path:'C:\\Users\\user\\AppData\\Local\\OpenAI\\Codex\\bin\\hash123\\codex.exe'}));
 f.identity.mockImplementation(async path=>path.toLowerCase()===paths.codex.toLowerCase()?'openai-codex-electron':codexCliWindowsIdentity(path));
 await f.lifecycle.restart('codex');
 const close=f.scripts().find(s=>s.includes('# tokenflow:close'))!;
 const payload=JSON.parse(Buffer.from(close.match(/FromBase64String\('([^']+)'\)/)![1],'base64').toString());
 expect(payload.map((p:WindowsProcess)=>p.pid)).toEqual([100]);
});

it('reads ASAR metadata with process.noAsar=true even when running inside Electron',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'asar-noasar-'));dirs.push(dir);
 const asarPath=join(dir,'app.asar');
 const contentDir=join(dir,'src');
 await mkdir(contentDir,{recursive:true});
 await writeFile(join(contentDir,'package.json'),JSON.stringify({name:'test-app',productName:'TestApp'}));
 await createPackage(contentDir,asarPath);
 (process as {noAsar?:boolean}).noAsar=false;
 expect(await electronPackageName(asarPath)).toBe('test-app');
});
