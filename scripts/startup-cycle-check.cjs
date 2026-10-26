// node scripts/startup-cycle-check.cjs — independent processes, synthetic encrypted accounts, no OS permissions.
const {mkdtemp,mkdir,readFile,readdir,rm}=require('node:fs/promises');
const {join,resolve}=require('node:path'),{tmpdir}=require('node:os'),{createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process'),assert=require('node:assert/strict'),esbuild=require('esbuild');
(async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'tokenflow-startup-cycle-')),root=join(temporary,'profile');await mkdir(root);
 const worker=resolve('scripts/fixtures/startup-cycle-worker.mjs'),bundle=join(temporary,'worker.mjs');
 const reexport=names=>`export {${names}} from ${JSON.stringify(worker)};`;
 const substitutes={
  electron:reexport('app,BrowserWindow,safeStorage,session,dialog,shell,nativeImage,ipcMain,clipboard,Tray,Menu'),
  'startup-window.js':reexport('createStartupWindow'),'network-proxy.js':reexport('createNetworkProxy'),
  'service.js':reexport('createDesktopService'),'file-cleanup.js':reexport('desktopCleanupFiles'),
  'qoder-crypto.js':reexport('qoderCrypto,qoderIdeCrypto,runQoderCrypto,closeQoderCrypto'),'claude-accounts.js':reexport('claudeKeychain'),
  'agent-connections.js':reexport('agentPaths'),'codex-reconciliation-monitor.js':reexport('CodexReconciliationMonitor'),
  '@cursor/sdk':`import {recordModelLookup} from ${JSON.stringify(worker)};export const Cursor={models:{list:async({apiKey})=>{recordModelLookup(apiKey);return [{id:'fixture-model',displayName:'Fixture'}];}}};`,
  'cursor-usage.js':`export class CursorUsage {async quota(){return {windows:[]};}}`,
  'cursor-conversations.js':`export async function rememberCursorGatewayConversation(){throw Error('Unexpected conversation write in startup check');}`,
 };
 try{
  await esbuild.build({entryPoints:[worker],bundle:true,platform:'node',format:'esm',banner:{js:"import {createRequire as fixtureCreateRequire} from 'node:module';const require=fixtureCreateRequire(import.meta.url);"},outfile:bundle,logLevel:'silent',plugins:[{name:'isolated-startup-platform',setup(build){
   build.onResolve({filter:/.*/},args=>{const name=args.path==='electron'||args.path==='@cursor/sdk'?args.path:args.path.split('/').at(-1);if(Object.hasOwn(substitutes,name))return {path:name,namespace:'startup-fixture'};});
   build.onLoad({filter:/.*/,namespace:'startup-fixture'},args=>({contents:substitutes[args.path],resolveDir:process.cwd()}));
  }}]});
  const files=async()=>{
   const values={};for(const name of await readdir(join(root,'secrets')).then(names=>names.sort()))values[name]=createHash('sha256').update(await readFile(join(root,'secrets',name))).digest('hex');
   values['api-sources.json']=createHash('sha256').update(await readFile(join(root,'api-sources.json'))).digest('hex');return values;
  };
  let original;const processIDs=new Set();
  for(const phase of ['allow','remembered-reset','skip','allow-again']){
   const report=join(temporary,`${phase}.json`);
   const child=spawnSync(process.execPath,[bundle],{env:{...process.env,AGENT_DATA_ROOT:root,HOME:root,TF_CYCLE_PHASE:phase,TF_CYCLE_REPORT:report},encoding:'utf8',timeout:15000});
   assert.equal(child.status,0,`${phase} process failed: ${child.stderr}`);
   const result=JSON.parse(await readFile(report,'utf8'));assert.equal(result.quit,true);assert.ok(!processIDs.has(result.pid));processIDs.add(result.pid);
   const current=await files();if(original)assert.deepEqual(current,original,'an existing encrypted credential or API source changed during '+phase);else original=current;
   console.log(`PASS ${phase}: choices=${result.confirmations}, restored accounts=${result.accounts}, API key loaded=${result.sourceHasKey}, OS-storage fixture calls=${result.storageCalls}, clean exit, all encrypted files unchanged`);
  }
 }finally{await rm(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
