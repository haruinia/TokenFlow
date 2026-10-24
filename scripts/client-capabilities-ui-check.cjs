/** Built-renderer checks only. A temporary Electron profile and fixture HTTP
 * endpoints keep real accounts, client config, installers and providers isolated. */
const {app,BrowserWindow}=require('electron');
const {createServer}=require('node:http');
const {readFile,writeFile,mkdir,mkdtemp,rm}=require('node:fs/promises');
const {join,resolve,extname}=require('node:path');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
async function main(){
 app.on('window-all-closed',()=>{});const root=await mkdtemp(join(tmpdir(),'tokenflow-client-capabilities-'));app.setPath('userData',root);await app.whenReady();app.dock?.hide();
 const sourceId='a'.repeat(24),choice={sourceId,model:'codex/fixture-model'},posts=[],installations=[],imports=[];
 const record=id=>({id:'11111111-1111-4111-8111-111111111111',target:id,...choice,selections:[choice],state:'applied',...(id==='codex'?{codexCoexist:true,officialModelSlugs:['gpt-fixture']}:{} )});
 const targets=['codex','claude'].map(id=>({id,name:id==='codex'?'Codex':'Claude Code',installation:{installed:id==='codex',configurationSupported:true,channel:id==='codex'?'npm':'missing',automatic:true,version:id==='codex'?'0.163.0':undefined,download:'https://fixture.invalid'},restartSupported:id==='codex',exists:true,revision:'1'.repeat(64),pids:[],configurationState:id==='codex'?'configured':'unmanaged',backups:[],connection:id==='codex'?record(id):null}));
 const sources=[{id:'b'.repeat(24),name:'Existing fixture API',baseURL:'https://fixture.invalid/v1',protocol:'responses',models:['fixture-model'],enabled:true,hasKey:true,checks:{}}];
 const local=()=>({state:'running',loginState:'idle',port:8317,logs:[],accounts:[{id:sourceId,label:'fixture@example.test',provider:'codex',status:'active',models:[choice.model]}],models:[{id:choice.model,provider:'codex'}],apiSources:sources,quotas:{},quotaBusy:false,providers:[{id:'codex',label:'Codex'}]});
 const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path.startsWith('/api/')){
   res.setHeader('content-type','application/json');
   if(req.method==='POST'){
    let raw='';for await(const chunk of req)raw+=chunk;const input=raw?JSON.parse(raw):{};
    if(path==='/api/a2a/connect'){posts.push(input);await new Promise(r=>setTimeout(r,900));const target=targets.find(t=>t.id===input.target);target.connection=record(input.target);target.configurationState='configured';res.end(JSON.stringify(target.connection));return;}
    if(path==='/api/a2a/program'){installations.push(input);await new Promise(r=>setTimeout(r,400));res.statusCode=409;res.end(JSON.stringify({error:'fixture npm update blocked'}));return;}
    if(path==='/api/sources/import/preview'){imports.push(input);res.end(JSON.stringify({token:'c'.repeat(48),rows:[{id:'0',name:'Claude fixture',app:'claude',baseURL:'https://claude.fixture.invalid/v1',protocol:'messages',models:['fixture-a'],status:'ready'},{id:'1',name:'Codex fixture',app:'codex',baseURL:'https://codex.fixture.invalid/v1',protocol:'responses',models:['fixture-b'],status:'ready'},{id:'2',name:'Official account fixture',app:'codex',models:[],status:'unsupported',reason:'此条目使用官方登录或托管认证，请在账号授权中添加。'}]}));return;}
    if(path==='/api/sources/import/apply'){imports.push(input);res.end(JSON.stringify({imported:input.ids.length,skipped:0}));return;}
   }
   const value=path==='/api/local-agent'?local():path==='/api/a2a'?{targets}:path==='/api/a2a/codex-coexist'?{available:true,enabled:!!targets[0].connection?.codexCoexist}:path==='/api/a2a/program-updates'?{updates:{codex:{status:'available',currentVersion:'0.163.0',latestVersion:'0.164.0'}}}:path==='/api/codex-accounts'?{revision:'fixture',loginState:'signed-in',accountId:'fixture-account',email:'fixture@example.test',pids:[],backup:null,gatewayConnected:!!targets[0].connection,codexCoexist:!!targets[0].connection?.codexCoexist,accounts:[{id:sourceId,accountId:'fixture-account',email:'fixture@example.test',switchable:true,reason:''}]}:path.startsWith('/api/native-accounts/')?{revision:'fixture',accounts:[],pids:[],backup:null,loginState:'signed-out',gatewayConnected:false}:path==='/api/claude-desktop'?{revision:'fixture',connected:false,mode:'1p',selections:[],pids:[],backup:null,installation:{installed:true,version:'fixture'}}:path==='/api/usage/overview'?{rows:[],nativeRows:[],combinedRows:[],allRows:[],coverage:[],scanning:false}:path==='/api/activity/traces'?{records:[]}:path==='/api/gateway/activity'?{recent:[]}:path==='/api/gateway-keys'?{keys:[]}:path==='/api/sources'?{sources}:path==='/api/maintenance'?{status:'idle',messages:[]}:path==='/api/a2a/codex-migration'?{phase:'idle'}:{};
   res.end(JSON.stringify(value));return;
  }
  try{const file=resolve('dist/console','.'+(path==='/'?'/index.html':path));res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[extname(file)]??'application/octet-stream');res.end(await readFile(file));}catch{res.statusCode=404;res.end();}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const win=new BrowserWindow({show:false,width:1320,height:920,webPreferences:{sandbox:true,backgroundThrottling:false}}),directory=resolve('release/client-capabilities-ui');await mkdir(directory,{recursive:true});
 const evaluate=code=>win.webContents.executeJavaScript(code),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const wait=async code=>{for(let i=0;i<150;i++){if(await evaluate(code))return;await pause(60);}throw Error('UI timeout: '+code);};
 const click=async(label,scope='document')=>{const result=await evaluate(`(()=>{const button=[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled);if(!button)return false;button.click();return true})()`);assert.equal(result,true,'button available: '+label);await pause(90);};
 const screenshot=async name=>{await pause(180);await writeFile(join(directory,name),(await win.webContents.capturePage()).toPNG());};
 const dialog='document.querySelector("dialog[open]")';
 try{
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);await wait('!!document.querySelector(".tfGatewaySection")');
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".tfNavGroup")].map(e=>e.textContent)'),['使用','供应商']);
  await wait('!!document.querySelector(".tfOfficialAccounts .tfLoginRadio.on")');assert.equal(await evaluate('document.querySelector(".tfOfficialAccounts .tfUsing").textContent'),'已登录');
  assert.equal(await evaluate('[...document.querySelectorAll("label")].find(e=>e.textContent.includes("同时保留官方模型"))?.querySelector("input")?.checked'),true);
  await screenshot('01-navigation-codex-coexist.png');
  await evaluate('document.querySelector(".tfAgentUpdate").click()');await wait('!!document.querySelector("dialog[open]")');assert.match(await evaluate(`${dialog}.innerText`),/更新 Codex.*npm/s);assert.equal(installations.length,0);
  await click('更新到最新版本',dialog);await wait('!!document.querySelector(".tfProgramDialog .tfError")');assert.equal(installations.length,1);assert.equal(await evaluate('document.querySelectorAll(".tfToast.error").length'),0);await screenshot('02-npm-update-error.png');await click('稍后再说',dialog);
  await evaluate(`localStorage.setItem('token-flow.agent.models.claude',${JSON.stringify(JSON.stringify([choice]))});localStorage.setItem('token-flow.agent.models.pending.claude','true');document.querySelectorAll('.tfTile')[1].click()`);await wait('document.querySelector(".tfAgentTitle h2")?.textContent==="Claude Code"');
  assert.equal(await evaluate('document.querySelectorAll("dialog[open]").length'),0,'missing Claude CLI must not force installation');assert.match(await evaluate('document.querySelector(".tfPanel").innerText'),/独立 Claude CLI/);
  assert.equal(await evaluate('[...document.querySelectorAll("button")].some(e=>e.textContent.trim()==="Claude Desktop")'),true);
  await evaluate('document.querySelector(".tfGatewaySection input[role=switch]").click()');await wait('!!document.querySelector(".tfModelApplyDialog[open]")');for(let n=0;n<40&&!posts.length;n++)await pause(25);assert.equal(posts.length,1);assert.equal(posts[0].target,'claude');assert.equal(installations.length,1);
  assert.equal(await evaluate('document.querySelectorAll(".tfThinkingFeedback:popover-open").length'),1,'application uses one shared Thinking layer');const applicationBounds=await evaluate('(()=>{const r=document.querySelector(".tfModelApplyDialog[open]").getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()');
  await screenshot('03-claude-apply-progress.png');await wait('document.querySelector(".tfModelApplyDialog[open]")?.innerText.includes("模型已应用")');assert.deepEqual(await evaluate('(()=>{const r=document.querySelector(".tfModelApplyDialog[open]").getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()'),applicationBounds,'application result keeps dialog position and dimensions');await screenshot('04-claude-applied.png');await click('关闭',dialog);
  await click('API 接口');await wait('!!document.querySelector(".tfApiSourceCard")');await click('导入');await click('读取本机 CC Switch',dialog);await wait('document.querySelectorAll("dialog[open] input[type=checkbox]").length===3');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("dialog[open] input[type=checkbox]")].map(e=>[e.checked,e.disabled])'),[[true,false],[true,false],[false,true]]);
  await evaluate('document.querySelectorAll("dialog[open] input[type=checkbox]")[0].click()');assert.match(await evaluate(`${dialog}.innerText`),/导入所选（1）/);assert.equal(imports.length,1);await screenshot('05-supplier-import-preview.png');
  const visuals=await evaluate(`(()=>{const form=${dialog}.querySelector('.tfGroup, .tfForm');return form?{background:getComputedStyle(form).backgroundColor,border:getComputedStyle(form).borderWidth}:null})()`);
  assert.equal(visuals.border,'0px','supplier preview reuses a layout without an added border');assert.equal(visuals.background,'rgba(0, 0, 0, 0)','supplier preview has no added background block');
  await click('导入所选（1）',dialog);await wait('!document.querySelector("dialog[open]")');assert.deepEqual(imports[1].ids,['1']);
  targets[0].connection=null;targets[0].configurationState='unmanaged';await evaluate(`localStorage.setItem('token-flow.usage.tab','codex');localStorage.setItem('token-flow.agent.models.codex',${JSON.stringify(JSON.stringify([choice]))});localStorage.setItem('token-flow.agent.models.pending.codex','true');localStorage.setItem('token-flow.appearance','light');`);await win.loadURL(win.webContents.getURL());await click('本地 Agent');await wait('!!document.querySelector(".tfGatewaySection")');await wait('[...document.querySelectorAll("label")].find(e=>e.textContent.includes("同时保留官方模型"))?.querySelector("input")?.checked===true');
  await screenshot('06-new-codex-default-coexist-light.png');
  win.setSize(760,680);await click('API 接口');await click('导入');await click('读取本机 CC Switch',dialog);await wait('document.querySelectorAll("dialog[open] input[type=checkbox]").length===3');const small=await evaluate(`(()=>{const r=${dialog}.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}})()`);assert.ok(small.x>=0&&small.y>=0&&small.right<=small.width&&small.bottom<=small.height,'small viewport keeps import dialog visible');await screenshot('07-supplier-preview-small-light.png');
  console.log(JSON.stringify({passed:['navigation order and supplier title','Codex coexist checkbox and logged-in identity','npm update stays in FlowDialog on failure','Claude shared configuration applies without standalone CLI and retains Desktop switch','supplier preview selection and disabled unsupported row','new Codex connection defaults coexist when available'],screenshots:directory,importPreviewVisuals:visuals,posts:posts.map(({target,codexCoexist})=>({target,codexCoexist})),programActions:installations},null,2));
 }finally{win.destroy();server.close();server.closeAllConnections();await rm(root,{recursive:true,force:true});}
}
main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
