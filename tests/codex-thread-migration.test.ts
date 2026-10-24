import {describe,it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath,stat,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {CodexThreadMigration,type MigrationClient} from '../packages/core/src/codex-thread-migration.js';
import {CodexHistoryBackups} from '../packages/core/src/codex-history-backups.js';
async function fixture(){
 const root=await mkdtemp(join(await realpath(tmpdir()),'thread-migration-')),home=join(root,'codex');await mkdir(home);
 await writeFile(join(home,'config.toml'),'model="native"');
 const db=new DatabaseSync(join(home,'state_5.sqlite'));db.exec('create table threads(id text,model_provider text,model text,rollout_path text,source text,archived integer)');
 for(const [id,provider,source,archived] of [['old','openai','vscode',0],['cli','openai','cli',0],['custom','other','vscode',0],['archived','openai','vscode',1],['test','openai','exec',0],['subagent','openai','{"subagent":1}',0],['draft','openai','vscode',0]] as const){const path=join(home,`${id}.jsonl`);await writeFile(path,`{"history":"${id}"}\n`);db.prepare('insert into threads values (?,?,?,?,?,?)').run(id,provider,id==='draft'?null:'native',path,source,archived);}
 let running=false,failOn='',archiveFailure=false,calls=0,compactionFailure=false;const compacted:string[]=[];
 const client=async():Promise<MigrationClient>=>({pid:100,setArchived:async(id,archived)=>{if(archived&&archiveFailure)throw Error('archive fixture failure');db.prepare('update threads set archived=? where id=?').run(Number(archived),id);},close:async()=>{},resume:async(id,provider,model,compact?:boolean)=>{calls++;if(id===failOn)throw Error('fixture failure');const row=db.prepare('select rollout_path from threads where id=?').get(id);await readFile(String(row?.rollout_path));db.prepare('update threads set model_provider=?,model=? where id=?').run(provider,model,id);if(compact){compacted.push(id);if(compactionFailure)throw Error('compaction fixture failure');}}});
 const migration=new CodexThreadMigration(root,join(home,'config.toml'),async()=>running?[99]:[],client);
 return {root,home,db,migration,compacted,setCompactionFailure:(v:boolean)=>compactionFailure=v,reopen:()=>new CodexThreadMigration(root,join(home,'config.toml'),async()=>running?[99]:[],client),setArchiveFailure:(v:boolean)=>archiveFailure=v,setRunning:(v:boolean)=>running=v,setFailure:(v:string)=>failOn=v,calls:()=>calls,close:async()=>{db.close();await rm(root,{recursive:true,force:true});}};
}
it('identifies imported official history without treating new gateway threads or key changes as new imports',async()=>{
 const f=await fixture();try{
  expect(await f.migration.bootstrapHistory('old')).toBeUndefined();
  await f.migration.prepare('gateway');await f.migration.migrate('gateway');
  const initial=await f.migration.bootstrapHistory('old');expect(initial?.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(await f.reopen().bootstrapHistory('old')).toEqual(initial);
  const born=join(f.home,'born.jsonl');await writeFile(born,'New gateway conversation');
  f.db.prepare('insert into threads values (?,?,?,?,?,?)').run('born','token_flow','gateway',born,'vscode',0);
  await f.migration.prepare('gateway',['gateway','other-model']);await f.migration.migrate('gateway',['gateway','other-model']);
  expect(await f.migration.bootstrapHistory('born')).toBeUndefined();expect(await f.migration.bootstrapHistory('old')).toEqual(initial);
  await writeFile(join(f.home,'old.jsonl'),'Official A; gateway completed B.');
  await f.migration.restore('native');expect(await f.migration.bootstrapHistory('old')).toBeUndefined();
  expect(await readFile(join(f.home,'old.jsonl'),'utf8')).toBe('Official A; gateway completed B.');
  await writeFile(join(f.home,'old.jsonl'),'Official A; gateway completed B; official continued C.');
  await f.migration.prepare('gateway');await f.migration.migrate('gateway');
  const latest=await f.migration.bootstrapHistory('old');expect(latest?.revision).toMatch(/^[a-f0-9]{64}$/);expect(latest?.revision).not.toBe(initial?.revision);
  expect(await readFile(join(f.home,'old.jsonl'),'utf8')).toBe('Official A; gateway completed B; official continued C.');
 }finally{await f.close();}
});
describe('Codex old thread migration',()=>{
 it('requires exit before backup or configuration writes',async()=>{const f=await fixture();try{f.setRunning(true);await expect(f.migration.prepare('gateway')).rejects.toMatchObject({code:'codex_exit_required'});expect(f.calls()).toBe(0);expect((await f.migration.status()).backups).toBe(0);}finally{await f.close();}});
 it('backs up routes and history, migrates only local official threads, restores without losing later turns',async()=>{const f=await fixture();try{
  await f.migration.prepare('gateway');const dirs=await readdir(join(f.root,'codex-thread-backups'));const saved=new DatabaseSync(join(f.root,'codex-thread-backups',dirs[0]!,'state_5.sqlite'),{readOnly:true});expect(saved.prepare('select model_provider from threads where id=?').get('old')?.model_provider).toBe('openai');saved.close();
  expect((await f.migration.migrate('gateway')).migrated).toBe(2);expect(f.calls()).toBe(2);expect(f.db.prepare('select model_provider from threads where id=?').get('custom')?.model_provider).toBe('other');
  await writeFile(join(f.home,'old.jsonl'),'original history plus a new message');await f.migration.prepare('next');expect((await f.migration.status()).backups).toBe(1);
  await f.migration.restore();expect(await readFile(join(f.home,'old.jsonl'),'utf8')).toBe('original history plus a new message');expect(f.db.prepare('select model_provider,model from threads where id=?').get('old')).toMatchObject({model_provider:'openai',model:'native'});expect((await f.migration.status()).restorable).toBe(0);
 }finally{await f.close();}});
 it('resumes a partial migration after a service restart and refuses external provider changes',async()=>{const f=await fixture();try{await f.migration.prepare('gateway');f.setFailure('cli');await expect(f.migration.migrate('gateway')).rejects.toThrow('fixture failure');expect((await f.migration.status()).remaining).toBe(1);f.setFailure('');await f.migration.migrate('gateway');expect((await f.migration.status()).remaining).toBe(0);f.db.prepare("update threads set model_provider='external' where id='old'").run();await expect(f.migration.restore()).rejects.toThrow('其他程序');expect((await f.migration.status()).restorable).toBe(2);}finally{await f.close();}});
 it('isolates missing history without blocking other threads or deleting their records',async()=>{const f=await fixture();try{
 f.db.prepare('insert into threads values (?,?,?,?,?,?)').run('gone','token_flow','workbuddy/deepseek-v4.1-flash',join(f.home,'missing.jsonl'),'vscode',0);
 await f.migration.prepare('gateway');await f.migration.migrate('gateway');
 await f.migration.restore('gpt-6-luna');
 expect(f.db.prepare('select model_provider from threads where id=?').get('gone')?.model_provider).toBe('token_flow');
 expect(f.db.prepare('select model_provider from threads where id=?').get('old')?.model_provider).toBe('openai');
 expect((await f.migration.status()).restorable).toBe(0);
 expect((await f.migration.status()).unavailable).toBe(1);
 const dirs=await readdir(join(f.root,'codex-thread-backups'));const journal=JSON.parse(await readFile(join(f.root,'codex-thread-backups',dirs[0]!,'manifest.json'),'utf8'));
 expect(journal.entries.find((entry:any)=>entry.id==='gone')?.state).toBe('unavailable');
 await f.reopen().restore(async()=>{throw new Error('unavailable history must not require model discovery');});expect((await f.migration.status()).backups).toBe(1);
 await writeFile(join(f.home,'missing.jsonl'),'recovered history');
 await f.reopen().restore('gpt-6-luna');
 expect(f.db.prepare('select model_provider from threads where id=?').get('gone')?.model_provider).toBe('openai');
 expect(await readFile(join(f.home,'missing.jsonl'),'utf8')).toBe('recovered history');
}finally{await f.close();}});
it('does not treat a non-file history path as missing or silently continue',async()=>{const f=await fixture();try{
 await f.migration.prepare('gateway');await f.migration.migrate('gateway');
 f.db.prepare("update threads set rollout_path=? where id='old'").run(f.home);
 await expect(f.reopen().restore()).rejects.toThrow('不是文件');
 expect((await f.migration.status()).unavailable).toBe(0);
 expect(f.db.prepare("select model_provider from threads where id='old'").get()?.model_provider).toBe('token_flow');
}finally{await f.close();}});
it('skips an archived history removed after backup without unarchiving or resuming it',async()=>{const f=await fixture();try{
 await f.migration.prepare('gateway');await f.migration.migrate('gateway');
 f.db.prepare("update threads set archived=1 where id='old'").run();await rm(join(f.home,'old.jsonl'));
 f.setFailure('old');await f.reopen().restore();
 expect(f.db.prepare("select archived from threads where id='old'").get()?.archived).toBe(1);
 expect(f.db.prepare("select model_provider from threads where id='cli'").get()?.model_provider).toBe('openai');
 expect((await f.migration.status()).restorable).toBe(0);
}finally{await f.close();}});
it('backs up gateway-born threads and restores them to an official model without discarding history',async()=>{const f=await fixture();try{
  const path=join(f.home,'gateway.jsonl');await writeFile(path,'gateway history and tools');
  f.db.prepare('insert into threads values (?,?,?,?,?,?)').run('gateway','token_flow','qoder/Kimi-K3',path,'vscode',0);
  f.setRunning(true);await expect(f.migration.restore('gpt-6-luna')).rejects.toMatchObject({code:'codex_exit_required'});
  f.setRunning(false);await f.migration.restore('gpt-6-luna');
  expect(f.db.prepare('select model_provider,model from threads where id=?').get('gateway')).toMatchObject({model_provider:'openai',model:'gpt-6-luna'});
  expect(await readFile(path,'utf8')).toBe('gateway history and tools');expect((await f.migration.status()).backups).toBe(1);
  await f.migration.restore('gpt-6-luna');expect(f.calls()).toBe(1);
 }finally{await f.close();}});
 it('keeps backups if Codex is opened during migration',async()=>{const f=await fixture();try{await f.migration.prepare('gateway');f.setRunning(true);await expect(f.migration.migrate('gateway')).rejects.toMatchObject({code:'codex_exit_required'});expect((await f.migration.status()).remaining).toBe(2);expect(f.calls()).toBe(0);}finally{await f.close();}});
});

it('restores archived threads without unarchiving and skips deleted records',async()=>{const f=await fixture();try{
 await f.migration.prepare('gateway');await f.migration.migrate('gateway');
 f.db.prepare("update threads set archived=1 where id='old'").run();
 f.db.prepare("delete from threads where id='cli'").run();
 await f.migration.restore();
 expect(f.db.prepare("select model_provider,model,archived from threads where id='old'").get()).toMatchObject({model_provider:'openai',model:'native',archived:1});
 expect(f.db.prepare("select id from threads where id='cli'").get()).toBeUndefined();
 expect((await f.migration.status()).restorable).toBe(0);
}finally{await f.close();}});
it('replaces removed gateway models and retains still-authorized thread selections',async()=>{const f=await fixture();try{
 await f.migration.prepare('gateway');await f.migration.migrate('gateway');
 f.db.prepare("update threads set model='retained' where id='cli'").run();
 await f.migration.prepare('replacement');await f.migration.migrate('replacement',['replacement','retained']);
 expect(f.db.prepare("select model from threads where id='old'").get()?.model).toBe('replacement');
 expect(f.db.prepare("select model from threads where id='cli'").get()?.model).toBe('retained');
 await f.migration.restore();
 expect(f.db.prepare("select model from threads where id='old'").get()?.model).toBe('native');
}finally{await f.close();}});

it('continues restoring surviving threads after a deleted record and keeps the deletion across retries',async()=>{const f=await fixture();try{
 await f.migration.prepare('gateway');await f.migration.migrate('gateway');
 f.db.prepare("delete from threads where id='old'").run();
 await f.migration.restore();await f.reopen().restore();
 expect(f.db.prepare("select model_provider from threads where id='cli'").get()?.model_provider).toBe('openai');
 expect(f.db.prepare("select id from threads where id='old'").get()).toBeUndefined();
 expect((await f.migration.status()).restorable).toBe(0);
}finally{await f.close();}});
it('preserves the archive state on resume failure and completes an interrupted rearchive after restart',async()=>{const f=await fixture();try{
 await f.migration.prepare('gateway');await f.migration.migrate('gateway');
 f.db.prepare("update threads set archived=1 where id='old'").run();f.setFailure('old');
 await expect(f.migration.restore()).rejects.toThrow('fixture failure');
 expect(f.db.prepare("select archived from threads where id='old'").get()?.archived).toBe(1);
 f.setFailure('');f.setArchiveFailure(true);
 await expect(f.migration.restore()).rejects.toThrow('archive fixture failure');
 expect(f.db.prepare("select model_provider,archived from threads where id='old'").get()).toMatchObject({model_provider:'openai',archived:0});
 f.setArchiveFailure(false);await f.reopen().restore();
 expect(f.db.prepare("select model_provider,archived from threads where id='old'").get()).toMatchObject({model_provider:'openai',archived:1});
 expect((await f.migration.status()).restorable).toBe(0);
}finally{await f.close();}});
it('reconciles gateway-born threads too and resumes a partially failed model replacement',async()=>{const f=await fixture();try{
 await f.migration.prepare('gateway');await f.migration.migrate('gateway');
 const path=join(f.home,'born.jsonl');await writeFile(path,'saved gateway history');
 f.db.prepare('insert into threads values (?,?,?,?,?,?)').run('born','token_flow','removed',path,'vscode',1);
 f.setRunning(true);await expect(f.migration.prepare('replacement')).rejects.toMatchObject({code:'codex_exit_required'});f.setRunning(false);
 await f.migration.prepare('replacement');expect((await f.migration.status()).remaining).toBe(3);
 f.setFailure('cli');await expect(f.migration.migrate('replacement')).rejects.toThrow('fixture failure');
 f.setFailure('');await f.reopen().migrate('replacement');
 expect(f.db.prepare("select model,archived from threads where id='born'").get()).toMatchObject({model:'replacement',archived:1});
 await f.reopen().restore('official-default');
 expect(f.db.prepare("select model_provider,model,archived from threads where id='born'").get()).toMatchObject({model_provider:'openai',model:'official-default',archived:1});
 expect(await readFile(path,'utf8')).toBe('saved gateway history');
}finally{await f.close();}});
it('does not confuse changed thread sources or a missing database with deletion',async()=>{const f=await fixture();try{
 await f.migration.prepare('gateway');await f.migration.migrate('gateway');
 f.db.prepare("update threads set source='exec' where id='old'").run();
 await expect(f.migration.restore()).rejects.toThrow('其他程序');
 expect((await f.migration.status()).restorable).toBe(2);
 await rm(join(f.home,'state_5.sqlite'));
 await expect(f.migration.restore()).rejects.toThrow('数据库');
 expect((await f.migration.status()).restorable).toBe(2);
}finally{await f.close();}});

it('finishes deleted-only journals without requiring a runtime or a default model',async()=>{const f=await fixture();try{
 await f.migration.prepare('gateway');await f.migration.migrate('gateway');
 f.db.prepare("delete from threads where id in ('old','cli')").run();
 const restarted=new CodexThreadMigration(f.root,join(f.home,'config.toml'),async()=>[],async()=>{throw Error('runtime should not start');});
 await restarted.restore(async()=>{throw Error('default should not be resolved');});
 expect((await restarted.status()).restorable).toBe(0);
}finally{await f.close();}});

it('does not rewrite journals or restart the migration runtime when only adding authorized models',async()=>{const f=await fixture();try{
 await f.migration.prepare('gateway');await f.migration.migrate('gateway');
 const dirs=await readdir(join(f.root,'codex-thread-backups'));const manifest=join(f.root,'codex-thread-backups',dirs[0]!,'manifest.json');const before=await stat(manifest);
 await f.migration.prepare('gateway',['gateway','added']);await f.migration.migrate('gateway',['gateway','added']);
 expect((await stat(manifest)).mtimeMs).toBe(before.mtimeMs);expect(f.calls()).toBe(2);expect((await f.migration.status()).backups).toBe(1);
}finally{await f.close();}});
it('adds a new conversation backup without another full database snapshot during the same migration',async()=>{const f=await fixture();try{
 await f.migration.prepare('gateway');await f.migration.migrate('gateway');
 const file=join(f.home,'new.jsonl');await writeFile(file,'new history');f.db.prepare('insert into threads values (?,?,?,?,?,?)').run('new','openai','native',file,'vscode',0);
 await f.migration.prepare('gateway',['gateway','added']);await f.migration.migrate('gateway',['gateway','added']);
 const dirs=await readdir(join(f.root,'codex-thread-backups'));expect(dirs).toHaveLength(2);
 let databases=0;for(const dir of dirs)databases+=(await readdir(join(f.root,'codex-thread-backups',dir))).filter(n=>n.endsWith('.sqlite')).length;
 expect(databases).toBe(1);await f.migration.restore();expect(f.db.prepare("select model_provider from threads where id='new'").get()?.model_provider).toBe('openai');expect(await readFile(file,'utf8')).toBe('new history');
}finally{await f.close();}});
it('reconciles gateway child threads and survives repeated switch, create, archive and delete cycles',async()=>{const f=await fixture();try{
 const insert=async(id:string,source:string,archived=0)=>{const path=join(f.home,`${id}.jsonl`);await writeFile(path,`history ${id}`);f.db.prepare('insert into threads values (?,?,?,?,?,?)').run(id,'token_flow','qoder/a',path,source,archived);};
 await f.migration.prepare('qoder/a');await f.migration.migrate('qoder/a');
 await insert('guardian','{"subagent":{"other":"guardian"}}');await insert('child','{"subagent":{"thread_spawn":{"parent_thread_id":"old"}}}',1);await insert('new-project','vscode');
 f.db.prepare("delete from threads where id='cli'").run();
 await f.reopen().restore('native');
 expect(f.db.prepare("select count(*) as n from threads where model_provider='token_flow'").get()?.n).toBe(0);
 expect(f.db.prepare("select archived from threads where id='child'").get()?.archived).toBe(1);
 for(let cycle=0;cycle<3;cycle++){await f.reopen().prepare('qoder/b');await f.reopen().migrate('qoder/b');await insert(`born-${cycle}`,'vscode');await f.reopen().restore('native');}
 expect(f.db.prepare("select count(*) as n from threads where model_provider='token_flow'").get()?.n).toBe(0);
 expect(f.db.prepare("select id from threads where id='cli'").get()).toBeUndefined();expect(await readFile(join(f.home,'new-project.jsonl'),'utf8')).toBe('history new-project');
}finally{await f.close();}});

it('inspects routing metadata without resuming threads or exposing their paths/content',async()=>{
 const f=await fixture();try{
  const before=await readFile(join(f.home,'config.toml'),'utf8');
  const result=await f.migration.inspect({provider:'token_flow',model:'qoder/test',allowedModels:['qoder/test']});
  expect(result.available).toBe(true);expect(result.mismatched).toBe(2);expect(result.total).toBe(7);
  expect(JSON.stringify(result)).not.toContain('rollout');expect(JSON.stringify(result)).not.toContain(f.root);
  expect((await f.migration.status()).backups).toBe(0);
  expect(await readFile(join(f.home,'config.toml'),'utf8')).toBe(before);
  expect((await f.migration.inspect({provider:'openai',model:'different-native-model'})).mismatched).toBe(0);
 }finally{f.db.close();await rm(f.root,{recursive:true,force:true});}
});

async function backupFiles(root:string){
 const files:string[]=[];for(const directory of await readdir(join(root,'codex-thread-backups')))for(const name of await readdir(join(root,'codex-thread-backups',directory)))files.push(`${directory}/${name}`);return files;
}
it('reuses immutable history and database baselines across complete switch cycles, retaining each current official model',async()=>{
 const f=await fixture();try{
  await f.migration.prepare('gateway');await f.migration.migrate('gateway');await f.migration.restore();
  const initial=await backupFiles(f.root),baseline=initial.find(path=>path.endsWith('/0.jsonl'))!;
  const original=await readFile(join(f.root,'codex-thread-backups',baseline),'utf8');
  for(let cycle=0;cycle<3;cycle++){
   f.db.prepare("update threads set model=? where id='old'").run(`official-${cycle}`);
   await writeFile(join(f.home,'old.jsonl'),`latest turns ${cycle}`);
   await f.reopen().prepare(`gateway-${cycle}`);await f.reopen().migrate(`gateway-${cycle}`);await f.reopen().restore();
   expect(f.db.prepare("select model from threads where id='old'").get()?.model).toBe(`official-${cycle}`);
   expect(await readFile(join(f.home,'old.jsonl'),'utf8')).toBe(`latest turns ${cycle}`);
  }
  const files=await backupFiles(f.root);expect(files.filter(name=>name.endsWith('.jsonl'))).toHaveLength(2);expect(files.filter(name=>name.endsWith('.sqlite'))).toHaveLength(1);
  expect(await readFile(join(f.root,'codex-thread-backups',baseline),'utf8')).toBe(original);
 }finally{await f.close();}
});
it('appends only a newly seen thread after returning to official, sharing the earlier database baseline',async()=>{
 const f=await fixture();try{
  await f.migration.prepare('gateway');await f.migration.migrate('gateway');await f.migration.restore();
  const path=join(f.home,'later.jsonl');await writeFile(path,'later official conversation');f.db.prepare('insert into threads values (?,?,?,?,?,?)').run('later','openai','latest-official',path,'vscode',0);
  await f.reopen().prepare('gateway');await f.reopen().migrate('gateway');await f.reopen().restore();
  const files=await backupFiles(f.root);expect(files.filter(name=>name.endsWith('.jsonl'))).toHaveLength(3);expect(files.filter(name=>name.endsWith('.sqlite'))).toHaveLength(1);
  expect(f.db.prepare("select model from threads where id='later'").get()?.model).toBe('latest-official');
 }finally{await f.close();}
});
it('backs up only added history on repeated switches and retains each observed route with a recoverable revision',async()=>{
 const f=await fixture();try{
  const path=join(f.home,'old.jsonl'),original=await readFile(path,'utf8');
  await f.migration.prepare('gateway');await f.migration.migrate('gateway');
  const gatewayText=original+'gateway turn\n';await writeFile(path,gatewayText);
  await f.reopen().restore('native');
  const officialText=gatewayText+'official turn\n';await writeFile(path,officialText);
  await f.reopen().prepare('second-gateway');await f.reopen().migrate('second-gateway');await f.reopen().restore('native');
  const files=await backupFiles(f.root);expect(files.filter(name=>name.endsWith('.jsonl'))).toHaveLength(2);expect(files.filter(name=>name.endsWith('.sqlite'))).toHaveLength(1);
  const versions:any[]=[];for(const file of files.filter(name=>name.endsWith('manifest.json'))){const journal=JSON.parse(await readFile(join(f.root,'codex-thread-backups',file),'utf8'));for(const entry of journal.entries)if(entry.id==='old')versions.push(...entry.historySnapshots);}
  const history=new CodexHistoryBackups(f.root);
  const gatewayVersion=versions.filter(v=>v.provider==='token_flow'&&v.model==='gateway').at(-1);
  expect((await history.read(gatewayVersion.snapshot)).toString()).toBe(gatewayText);
  const latest=versions.find(v=>v.provider==='token_flow'&&v.model==='second-gateway');expect((await history.read(latest.snapshot)).toString()).toBe(officialText);
  const directory=join(f.root,'codex-history-backups',latest.snapshot.key),deltas=(await readdir(directory)).filter(name=>name.endsWith('.delta'));
  expect(deltas).toHaveLength(2);let bytes=0;for(const file of deltas)bytes+=(await stat(join(directory,file))).size;
  expect(bytes).toBe(Buffer.byteLength('gateway turn\nofficial turn\n'));expect(await readFile(path,'utf8')).toBe(officialText);
 }finally{await f.close();}
});
it('creates a fresh baseline when an earlier history backup has been removed instead of publishing a broken reference',async()=>{
 const f=await fixture();try{
  await f.migration.prepare('gateway');await f.migration.migrate('gateway');await f.migration.restore();
  const previous=(await readdir(join(f.root,'codex-thread-backups')))[0]!;await rm(join(f.root,'codex-thread-backups',previous,'0.jsonl'));
  await writeFile(join(f.home,'old.jsonl'),'newer live history');await f.reopen().prepare('gateway');
  const latest=(await readdir(join(f.root,'codex-thread-backups'))).find(id=>id!==previous)!;
  expect(await readFile(join(f.root,'codex-thread-backups',latest,'0.jsonl'),'utf8')).toBe('newer live history');
  const manifest=JSON.parse(await readFile(join(f.root,'codex-thread-backups',latest,'manifest.json'),'utf8'));
  expect(manifest.entries.find((entry:any)=>entry.id==='old').historyBackup).toBeUndefined();
  expect(manifest.entries.find((entry:any)=>entry.id==='cli').historyBackup).toMatchObject({journalId:previous,file:'1.jsonl'});
 }finally{await f.close();}
});
it('does not leave an unpublished duplicate backup directory when live history is invalid',async()=>{
 const f=await fixture();try{
  await rm(join(f.home,'old.jsonl'));await mkdir(join(f.home,'old.jsonl'));
  await expect(f.migration.prepare('gateway')).rejects.toThrow();
  expect(await readdir(join(f.root,'codex-thread-backups'))).toEqual([]);expect(f.calls()).toBe(0);
  expect(f.db.prepare("select model_provider from threads where id='old'").get()?.model_provider).toBe('openai');
 }finally{await f.close();}
});
it.each(['directory','relative','symlink'])('validates live history before reusing a baseline when the path becomes %s',async(kind)=>{
 const f=await fixture();try{
  await f.migration.prepare('gateway');await f.migration.migrate('gateway');await f.migration.restore();
  const previous=await readdir(join(f.root,'codex-thread-backups'));
  if(kind==='relative')f.db.prepare("update threads set rollout_path='relative.jsonl' where id='old'").run();
  else{await rm(join(f.home,'old.jsonl'));if(kind==='directory')await mkdir(join(f.home,'old.jsonl'));else await symlink(join(f.home,'cli.jsonl'),join(f.home,'old.jsonl'));}
  await expect(f.reopen().prepare('next-gateway')).rejects.toThrow();
  expect(await readdir(join(f.root,'codex-thread-backups'))).toEqual(previous);
  expect(f.db.prepare("select model_provider from threads where id='old'").get()?.model_provider).toBe('openai');
 }finally{await f.close();}
});

it('backs up and switches large histories without starting any compaction',async()=>{
 const f=await fixture();try{
  const original=JSON.stringify({type:'response_item',payload:{role:'assistant',content:'old work '.repeat(40000)}})+'\n';
  await writeFile(join(f.home,'old.jsonl'),original);await f.migration.prepare('gateway');f.setCompactionFailure(true);
  // Upgrade from .43 must ignore its unfinished switch-time compaction marker.
  for(const name of await readdir(join(f.root,'codex-thread-backups'))){const path=join(f.root,'codex-thread-backups',name,'manifest.json');const journal=JSON.parse(await readFile(path,'utf8'));for(const entry of journal.entries){entry.compactionChecked=true;entry.initialCompaction='pending';}await writeFile(path,JSON.stringify(journal));}
  await f.migration.migrate('gateway');expect(f.compacted).toEqual([]);
  expect(f.db.prepare("select model_provider from threads where id='old'").get()?.model_provider).toBe('token_flow');
  expect(await readFile(join(f.home,'old.jsonl'),'utf8')).toBe(original);
  await f.reopen().migrate('gateway');await f.reopen().restore();expect(f.compacted).toEqual([]);
 }finally{await f.close();}
});

it('keeps an authorized official model while moving its provider into a mixed catalog, including later repairs',async()=>{
 const f=await fixture();try{
  const allowed=['gateway','native'];
  await f.migration.prepare('gateway',allowed);
  const manifest=JSON.parse(await readFile(join(f.root,'codex-thread-backups',(await readdir(join(f.root,'codex-thread-backups')))[0]!,'manifest.json'),'utf8'));
  expect(manifest.entries.every((entry:any)=>entry.nextModel==='native')).toBe(true);
  await f.migration.migrate('gateway',allowed);
  for(const id of ['old','cli'])expect(f.db.prepare('select model_provider,model from threads where id=?').get(id)).toMatchObject({model_provider:'token_flow',model:'native'});
  const before=f.calls();await f.reopen().prepare('gateway',allowed);await f.reopen().migrate('gateway',allowed);expect(f.calls()).toBe(before);
  // A resumed official route may need its provider repaired, without replacing
  // the still-authorized official model with the gateway default.
  f.db.prepare("update threads set model_provider='openai' where id='old'").run();
  await f.reopen().prepare('gateway',allowed);await f.reopen().migrate('gateway',allowed);
  expect(f.db.prepare("select model_provider,model from threads where id='old'").get()).toMatchObject({model_provider:'token_flow',model:'native'});
  // New official conversations discovered on a later apply use the same rule.
  const file=join(f.home,'later-mixed.jsonl');await writeFile(file,'later mixed history');f.db.prepare('insert into threads values (?,?,?,?,?,?)').run('later-mixed','openai','native',file,'vscode',0);
  await f.reopen().prepare('gateway',allowed);await f.reopen().migrate('gateway',allowed);
  expect(f.db.prepare("select model_provider,model from threads where id='later-mixed'").get()).toMatchObject({model_provider:'token_flow',model:'native'});
 }finally{await f.close();}
});
