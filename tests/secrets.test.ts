import { it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSecrets } from '../apps/desktop/src/secrets.js';
import { CredentialHistory } from '../packages/core/src/credential-history.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function setup(){const root=await mkdtemp(join(tmpdir(),'secrets-test-'));roots.push(root);await mkdir(join(root,'secrets'));return root;}
const storage={isEncryptionAvailable:()=>true,encryptString:(v:string)=>Buffer.from(`encrypted:${v}`),decryptString:(b:Buffer)=>{if(!b.toString().startsWith('encrypted:'))throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');return b.toString().slice(10);}};
it('persists and forgets authorization history through the desktop encrypted store',async()=>{
 const root=await setup(),secrets=createSecrets(root,storage),history=new CredentialHistory(root,secrets);
 const grant={email:'fixture@example.invalid',access_token:'fixture-private-token'};
 await history.remember('qoder',[grant]);
 const files=await readdir(join(root,'secrets'));
 const grantFile=files.find(name=>/^grant-[a-f0-9]{64}\.bin$/.test(name))!;
 expect(grantFile).toBeTruthy();expect(files.some(name=>/^auth-history-index-qoder-[a-f0-9]{64}\.bin$/.test(name))).toBe(true);
 expect(JSON.parse(await secrets.get(grantFile.slice(0,-4))).credential).toEqual(grant);
 await history.forget('qoder',[grant]);expect(await secrets.get(grantFile.slice(0,-4))).toBe('');
 for(const name of ['grant-../outside',`auth-history-index-../qoder-${'a'.repeat(64)}`])await expect(secrets.get(name)).rejects.toThrow('密钥存储名称无效');
});
it('preserves unreadable ciphertext and replaces it only after backing it up',async()=>{
 const root=await setup();const file=join(root,'secrets','cliproxy.bin');await writeFile(file,'corrupt');
 const secrets=createSecrets(root,storage);expect(await secrets.get('cliproxy')).toBe('');expect(await readFile(file,'utf8')).toBe('corrupt');
 expect(secrets.warnings().join()).toContain('无法解密');await secrets.set('cliproxy','replacement');
 expect(await secrets.get('cliproxy')).toBe('replacement');
 const backup=(await readdir(join(root,'secrets'))).find(name=>name.startsWith('cliproxy.bin.unreadable-'))!;
 expect(await readFile(join(root,'secrets',backup),'utf8')).toBe('corrupt');
 expect(secrets.warnings().join()).not.toContain('replacement');
});
it('does not overwrite locked-store credentials and lets reads recover once unlocked',async()=>{
 const root=await setup();let available=false;
 await writeFile(join(root,'secrets','custom.bin'),'encrypted:original');
 const secrets=createSecrets(root,{...storage,isEncryptionAvailable:()=>available});
 expect(await secrets.get('custom')).toBe('');await expect(secrets.set('custom','new')).rejects.toThrow('不可用');
 expect(await readFile(join(root,'secrets','custom.bin'),'utf8')).toBe('encrypted:original');
 available=true;expect(await secrets.get('custom')).toBe('original');
});
it.each(['darwin','win32','linux'] as const)('skips all OS storage calls and preserves encrypted files on %s',async platform=>{
 const root=await setup(),file=join(root,'secrets','cliproxy.bin');await writeFile(file,'encrypted:original');
 const blocked={isEncryptionAvailable:vi.fn(()=>true),encryptString:vi.fn(storage.encryptString),decryptString:vi.fn(storage.decryptString),getSelectedStorageBackend:vi.fn(()=> 'gnome_libsecret')};
 const secrets=createSecrets(root,blocked,platform,false);
 expect(secrets.canEncrypt()).toBe(false);
 for(let attempt=0;attempt<3;attempt++)expect(await secrets.get('cliproxy')).toBe('');
 await expect(secrets.set('cliproxy','replacement')).rejects.toThrow('本次启动已跳过');
 expect(await readFile(file,'utf8')).toBe('encrypted:original');
 expect(await readdir(join(root,'secrets'))).toEqual(['cliproxy.bin']);
 for(const operation of Object.values(blocked))expect(operation).not.toHaveBeenCalled();
 // The decision is session-scoped; allowing access on the next launch reuses the same original ciphertext.
 expect(await createSecrets(root,storage,platform).get('cliproxy')).toBe('original');
});
it('backs up undecryptable API keys before explicit replacement and retains ciphertext if encryption fails',async()=>{
 const root=await setup();const file=join(root,'secrets','openai.bin');await writeFile(file,'broken');
 const failed=createSecrets(root,{...storage,encryptString:()=>{throw new Error('keychain locked');}});
 await expect(failed.set('openai','new')).rejects.toThrow('locked');expect(await readFile(file,'utf8')).toBe('broken');
 const secrets=createSecrets(root,storage);await secrets.set('openai','new');expect(await secrets.get('openai')).toBe('new');
 expect((await readdir(join(root,'secrets'))).some(name=>name.startsWith('openai.bin.unreadable-'))).toBe(true);
 expect(await secrets.get('custom')).toBe('');
});
it('stores independent Cursor SDK credentials in the encrypted credential store',async()=>{
 const root=await setup();const secrets=createSecrets(root,storage);const credential=JSON.stringify({apiKey:'fixture-cursor-key',disabled:false});await secrets.set('cursor-account',credential);expect(await secrets.get('cursor-account')).toBe(credential);expect((await readdir(join(root,'secrets')))).toContain('cursor-account.bin');await secrets.set('cursor-account','');expect(await secrets.get('cursor-account')).toBe('');
});
it('reuses decrypted credentials in memory until their ciphertext changes and never persists the cache',async()=>{
 const root=await setup(),file=join(root,'secrets','custom.bin');await writeFile(file,'encrypted:original');
 const decrypt=vi.fn(storage.decryptString),secrets=createSecrets(root,{...storage,decryptString:decrypt});
 expect(await secrets.get('custom')).toBe('original');expect(await secrets.get('custom')).toBe('original');expect(decrypt).toHaveBeenCalledTimes(1);
 await writeFile(file,'encrypted:changed');expect(await secrets.get('custom')).toBe('changed');expect(decrypt).toHaveBeenCalledTimes(2);
 await secrets.set('custom','updated');const calls=decrypt.mock.calls.length;expect(await secrets.get('custom')).toBe('updated');expect(decrypt).toHaveBeenCalledTimes(calls);
 expect(await readdir(join(root,'secrets'))).toEqual(['custom.bin']);
 expect(await readFile(file,'utf8')).toBe('encrypted:updated');
 await secrets.remove('custom');expect(await secrets.get('custom')).toBe('');
 await writeFile(file,'encrypted:restored');expect(await secrets.get('custom')).toBe('restored');expect(decrypt).toHaveBeenCalledTimes(calls+1);
});
it('does not return a cached credential when storage becomes unavailable or its file becomes unreadable',async()=>{
 const root=await setup(),file=join(root,'secrets','custom.bin');await writeFile(file,'encrypted:original');let available=true;
 const decrypt=vi.fn(storage.decryptString),secrets=createSecrets(root,{...storage,isEncryptionAvailable:()=>available,decryptString:decrypt});
 expect(await secrets.get('custom')).toBe('original');available=false;expect(await secrets.get('custom')).toBe('');
 available=true;expect(await secrets.get('custom')).toBe('original');expect(decrypt).toHaveBeenCalledTimes(1);
 await writeFile(file,'corrupt');expect(await secrets.get('custom')).toBe('');
 await writeFile(file,'encrypted:original');expect(await secrets.get('custom')).toBe('original');expect(decrypt).toHaveBeenCalledTimes(3);
});
it('clears read warnings and unreadable state after explicit recovery, including cached success after unlock',async()=>{
 const root=await setup(),file=join(root,'secrets','openai.bin');await writeFile(file,'encrypted:fixture');let denied=true,available=true;
 const decrypt=vi.fn((value:Buffer)=>{if(denied)throw Error('fixture denied');return storage.decryptString(value);});
 const secrets=createSecrets(root,{...storage,isEncryptionAvailable:()=>available,decryptString:decrypt});
 expect(await secrets.get('openai')).toBe('');expect(secrets.warnings()).toHaveLength(1);denied=false;
 expect(await secrets.get('openai',{retry:true})).toBe('fixture');expect(secrets.warnings()).toEqual([]);
 available=false;expect(await secrets.get('openai')).toBe('');expect(secrets.warnings()).toHaveLength(1);available=true;
 expect(await secrets.get('openai')).toBe('fixture');expect(secrets.warnings()).toEqual([]);expect(decrypt).toHaveBeenCalledTimes(2);
 await secrets.set('openai','replacement');expect((await readdir(join(root,'secrets'))).some(name=>name.includes('.unreadable-'))).toBe(false);
});
it('encrypts native login backups and fails closed on unreadable or locked originals',async()=>{
 const root=await setup();const secrets=createSecrets(root,storage);await secrets.set('native-login-workbuddy','original-session');expect(await secrets.get('native-login-workbuddy')).toBe('original-session');
 const path=join(root,'secrets','native-login-qoder.bin');await writeFile(path,'corrupt-original');await expect(secrets.get('native-login-qoder')).rejects.toThrow('无法解密');expect(await readFile(path,'utf8')).toBe('corrupt-original');
 const locked=createSecrets(root,{...storage,isEncryptionAvailable:()=>false});await expect(locked.get('native-login-workbuddy')).rejects.toThrow('安全存储');await expect(locked.set('native-login-workbuddy','replacement')).rejects.toThrow('不可用');expect(await secrets.get('native-login-workbuddy')).toBe('original-session');
});

it.each(['darwin','win32','linux'] as const)('keeps every desktop product backup independent on %s',async platform=>{
 const root=await setup(),secrets=createSecrets(root,storage,platform);
 const keys=['native-login-workbuddy','native-login-workbuddy-ai','native-login-qoder','native-login-qoder-ide','native-login-claude-desktop'];
 for(const key of keys){expect(await secrets.get(key)).toBe('');await secrets.set(key,`original:${key}`);}
 for(const key of keys){expect(await secrets.get(key)).toBe(`original:${key}`);expect(await readFile(join(root,'secrets',`${key}.bin`),'utf8')).not.toBe(`original:${key}`);}
 for(const key of keys.slice(1,4)){
  const locked=createSecrets(root,{...storage,isEncryptionAvailable:()=>false},platform);
  await expect(locked.get(key)).rejects.toThrow('安全存储');
  await expect(locked.set(key,'replacement')).rejects.toThrow('不可用');
  expect(await secrets.get(key)).toBe(`original:${key}`);
 }
 await secrets.remove('native-login-workbuddy-ai');expect(await secrets.get('native-login-workbuddy-ai')).toBe('');expect(await secrets.get('native-login-workbuddy')).toBe('original:native-login-workbuddy');
 await secrets.set('native-login-new-provider','new-provider-backup');expect(await secrets.get('native-login-new-provider')).toBe('new-provider-backup');
 await expect(secrets.get('../secrets/native-login-workbuddy')).rejects.toThrow('密钥存储名称无效');
});

it('accepts new credential types while rejecting unsafe portable filenames',async()=>{
 const root=await setup(),secrets=createSecrets(root,storage);
 for(const name of ['future-provider-token','grant-short','auth-history-index-new-provider-123']){
  await secrets.set(name,'fixture');expect(await secrets.get(name)).toBe('fixture');
  await secrets.remove(name);expect(await secrets.get(name)).toBe('');
 }
 for(const name of ['', '..', '../outside', 'a/b', 'a\\b', '/absolute', 'C:outside', 'name\0', 'CON', 'lpt1', 'a'.repeat(201)]){
  await expect(secrets.get(name)).rejects.toThrow('密钥存储名称无效');
  await expect(secrets.set(name,'fixture')).rejects.toThrow('密钥存储名称无效');
  await expect(secrets.remove(name)).rejects.toThrow('密钥存储名称无效');
 }
});
