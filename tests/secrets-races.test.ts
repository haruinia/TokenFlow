import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSecrets} from '../apps/desktop/src/secrets.js';
import {CredentialAccessStaleError} from '../packages/core/src/revision-credential-access.js';
const gate=vi.hoisted(()=>({path:'',entered:()=>{},release:Promise.resolve(),used:false}));
vi.mock('node:fs/promises',async importOriginal=>{
 const actual=await importOriginal<typeof import('node:fs/promises')>();
 return {...actual,readFile:async(...args:Parameters<typeof actual.readFile>)=>{
  const value=await actual.readFile(...args);
  if(String(args[0])===gate.path&&!gate.used){gate.used=true;gate.entered();await gate.release;}
  return value;
 }};
});
const roots:string[]=[];
afterEach(async()=>{gate.path='';for(const path of roots.splice(0))await rm(path,{recursive:true,force:true});});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};};
async function setup(){const root=await mkdtemp(join(tmpdir(),'secrets-races-'));roots.push(root);await mkdir(join(root,'secrets'));const decrypt=vi.fn((value:Buffer)=>value.toString());return {root,decrypt,secrets:createSecrets(root,{isEncryptionAvailable:()=>true,encryptString:(value:string)=>Buffer.from(value),decryptString:decrypt})};}
function hold(path:string){const entered=deferred(),release=deferred();Object.assign(gate,{path,entered:entered.resolve,release:release.promise,used:false});return {entered:entered.promise,release:release.resolve};}
it('rejects an old readFile result that arrives after set has seeded the new ciphertext',async()=>{
 const f=await setup(),file=join(f.root,'secrets','openai.bin');await writeFile(file,'fixture-old');
 const held=hold(file),old=f.secrets.get('openai'),rejected=expect(old).rejects.toBeInstanceOf(CredentialAccessStaleError);await held.entered;
 await f.secrets.set('openai','fixture-new');held.release();await rejected;
 expect(await f.secrets.get('openai')).toBe('fixture-new');expect(f.decrypt).toHaveBeenCalledTimes(1);
});
it('serializes same-name writes without serializing unrelated names or sharing temp paths',async()=>{
 const f=await setup(),file=join(f.root,'secrets','openai.bin');await writeFile(file,'fixture-old');const held=hold(file);
 const first=f.secrets.set('openai','fixture-first');await held.entered;const second=f.secrets.set('openai','fixture-second');
 await f.secrets.set('custom','fixture-independent');expect(await f.secrets.get('custom')).toBe('fixture-independent');held.release();await Promise.all([first,second]);
 expect(await f.secrets.get('openai')).toBe('fixture-second');expect(await readFile(file,'utf8')).toBe('fixture-second');expect((await readdir(join(f.root,'secrets'))).some(name=>name.endsWith('.tmp'))).toBe(false);
});
it('orders removal after a queued write and invalidates a read captured before deletion',async()=>{
 const f=await setup(),file=join(f.root,'secrets','openai.bin');await writeFile(file,'fixture-old');const held=hold(file);
 const old=f.secrets.get('openai'),rejected=expect(old).rejects.toBeInstanceOf(CredentialAccessStaleError);await held.entered;await f.secrets.remove('openai');held.release();await rejected;expect(await f.secrets.get('openai')).toBe('');
 await Promise.all([f.secrets.set('openai','fixture-new'),f.secrets.remove('openai')]);expect(await f.secrets.get('openai')).toBe('');
});
it('does not let a late obsolete source publish a failure warning over a successful replacement',async()=>{
 const f=await setup(),file=join(f.root,'secrets','openai.bin');await writeFile(file,'fixture-old');f.decrypt.mockImplementation(value=>{if(value.toString()==='fixture-old')throw Error('fixture denied');return value.toString();});
 const held=hold(file),old=f.secrets.get('openai'),rejected=expect(old).rejects.toBeInstanceOf(CredentialAccessStaleError);await held.entered;
 await f.secrets.set('openai','fixture-new');held.release();await rejected;expect(await f.secrets.get('openai')).toBe('fixture-new');expect(f.secrets.warnings()).toEqual([]);expect(f.decrypt).toHaveBeenCalledOnce();
});
