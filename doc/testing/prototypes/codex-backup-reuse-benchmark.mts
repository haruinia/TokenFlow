// Synthetic timing only; never reads the user's Codex home.
import {mkdtemp,mkdir,writeFile,readdir,readFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {DatabaseSync} from 'node:sqlite';
import {CodexThreadMigration} from '../../../packages/core/src/codex-thread-migration.js';
const root=await mkdtemp(join(await realpath(tmpdir()),'tf97-backup-bench-')),home=join(root,'codex');await mkdir(home);await writeFile(join(home,'config.toml'),'model="fixture"');
const db=new DatabaseSync(join(home,'state_5.sqlite'));db.exec('create table threads(id text,model_provider text,model text,rollout_path text,source text,archived integer)');
try{
 for(let i=0;i<60;i++){const path=join(home,`${i}.jsonl`);await writeFile(path,JSON.stringify({type:'fixture',content:'x'.repeat(512*1024)})+'\n');db.prepare('insert into threads values (?,?,?,?,?,?)').run(String(i),'openai','fixture',path,'vscode',0);}
 const m=new CodexThreadMigration(root,join(home,'config.toml'),async()=>[],async()=>({resume:async()=>{},setArchived:async()=>{},close:async()=>{}}));
 await m.prepare('gateway');const times=[];
 for(const old of [true,false]){
  const dirs=await readdir(join(root,'codex-thread-backups'));
  if(old)for(const id of dirs){const path=join(root,'codex-thread-backups',id,'manifest.json'),value=JSON.parse(await readFile(path,'utf8'));for(const e of value.entries)delete e.capturedFile;await writeFile(path,JSON.stringify(value));}
  const start=performance.now();await m.prepare('gateway');times.push({reuseFileIdentity:!old,ms:Math.round(performance.now()-start)});
 }
 console.log(JSON.stringify({files:60,totalMiB:30,runs:times}));
}finally{db.close();await rm(root,{recursive:true,force:true});}
