// Run with Electron after building: electron scripts/check-quota-panel.cjs
// Synthetic quota HTTP responses only. No production service or credentials.
const {app,BrowserWindow,Tray,nativeImage,ipcMain}=require('electron');
const {createServer}=require('node:http');
const {readFile,mkdir,writeFile,mkdtemp,rm}=require('node:fs/promises');
const {join,resolve,extname}=require('node:path');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
const root=resolve(__dirname,'..'),out=join(root,'.tmp/quota-panel-check');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let server,tray,panel,profile;
app.on('window-all-closed',()=>{});
async function run(){
 profile=await mkdtemp(join(tmpdir(),'tokenflow-quota-panel-ui-'));app.setPath('userData',profile);
 await app.whenReady();await mkdir(out,{recursive:true});
 const {build}=require('esbuild');
 await build({entryPoints:[join(root,'apps/desktop/src/quota-panel.ts')],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:join(out,'panel.cjs')});
 const {createQuotaPanel}=require(join(out,'panel.cjs'));
 const now=new Date().toISOString(),reset=new Date(Date.now()+7200000).toISOString();
 const accounts=[['personal','codex','Personal · demo@example.test'],['work','claude','Work · demo@example.test'],['anti','antigravity','Google · demo@example.test'],['unknown','qoder','一个很长的账号名称，用来核对额度面板是否正确截断而不会溢出']].map(([id,provider,label])=>({id,provider,label,disabled:false}));
 const quota=(accountId,provider,windows)=>({accountId,provider,observedAt:now,status:'ok',plan:'Pro',windows:windows.map(([label,usedPercent],i)=>({id:String(i),label,usedPercent,resetsAt:reset}))});
 const snapshot={loading:false,refreshing:false,accounts,providers:[{id:'codex',label:'Codex'},{id:'claude',label:'Claude'},{id:'antigravity',label:'Antigravity'},{id:'qoder',label:'Qoder'}],quotas:{personal:quota('personal','codex',[['Codex · 5 小时',12],['Codex · 7 天',55]]),work:quota('work','claude',[['5 小时',92],['每周',100]]),anti:quota('anti','antigravity',[['Claude and GPT models · Weekly Limit Remaining',58],['Claude and GPT models · Five Hour Limit Remaining',1],['Gemini Models · Weekly Limit Remaining',3],['Gemini Models · Five Hour Limit Remaining',6]]),unknown:quota('unknown','qoder',[['高级模型',null]])}};
 let mode='ready',reads=0,writes=0,opened;
 server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  if(path.startsWith('/api/')){
   res.setHeader('Content-Type','application/json');
   if(req.method==='POST'){writes++;await delay(100);snapshot.quotas.personal.windows[0].usedPercent=20;}
   else reads++;
   if(mode==='error'){res.statusCode=503;res.end(JSON.stringify({error:'fixture failure'}));return;}
   res.end(JSON.stringify(mode==='empty'?{...snapshot,accounts:[],quotas:{}}:snapshot));return;
  }
  try{const file=join(root,'dist/console',path==='/'?'index.html':path);const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};res.setHeader('Content-Type',types[extname(file)]||'application/octet-stream');res.end(await readFile(file));}catch{res.statusCode=404;res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const address=`http://127.0.0.1:${server.address().port}`;
 tray=new Tray(nativeImage.createFromPath(join(root,'dist/console/tray-icon.png')).resize({width:18,height:18}));
 tray.setToolTip('TokenFlow 额度面板 · 隔离验收');
 panel=createQuotaPanel({address,preload:join(root,'dist/preload.cjs'),icon:join(root,'dist/console/app-icon.png'),tray});
 ipcMain.handle('quota:hide',()=>panel.hide());
 ipcMain.handle('workspace:open',(_event,view)=>{opened=view;panel.hide();});
 await panel.toggle();let win=panel.window();
 const js=source=>win.webContents.executeJavaScript(source);
 async function until(source){for(let i=0;i<100;i++){if(await js(source))return;await delay(50);}throw Error(`UI wait failed: ${source}`);}
 await until('document.querySelectorAll(".tfQuotaPopoverAccount").length===4');
 await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await delay(150);
 assert.equal(writes,0);assert.ok(win.isVisible());assert.equal(BrowserWindow.getAllWindows().length,1);
 const errors=[];win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
 assert.equal(await js('document.documentElement.scrollWidth > innerWidth'),false);
 await writeFile(join(out,'dark.png'),(await win.webContents.capturePage()).toPNG());
 await js('document.documentElement.dataset.theme="light"');await delay(100);
 await writeFile(join(out,'light.png'),(await win.webContents.capturePage()).toPNG());
 await js('document.querySelector("button[aria-label=刷新额度]").click()');
 await until('document.body.textContent.includes("80%")');assert.equal(writes,1);
 await panel.toggle();assert.equal(win.isVisible(),false);
 await delay(200);await panel.toggle();assert.equal(panel.window(),win);assert.equal(win.isVisible(),true);
 const outside=new BrowserWindow({width:240,height:120,show:true});await outside.loadURL('data:text/html,<title>Outside panel fixture</title>');outside.focus();
 for(let i=0;i<20&&win.isVisible();i++)await delay(50);assert.equal(win.isVisible(),false,'outside focus dismisses the panel');outside.destroy();
 await delay(200);await panel.toggle();
 await js('document.querySelector(".tfQuotaPopoverBody").scrollTop=10000');await delay(100);
 await writeFile(join(out,'details.png'),(await win.webContents.capturePage()).toPNG());
 await js('document.querySelector("footer .textButton").click()');await delay(100);
 assert.equal(opened,'accounts');assert.equal(win.isVisible(),false);
 const hiddenReads=reads;await delay(16000);assert.equal(reads,hiddenReads,'hidden panel must not poll');
 await delay(200);await panel.toggle();mode='empty';await win.webContents.reload();await until('document.body.textContent.includes("添加账号，随时查看额度")');
 await writeFile(join(out,'empty.png'),(await win.webContents.capturePage()).toPNG());
 mode='error';await win.webContents.reload();await until('document.body.textContent.includes("暂时无法读取额度")');
 assert.equal(await js('!!document.querySelector(".tfLoadingSkeleton")'),false);
 await writeFile(join(out,'error.png'),(await win.webContents.capturePage()).toPNG());
 await js('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))');await delay(100);assert.equal(win.isVisible(),false);
 assert.deepEqual(errors,[]);
 const result={passed:true,readOnlyOnOpen:true,explicitRefresh:true,reusesWindow:true,blurDismiss:true,hiddenPollingStopped:true,manageAccounts:true,escapeDismiss:true,zeroUnknownAndLongLabels:true,consoleErrors:errors};
 await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
async function cleanup(){panel?.destroy();tray?.destroy();server?.close();if(profile)await rm(profile,{recursive:true,force:true});}
run().then(async()=>{await cleanup();app.exit(0);}).catch(async error=>{console.error(error);await cleanup();app.exit(1);});
