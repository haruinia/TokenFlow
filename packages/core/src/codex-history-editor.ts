import type {ReportSwitchStep} from './codex-switch-progress.js';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,join,relative,basename} from 'node:path';
import {mkdir,readdir,readFile,writeFile,rename,stat,rm,copyFile,chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import {GatewayContextError} from './gateway-context.js';
import {withCodexBackupLock,assertCodexBackupLock} from './codex-backup-lock.js';
import {safePath} from './agent-connections.js';
import {CodexHistoryBackups,type HistorySnapshot} from './codex-history-backups.js';
import {repairCodexProjectionLineages,pendingProjectionArchives,type CodexProjectionRepair} from './codex-projection-repair.js';
type Item=Record<string,any>;
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const detached=(text:string):string=>JSON.parse(JSON.stringify(text));
export const rolloutId=(path:string)=>{const match=/^rollout-.+-([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})(?:_([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}))?\.jsonl$/i.exec(basename(path));return match?.[2]??match?.[1];};
export async function codexRolloutFiles(home:string){
  const files:{path:string;mtime:number}[]=[];
  const walk=async(dir:string,depth:number)=>{
   await safePath(dir);let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
   for(const entry of entries){if(entry.isSymbolicLink())continue;const path=join(dir,entry.name);
    if(entry.isDirectory()&&depth<4)await walk(path,depth+1);
    else if(entry.isFile()&&/^rollout-.*\.jsonl$/.test(entry.name)){const info=await stat(path);files.push({path,mtime:info.mtimeMs});}
   }
  };
  await walk(join(home,'sessions'),0);await walk(join(home,'archived_sessions'),0);
  return files.sort((a,b)=>b.mtime-a.mtime);
 }

/** Shared offline transaction: snapshot, compare, replace, and repair projections.
 * Callers own content policy; this module never interprets message payloads. */
export class CodexHistoryEditor {
 private backups:string;private history:CodexHistoryBackups;
 constructor(private root:string,private configPath:string,private report:ReportSwitchStep=()=>{}){this.backups=join(root,'codex-context-backups');this.history=new CodexHistoryBackups(root);}
 async rewrite(transform:(path:string,before:string)=>Promise<string>|string,processes:()=>Promise<number[]>,extraPaths:string[]=[]){
  return withCodexBackupLock(this.root,async()=>{const staging=join(this.root,'codex-context-staging',randomUUID());
   try{return await this.commit(transform,async()=>{assertCodexBackupLock(this.root);return processes();},staging,extraPaths);}finally{await rm(staging,{recursive:true,force:true});}
  });
 }
 private async commit(transform:(path:string,before:string)=>Promise<string>|string,processes:()=>Promise<number[]>,staging:string,extraPaths:string[]){
  // Rewritten rollouts wait on disk; only their hashes stay in memory.
  const candidates:{path:string;beforeHash:string;afterHash:string;staged:string}[]=[];
  const stage=async(path:string,before:string,after:string)=>{
   await mkdir(staging,{recursive:true,mode:0o700});const staged=join(staging,`${candidates.length}.jsonl`);
   await writeFile(staged,after,{mode:0o600,flag:'wx'});candidates.push({path,beforeHash:digest(before),afterHash:digest(after),staged});
  };
  // Keep only headers and numeric boundaries for unchanged history. A large
  // Codex home can contain gigabytes of rollouts; never retain them all in RAM.
  const views=new Map<string,{header:string;originalHeader:string;row:Item;boundaries:number[];bytes:number;turns:{id:string;ordinal:number}[]}>();
  const remember=(path:string,text:string)=>{
   const lines=text.split('\n');let row:Item;try{row=JSON.parse(lines[0]!);}catch{return;}
   const boundaries:number[]=[],turns:{id:string;ordinal:number}[]=[];let bytes=0,ordinal=Number.isSafeInteger(row.ordinal)&&row.ordinal>=0?row.ordinal:0;boundaries[ordinal]=0;
   for(const line of lines){if(!line)break;let event:Item;try{event=JSON.parse(line);}catch{break;}if(event.ordinal!==ordinal)break;if(event.type==='turn_context'&&typeof event.payload?.turn_id==='string')turns.push({id:event.payload.turn_id,ordinal});bytes+=Buffer.byteLength(line)+1;boundaries[++ordinal]=bytes;}
   const header=detached(lines[0]!);
   views.set(path,{header,originalHeader:views.get(path)?.originalHeader??header,row,boundaries,bytes:Buffer.byteLength(text),turns});
  };
  const paths=new Set([...(await codexRolloutFiles(dirname(this.configPath))).map(f=>f.path),...extraPaths]);
  let checked=0;this.report('history','正在检查对话上下文',0,paths.size);
  for(const path of paths){
   this.report('history','正在检查对话上下文',++checked,paths.size);
   await safePath(path);const before=await readFile(path,'utf8');remember(path,before);
   const after=await transform(path,before);if(after===before)continue;
   await stage(path,before,after);remember(path,after);
  }
  // Codex paginated branches pin an ordinal AND a byte boundary in the
  // canonical source rollout. Rewriting JSON changes UTF-8 byte lengths even
  // when every event stays in place. Rebase dependants, including stale bounds
  // left by older TokenFlow versions, from explicit ordinals (never guess).
  const sources=new Map<string,string>(),invalidated=new Set<string>();
  for(const [path] of views){const id=rolloutId(path);if(id)sources.set(id,path);}
  const invalidate=(path:string)=>{
   const immutable=rolloutId(path),logical=views.get(path)?.row.payload?.id;
   if(immutable)invalidated.add(immutable);
   // The logical ID can also name an unchanged ancestor rollout. Its
   // independent projection is still needed to page inherited turns.
   if(typeof logical==='string'&&(!sources.has(logical)||sources.get(logical)===path))invalidated.add(logical);
  };
  let changed=true,passes=0;
  while(changed){
   if(++passes>views.size+1)throw new GatewayContextError('分页历史依赖存在循环，原记录保留。',409);
   changed=false;
   for(const view of views.values()){
    const base=view.row.type==='session_meta'?view.row.payload?.history_base:undefined;
    if(!base||!Number.isSafeInteger(base.end_ordinal_exclusive)||base.end_ordinal_exclusive<0)continue;
    const source=sources.get(base.thread_id);if(!source)continue;
    const offset=views.get(source)!.boundaries[base.end_ordinal_exclusive];
    if(offset===undefined||offset===base.end_byte_offset)continue;
    invalidate(source);base.end_byte_offset=offset;
    const header=JSON.stringify(view.row),delta=Buffer.byteLength(header)-Buffer.byteLength(view.header);
    for(let ordinal=0;ordinal<view.boundaries.length;ordinal++)if(view.boundaries[ordinal]!==undefined&&view.boundaries[ordinal]!>0)view.boundaries[ordinal]!+=delta;
    view.header=header;changed=true;
   }
  }
  for(const [path,view] of views){
   if(view.header===view.originalHeader)continue;
   const rest=(text:string)=>{const end=text.indexOf('\n');return end<0?'':text.slice(end);};
   const candidate=candidates.find(c=>c.path===path);
   if(candidate){const after=view.header+rest(await readFile(candidate.staged,'utf8'));await writeFile(candidate.staged,after,{mode:0o600});candidate.afterHash=digest(after);continue;}
   await safePath(path);const before=await readFile(path,'utf8');if(before.split('\n',1)[0]!==view.originalHeader)throw new GatewayContextError('迁移期间会话发生变化，原记录保留。',409);
   await stage(path,before,view.header+rest(before));
  }
  for(const c of candidates)invalidate(c.path);
  // Older releases may already have rewritten the durable file while leaving
  // its immutable-ID projection intact. Repair only offsets disproved by the
  // persisted file's size/ordinal boundaries; never delete durable history.
  const home=dirname(this.configPath);
  const homeFiles=await readdir(home).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;});
  const databases=homeFiles.filter(n=>/^thread_history_\d+\.sqlite$/.test(n));
  const nativeRepairs=new Map<string,CodexProjectionRepair>();
  const stateName=homeFiles.filter(n=>/^state_\d+\.sqlite$/.test(n)).sort((a,b)=>Number(b.match(/\d+/)![0])-Number(a.match(/\d+/)![0]))[0];
  const routes:{id:string;path:string}[]=[];
  if(stateName&&databases.length){
   const {DatabaseSync}=await import('node:sqlite');const path=join(home,stateName);await safePath(path);const db=new DatabaseSync(path,{readOnly:true});
   try{for(const row of db.prepare('SELECT id,rollout_path FROM threads').all())if(typeof row.id==='string'&&typeof row.rollout_path==='string')routes.push({id:row.id,path:row.rollout_path});}finally{db.close();}
  }
  for(const name of databases){
   const path=join(home,name);await safePath(path);
   const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path,{readOnly:true});
   try{
    const columns=new Set(db.prepare('PRAGMA table_info(thread_history_projection_state)').all().map(row=>row.name));
    if(!['thread_id','next_rollout_byte_offset','next_rollout_ordinal'].every(name=>columns.has(name)))continue;
    const lookup=db.prepare('SELECT next_rollout_byte_offset AS offset,next_rollout_ordinal AS ordinal FROM thread_history_projection_state WHERE thread_id=?');
    for(const [rollout,path] of sources){
     const view=views.get(path)!,logical=view.row.payload?.id;
     for(const id of new Set([rollout,...(typeof logical==='string'&&(!sources.has(logical)||sources.get(logical)===path)?[logical]:[])])){
      const row=lookup.get(id);if(!row)continue;
      const offset=Number(row.offset),ordinal=Number(row.ordinal),boundary=view.boundaries[ordinal];
      if(offset>view.bytes||Number.isSafeInteger(boundary)&&boundary!==offset)invalidate(path);
     }
    }
    for(const route of routes){
     const leaf=views.get(route.path);if(!leaf)continue;
     const ancestors:CodexProjectionRepair['ancestors']=[];let view=leaf,seen=new Set<string>();let needsRepair=false;
     while(view.row.payload?.history_base){
      const base=view.row.payload.history_base,id=base.thread_id,path=sources.get(id);
      if(typeof id!=='string'||!path||seen.has(id))break;seen.add(id);
      const source=views.get(path)!,offset=source.boundaries[base.end_ordinal_exclusive];
      if(!Number.isSafeInteger(offset)||offset!==base.end_byte_offset)break;
      const state=lookup.get(id);
      if(!state||invalidated.has(id))needsRepair=true;
      ancestors.push({id,ordinal:base.end_ordinal_exclusive,offset,boundaries:source.boundaries});view=source;
     }
     if(!needsRepair||!ancestors.length)continue;
     const immutable=rolloutId(route.path);
     const turn=immutable?db.prepare("SELECT turn_id FROM thread_turns WHERE thread_id=? AND status IN ('completed','failed','interrupted') ORDER BY rollout_ordinal DESC LIMIT 1").get(immutable):undefined;
     const lastTurnId=typeof turn?.turn_id==='string'?turn.turn_id:leaf.turns.at(-1)?.id??view.turns.find(turn=>turn.ordinal<ancestors.at(-1)!.ordinal)?.id;
     if(!lastTurnId)throw new GatewayContextError('历史祖先索引需要重建，但缺少明确的轮次边界；原记录和备份保留。',409);
     nativeRepairs.set(route.id,{threadId:route.id,lastTurnId,ancestors});
    }
   }finally{db.close();}
  }
  this.report('projection','正在核对分页历史索引');
  const pendingArchives=await pendingProjectionArchives(home);
  if(!candidates.length&&!invalidated.size&&!nativeRepairs.size&&!pendingArchives.length)return {migrated:0};
  if((await processes()).length)throw Object.assign(new Error((candidates.length?`有 ${candidates.length} 个会话需要兼容处理。`:'会话历史索引需要兼容处理。')+'请先退出 Codex，再迁移会话；原配置和会话尚未修改。'),{statusCode:409});
  const changedDuringBackup=()=>Object.assign(new Error('迁移期间会话发生变化，已停止；原始备份已保留。'),{statusCode:409});
  const batch=join(this.backups,randomUUID());await mkdir(batch,{recursive:true,mode:0o700});
  const journal=candidates.map(c=>({path:relative(dirname(this.configPath),c.path),historySnapshot:undefined as HistorySnapshot|undefined,beforeHash:c.beforeHash,afterHash:c.afterHash}));
  const databaseBackups:Record<string,string>={};const createdAt=new Date().toISOString();
  const saveJournal=()=>writeFile(join(batch,'manifest.json'),JSON.stringify({createdAt,files:journal,databaseBackups}),{mode:0o600});
  try{
   for(let i=0;i<candidates.length;i++){this.report('backup','正在保存受影响的上下文',i+1,candidates.length);const c=candidates[i]!;await safePath(c.path);const before=await readFile(c.path,'utf8');if(digest(before)!==c.beforeHash)throw changedDuringBackup();journal[i]!.historySnapshot=await this.history.capture(c.path,Buffer.from(before));}
   await saveJournal();
  }catch(error){await rm(batch,{recursive:true,force:true});throw error;}
  // This database is a derived UI projection with byte offsets into the
  // rollouts. Preserve a consistent backup, then let Codex rebuild affected
  // projections from history instead of reusing offsets into rewritten bytes.
  const databaseCandidates:string[]=[];
  for(const directory of [join(this.root,'codex-thread-backups'),this.backups])for(const id of await readdir(directory).catch(()=>[]))if(/^[a-f0-9-]{36}$/.test(id))databaseCandidates.push(join(directory,id));
  for(const name of databases){
   if(!invalidated.size&&!nativeRepairs.size)break;
   const path=join(home,name);await safePath(path);
   const {DatabaseSync,backup}=await import('node:sqlite');const db=new DatabaseSync(path);
   try{
    for(const directory of databaseCandidates){const candidate=join(directory,name);try{await safePath(candidate);if((await stat(candidate)).isFile()){databaseBackups[name]=candidate;break;}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    if(!databaseBackups[name]){databaseBackups[name]=join(batch,name);await backup(db,databaseBackups[name]);}
    await saveJournal();
    if((await processes()).length)throw new GatewayContextError('Codex 重新启动，迁移已停止。',409);
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
    db.exec('BEGIN IMMEDIATE');
    try{for(const table of ['thread_turns','thread_items','thread_history_projection_state','thread_realtime_items'])if(tables.has(table)){const remove=db.prepare(`DELETE FROM ${table} WHERE thread_id=?`);for(const id of invalidated)remove.run(id);}db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
   }finally{db.close();}
  }
  const unchanged=async(path:string,hash:string)=>digest(await readFile(path,'utf8'))===hash;
  let written=0;for(const candidate of candidates){
   this.report('history-write','正在保存兼容后的上下文',++written,candidates.length);
   await safePath(candidate.path);if(!await unchanged(candidate.path,candidate.beforeHash))throw changedDuringBackup();
   const temp=candidate.path+'.token-flow-'+randomUUID();
   try{await copyFile(candidate.staged,temp,constants.COPYFILE_EXCL);await chmod(temp,0o600);if(!await unchanged(temp,candidate.afterHash))throw changedDuringBackup();if((await processes()).length||!await unchanged(candidate.path,candidate.beforeHash))throw Object.assign(new Error('Codex 重新启动或会话发生变化，迁移已停止，备份保留。'),{statusCode:409});await rename(temp,candidate.path);}finally{await rm(temp,{force:true});}
  }
  if(nativeRepairs.size||pendingArchives.length)this.report('projection','正在重建受影响的分页索引');
  if(nativeRepairs.size||pendingArchives.length)await repairCodexProjectionLineages(home,[...nativeRepairs.values()],processes);
  return {migrated:candidates.length};
 }
}
