import { contextBridge, ipcRenderer } from 'electron';
// Expose bounded text writes and appearance changes, never clipboard reads or arbitrary IPC.
contextBridge.exposeInMainWorld('desktop',{
  platform:process.platform,version:'0.1.0',
  copyText:(text:string)=>ipcRenderer.invoke('clipboard:write-text',text),
  setTheme:(theme:'dark'|'light')=>ipcRenderer.invoke('window:set-theme',theme),
  openWorkspace:(view?:'accounts')=>ipcRenderer.invoke('workspace:open',view),
  hideQuotaPanel:()=>ipcRenderer.invoke('quota:hide'),
  setQuotaAppearance:(theme:'dark'|'light')=>ipcRenderer.invoke('quota:appearance',theme),
});

// A main-process shortcut only; no renderer access to arbitrary IPC.
ipcRenderer.on('repair:open',()=>window.dispatchEvent(new Event('token-flow:open-repair')));
ipcRenderer.on('accounts:open',()=>window.dispatchEvent(new Event('token-flow:open-accounts')));
ipcRenderer.on('quota:visibility',(_event,visible:boolean)=>window.dispatchEvent(new CustomEvent('token-flow:quota-visibility',{detail:visible})));
ipcRenderer.on('quota:material',(_event,state:{glass:boolean})=>window.dispatchEvent(new CustomEvent('token-flow:quota-material',{detail:state})));
