import {qoderCrypto,qoderIdeCrypto,runQoderCrypto,closeQoderCrypto} from './qoder-crypto.js';
import { app, BrowserWindow, safeStorage, session, dialog, shell, nativeImage, ipcMain, clipboard, Tray, Menu } from 'electron';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSecrets } from './secrets.js';
import { resolveProfile } from './profile.js';
import { projectWindowOpenHandler } from '../../shared/project-links.js';
import { createDesktopService } from '../../../packages/core/src/service.js';
import { desktopCleanupFiles } from './file-cleanup.js';
import {createNetworkProxy} from '../../../packages/core/src/network-proxy.js';
import {createStartupWindow} from './startup-window.js';
import {rememberedCredentialAccess,rememberCredentialAccess} from './credential-access.js';
import {claudeKeychain} from '../../../packages/core/src/claude-accounts.js';
import {agentPaths} from '../../../packages/core/src/agent-connections.js';
import {workspaceWindowOptions,windowsTitleBar} from './window-options.js';
import {CodexReconciliationMonitor} from '../../../packages/core/src/codex-reconciliation-monitor.js';
import {createQuotaPanel} from './quota-panel.js';

const here=dirname(fileURLToPath(import.meta.url));
if(process.argv.includes('--tokenflow-qoder-crypto')){void runQoderCrypto();}
else {
// Retain the existing profile across the product rename, without copying credentials.
const profile=resolveProfile(app.getPath('appData'),process.env.AGENT_DATA_ROOT);
mkdirSync(profile,{recursive:true,mode:0o700});
app.setPath('userData',profile);
if(process.platform==='win32')app.setAppUserModelId('local.browseragent.desktop');
if(process.platform==='linux')app.setDesktopName('tokenflow.desktop');
// macOS encryption retains the original keychain service across the display-name change.
app.setName(['darwin','linux'].includes(process.platform)?'token-flow':'TokenFlow');
if(!app.requestSingleInstanceLock()) app.quit();
else { void start().catch(error=>{dialog.showErrorBox('TokenFlow 启动失败',error instanceof Error?error.message:String(error));app.exit(1);}); }
}
async function start() {
  let window:BrowserWindow|undefined;
  let closing=false;
  let tray:Tray|undefined;
  let quotaPanel:ReturnType<typeof createQuotaPanel>|undefined;
  await app.whenReady();
  if(process.platform==='win32')Menu.setApplicationMenu(null);
  const icon=join(here,'console','app-icon.png');
  const root=process.env.AGENT_DATA_ROOT?resolve(process.env.AGENT_DATA_ROOT):app.getPath('userData');
  const remembered=await rememberedCredentialAccess(root);
  const startup=await createStartupWindow(icon,remembered?'loading':'choice');
  // Ask only until the user has allowed a successful secure-store load. Never infer consent from credential files.
  let allowCredentials=remembered||await startup.confirmCredentialAccess();
  const resetCredentialChoice=()=>{void rememberCredentialAccess(root,false).catch(()=>dialog.showErrorBox('无法保存启动偏好','请稍后重试。已有凭据不受影响。'));};
  await startup.update('正在准备网络连接…');
  // Resolve external traffic using a separate OS-proxy session. The workspace
  // only loads loopback URLs and must remain reachable with any system proxy.
  const networkSession=session.fromPartition('tokenflow-outbound',{cache:false});
  await networkSession.setProxy({mode:'system'});
  const network=await createNetworkProxy(url=>networkSession.resolveProxy(url));
  network.installFetch();
  await session.defaultSession.setProxy({mode:'direct'});
  await startup.update(allowCredentials?'正在读取已保存的凭据…':'正在准备本地工作台…',allowCredentials?(process.platform==='darwin'?'系统可能请求钥匙串权限，用于解密已保存的凭据。':'正在通过系统安全存储读取已保存的密钥。'):'');
  if(process.platform==='darwin'&&allowCredentials){
    // Keep the legacy service name if the keychain cannot initialize; Secrets exposes its warning.
    try{if(safeStorage.isEncryptionAvailable()){safeStorage.encryptString('');app.setName('TokenFlow');}}catch{}
  }
  if(process.platform==='linux')app.setName('TokenFlow');
  app.setAboutPanelOptions({applicationName:'TokenFlow',iconPath:icon});
  // The keychain-compatible internal name may stay token-flow. Visible menus
  // should still use the product name, including when encryption is unavailable.
  if(process.platform==='darwin')Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'TokenFlow',submenu:[{role:'about',label:'关于 TokenFlow'},{label:'下次启动重新选择登录读取',click:resetCredentialChoice},{type:'separator'},{role:'services',label:'服务'},{type:'separator'},{role:'hide',label:'隐藏 TokenFlow'},{role:'hideOthers',label:'隐藏其他应用'},{role:'unhide',label:'显示全部'},{type:'separator'},{role:'quit',label:'退出 TokenFlow'}]},
    {role:'fileMenu',label:'文件'},{role:'editMenu',label:'编辑'},{role:'viewMenu',label:'视图'},{role:'windowMenu',label:'窗口'},
  ]));
  if(process.platform==='darwin')app.dock?.setIcon(nativeImage.createFromPath(join(here,'console','app-icon-mac.png')));
  await mkdir(join(root,'secrets'),{recursive:true,mode:0o700});
  const secrets=createSecrets(root,safeStorage,process.platform,allowCredentials);
  let localKey=await secrets.get('cliproxy');
  if(!localKey){
    localKey=randomBytes(32).toString('hex');
    if(secrets.canEncrypt())await secrets.set('cliproxy',localKey);
    else secrets.temporaryGateway();
  }
  // Remember only a successful load/write; a locked or unreadable vault must not silently become permanent consent.
  if(allowCredentials)await rememberCredentialAccess(root,!secrets.warnings().length).catch(()=>{});
  const token=randomBytes(32).toString('hex');
  const base=app.isPackaged?process.resourcesPath:resolve(here,'..');
  const claudeKeychainStore=process.platform==='darwin'?claudeKeychain(dirname(agentPaths().claude)):undefined;
  const claudeCredentialStore=claudeKeychainStore;
  const reconciliation=new CodexReconciliationMonitor({root,codexHome:dirname(agentPaths().codex),allowOfficial:false,proxyURL:network.url});
  await startup.update('正在启动本地服务…');
  // Desktop conversations stay on the installed official engine. Cross-provider
  // native-agent runtime remains available only to explicitly configured probes.
  const service=await createDesktopService({nativeCredentialsOnDemand:true,onNativeCredentialAccess:provider=>{secrets.enableAccess();allowCredentials=true;if(provider==='codex')reconciliation.enableOfficial();},codexBridgeRuntime:join(here,'codex-provider-bridge.js'),root,token,localKey,secrets,outboundProxyURL:network.url,networkSnapshot:network.snapshot,fileCleanup:{
    ...desktopCleanupFiles(app,shell),
    pickDirectory:async()=>{
      const picker={title:'选择扫描位置，可选择文件夹或磁盘',properties:['openDirectory'] as ('openDirectory')[]};
      const result=window?await dialog.showOpenDialog(window,picker):await dialog.showOpenDialog(picker);
      return result.canceled?undefined:result.filePaths[0];
    },
  },claudeCredentialStore,desktopAccounts:{crypto:qoderCrypto},qoderIde:{crypto:qoderIdeCrypto},credentialWarnings:()=>[...secrets.warnings(),...(!allowCredentials?['本次启动未读取 TokenFlow 已保存的安全存储，部分账号和 API 密钥暂不可用。本机客户端登录仅在主动导入或切换时读取。']:[])],openExternal:url=>shell.openExternal(url),proxyPort:process.env.AGENT_PROXY_PORT?Number(process.env.AGENT_PROXY_PORT):undefined,binary:process.env.CLIPROXY_BINARY?resolve(process.env.CLIPROXY_BINARY):join(base,'sidecars',`${process.platform}-${process.arch}`,process.platform==='win32'?'cliproxyapi.exe':'cliproxyapi'),uiRoot:join(here,'console')});
  const address=await service.app.listen({host:'127.0.0.1',port:Number(process.env.AGENT_PORT??9527)});
  void reconciliation.start();
  ipcMain.handle('clipboard:write-text',(event,text:unknown)=>{
    if(!window || event.sender!==window.webContents || event.senderFrame!==window.webContents.mainFrame || new URL(event.senderFrame.url).origin!==address)throw new Error('Clipboard request denied');
    if(typeof text!=='string' || text.length>1_000_000)throw new Error('Invalid clipboard text');
    clipboard.writeText(text);
  });
  ipcMain.handle('window:set-theme',(event,theme:unknown)=>{
    if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||new URL(event.senderFrame.url).origin!==address)throw new Error('Window theme request denied');
    if(theme!=='dark'&&theme!=='light')throw new Error('Invalid window theme');
    if(process.platform==='win32')window.setTitleBarOverlay(windowsTitleBar(theme));
  });
  await session.defaultSession.cookies.set({url:address,name:'agent_session',value:token,httpOnly:true,sameSite:'strict',path:'/'});
  const show=async()=>{
    if(process.platform==='darwin')await app.dock?.show();
    if(window){if(window.isMinimized())window.restore();window.show();window.focus();return;}
    window=new BrowserWindow({...workspaceWindowOptions(icon),...startup.bounds(),webPreferences:{preload:join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    if(startup.isMaximized())window.maximize();
    window.webContents.setWindowOpenHandler(projectWindowOpenHandler(url=>shell.openExternal(url),url=>{
        dialog.showErrorBox('无法打开项目页面',`请在浏览器中打开 ${url}`);
    }));
    window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==address)event.preventDefault();});
    window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    window.on('close',event=>{
      if(closing)return;
      event.preventDefault();
      window?.hide();
    });
    window.on('closed',()=>{window=undefined;});
    await window.loadURL(address);
    window.show();
    window.focus();
  };
  const trayIcon=nativeImage.createFromPath(process.platform==='darwin'?join(here,'console','tray-icon.png'):icon).resize(process.platform==='darwin'?{width:18,height:18}:{width:32,height:32});
  if(process.platform==='darwin')trayIcon.setTemplateImage(true);
  tray=new Tray(trayIcon);
  tray.setToolTip('TokenFlow · 账号额度');
  quotaPanel=createQuotaPanel({address,preload:join(here,'preload.cjs'),icon,tray});
  const fromQuotaPanel=(event:Electron.IpcMainInvokeEvent)=>{
    const panel=quotaPanel?.window();
    return !!panel&&event.sender===panel.webContents&&event.senderFrame===panel.webContents.mainFrame&&new URL(event.senderFrame.url).origin===address;
  };
  ipcMain.handle('workspace:open',async(event,view:unknown)=>{
    if(!fromQuotaPanel(event)||view!==undefined&&view!=='accounts')throw new Error('Workspace request denied');
    quotaPanel?.hide();await show();
    if(view==='accounts')window?.webContents.send('accounts:open');
  });
  ipcMain.handle('quota:hide',event=>{if(!fromQuotaPanel(event))throw new Error('Quota panel request denied');quotaPanel?.hide();});
  ipcMain.handle('quota:appearance',(event,theme:unknown)=>{
    if(!fromQuotaPanel(event)||theme!=='dark'&&theme!=='light')throw new Error('Quota appearance request denied');
    return quotaPanel!.setAppearance(theme);
  });
  const trayMenu=Menu.buildFromTemplate([
    {label:'打开工作台',click:()=>{void show();}},
    {label:'维修师傅',click:()=>{void show().then(()=>window?.webContents.send('repair:open'));}},
    {label:'下次启动重新选择登录读取',click:resetCredentialChoice},
    {type:'separator'},
    {label:'退出 TokenFlow',click:()=>app.quit()},
  ]);
  tray.on('right-click',()=>tray?.popUpContextMenu(trayMenu));
  tray.on('click',()=>{void quotaPanel?.toggle().catch(()=>show());});
  app.on('will-quit',()=>{quotaPanel?.destroy();tray?.destroy();});
  app.on('second-instance',()=>{void show();});app.on('activate',()=>{void show();});
  // Keep the gateway and menu bar alive even if the workspace is destroyed.
  app.on('window-all-closed',()=>{});
  app.on('before-quit',event=>{if(closing)return;event.preventDefault();closing=true;void reconciliation.close().finally(()=>service.app.close()).finally(()=>closeQoderCrypto()).finally(()=>network.close()).finally(()=>app.quit());});
  // Load only TokenFlow-owned accounts. External client credentials require a targeted user action.
  await startup.update('正在打开工作台…');
  void service.discoverLocal().catch(() => undefined); // On-demand mode loads saved accounts only.
  await show();
  startup.close();
}
