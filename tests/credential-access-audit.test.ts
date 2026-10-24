// Audit fixtures only: all OS storage/process entry points are mocked. No real
// Keychain, account directories, helper process, or network is accessed.
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createSecrets} from '../apps/desktop/src/secrets.js';
import {DesktopAccounts} from '../packages/core/src/desktop-accounts.js';
import {QoderIdeLogin} from '../packages/core/src/qoder-ide-login.js';
const keychain=vi.hoisted(()=>({denied:false,revision:'fixture-revision',value:'fixture-value',protectedReads:0}));
const exec=vi.hoisted(()=>vi.fn());
Object.defineProperty(exec,Symbol.for('nodejs.util.promisify.custom'),{value:async(_file:string,args:string[])=>{
 if(args.includes('-w')){keychain.protectedReads++;if(keychain.denied)throw Error('fixture denied');}
 return {stdout:args.includes('-w')?keychain.value:keychain.revision,stderr:''};
}});
vi.mock('node:child_process',()=>({execFile:exec,spawn:vi.fn(()=>{throw Error('Unexpected fixture process');})}));
const roots:string[]=[];
beforeEach(()=>{Object.assign(keychain,{denied:false,revision:'fixture-revision',value:'fixture-value',protectedReads:0});});
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function root(){const path=await mkdtemp(join(await realpath(tmpdir()),'credential-audit-'));roots.push(path);return path;}
async function qoder(client:'qoder'|'qoder-ide'){
 const path=join(await root(),client==='qoder'?'auth.v1.dat':'state.vscdb');
 const value=client==='qoder'?{schemaVersion:1,token:'fixture-token',refreshToken:'fixture-refresh',user:{id:'fixture-user'}}:{token:'fixture-token',refreshToken:'fixture-refresh',id:'fixture-user'};
 if(client==='qoder')await writeFile(path,JSON.stringify(value));
 else {const db=new DatabaseSync(path);try{db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY,value TEXT)');db.prepare('INSERT INTO ItemTable VALUES (?,?)').run('secret://aicoding.auth.userInfo',JSON.stringify(Buffer.from(JSON.stringify(value))));}finally{db.close();}}
 const crypto=vi.fn(async(_op:'encrypt'|'decrypt',data:string)=>Buffer.from(data,'base64').toString());
 const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({id:'fixture-user'})));
 const secrets={get:async()=>'',set:async()=>{}};
 const manager=client==='qoder'?new DesktopAccounts('qoder',secrets,async()=>[],{paths:{qoder:path},crypto,fetch:fetcher,platform:'darwin'}):new QoderIdeLogin({path,crypto,fetch:fetcher,platform:'darwin'},secrets);
 const replace=async(id:string|null)=>{
  const next=client==='qoder'?{...value,user:{id}}:{...value,id};
  if(client==='qoder'){if(id===null)await rm(path);else await writeFile(path,JSON.stringify(next));}
  else {const db=new DatabaseSync(path);try{if(id===null)db.prepare('DELETE FROM ItemTable WHERE key=?').run('secret://aicoding.auth.userInfo');else db.prepare('INSERT OR REPLACE INTO ItemTable VALUES (?,?)').run('secret://aicoding.auth.userInfo',JSON.stringify(Buffer.from(JSON.stringify(next))));}finally{db.close();}}
 };
 return {manager,crypto,path,replace};
}
it.each(['qoder','qoder-ide'] as const)('%s shares one protected read across startup identity and subsequent auto-import',async client=>{
 const f=await qoder(client);
 await Promise.all([f.manager.usageLogin(),f.manager.status()]);
 expect(f.crypto).toHaveBeenCalledTimes(1);
 await f.manager.importCredential();
 expect(f.crypto,'auto-import must reuse the same credential revision, not decrypt it again').toHaveBeenCalledTimes(1);
});
it.each(['qoder','qoder-ide'] as const)('%s does not reopen a denied revision through the auto-import consumer',async client=>{
 const f=await qoder(client);f.crypto.mockRejectedValue(Error('fixture denied'));
 await Promise.allSettled([f.manager.usageLogin(),f.manager.status()]);
 await Promise.allSettled([f.manager.importCredential(),f.manager.usageLogin()]);
 expect(f.crypto,'a denied background read must require explicit retry').toHaveBeenCalledTimes(1);
});
it.each(['qoder','qoder-ide'] as const)('%s recovers through explicit refresh and reuses that revision for import',async client=>{
 const f=await qoder(client);f.crypto.mockRejectedValueOnce(Error('fixture denied'));
 expect((await f.manager.status()).loginState).toBe('unreadable');expect((await f.manager.status()).loginState).toBe('unreadable');expect(f.crypto).toHaveBeenCalledTimes(1);
 expect((await f.manager.status(true)).loginState).toBe('signed-in');await f.manager.importCredential();expect(f.crypto).toHaveBeenCalledTimes(2);
});
it.each(['qoder','qoder-ide'] as const)('%s invalidates documents after deletion or a changed source revision',async client=>{
 const f=await qoder(client);expect((await f.manager.status()).accountId).toBe('fixture-user');
 await f.replace(null);expect((await f.manager.status()).loginState).toBe('signed-out');await f.replace('fixture-user');expect((await f.manager.status()).accountId).toBe('fixture-user');expect(f.crypto).toHaveBeenCalledTimes(2);
 await f.replace('fixture-new');expect((await f.manager.usageLogin())?.accountId).toBe('fixture-new');expect(f.crypto).toHaveBeenCalledTimes(3);
});
it.each(['qoder','qoder-ide'] as const)('%s rejects an old delayed decrypt without poisoning a newer revision',async client=>{
 const f=await qoder(client);let release!:(value:string)=>void;const pending=new Promise<string>(yes=>{release=yes;});f.crypto.mockImplementationOnce(()=>pending);
 const old=f.manager.usageLogin(),rejected=expect(old).rejects.toThrow('无法确认');await expect.poll(()=>f.crypto.mock.calls.length).toBe(1);
 const oldData=client==='qoder'?await readFile(f.path,'utf8'):JSON.stringify({id:'fixture-user',token:'fixture-token'});
 await f.replace('fixture-new');expect((await f.manager.usageLogin())?.accountId).toBe('fixture-new');release(oldData);await rejected;
 expect((await f.manager.status()).accountId).toBe('fixture-new');expect(f.crypto).toHaveBeenCalledTimes(2);
});
it('Claude denial does not trigger another protected read on each background observation',async()=>{
 const {claudeKeychain}=await import('../packages/core/src/claude-accounts.js');
 const store=claudeKeychain('/fixture-audit');keychain.denied=true;
 // service observes once before listen, once on listen, then every five seconds.
 for(let observation=0;observation<3;observation++)await Promise.allSettled([store.read(),store.read()]);
 expect(keychain.protectedReads).toBe(1);
});
it('records the existing Claude successful-read sharing and revision invalidation control',async()=>{
 const {claudeKeychain}=await import('../packages/core/src/claude-accounts.js');const store=claudeKeychain('/fixture-audit');
 await Promise.all([store.read(),store.read()]);await store.read();expect(keychain.protectedReads).toBe(1);
 keychain.revision='fixture-changed';await store.read();expect(keychain.protectedReads).toBe(2);
 keychain.value='fixture-changed-with-same-metadata';expect(await store.read({fresh:true})).toBe(keychain.value);expect(keychain.protectedReads).toBe(3);
});
it('TokenFlow does not repeatedly decrypt an unchanged denied ciphertext for background consumers',async()=>{
 const path=await root();await mkdir(join(path,'secrets'));await writeFile(join(path,'secrets','openai.bin'),'fixture-ciphertext');
 const decrypt=vi.fn(()=>{throw Error('fixture denied');});const secrets=createSecrets(path,{isEncryptionAvailable:()=>true,encryptString:Buffer.from,decryptString:decrypt},'darwin');
 await Promise.all([secrets.get('openai'),secrets.get('openai')]);await secrets.get('openai');
 expect(decrypt).toHaveBeenCalledTimes(1);
});
it('TokenFlow replacement does not decrypt a ciphertext already read successfully in this session',async()=>{
 const path=await root();await mkdir(join(path,'secrets'));await writeFile(join(path,'secrets','openai.bin'),'fixture-old');
 const decrypt=vi.fn((data:Buffer)=>data.toString());const secrets=createSecrets(path,{isEncryptionAvailable:()=>true,encryptString:(value:string)=>Buffer.from(value),decryptString:decrypt},'darwin');
 await secrets.get('openai');await secrets.set('openai','fixture-new');expect(decrypt).toHaveBeenCalledTimes(1);
});
