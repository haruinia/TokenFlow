import {BrowserWindow,app} from 'electron';
import {readFile} from 'node:fs/promises';
import {workspaceWindowOptions} from './window-options.js';

/** Paint before synchronous OS credential access, so a keychain prompt has visible context. */
export async function createStartupWindow(icon:string,initialMode:'choice'|'loading'='choice'){
 const window=new BrowserWindow({...workspaceWindowOptions(icon),webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
 let finished=false;
 window.on('closed',()=>{if(!finished)app.quit();});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.on('will-navigate',event=>event.preventDefault());
 window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 const logo=await readFile(icon).then(data=>`data:image/png;base64,${data.toString('base64')}`).catch(()=>undefined);
 // One brand node and shared stage geometry keep the header anchored across choices and loading.
 const brand=`<header class="brand">${logo?`<img src="${logo}" alt="">`:""}<span>TokenFlow</span></header>`;
 const permissionHint=process.platform==='darwin'?'系统可能请求钥匙串授权。':'系统可能请求安全存储授权。';
 const html=`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>TokenFlow</title><style>
 :root{color-scheme:dark;--canvas:#161719;--text:#ececef;--muted:#a5a6ad;--soft:#37383c}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--canvas);color:var(--text);font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;height:100vh;overflow:hidden}.titlebar{position:absolute;inset:0 0 auto;height:64px;-webkit-app-region:drag}.brand{display:flex;justify-content:center;align-items:center;gap:10px;margin-bottom:28px;font-size:18px;font-weight:600;letter-spacing:-.4px}.brand img{width:32px;height:32px}main{height:100%;display:grid;place-items:center;padding:64px 32px}.startupContent{width:min(480px,100%)}.startupStages{display:grid}.startupStages>section{grid-area:1/1;align-self:start;width:100%}.startupStages>[hidden]{display:block!important;visibility:hidden;pointer-events:none}.loading,.consent{text-align:center;max-width:440px;margin-inline:auto}.ring{width:26px;height:26px;margin:0 auto 24px;border:2px solid var(--soft);border-top-color:var(--text);border-radius:50%;animation:spin 1s linear infinite}h1{font-size:22px;letter-spacing:-.5px;margin:0 0 12px;font-weight:600}p{color:var(--muted);line-height:1.8;margin:0}.hint{font-size:13px;margin-top:8px;margin-inline:auto;max-width:420px}.consent{width:100%}h2{font-size:22px;font-weight:600;letter-spacing:-.5px;margin:0 0 12px;line-height:1.4}h2:focus{outline:none}.detail{font-size:14px}.consent .hint{margin-top:12px;font-size:13px}.actions{display:flex;justify-content:center;gap:12px;margin-top:28px}button{font:inherit;font-size:13px;font-weight:500;min-height:38px;padding:0 16px;border:0;border-radius:7px;cursor:pointer;background:transparent;color:var(--muted);transition:color 150ms,background-color 150ms}button:hover{color:var(--text)}button:focus-visible{outline:none;color:var(--text);font-weight:600;text-decoration:none}button.primary{background:#e1e3e8;color:#1d1e21;font-weight:600}button.primary:hover,button.primary:focus-visible{background:#f1f2f5}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.ring{animation:none}button{transition:none}}@media(max-height:650px){.brand{margin-bottom:20px}main{padding:64px 24px 32px}}
 </style><div class="titlebar" aria-hidden="true"></div><main aria-busy="true"><div class="startupContent">${brand}<div class="startupStages"><section class="loading" id="loading" ${initialMode==='choice'?'hidden':''}><div class="ring" aria-hidden="true"></div><h1>正在准备工作台</h1><p id="status" role="status" aria-live="polite">正在启动…</p><p class="hint" id="hint"></p></section><section class="consent" id="consent" role="region" aria-labelledby="access-title" aria-describedby="access-detail access-hint" hidden><h2 id="access-title" tabindex="-1">读取 TokenFlow 已保存的凭据？</h2><p class="detail" id="access-detail">用于恢复你已在 TokenFlow 保存的 API 密钥和账号。其他客户端的本机登录只在你主动导入或切换时读取。</p><p class="hint" id="access-hint">${permissionHint}暂不读取会保留已有凭据，部分已保存账号和 API 密钥暂不可用。</p><footer class="actions"><button id="skip" type="button">暂不读取</button><button id="allow" class="primary" type="button">允许读取</button></footer></section></div></div></main></html>`;
 await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
 window.show();
 const update=async(status:string,hint='')=>{
  if(window.isDestroyed())return;
  await window.webContents.executeJavaScript(`document.getElementById('status').textContent=${JSON.stringify(status)};document.getElementById('hint').textContent=${JSON.stringify(hint)};new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`).catch(()=>{});
 };
 await update('正在启动…');
 let confirmation:Promise<boolean>|undefined;
 const confirmCredentialAccess=()=>confirmation??=(async()=>{
  if(window.isDestroyed())return false;
  let onClosed:()=>void=()=>{};
  const closed=new Promise<boolean>(resolve=>{onClosed=()=>resolve(false);window.once('closed',onClosed);});
  try{return await Promise.race([closed,window.webContents.executeJavaScript(`new Promise(resolve=>{
   const loading=document.getElementById('loading'),consent=document.getElementById('consent'),main=document.querySelector('main');
   const skip=document.getElementById('skip'),allow=document.getElementById('allow');
   loading.hidden=true;consent.hidden=false;main.setAttribute('aria-busy','false');document.getElementById('access-title').focus();
   const done=value=>{skip.removeEventListener('click',onSkip);allow.removeEventListener('click',onAllow);document.removeEventListener('keydown',onKey);consent.hidden=true;loading.hidden=false;main.setAttribute('aria-busy','true');resolve(value);};
   const onSkip=()=>done(false),onAllow=()=>done(true);
   const onKey=event=>{if(event.key==='Escape'){event.preventDefault();done(false);}};
   skip.addEventListener('click',onSkip);allow.addEventListener('click',onAllow);document.addEventListener('keydown',onKey);
  })`).then(value=>value===true).catch(()=>false)]);}
  finally{window.removeListener('closed',onClosed);confirmation=undefined;}
 })();
 return {update,confirmCredentialAccess,bounds:()=>window.isDestroyed()?undefined:window.getBounds(),isMaximized:()=>!window.isDestroyed()&&window.isMaximized(),close(){finished=true;if(!window.isDestroyed())window.destroy();}};
}
