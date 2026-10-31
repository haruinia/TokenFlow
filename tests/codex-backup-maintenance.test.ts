import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm,realpath,readdir,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {CodexBackupMaintenance} from '../packages/core/src/codex-backup-maintenance.js';
import {CodexHistoryBackups} from '../packages/core/src/codex-history-backups.js';
async function fixture(){
 const root=await mkdtemp(join(await realpath(tmpdir()),'backup-maintenance-'));const dirs=[];
 for(let i=0;i<2;i++){const id=randomUUID(),path=join(root,'codex-thread-backups',id);await mkdir(path,{recursive:true});await writeFile(join(path,'0.jsonl'),'immutable original history');await writeFile(join(path,'state_5.sqlite'),'same synthetic database');await writeFile(join(path,'manifest.json'),JSON.stringify({version:1,id,state:'restored',entries:[{id:'thread',source:'vscode'}]}));if(process.platform==='darwin')for(const name of ['0.jsonl','state_5.sqlite'])execFileSync('/usr/bin/xattr',['-c',join(path,name)]);dirs.push(path);}
 return {root,dirs,close:()=>rm(root,{recursive:true,force:true})};
}
it('shares identical immutable baselines without breaking manifests, history deltas or future reads',async()=>{
 const f=await fixture();try{
  const history=new CodexHistoryBackups(f.root),original=Buffer.from('immutable original history');
  const a=await history.capture('/fixture/rollout',original,join(f.dirs[0]!,'0.jsonl'));const b=await history.capture('/fixture/rollout',Buffer.concat([original,Buffer.from('\nnew turn')]));
  const before=await Promise.all(f.dirs.map(p=>readFile(join(p,'manifest.json'),'utf8')));
  const maintenance=new CodexBackupMaintenance(f.root,async()=>{});const report=await maintenance.run();expect(report.sharedFiles).toBe(process.platform==='darwin'?2:0);
  const firstInode=(await stat(join(f.dirs[0]!,'0.jsonl'))).ino,secondInode=(await stat(join(f.dirs[1]!,'0.jsonl'))).ino;
  if(process.platform==='darwin')expect(firstInode).toBe(secondInode);else expect(firstInode).not.toBe(secondInode);
  expect(await Promise.all(f.dirs.map(p=>readFile(join(p,'manifest.json'),'utf8')))).toEqual(before);
  expect(await history.read(a)).toEqual(original);expect((await history.read(b)).toString()).toBe('immutable original history\nnew turn');
  expect((await maintenance.run()).sharedFiles).toBe(0);
 }finally{await f.close();}
});
it('retains distinct database snapshots and removes only unreferenced unpublished history payloads',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.dirs[1]!,'state_5.sqlite'),'different database state');
  const history=new CodexHistoryBackups(f.root),s=await history.capture('/fixture/rollout',Buffer.from('saved'));
  const orphan=join(f.root,'codex-history-backups',s.key,'a'.repeat(64)+'.delta');await writeFile(orphan,'unpublished');
  const r=await new CodexBackupMaintenance(f.root,async()=>{}).run();expect(r.removedUnreferencedFiles).toBe(1);
  expect((await stat(join(f.dirs[0]!,'state_5.sqlite'))).ino).not.toBe((await stat(join(f.dirs[1]!,'state_5.sqlite'))).ino);
  expect((await history.read(s)).toString()).toBe('saved');await expect(stat(orphan)).rejects.toMatchObject({code:'ENOENT'});
 }finally{await f.close();}
});
it('does not rehash unchanged backups or inspect ACLs for distinct content, but detects later changes',async()=>{
 const f=await fixture();try{
  for(const [i,dir] of f.dirs.entries()){await writeFile(join(dir,'0.jsonl'),`history-${i}`);await writeFile(join(dir,'state_5.sqlite'),`database-${i}`);}
  const maintenance=new CodexBackupMaintenance(f.root,async()=>{});
  const first=await maintenance.run(),again=await maintenance.run();expect(first.hashedFiles).toBe(4);expect(first.metadataReads).toBe(0);expect(again.hashedFiles).toBe(0);
  await writeFile(join(f.dirs[1]!,'0.jsonl'),'history-X');expect((await maintenance.run()).hashedFiles).toBe(1);
 }finally{await f.close();}
});
it('fails before sharing or deletion when a cross-directory baseline reference is broken',async()=>{
 const f=await fixture();try{
  const mpath=join(f.dirs[1]!,'manifest.json'),m=JSON.parse(await readFile(mpath,'utf8'));m.entries[0].historyBackup={journalId:randomUUID(),file:'0.jsonl'};await writeFile(mpath,JSON.stringify(m));
  await expect(new CodexBackupMaintenance(f.root,async()=>{}).run()).rejects.toMatchObject({code:'codex_backup_reference_conflict'});
  expect((await stat(join(f.dirs[0]!,'0.jsonl'))).ino).not.toBe((await stat(join(f.dirs[1]!,'0.jsonl'))).ino);
 }finally{await f.close();}
});
it('refuses a corrupted full baseline and preserves every old copy',async()=>{
 const f=await fixture();try{
  const h=new CodexHistoryBackups(f.root);await h.capture('/fixture/rollout',Buffer.from('immutable original history'),join(f.dirs[0]!,'0.jsonl'));await writeFile(join(f.dirs[0]!,'0.jsonl'),'corrupted history');
  await expect(new CodexBackupMaintenance(f.root,async()=>{}).run()).rejects.toMatchObject({code:'codex_backup_reference_conflict'});
  expect(await readFile(join(f.dirs[1]!,'0.jsonl'),'utf8')).toBe('immutable original history');
 }finally{await f.close();}
});
it('checks that Codex remains stopped before any storage mutation',async()=>{
 const f=await fixture();try{
  let checks=0;await expect(new CodexBackupMaintenance(f.root,async()=>{if(++checks>1)throw Error('running');}).run()).rejects.toThrow('running');
  expect((await stat(join(f.dirs[0]!,'0.jsonl'))).ino).not.toBe((await stat(join(f.dirs[1]!,'0.jsonl'))).ino);
 }finally{await f.close();}
});
it('excludes another writer/collector during payload publication, including a separate process',async()=>{
 const {withCodexBackupLock}=await import('../packages/core/src/codex-backup-lock.js');const {spawn}=await import('node:child_process');
 const f=await fixture();let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
 const writer=withCodexBackupLock(f.root,async()=>{entered();await held;});
 try{
  await started;await expect(new CodexBackupMaintenance(f.root,async()=>{}).run()).rejects.toMatchObject({code:'codex_backup_busy'});
  await expect(new CodexHistoryBackups(f.root).capture('/fixture/writing',Buffer.from('partial'))).rejects.toMatchObject({code:'codex_backup_busy'});
  const code=await new Promise<number|null>((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',`import lock from 'proper-lockfile';try{const release=await lock.lock(process.argv[1],{realpath:false,lockfilePath:process.argv[1]+'/.codex-backup.lock',retries:0});await release();process.exit(2);}catch(e){process.exit(e.code==='ELOCKED'?0:3);}`,f.root],{stdio:'ignore'});child.on('error',reject);child.on('exit',resolve);});expect(code).toBe(0);
 }finally{release();await writer;await f.close();}
});

it.skipIf(process.platform==='win32')('preserves distinct file permissions instead of inheriting a less restrictive source inode',async()=>{
 const f=await fixture();try{
  const a=join(f.dirs[0]!,'0.jsonl'),b=join(f.dirs[1]!,'0.jsonl');await chmod(a,0o600);await chmod(b,0o400);
  await new CodexBackupMaintenance(f.root,async()=>{}).run();expect((await stat(a)).ino).not.toBe((await stat(b)).ino);expect((await stat(b)).mode&0o777).toBe(0o400);
 }finally{await f.close();}
});

it.skipIf(process.platform!=='darwin')('keeps different extended attributes on separate inodes',async()=>{
 const f=await fixture();try{
  const a=join(f.dirs[0]!,'0.jsonl'),b=join(f.dirs[1]!,'0.jsonl');execFileSync('/usr/bin/xattr',['-w','com.tokenflow.fixture','first',a]);execFileSync('/usr/bin/xattr',['-w','com.tokenflow.fixture','second',b]);
  await new CodexBackupMaintenance(f.root,async()=>{}).run();expect((await stat(a)).ino).not.toBe((await stat(b)).ino);expect(execFileSync('/usr/bin/xattr',['-p','com.tokenflow.fixture',b],{encoding:'utf8'}).trim()).toBe('second');
 }finally{await f.close();}
});
