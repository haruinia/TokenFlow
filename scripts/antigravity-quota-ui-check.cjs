// Run after npm run build. Isolated fixtures; no real account mutation or provider request.
const {app,BrowserWindow}=require('electron');
const {createServer}=require('node:http');
const {readFile,mkdtemp,rm,mkdir,writeFile}=require('node:fs/promises');
const {join,resolve,extname}=require('node:path');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
(async()=>{
 const root=await mkdtemp(join(tmpdir(),'tokenflow-quota-ui-'));app.setPath('userData',root);app.on('window-all-closed',()=>{});await app.whenReady();app.dock?.hide();
 let mutations=0;
 const account={id:'fixture-account',provider:'antigravity',label:'quota-fixture@example.test',status:'active',disabled:false,unavailable:false,models:['gemini-fixture','claude-fixture']};
 const quotaWindow=(id,label,usedPercent)=>({id,label,usedPercent,resetsAt:new Date(Date.now()+7200000).toISOString()});
 const windows=[quotaWindow('3p-weekly','Claude and GPT models · Weekly Limit Remaining',58),quotaWindow('3p-5h','Claude and GPT models · Five Hour Limit Remaining',1),...Array.from({length:12},(_,i)=>quotaWindow(`model:gemini-${i}`,`Gemini ${i} · 模型额度`,0)),quotaWindow('model:claude-fixture','Claude · 模型额度',58),quotaWindow('model:tab_fixture','Tab · 模型额度',0)];
 const local={state:'running',loginState:'idle',port:8317,logs:[],accounts:[account],models:account.models.map(id=>({id,provider:'antigravity'})),quotas:{[account.id]:{accountId:account.id,provider:'antigravity',status:'ok',observedAt:new Date().toISOString(),windows}},quotaBusy:false,providers:[{id:'antigravity',label:'Antigravity',flow:'callback',hint:'fixture'}]};
 const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path.startsWith('/api/')){
   res.setHeader('content-type','application/json');if(req.method==='POST')mutations++;
   const value=path==='/api/local-agent'?local:path==='/api/a2a'?{targets:[]}:path==='/api/maintenance'?{status:'idle',messages:[]}:path==='/api/codex-accounts'||path.startsWith('/api/native-accounts/')?{revision:'fixture',accounts:[],pids:[],backup:null,gatewayConnected:false}:path==='/api/gateway-keys'?{keys:[]}:path==='/api/gateway/activity'?{recent:[]}:path==='/api/usage/overview'?{rows:[],nativeRows:[],combinedRows:[],allRows:[],coverage:[],scanning:false}:{};
   res.end(JSON.stringify(value));return;
  }
  try{const file=resolve('dist/console','.'+(path==='/'?'/index.html':path));res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)]??'application/octet-stream');res.end(await readFile(file));}catch{res.statusCode=404;res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const win=new BrowserWindow({show:false,width:1320,height:1000,webPreferences:{sandbox:true}});
 const evaluate=code=>win.webContents.executeJavaScript(code),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const wait=async code=>{for(let n=0;n<150;n++){if(await evaluate(code))return;await pause(40);}throw Error('Quota UI timeout: '+code);};
 try{
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  await wait("!![...document.querySelectorAll('button')].find(b=>b.textContent==='账号授权')");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='账号授权').click()");
  await wait('!!document.getElementById("provider-tab-antigravity")');await evaluate('document.getElementById("provider-tab-antigravity").click()');
  await wait('!!document.querySelector(".tfQuotaModelDetails")');
  assert.equal(await evaluate('document.querySelectorAll(".quota > .quotaWindow").length'),3);
  assert.equal(await evaluate('document.querySelector(".tfQuotaModelDetails").open'),false);
  assert.equal(await evaluate('document.querySelectorAll(".tfQuotaModelRows .quotaWindow").length'),14);
  const overview=await evaluate('[...document.querySelectorAll(".quota > .quotaWindow")].map(e=>e.innerText).join(" / ")');
  assert.match(overview,/已用 58% · 剩余 42%/);assert.match(overview,/已用 1% · 剩余 99%/);assert.match(overview,/Gemini/);assert.match(overview,/剩余 100%/);
  const save=async name=>{if(process.env.TOKENFLOW_UI_ARTIFACTS){await mkdir(process.env.TOKENFLOW_UI_ARTIFACTS,{recursive:true});await writeFile(join(process.env.TOKENFLOW_UI_ARTIFACTS,name),(await win.webContents.capturePage()).toPNG());}};
  await save('quota-overview.png');
  await evaluate('document.querySelector(".tfQuotaModelDetails summary").click()');
  assert.equal(await evaluate('document.querySelector(".tfQuotaModelDetails").open'),true);
  assert.match(await evaluate('document.querySelector(".tfQuotaModelDetails").innerText'),/模型可能共享额度，不能累加/);
  for(const [width,height] of [[1320,1000],[620,860]]){
   win.setSize(width,height);await pause(150);await evaluate('document.querySelector(".tfQuotaModelDetails").scrollIntoView({block:"start"})');
   assert.ok(await evaluate('document.querySelector(".tfQuotaModelDetails").scrollWidth<=document.querySelector(".tfQuotaSide").clientWidth'),'model details fit quota column');await save(`quota-details-${width}.png`);
  }
  assert.equal(mutations,0);
  console.log('PASS: three overview rows, original percentages unchanged, all 14 model details collapsed by default and expandable, narrow layout fits, no account mutation.');
 }finally{win.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
 app.exit(0);
})().catch(error=>{console.error(error);app.exit(1);});
