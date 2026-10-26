/** Desktop's real long-lived CLI shape, isolated home and no inference or credentials. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {CodexNativeAgents} from '../packages/core/src/codex-native-agents.ts';
const official='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const root=await mkdtemp(join(tmpdir(),'tf-desktop-startup-'));
const assets=resolve('sidecars/darwin-arm64/codex-native-agents');
const bridge=process.argv.includes('--bridge')?resolve(process.argv[process.argv.indexOf('--bridge')+1]):resolve('dist/codex-provider-bridge.js');
const checks:any[]=[];
try{
 const runtime=process.argv.includes('--official')?undefined:await new CodexNativeAgents(assets,root).install(official);
 await copyFile(bridge,join(root,'bridge.mjs'));
 await writeFile(join(root,'settings.json'),JSON.stringify({binary:official,nativeAgents:runtime,gatewayWorkers:!runtime,officialModels:['gpt-6-astra'],gatewayModels:[]}));
 for(const [name,analyticsConfig,expected,transport] of [['desktop-explicit-opt-out','[analytics]\nenabled=false\n',false,[]],['desktop-default','',undefined,[]],['desktop-stdio','[analytics]\nenabled=false\n',false,['--stdio']]] as const){
  const home=join(root,name);await mkdir(home);await writeFile(join(home,'config.toml'),'cli_auth_credentials_store="file"\n'+analyticsConfig);
  const args=['-c','features.code_mode_host=true','app-server','--analytics-default-enabled',...transport];
  const proc=spawn(process.execPath,[join(root,'bridge.mjs'),...args],{cwd:home,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});
  let buf='',stderr='',seq=0;const pending=new Map<number,any>();
  proc.stderr.on('data',b=>{stderr=(stderr+String(b)).slice(-4000)});
  proc.stdout.on('data',b=>{buf+=String(b);let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);let m;try{m=JSON.parse(line)}catch{continue}const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}});
  proc.on('exit',(code,signal)=>{for(const p of pending.values())p.reject(Error(`Desktop startup exited (${code},${signal}): ${stderr}`));pending.clear()});
  const rpc=(method:string,params:any)=>new Promise<any>((res,rej)=>{const id=++seq,t=setTimeout(()=>{pending.delete(id);rej(Error('Timeout '+method+': '+stderr))},20000);pending.set(id,{resolve:(v:any)=>{clearTimeout(t);res(v)},reject:(e:any)=>{clearTimeout(t);rej(e)}});proc.stdin.write(JSON.stringify({id,method,params})+'\n')});
  try{
   await rpc('initialize',{clientInfo:{name:'codex_desktop',title:'Codex Desktop',version:'startup-regression'},capabilities:{experimentalApi:true}});proc.stdin.write('{"method":"initialized"}\n');
   const status=JSON.parse(await readFile(join(root,'status-'+proc.pid+'.json'),'utf8'));assert.equal(status.nativeAgentsRevision,runtime?.revision);assert.notEqual(status.enginePid,proc.pid);
   const read=await rpc('config/read',{includeLayers:false});assert.equal(read.config.analytics?.enabled,expected,'Analytics default must not override explicit opt-out');
   const requirements=await rpc('configRequirements/read',{});assert.ok('requirements' in requirements);
   const thread=await rpc('thread/start',{cwd:home,model:'gpt-6-astra',modelProvider:'openai',approvalPolicy:'never',sandbox:'read-only'});assert.ok(thread.thread.id);
   checks.push({name,initialized:true,explicitAnalyticsSetting:read.config.analytics?.enabled??null,requirementsRead:true,threadStarted:true});
  }finally{if(proc.exitCode===null&&proc.signalCode===null){proc.kill();await new Promise<void>(r=>proc.once('exit',()=>r()))}}
 }
 console.log(JSON.stringify({passed:true,nativeRevision:runtime?.revision,officialEngine:!runtime,checks,credentialsUsed:false,inferenceRequests:0}));
}finally{await rm(root,{recursive:true,force:true})}
