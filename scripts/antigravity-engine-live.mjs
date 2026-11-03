// Opt-in verification of the built sidecar. Saved credentials are read-only;
// only access tokens are copied into a disposable profile (never refresh tokens).
import {readFile,readdir,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {traeAcceptanceConfigPath as installedConfigPath} from './trae-acceptance-config.mjs';

if(!process.argv.includes('--live'))throw Error('Pass --live to query saved Antigravity accounts; add --inference for a small smoke request.');
const cfgPath=installedConfigPath(),config=YAML.parse(await readFile(cfgPath,'utf8'));
const source=config['auth-dir']||join(dirname(cfgPath),'auth');
const root=await mkdtemp(join(tmpdir(),'tokenflow-antigravity-engine-'));
const managementKey=randomBytes(24).toString('hex'),localKey=randomBytes(24).toString('hex');
let child,childExit,report={accounts:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 await mkdir(join(root,'auth'),{mode:0o700});
 const names=[];
 for(const file of await readdir(source)){
  if(!file.endsWith('.json'))continue;
  let a;try{a=JSON.parse(await readFile(join(source,file),'utf8'));}catch{continue;}
  if(a.type!=='antigravity'||a.disabled||!a.access_token)continue;
  const name=`account-${names.length+1}.json`;names.push(name);
  const keys=['type','access_token','project_id','expired','expires_in','timestamp','proxy_url','base_url','user_agent'];
  await writeFile(join(root,'auth',name),JSON.stringify(Object.fromEntries(keys.filter(k=>a[k]!==undefined).map(k=>[k,a[k]]))),{mode:0o600});
 }
 assert.ok(names.length,'No enabled Antigravity credentials');
 const allocator=createServer();await new Promise(r=>allocator.listen(0,'127.0.0.1',r));const port=allocator.address().port;await new Promise(r=>allocator.close(r));
 const cfg={host:'127.0.0.1',port,'auth-dir':join(root,'auth'),'api-keys':[localKey],'proxy-url':config['proxy-url']??'','remote-management':{'allow-remote':false,'secret-key':managementKey,'disable-control-panel':true,'disable-auto-update-panel':true},'request-log':false,'logging-to-file':false,'request-retry':0};
 await writeFile(join(root,'config.yaml'),YAML.stringify(cfg),{mode:0o600});
 const binary=process.env.TOKEN_FLOW_ANTIGRAVITY_BINARY||resolve(`sidecars/${process.platform}-${process.arch}/${process.platform==='win32'?'cliproxyapi.exe':'cliproxyapi'}`);
 child=spawn(binary,['-config',join(root,'config.yaml')],{cwd:root,stdio:['ignore','pipe','pipe']});
 // Logs may contain vendor details. Retain only the version updater's numeric
 // result; never print raw subprocess output or credential/error response bodies.
 const versionLog=b=>{const m=String(b).match(/fetched latest antigravity version[^\n]*version[=:]["']?([\d.]+)/);if(m)report.onlineVersion=m[1];};
 child.stdout.on('data',versionLog);child.stderr.on('data',()=>{});
 childExit=new Promise(resolve=>{child.on('exit',(code,signal)=>resolve({code,signal}));child.on('error',()=>resolve({error:'start_failed'}));});
 const address=`http://127.0.0.1:${port}`;
 let ready=false;
 for(let n=0;n<150;n++){
  try{const r=await fetch(address+'/v0/management/auth-files',{headers:{Authorization:'Bearer '+managementKey},signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break;}}catch{}
  if(child.exitCode!==null)break;
  await sleep(200);
 }
 assert.ok(ready,'Isolated sidecar did not become ready');
 for(const name of names){
  let result,http;
  for(let attempt=0;attempt<3;attempt++){
   const r=await fetch(address+'/v0/management/auth-files/models?name='+encodeURIComponent(name)+'&refresh=true',{headers:{Authorization:'Bearer '+managementKey},signal:AbortSignal.timeout(15000)});
   http=r.status;result=await r.json();if(result.catalog?.status==='live')break;
  }
  const ids=(result.models??[]).map(m=>m.id).sort();
  const row={account:report.accounts.length+1,http,catalog:result.catalog?.status,verifiedAt:result.catalog?.verifiedAt,models:ids};report.accounts.push(row);console.log(JSON.stringify(row));
  assert.equal(http,200);assert.equal(result.catalog?.status,'live');assert.ok(ids.length);
  assert.ok(ids.every(id=>!id.endsWith('-disabled')&&!id.endsWith('-tiered')),'Non-callable model was published');
 }
 const r=await fetch(address+'/v1/models',{headers:{Authorization:'Bearer '+localKey}});const data=await r.json();
 const registered=new Set(data.data?.map(m=>m.id));
 for(const a of report.accounts)for(const id of a.models)assert.ok(registered.has(id),'Account model missing from inference registry');
 report.registryMatches=true;
 if(process.argv.includes('--inference')){
  const model=report.accounts.flatMap(a=>a.models).find(id=>id==='gemini-3.8-flash-low');assert.ok(model,'Expected small smoke-test model absent');
  const r=await fetch(address+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+localKey,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'Reply with exactly OK.'}],max_tokens:128}),signal:AbortSignal.timeout(60000)});
  const d=await r.json();report.inference={model,http:r.status,hasText:!!d.choices?.[0]?.message?.content,finishReason:d.choices?.[0]?.finish_reason};console.log(JSON.stringify(report.inference));
  assert.equal(r.status,200);assert.ok(report.inference.hasText);
 }
 report.passed=true;
}finally{
 if(child){child.kill('SIGTERM');await Promise.race([childExit,sleep(3000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await childExit;}}
 await rm(root,{recursive:true,force:true});
 const out=process.env.TOKEN_FLOW_ANTIGRAVITY_REPORT;
 if(out)await writeFile(out,JSON.stringify(report,null,2)+'\n',{mode:0o600});
}
