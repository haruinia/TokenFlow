// Isolated process fixture. Electron, OS storage, provider networking and the service boundary are substituted.
// The desktop entry, consent file, encrypted credential store, account loader and API source store are real.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createSecrets} from '../../apps/desktop/src/secrets.js';
import {rememberedCredentialAccess} from '../../apps/desktop/src/credential-access.js';
import {ApiSources} from '../../packages/core/src/api-sources.js';
import {CursorProvider} from '../../packages/core/src/cursor.js';

const root=process.env.AGENT_DATA_ROOT,phase=process.env.TF_CYCLE_PHASE;
assert.ok(root&&phase);
const allowed=phase!=='skip',state={storage:[],clientReads:0,modelKeys:[],confirmations:0,modes:[],menus:[],events:[],errors:[],finished:false,quit:false};
const digest=value=>createHash('sha256').update(value).digest('hex');
// A test-only AES key, not an OS keychain substitute shipped in the application.
const fixtureKey=createHash('sha256').update('tokenflow-startup-cycle-fixture-only').digest();
export const safeStorage={
 isEncryptionAvailable(){state.storage.push('available');return true;},
 encryptString(value){state.storage.push('encrypt');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',fixtureKey,iv);const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]);},
 decryptString(value){state.storage.push('decrypt');const decipher=createDecipheriv('aes-256-gcm',fixtureKey,value.subarray(0,12));decipher.setAuthTag(value.subarray(12,28));return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString();},
};
export const app=Object.assign(new EventEmitter(),{
 getPath:()=>root,setPath(){},setName(){},setAppUserModelId(){},setDesktopName(){},requestSingleInstanceLock:()=>true,whenReady:async()=>{},setAboutPanelOptions(){},
 dock:{setIcon(){},show:async()=>{}},
 quit(){let prevented=false;app.emit('before-quit',{preventDefault(){prevented=true;}});if(!prevented){app.emit('will-quit');state.events.push('quit');state.quit=true;}},
 exit(){state.quit=true;},
});
export const session={fromPartition:()=>({setProxy:async()=>{},resolveProxy:async()=>''}),defaultSession:{setProxy:async()=>{},cookies:{set:async()=>{}}}};
export const Menu={setApplicationMenu(){},buildFromTemplate(items){state.menus.push(...items.flatMap(item=>item.submenu??[item]));return {};}};
export const nativeImage={createFromPath:()=>({resize:()=>({setTemplateImage(){}})})};
export const dialog={showErrorBox(_title,message){state.errors.push(message);}};
export const ipcMain={handle(){}},clipboard={},shell={};
export class BrowserWindow extends EventEmitter{
 webContents={setWindowOpenHandler(){},on(){},session:{setPermissionRequestHandler(){}}};
 async loadURL(){state.events.push('workspace-loaded');}
 show(){state.events.push('workspace-shown');}
 focus(){}
}
export class Tray extends EventEmitter{setToolTip(){}destroy(){state.events.push('tray-closed');}}
export async function createStartupWindow(_icon,mode){state.modes.push(mode);return {
 update:async status=>{state.events.push(status);},
 confirmCredentialAccess:async()=>{state.confirmations++;assert.equal(state.storage.length,0);return allowed;},
 bounds:()=>({width:1320,height:900}),isMaximized:()=>false,close:()=>{state.finished=true;},
};}
export async function createNetworkProxy(){return {url:'http://127.0.0.1:1',installFetch(){},snapshot:()=>({}),close:async()=>{state.events.push('network-closed');}};}
export function desktopCleanupFiles(){return {};}
export function agentPaths(){return {claude:join(root,'claude/settings.json'),codex:join(root,'codex/config.toml')};}
export class CodexReconciliationMonitor{
 constructor(options){assert.equal(options.root,root);assert.equal(options.allowOfficial,allowed);}
 async start(){state.events.push('recorder-started');}
 async close(){state.events.push('recorder-stopped');}
}
export async function qoderCrypto(){state.clientReads++;return null;}
export const qoderIdeCrypto=qoderCrypto;
export async function closeQoderCrypto(){state.events.push('crypto-closed');}
export function runQoderCrypto(){throw Error('Unexpected crypto helper');}
export function claudeKeychain(){return {read:qoderCrypto,write:qoderCrypto};}
export function recordModelLookup(apiKey){state.modelKeys.push(digest(apiKey));}

let loaded;
export async function createDesktopService(options){
 const sources=await ApiSources.open(root,options.secrets,{kind:'cliproxy',baseURL:'http://127.0.0.1:8317/v1'});
 const cursor=new CursorProvider(root,options.secrets);await cursor.load();
 const entries=await sources.list(),snapshot=cursor.snapshot();
 loaded={accounts:snapshot.accounts.map(account=>({id:account.id,label:account.label})),models:snapshot.models.length,
  sourceCount:entries.length,sourceHasKey:entries[0]?.hasKey,sourceKey:digest(await sources.keyFor(entries[0].id)),
  internalKey:digest(options.localKey),exportedKey:digest(await options.secrets.get('gateway-key-fixture'))};
 // Polling and client operations after the startup decision must not bypass the same guard.
 for(let attempt=0;attempt<2;attempt++)await sources.list();
 for(const operation of [()=>options.desktopAccounts.crypto('decrypt','fixture'),()=>options.qoderIde.crypto('decrypt','fixture'),
  ...(options.claudeCredentialStore?[()=>options.claudeCredentialStore.read()]:[])]){
  if(allowed)await operation();else await assert.rejects(operation,/本次启动未允许/);
 }
 return {app:{listen:async()=> 'http://127.0.0.1:9527',close:async()=>{await cursor.close();await sources.close();state.events.push('service-closed');}},discoverLocal:async()=>{}};
}

async function run(){
globalThis.fetch=async()=>{throw new Error('External networking is forbidden in the startup cycle fixture');};
if(phase==='allow'){
 await mkdir(join(root,'secrets'),{recursive:true});const vault=createSecrets(root,safeStorage);
 await vault.set('cliproxy','fixture-internal-key');await vault.set('gateway-key-fixture','fixture-exported-key');
 await vault.set('cursor-account',JSON.stringify({version:1,accounts:[
  {email:'first@example.invalid',apiKey:'fixture-account-first',disabled:false},
  {email:'second@example.invalid',apiKey:'fixture-account-second',disabled:false},
 ]}));
 const sources=await ApiSources.open(root,vault,{kind:'cliproxy',baseURL:'http://127.0.0.1:8317/v1'});
 await sources.save({name:'Startup fixture',baseURL:'https://fixture.invalid/v1',protocol:'responses',models:['fixture-model'],apiKey:'fixture-source-key'});await sources.close();
 state.storage=[];
}
const wait=async predicate=>{for(let n=0;n<500;n++){assert.deepEqual(state.errors,[]);if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Startup cycle fixture timed out');};
const encryptedFiles=async()=>{
 const values={};for(const name of await readdir(join(root,'secrets')).then(names=>names.sort()))values[name]=digest(await readFile(join(root,'secrets',name)));
 values['api-sources.json']=digest(await readFile(join(root,'api-sources.json')));return values;
};
const original=await encryptedFiles();
await import('../../apps/desktop/src/main.js');await wait(()=>state.finished);
assert.equal(state.confirmations,phase==='remembered-reset'?0:1);
assert.deepEqual(state.modes,[phase==='remembered-reset'?'loading':'choice']);
assert.equal(loaded.sourceCount,1);assert.equal(loaded.sourceHasKey,allowed);
if(allowed){
 assert.deepEqual(loaded.accounts.map(account=>account.label).sort(),['first@example.invalid','second@example.invalid']);
 assert.equal(loaded.models,1);assert.equal(loaded.internalKey,digest('fixture-internal-key'));
 assert.equal(loaded.exportedKey,digest('fixture-exported-key'));assert.equal(loaded.sourceKey,digest('fixture-source-key'));
 assert.deepEqual(state.modelKeys.sort(),['fixture-account-first','fixture-account-second'].map(digest).sort(),'each restored account must load with its own key');
 assert.equal(await rememberedCredentialAccess(root),true);assert.ok(state.storage.includes('decrypt'));
}else{
 assert.deepEqual(loaded.accounts,[]);assert.equal(loaded.models,0);assert.equal(state.storage.length,0);assert.equal(state.clientReads,0);
 assert.notEqual(loaded.internalKey,digest('fixture-internal-key'));assert.equal(loaded.exportedKey,digest(''));assert.equal(await rememberedCredentialAccess(root),false);
}
if(phase==='remembered-reset'){
 const reset=state.menus.find(item=>item.label==='下次启动重新选择登录读取');assert.ok(reset,'reset action must be available through the real desktop menu');
 reset.click();await wait(async()=>!await rememberedCredentialAccess(root));
 assert.equal(loaded.accounts.length,2,'resetting the next launch must not unload current accounts');
}
assert.ok(state.events.includes('recorder-started'));
app.quit();await wait(()=>state.quit);assert.ok(state.events.includes('recorder-stopped'));assert.ok(state.events.indexOf('recorder-stopped')<state.events.indexOf('service-closed'));assert.ok(state.events.indexOf('service-closed')<state.events.indexOf('crypto-closed'));assert.ok(state.events.indexOf('crypto-closed')<state.events.indexOf('network-closed'));assert.ok(state.events.indexOf('network-closed')<state.events.indexOf('quit'));
assert.deepEqual(await encryptedFiles(),original,'startup/reset/shutdown must preserve every encrypted file');
await writeFile(process.env.TF_CYCLE_REPORT,JSON.stringify({phase,pid:process.pid,confirmations:state.confirmations,accounts:loaded.accounts.length,sourceHasKey:loaded.sourceHasKey,storageCalls:state.storage.length,quit:state.quit}));
}
void run().catch(error=>{console.error(error);process.exitCode=1;});
