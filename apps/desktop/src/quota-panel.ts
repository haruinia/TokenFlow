import {BrowserWindow,screen,type Tray} from 'electron';
import {quotaPanelBounds} from './quota-panel-bounds.js';

/** An independent, read-only view. Hiding either window never stops the gateway. */
export function createQuotaPanel(options:{address:string;preload:string;icon:string;tray:Tray}){
 let window:BrowserWindow|undefined;
 let loading:Promise<void>|undefined;
 let requested=false;
 let lastBlur=0;
 const hide=()=>{requested=false;window?.hide();};
 const toggle=async()=>{
  // On macOS the tray click first blurs the panel. Treat that click as a close.
  if(requested||Date.now()-lastBlur<180){hide();return;}
  requested=true;
  if(!window){
   const panel=new BrowserWindow({width:400,height:580,show:false,frame:false,resizable:false,minimizable:false,maximizable:false,fullscreenable:false,skipTaskbar:true,alwaysOnTop:true,backgroundColor:'#202123',title:'TokenFlow · 账号额度',icon:options.icon,
    webPreferences:{preload:options.preload,contextIsolation:true,nodeIntegration:false,sandbox:true}});
   window=panel;
   panel.webContents.setWindowOpenHandler(()=>({action:'deny'}));
   panel.webContents.on('will-navigate',event=>event.preventDefault());
   panel.on('blur',()=>{lastBlur=Date.now();hide();});
   panel.on('show',()=>panel.webContents.send('quota:visibility',true));
   panel.on('hide',()=>panel.webContents.send('quota:visibility',false));
   panel.on('closed',()=>{window=undefined;loading=undefined;requested=false;});
   loading=panel.loadURL(`${options.address}/?panel=quota`).catch(error=>{panel.destroy();throw error;});
  }
  await loading;
  if(!requested||!window||window.isDestroyed())return;
  const anchor=options.tray.getBounds();
  const display=anchor.width?screen.getDisplayMatching(anchor):screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  window.setBounds(quotaPanelBounds(anchor,display.workArea));
  window.show();window.focus();
 };
 return {toggle,hide,window:()=>window,destroy:()=>{requested=false;window?.destroy();}};
}
