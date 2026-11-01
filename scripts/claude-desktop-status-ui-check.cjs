// Run after npm run build: npx electron scripts/claude-desktop-status-ui-check.cjs
// Fixture-only UI verification; never reads or changes a real client configuration.
const {app,BrowserWindow}=require('electron');
const {createServer}=require('node:http');
const {readFile,mkdtemp,rm,writeFile,mkdir}=require('node:fs/promises');
const {resolve,join,extname}=require('node:path');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
(async()=>{
 const root=await mkdtemp(join(tmpdir(),'tokenflow-desktop-status-'));app.setPath('userData',root);app.on('window-all-closed',()=>{});await app.whenReady();app.dock?.hide();
 let connected=true,cliSignedIn=false,fail=false,mappingUpdateRequired=true,configurationChanged=false,apiDirect=null;
 const choice={sourceId:'source',model:'claude/fixture'};
 const local={state:'running',loginState:'idle',port:8317,logs:[],accounts:[{id:'source',provider:'claude',label:'fixture@example.test',status:'active',disabled:false,unavailable:false,models:[choice.model]}],models:[{id:choice.model,provider:'claude'}],quotas:{},quotaBusy:false,providers:[]};
 const target={id:'claude',name:'Claude Code',installation:{installed:true,version:'1.0'},exists:true,revision:'fixture',pids:[],connection:null,configurationState:'unmanaged',backups:[]};
 const desktop=()=>({revision:'fixture',connected,apiDirect,mode:connected||apiDirect?'3p':'1p',configurationChanged,mappingUpdateRequired,backup:connected||configurationChanged||apiDirect?{state:'applied'}:null,selections:connected||configurationChanged?[choice]:[],unavailableReason:'',pids:[],automaticRestart:false,installation:{installed:true,version:'1.0'}});
 const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path.startsWith('/api/')){
   res.setHeader('content-type','application/json');
   if(path==='/api/claude-desktop'&&fail){res.statusCode=503;res.end(JSON.stringify({error:'fixture unavailable'}));return;}
   if(path==='/api/claude-desktop/restore'){connected=false;apiDirect=null;}
   if(path==='/api/a2a/claude-desktop-api'){res.end(JSON.stringify({revision:'fixture',active:apiDirect,choices:[{sourceId:'api-fixture',name:'Messages API',available:true,models:['claude-sonnet-4-6']},{sourceId:'incompatible',name:'Responses only',available:false,models:[]}]}));return;}
   if(path==='/api/a2a/claude-desktop-api/apply'){apiDirect={sourceId:'api-fixture',name:'Messages API',model:'claude-sonnet-4-6',configured:true};connected=false;}
   if(path==='/api/a2a/claude-desktop-api/restore')apiDirect=null;
   if(path==='/api/claude-desktop/connect'){mappingUpdateRequired=false;configurationChanged=false;connected=true;}
   const value=path.startsWith('/api/claude-desktop')?desktop():path==='/api/local-agent'?local:path==='/api/a2a'?{targets:[target]}:path==='/api/a2a/program-updates'?{updates:{}}:path==='/api/native-accounts/claude'?{revision:'fixture',accounts:[],pids:[],backup:null,loginState:cliSignedIn?'signed-in':'signed-out',...(cliSignedIn?{accountId:'cli-account',email:'cli@example.test'}:{})}:path.startsWith('/api/native-accounts/')||path==='/api/codex-accounts'?{revision:'fixture',accounts:[],pids:[],backup:null}:path==='/api/usage/overview'?{rows:[],combinedRows:[],allRows:[],nativeRows:[],coverage:[],scanning:false}:path==='/api/gateway-keys'?{keys:[]}:path==='/api/gateway/activity'?{recent:[]}:path==='/api/activity/traces'?{records:[]}:path==='/api/maintenance'?{status:'idle',messages:[]}:{};
   res.end(JSON.stringify(value));return;
  }
  try{const file=resolve('dist/console','.'+(path==='/'?'/index.html':path));res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)]??'application/octet-stream');res.end(await readFile(file));}catch{res.statusCode=404;res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const win=new BrowserWindow({show:false,width:1320,height:1000,webPreferences:{sandbox:true}});
 const evaluate=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(e){throw Error(`UI evaluation failed: ${code}`,{cause:e});}},pause=ms=>new Promise(r=>setTimeout(r,ms));
 const wait=async code=>{for(let n=0;n<160;n++){if(await evaluate(code))return;await pause(50);}throw Error('UI timeout: '+code);};
 const click=async text=>{await evaluate(`[...(document.querySelector("dialog[open]")??document).querySelectorAll("button")].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled).click()`);};
 const dot='document.querySelector(".tfTile .dot")';
 try{
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  await evaluate('localStorage.setItem("token-flow.claude.client","desktop")');await win.reload();
  await wait('document.querySelector(".tfPanel [aria-label=\\"启用网关模型\\"]")?.checked===true');
  assert.equal(await evaluate(`${dot}.getAttribute("aria-label")`),'使用中');
  assert.equal(await evaluate(`${dot}.classList.contains("ok")`),true);
  assert.equal(await evaluate('document.querySelector(".tfPanel").innerText.includes("旧版菜单名称可能与子代理型号冲突")'),true);
  await click('重新应用');await wait('!!document.querySelector("dialog[open]")');await click('应用');
  await wait('!document.querySelector("dialog[open]")&&!document.querySelector(".tfPanel").innerText.includes("旧版菜单名称可能与子代理型号冲突")');
  connected=false;configurationChanged=true;await win.reload();
  await wait('document.querySelector(".tfPanel")?.innerText.includes("Claude Desktop 接入配置已被修改")');
  assert.equal(await evaluate('document.querySelector(".tfPanel [aria-label=\\"启用网关模型\\"]").checked'),false);
  await click('重新应用');await click('应用');await wait('!document.querySelector("dialog[open]")&&document.querySelector(".tfPanel [aria-label=\\"启用网关模型\\"]")?.checked===true');
  await click('Claude CLI');await wait('!document.querySelector(".tfPanel[aria-label=\\"Claude Desktop\\"]")');
  assert.equal(await evaluate(`${dot}.getAttribute("aria-label")`),'未接入');
  await click('Claude Desktop');await wait('document.querySelector(".tfPanel [aria-label=\\"启用网关模型\\"]")?.checked===true');
  await click('切回官方');await click('切回官方');await wait(`${dot}.getAttribute("aria-label")==="未接入"`);
  cliSignedIn=true;await evaluate('window.dispatchEvent(new Event("tokenflow:native-login-changed"))');await pause(250);
  assert.equal(await evaluate(`${dot}.classList.contains("ok")`),false);
  await click('Claude CLI');await wait(`${dot}.getAttribute("aria-label")==="使用中"`);
  await click('Claude Desktop');await wait('!!document.querySelector(".tfPanel[aria-label=\\"Claude Desktop\\"]")');
  fail=true;await wait(`${dot}.getAttribute("aria-label")==="有问题"`);
  fail=false;connected=true;await click('重试');await wait(`${dot}.getAttribute("aria-label")==="使用中"`);
  await click('添加 API');await wait('!!document.querySelector("dialog[open] option[value=incompatible]")');
  assert.equal(await evaluate('document.querySelector("dialog[open] option[value=incompatible]").disabled'),true);
  await evaluate('const s=document.querySelector("dialog[open] select");s.value="api-fixture";s.dispatchEvent(new Event("change",{bubbles:true}))');await click('应用');
  await wait('!document.querySelector("dialog[open]")&&document.querySelector(".tfPanel").innerText.includes("Messages API")');
  assert.equal(await evaluate(`${dot}.getAttribute("aria-label")`),'使用中');
  assert.equal(await evaluate(`document.querySelector('.tfPanel [aria-label="启用网关模型"]')?.checked??false`),false);
  await mkdir('.tmp/claude-desktop-api-ui',{recursive:true});await writeFile('.tmp/claude-desktop-api-ui/direct.png',(await win.webContents.capturePage()).toPNG());
  await click('恢复原账号直连');await wait('!document.querySelector("dialog[open]")&&!document.querySelector(".tfPanel").innerText.includes("Messages API")');
  assert.equal(await evaluate(`document.querySelector('.tfPanel [aria-label="Claude Desktop 官方账号"]').innerText.includes("使用中")`),true);
  console.log('PASS: Desktop API source picker, disabled incompatible protocols, API state and official restoration.');
  console.log('PASS: legacy mapping and external drift can be reapplied; desktop dot, separate CLI state, restore, errors and retry update correctly.');
 }finally{win.destroy();server.close();server.closeAllConnections();await rm(root,{recursive:true,force:true});}
})().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
