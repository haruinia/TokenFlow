import {codexRuntimeClient,migrationBinary} from './codex-runtime.js';
import {mkdir, readdir, readFile, writeFile, rename, copyFile, chmod, stat, rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {RunnerCoreError} from './errors.js';
import {safePath} from './agent-connections.js';
import {CodexHistoryBackups,type HistorySnapshot} from './codex-history-backups.js';

const active=(entry:Entry)=>entry.state!=='restored'&&entry.state!=='deleted'&&entry.state!=='unavailable'&&entry.state!=='parent_managed';
/** Native children are reloaded by their owner; thread/resume ignores provider overrides. */
const parentManaged=(row:Pick<Route,'source'>)=>{try{const source=JSON.parse(row.source);return !!source&&typeof source==='object'&&'subagent' in source;}catch{return false;}};
const fail=(message:string,code='codex_migration_failed')=>new RunnerCoreError(message,{statusCode:409,code});
type Route={id:string;provider:string;model:string;rollout:string;archived:boolean;source:string};
type HistoryBackup={journalId:string;file:string};
type Entry=Route&{bootstrapHistory?:string;historyBackup?:HistoryBackup;historySnapshots?:{snapshot:HistorySnapshot;provider:string;model:string;recordedAt:string}[];observedRoute?:{provider:string;model:string};nextModel:string;returnModel?:string;rearchive?:boolean;state:'pending'|'migrated'|'restored'|'deleted'|'unavailable'|'parent_managed'};
type Journal={version:1;id:string;createdAt:string;databaseBackup?:string;state:'prepared'|'migrated'|'restored';entries:Entry[]};
export type MigrationStatus={lifecyclePhase?:'idle'|'stopping'|'changing'|'opening';backups:number;remaining:number;restorable:number;unavailable?:number;phase:'idle'|'backup'|'migrating'|'restoring';done:number;total:number};
export interface MigrationClient {pid?:number;resume(id:string,provider:string,model:string):Promise<void>;setArchived(id:string,archived:boolean):Promise<void>;close():Promise<void>}

/** Resume routing only. Switching never starts a turn, tool, or compaction. */
export async function codexMigrationClient(home:string,binary?:string):Promise<MigrationClient>{
 const client=await codexRuntimeClient(home,binary);
 return {pid:client.pid,close:client.close,setArchived:async(id,archived)=>{await client.rpc(archived?'thread/archive':'thread/unarchive',{threadId:id});},resume:async(id,provider,model)=>{
  const result=await client.rpc('thread/resume',{threadId:id,modelProvider:provider,model});
  if(result.thread?.id!==id||result.thread?.modelProvider!==provider)throw fail('Codex 未确认新来源，迁移已停止，备份保留。');
  await client.rpc('thread/unsubscribe',{threadId:id}).catch(()=>{});
 }};
}

export class CodexThreadMigration {
 private home:string;private directory:string;private history:CodexHistoryBackups;
 private bootstrapRevisions?:Map<string,{revision:string;recordedAt:number}>;
 private progress:Pick<MigrationStatus,'phase'|'done'|'total'>={phase:'idle',done:0,total:0};
 constructor(root:string,configPath:string,private processes:()=>Promise<number[]>,private clientFactory:(home:string)=>Promise<MigrationClient>=codexMigrationClient){this.home=dirname(configPath);this.directory=join(root,'codex-thread-backups');this.history=new CodexHistoryBackups(root);}
 private async database(){
  await safePath(this.home);let files:string[];try{files=await readdir(this.home);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  const name=files.filter(name=>/^state_\d+\.sqlite$/.test(name)).sort((a,b)=>Number(b.match(/\d+/)![0])-Number(a.match(/\d+/)![0]))[0];
  if(name){const path=join(this.home,name);await safePath(path);return path;}
 }
 private async rows():Promise<Route[]>{
  const path=await this.database();if(!path)return [];
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path,{readOnly:true});
  try{return db.prepare("SELECT id,model_provider AS provider,model,rollout_path AS rollout,archived,source FROM threads").all().map(row=>({id:String(row.id),provider:String(row.provider),model:String(row.model??''),rollout:String(row.rollout??''),archived:!!row.archived,source:String(row.source)}));}finally{db.close();}
 }
 private async journals():Promise<Journal[]>{
  await safePath(this.directory);let files:string[];try{files=await readdir(this.directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  const result:Journal[]=[];for(const id of files.filter(id=>/^[a-f0-9-]{36}$/.test(id))){const path=join(this.directory,id,'manifest.json');await safePath(path);try{const value=JSON.parse(await readFile(path,'utf8'));if(value.version!==1||value.id!==id||!Array.isArray(value.entries))throw fail('旧对话备份索引损坏，请保留备份后联系维修。');result.push(value);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  return result.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
 }
 private async save(journal:Journal){const path=join(this.directory,journal.id,'manifest.json');await safePath(path);const temp=path+'.tmp';await writeFile(temp,JSON.stringify(journal),{mode:0o600});await rename(temp,path);this.bootstrapRevisions=undefined;}
 /** The switch backup identifies a particular thread/branch history revision.
  * Read metadata once; normal inference never scans rollouts or starts a model. */
 async bootstrapHistory(threadId:string|undefined){
  if(!threadId)return;
  if(!this.bootstrapRevisions){
   const revisions=new Map<string,{revision:string;recordedAt:number}>(),seen=new Set<string>();
   try{for(const journal of (await this.journals()).reverse())for(const entry of journal.entries){
    if(seen.has(entry.id))continue;seen.add(entry.id);
    if(!active(entry))continue;
    const saved=entry.historySnapshots?.filter(saved=>saved.provider==='openai').at(-1);
    const revision=entry.bootstrapHistory??saved?.snapshot.revision;
    if(revision)revisions.set(entry.id,{revision,recordedAt:Date.parse(saved?.recordedAt??journal.createdAt)});
   }}catch{return; /* Missing migration evidence leaves compaction to Codex. */}
   this.bootstrapRevisions=revisions;
  }
  return this.bootstrapRevisions.get(threadId);
 }
 private async hasHistory(row:Route){
  if(!row.rollout)return false;
  if(!isAbsolute(row.rollout))throw fail('旧对话记录路径异常，未迁移。');
  await safePath(row.rollout);
  try{if(!(await stat(row.rollout)).isFile())throw fail('旧对话记录不是文件，未迁移。');return true;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
 }
 private async backupFile(path:string){
  await safePath(path);
  try{return (await stat(path)).isFile();}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
 }
 /** Reuse the first recovery baseline; live history is never replaced by it on a switch. */
 private async historyBackup(row:Route,journals:Journal[]):Promise<HistoryBackup|undefined>{
  for(const journal of journals)for(const [index,entry] of journal.entries.entries()){
   if(entry.id!==row.id||entry.source!==row.source||entry.state==='deleted')continue;
   const saved=entry.historyBackup??{journalId:journal.id,file:`${index}.jsonl`};
   if(!/^[a-f0-9-]{36}$/.test(saved.journalId)||!/^\d+\.jsonl$/.test(saved.file))continue;
   if(await this.backupFile(join(this.directory,saved.journalId,saved.file)))return saved;
  }
 }
 private async captureHistory(row:Route,entry:Entry,journal:Journal,index:number){
  if(!await this.hasHistory(row))return false;
  const baseline=entry.historyBackup??{journalId:journal.id,file:`${index}.jsonl`};
  const file=join(this.directory,baseline.journalId,baseline.file);
  const snapshot=await this.history.capture(row.rollout,await readFile(row.rollout),await this.backupFile(file)?file:undefined);
  if(row.provider==='openai')entry.bootstrapHistory=snapshot.revision;
  const versions=entry.historySnapshots??=[];const latest=versions.at(-1);
  if(latest?.snapshot.revision===snapshot.revision&&latest.provider===row.provider&&latest.model===row.model)return false;
  versions.push({snapshot,provider:row.provider,model:row.model,recordedAt:new Date().toISOString()});return true;
 }
 private async captureKnown(journals:Journal[],rows:Route[]){
  const seen=new Set<string>(),current=new Map(rows.map(row=>[row.id,row]));
  for(const journal of [...journals].reverse()){
   let changed=false;
   for(const [index,entry] of journal.entries.entries()){
    if(seen.has(entry.id)||entry.state==='deleted')continue;seen.add(entry.id);
    const row=current.get(entry.id);if(row&&row.source===entry.source)changed=await this.captureHistory(row,entry,journal,index)||changed;
   }
   if(changed)await this.save(journal);
  }
 }
 // Retain missing records, without replaying deleted history from an old backup.
 // If the live history becomes available later, retry its original journal.
 private async recoverAvailable(){
  const journals=await this.journals(),rows=new Map((await this.rows()).map(row=>[row.id,row]));
  for(const journal of journals){let changed=false;for(const entry of journal.entries){
   const row=rows.get(entry.id);
   if(entry.state==='unavailable'&&row&&await this.hasHistory(row)){await this.idle();entry.state='pending';changed=true;}
  }if(changed){journal.state='prepared';await this.save(journal);}}
 }
 private async idle(ownPid?:number){if((await this.processes()).some(pid=>pid!==ownPid))throw fail('请先保存工作并完全退出 Codex，再继续迁移旧对话。备份和现有记录会保留。','codex_exit_required');}
 async status():Promise<MigrationStatus>{const journals=await this.journals();return {...this.progress,backups:journals.length,remaining:journals.flatMap(j=>j.entries).filter(e=>e.state==='pending').length,restorable:journals.flatMap(j=>j.entries).filter(active).length,unavailable:journals.flatMap(j=>j.entries).filter(e=>e.state==='unavailable').length};}
 /** Read routing metadata only: never send conversation contents or rollout paths to a model. */
 async inspect(expected:{provider:string;model?:string;allowedModels?:string[]}){
  const available=!!await this.database(),rows=await this.rows(),journals=await this.journals();
  const groups=new Map<string,{provider:string;model:string;archived:boolean;count:number}>();
  for(const row of rows){const key=JSON.stringify([row.provider,row.model,row.archived]);const group=groups.get(key)??{provider:row.provider,model:row.model,archived:row.archived,count:0};group.count++;groups.set(key,group);}
  const relevant=rows.filter(row=>!parentManaged(row)&&(row.provider==='token_flow'||!row.archived&&['cli','vscode'].includes(row.source)&&!!row.model&&row.provider==='openai'));
  const mismatched=relevant.filter(row=>row.provider!==expected.provider||expected.provider==='token_flow'&&!(expected.allowedModels??[expected.model]).includes(row.model));
  const fingerprint=createHash('sha256').update(JSON.stringify({rows:rows.map(({rollout:_,...row})=>row).sort((a,b)=>a.id.localeCompare(b.id)),journals})).digest('hex');
  return {available,expected,total:rows.length,active:rows.filter(row=>!row.archived).length,archived:rows.filter(row=>row.archived).length,groups:[...groups.values()].slice(0,80),groupCount:groups.size,
   mismatched:mismatched.length,samples:mismatched.slice(0,20).map(({id,provider,model,archived})=>({id,provider,model,archived})),fingerprint,
   migrations:journals.slice(-12).reverse().map(j=>({id:j.id,createdAt:j.createdAt,state:j.state,total:j.entries.length,states:Object.fromEntries([...new Set(j.entries.map(e=>e.state))].map(state=>[state,j.entries.filter(e=>e.state===state).length]))})),
   note:'只读路由元数据。官方账号按请求认证，旧对话来源字段不能证明计费账号；官方旧对话保留不同模型不一定异常。未发起模型请求，未验证实际回复。'};
 }
 /** Complete a consistent local backup before the caller writes gateway config. */
 async prepare(model:string,allowedModels:string[]=[model]){
  await this.recoverAvailable();
  const journals=await this.journals(),owned=new Set(journals.flatMap(j=>j.entries.filter(e=>active(e)||e.state==='unavailable').map(e=>e.id)));
  const current=await this.rows();
  const rows=current.filter(row=>(row.provider==='openai'&&!row.archived&&['vscode','cli'].includes(row.source)||row.provider==='token_flow')&&!!row.model&&!parentManaged(row)&&!owned.has(row.id));
  if(!rows.length&&!journals.some(j=>j.entries.some(active)))return;
  await this.idle();
  await this.captureKnown(journals,current);
  for(const journal of journals){
   let changed=false;
   for(const entry of journal.entries){const row=current.find(row=>row.id===entry.id);if(active(entry)&&row?.provider==='token_flow'&&!allowedModels.includes(row.model)){entry.state='pending';entry.nextModel=model;changed=true;}}
   if(changed){journal.state='prepared';await this.save(journal);}
  }
  if(rows.length)await this.backup(rows,model,false,allowedModels);
 }
 /** Also retain conversations created while the gateway was active. */
 async prepareOfficial(model:string){
  const journals=await this.journals(),current=await this.rows();
  const owned=new Set(journals.flatMap(j=>j.entries.filter(e=>active(e)||e.state==='unavailable').map(e=>e.id)));
  const rows=current.filter(row=>row.provider==='token_flow'&&!!row.model&&!parentManaged(row)&&!owned.has(row.id));
  if(journals.some(j=>j.entries.some(active))){await this.idle();await this.captureKnown(journals,current);}
  if(!rows.length)return;
  if(!model||model.includes('/'))throw fail('请先选择一个官方 Codex 模型，再还原这些对话。');
  await this.idle();await this.backup(rows,model,true);
 }
 private async backup(rows:Route[],model:string,official:boolean,allowedModels:string[]=[model]){
  // Check runtime availability before creating a backup or changing configuration.
  if(this.clientFactory===codexMigrationClient)await migrationBinary();
  // Empty drafts have no saved model or completed turn; leave them untouched.
  this.progress={phase:'backup',done:0,total:rows.length};
  const journal:Journal={version:1,id:randomUUID(),createdAt:new Date().toISOString(),state:'prepared',entries:rows.map(row=>({...row,observedRoute:{provider:row.provider,model:row.model},provider:official?'openai':row.provider,model:official?model:row.model,nextModel:official||allowedModels.includes(row.model)?row.model:model,state:official?'migrated':'pending'}))};
  const directory=join(this.directory,journal.id);await mkdir(directory,{recursive:true,mode:0o700});
  try{
   const {DatabaseSync,backup}=await import('node:sqlite');
   const files=(await readdir(this.home)).filter(name=>/^(?:state|thread_history)_\d+\.sqlite$/.test(name));
   // Completed switches keep their immutable recovery baseline too. Each new
   // manifest records this cycle's routes, without duplicating earlier history.
   const previous=await this.journals();let reuse=false;
   for(const baseline of previous){
    const baselineId=baseline.databaseBackup??baseline.id;if(!/^[a-f0-9-]{36}$/.test(baselineId))continue;
    const exists=await Promise.all(files.map(name=>this.backupFile(join(this.directory,baselineId,name))));
    if(exists.every(Boolean)){journal.databaseBackup=baselineId;reuse=true;break;}
   }
   for(const name of reuse?[]:files){await this.idle();const path=join(this.home,name);await safePath(path);const db=new DatabaseSync(path,{readOnly:true});try{await backup(db,join(directory,name));await chmod(join(directory,name),0o600);}finally{db.close();}}
   const config=join(this.home,'config.toml');await safePath(config);try{await copyFile(config,join(directory,'config.toml'));await chmod(join(directory,'config.toml'),0o600);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   for(let i=0;i<rows.length;i++){
    const row=rows[i]!;
    // Reusing recovery data must not bypass validation before config changes.
    await this.hasHistory(row);
    const saved=await this.historyBackup(row,previous);
    if(saved)journal.entries[i]!.historyBackup=saved;
    else if(row.rollout){if(!isAbsolute(row.rollout))throw fail('旧对话记录路径异常，未迁移。');await safePath(row.rollout);try{await copyFile(row.rollout,join(directory,`${i}.jsonl`),constants.COPYFILE_FICLONE);await chmod(join(directory,`${i}.jsonl`),0o600);}catch(error){const code=(error as NodeJS.ErrnoException).code;if(code!=='ENOENT')throw fail(`旧对话记录无法备份${code?`（${code}）`:''}，登录配置未修改。`);}}
    await this.captureHistory(row,journal.entries[i]!,journal,i);
    this.progress.done=i+1;
   }
   await this.idle();await this.save(journal);
  }catch(error){
   // No live history or configuration has changed before this manifest exists.
   if(!await this.backupFile(join(directory,'manifest.json')))await rm(directory,{recursive:true,force:true});
   throw error;
  }finally{this.progress={phase:'idle',done:0,total:0};}
 }
 async migrate(model:string,allowedModels:string[]=[model]){return this.execute(false,model,allowedModels);}
 async restore(model?:string|(()=>Promise<string|undefined>)){
  await this.recoverAvailable();
  const journals=await this.journals(),entries=journals.flatMap(j=>j.entries.filter(active)),rows=await this.rows();
  const unavailable=new Set(journals.flatMap(j=>j.entries.filter(e=>e.state==='unavailable').map(e=>e.id)));
  const hasThreads=rows.some(row=>!parentManaged(row)&&!unavailable.has(row.id)&&(entries.some(entry=>entry.id===row.id)||row.provider==='token_flow'&&!!row.model));
  if(!entries.length&&!hasThreads)return {migrated:0};
  const selected=hasThreads?(typeof model==='function'?await model():model):undefined;
  await this.prepareOfficial(selected??'');return this.execute(true,selected);
 }
 private async execute(restore:boolean,model?:string,allowedModels:string[]=[]){
  const journals=await this.journals(),entries=journals.flatMap(j=>j.entries.filter(active));
  if(!entries.length)return {migrated:0};
  if(!restore){
   const rows=new Map((await this.rows()).map(row=>[row.id,row]));
   if(entries.every(entry=>{const row=rows.get(entry.id);return !parentManaged(entry)&&entry.state==='migrated'&&!entry.rearchive&&row?.provider==='token_flow'&&row.source===entry.source&&allowedModels.includes(row.model);}))return {migrated:0};
  }
  await this.idle();
  if(!await this.database())throw fail('找不到旧对话数据库，备份已保留，请检查 Codex 数据目录后重试。');
  this.progress={phase:restore?'restoring':'migrating',done:0,total:entries.length};let client:MigrationClient|undefined;
  try{
   const getClient=async()=>client??=await this.clientFactory(this.home);
   for(const journal of journals){for(const entry of journal.entries){if(!entries.includes(entry))continue;await this.idle(client?.pid);
    let row=(await this.rows()).find(row=>row.id===entry.id);
    if(row&&row.source!==entry.source)throw fail('旧对话来源已被其他程序修改，未覆盖；请检查后重试。');
    if(row&&!await this.hasHistory(row)){entry.state='unavailable';await this.save(journal);continue;}
    // Finish an interrupted archive round-trip before deciding whether routing is done.
    if(row&&entry.rearchive){if(!row.archived)await (await getClient()).setArchived(entry.id,true);entry.rearchive=false;await this.save(journal);row=(await this.rows()).find(row=>row.id===entry.id);}
    if(!row){entry.state='deleted';await this.save(journal);continue;}
    if(row.source!==entry.source)throw fail('旧对话来源已被其他程序修改，未覆盖；请检查后重试。');
    if(parentManaged(row)){entry.state='parent_managed';await this.save(journal);this.progress.done++;continue;}
    if(!restore&&row.provider==='token_flow'&&allowedModels.includes(row.model)){entry.state='migrated';entry.nextModel=row.model;await this.save(journal);continue;}
    if(restore&&model){entry.returnModel=model;await this.save(journal);}
    const restoredModel=entry.returnModel??(entry.provider==='token_flow'?'':entry.model),restoredProvider=entry.provider==='token_flow'?'openai':entry.provider;
    if(restore&&!restoredModel)throw fail('请先选择一个官方 Codex 模型，再还原这些对话。');
    if(restore&&row.provider===restoredProvider&&row.model===restoredModel){entry.state='restored';await this.save(journal);continue;}
    if(!(restore&&row.provider===restoredProvider)&&row.provider!==(restore?'token_flow':entry.provider)&&row.provider!=='token_flow')throw fail('旧对话来源已被其他程序修改，未覆盖；请检查后重试。');
    if(!restore){entry.nextModel=allowedModels.includes(row.model)?row.model:model!;await this.save(journal);}
    // Codex refuses to resume archived threads. Keep the archive intent durable
    // so a crash between unarchive and archive is recoverable on the next attempt.
    const runtime=await getClient();await this.idle(runtime.pid);
    if(row.archived){entry.rearchive=true;await this.save(journal);}
    try{
     if(row.archived)await runtime.setArchived(entry.id,false);
     await runtime.resume(entry.id,restore?restoredProvider:'token_flow',restore?restoredModel:entry.nextModel);
    }finally{
     if(entry.rearchive){await runtime.setArchived(entry.id,true);entry.rearchive=false;await this.save(journal);}
    }
    const persisted=(await this.rows()).find(row=>row.id===entry.id);
    if(persisted?.provider!==(restore?restoredProvider:'token_flow')||persisted?.model!==(restore?restoredModel:entry.nextModel)||persisted?.archived!==row.archived)throw fail('旧对话来源未持久保存，迁移已停止，备份保留。');
    await this.captureHistory(persisted,entry,journal,journal.entries.indexOf(entry));
    entry.state=restore?'restored':'migrated';await this.save(journal);this.progress.done++;
   }journal.state=journal.entries.every(e=>!active(e))?'restored':journal.entries.every(e=>!active(e)||e.state==='migrated')?'migrated':'prepared';await this.save(journal);}
   return {migrated:this.progress.done};
  }finally{await client?.close();this.progress={phase:'idle',done:0,total:0};}
 }
}
