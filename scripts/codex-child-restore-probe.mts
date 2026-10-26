// No inference: read-only live input, with resume/archive writes in a private copy.
// Usage: node --import tsx scripts/codex-child-restore-probe.mts <child-id> [--reproduce]
import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,readdir,writeFile,mkdir,copyFile,rm,realpath,stat} from 'node:fs/promises';
import {join,basename,relative} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {constants} from 'node:fs';
import {DatabaseSync,backup} from 'node:sqlite';
import {codexRuntimeClient} from '../packages/core/src/codex-runtime';
import {CodexThreadMigration} from '../packages/core/src/codex-thread-migration';
const id=process.argv[2];if(!id)throw Error('Thread ID required');
const home=join(homedir(),'.codex'),root=await mkdtemp(join(await realpath(tmpdir()),'tf-child-restore-'));
const data=join(homedir(),'Library/Application Support/desktop-browser-agent');
let runtime:Awaited<ReturnType<typeof codexRuntimeClient>>|undefined,db:DatabaseSync|undefined;
try{
 const original=new DatabaseSync(join(home,'state_5.sqlite'),{readOnly:true});
 try{await backup(original,join(root,'state_5.sqlite'));}finally{original.close();}
 for(const file of (await readdir(home)).filter(file=>/^thread_history_\d+\.sqlite$/.test(file))){const history=new DatabaseSync(join(home,file),{readOnly:true});try{await backup(history,join(root,file));}finally{history.close();}}
 db=new DatabaseSync(join(root,'state_5.sqlite'));
 const child=db.prepare('select * from threads where id=?').get(id);assert.ok(child,'Thread missing');
 const parent=JSON.parse(String(child.source))?.subagent?.thread_spawn?.parent_thread_id;assert.ok(parent);
 const rows=db.prepare('select id,rollout_path,model_provider,model,source,archived from threads').all();
 const isChild=(row:any)=>{try{return !!JSON.parse(String(row.source))?.subagent;}catch{return false;}};
 const children=rows.filter(isChild);
 const copies=new Map<string,string>();
 for(const directory of ['sessions','archived_sessions']){try{await cp(join(home,directory),join(root,directory),{recursive:true,mode:constants.COPYFILE_FICLONE});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 for(const row of rows){const rel=relative(home,String(row.rollout_path));assert.ok(!rel.startsWith('..'),'Rollout outside CODEX_HOME');const destination=join(root,rel);copies.set(String(row.id),destination);db.prepare('update threads set rollout_path=? where id=?').run(destination,row.id);}
 const official='model="gpt-6.1-sol"\nmodel_provider="openai"\n';
 const gateway='[model_providers.token_flow]\nname="Fixture"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\n';
 await writeFile(join(root,'config.toml'),official+gateway);
 if(process.argv.includes('--reproduce')){
  runtime=await codexRuntimeClient(root);
  await runtime.rpc('thread/resume',{threadId:parent,modelProvider:'openai',model:'gpt-6.1-sol'});
  const result=await runtime.rpc('thread/resume',{threadId:id,modelProvider:'openai',model:'gpt-6.1-sol'});
  console.log(JSON.stringify({requestedProvider:'openai',returnedProvider:result.thread?.modelProvider,returnedModel:result.model}));
  assert.equal(result.thread?.modelProvider,'openai','Codex 未确认新来源，迁移已停止，备份保留。');
 }else{
  // Replay only unfinished entries, retaining their original journal metadata.
  for(const directory of await readdir(join(data,'codex-thread-backups'))){let journal:any;try{journal=JSON.parse(await readFile(join(data,'codex-thread-backups',directory,'manifest.json'),'utf8'));}catch{continue;}
   journal.entries=journal.entries.filter((entry:any)=>['pending','migrated'].includes(entry.state)).map((entry:any)=>({...entry,rollout:copies.get(entry.id),historyBackup:undefined,historySnapshots:undefined}));
   if(!journal.entries.length)continue;const dest=join(root,'codex-thread-backups',directory);await mkdir(dest,{recursive:true});await writeFile(join(dest,'manifest.json'),JSON.stringify(journal));
  }
  const migration=new CodexThreadMigration(root,join(root,'config.toml'),async()=>[]);
  const result=await migration.restore('gpt-6.1-sol');
  for(const row of children)assert.deepEqual({...db.prepare('select model_provider,model,source,archived from threads where id=?').get(row.id)},{model_provider:row.model_provider,model:row.model,source:row.source,archived:row.archived});
  const check=await migration.inspect({provider:'openai'});
  // Existing records with missing rollouts stay unavailable, never reconstructed from old backups.
  for(const sample of check.samples)await assert.rejects(stat(copies.get(sample.id)!),{code:'ENOENT'});
  assert.equal(check.mismatched,(await migration.status()).unavailable??0);
  assert.equal((await migration.status()).restorable,0);
  // Restore config and verify that the owner can reopen without a gateway provider.
  await writeFile(join(root,'config.toml'),official);runtime=await codexRuntimeClient(root);
  const owner=await runtime.rpc('thread/resume',{threadId:parent,modelProvider:'openai',model:'gpt-6.1-sol'});assert.equal(owner.thread?.modelProvider,'openai');
  console.log(JSON.stringify({passed:true,migrated:result.migrated,childrenPreserved:children.length,unavailable:check.mismatched,parentOfficialWithoutGateway:true,inferenceRequests:0}));
 }
}finally{await runtime?.close();db?.close();await rm(root,{recursive:true,force:true});}
