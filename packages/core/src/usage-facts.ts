import {DatabaseSync} from 'node:sqlite';
import {chmod,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {compatibilityIncrements} from './usage-compatibility.js';
import type {UsageEvent,UsageRow} from './usage-ledger.js';
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),hash=z.string().regex(/^[a-f0-9]{64}$/);
const eventSchema=z.object({
 eventId:z.string().min(1).max(128),responseHash:hash.optional(),billingAccountHash:hash.optional(),threadHash:hash.optional(),parentThreadHash:hash.optional(),
 taskKind:z.enum(['main','subagent','compaction','unknown']).optional(),
 target:z.string().max(80),keyId:z.string().max(80),keyName:z.string().max(160),sourceId:z.string().max(160),model:z.string().max(300),
 startedAt:z.string().datetime(),durationMs:count,status:z.number().int(),
 inputTokens:count.nullable(),outputTokens:count.nullable(),cachedTokens:count.nullable(),cacheWriteTokens:count.nullable().optional(),reasoningTokens:count.nullable().optional(),reportedTotalTokens:count.nullable().optional(),
 toolCalls:count.optional(),toolResults:count.optional(),generationMs:count.optional(),timedOutputTokens:count.optional(),
 outcome:z.enum(['completed','failed','cancelled','truncated']).optional(),measurementSource:z.enum(['gateway','native-reconciled']).optional(),
});
export type UsageFact=z.infer<typeof eventSchema>;
/** A private, prompt-free journal. JSON day totals remain a compatibility export only. */
export class UsageFacts{
 private records=new Map<string,UsageFact>();
 private responses=new Map<string,Set<string>>();
 private pending=new Map<string,UsageFact>();
 private legacyRows:UsageRow[]=[];
 private prunedDay='';
 warning='';
 private constructor(private db?:DatabaseSync){}
 get available(){return !!this.db;}
 private remember(fact:UsageFact){
  this.records.set(fact.eventId,fact);
  if(fact.responseHash){const ids=this.responses.get(fact.responseHash)??new Set<string>();ids.add(fact.eventId);this.responses.set(fact.responseHash,ids);}
 }
 static async open(root:string,legacy:UsageRow[]){
  const path=join(root,'usage-facts.sqlite');let db:DatabaseSync|undefined;
  try{
   await mkdir(root,{recursive:true});db=new DatabaseSync(path);
   await chmod(path,0o600);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;');
   db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS legacy(id INTEGER PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS facts(id TEXT PRIMARY KEY,response_hash TEXT,started_at TEXT NOT NULL,payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS facts_response ON facts(response_hash); CREATE INDEX IF NOT EXISTS facts_time ON facts(started_at);');
   db.exec('BEGIN IMMEDIATE');
   try{if(!db.prepare("SELECT 1 FROM meta WHERE key='legacy-imported'").get()){
    const insert=db.prepare('INSERT INTO legacy(payload) VALUES(?)');for(const row of legacy)insert.run(JSON.stringify(row));
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('legacy-imported',new Date().toISOString());
    db.prepare("INSERT INTO meta(key,value) VALUES('compat-export',?)").run(JSON.stringify({confirmed:true,rows:legacy}));
   }db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
   const facts=new UsageFacts(db);
   facts.legacyRows=db.prepare('SELECT payload FROM legacy').all().map(r=>JSON.parse(String(r.payload)));
   for(const row of db.prepare('SELECT payload FROM facts').all()){const fact=eventSchema.parse(JSON.parse(String(row.payload)));facts.remember(fact);}
   return facts;
  }catch{db?.close();const facts=new UsageFacts();facts.legacyRows=legacy;facts.warning='用量明细库无法打开；原文件已保留。当前显示上次汇总与本次内存记录，新记录尚未持久保存。请检查磁盘后重启应用。';return facts;}
 }
 reconcileLegacy(rows:UsageRow[],producer?:string){
  if(!this.db||producer==='tokenflow-facts-v1')return;
  const saved=this.db.prepare("SELECT value FROM meta WHERE key='compat-export'").get();if(!saved)throw Error('Missing legacy export baseline');
  const baseline=JSON.parse(String(saved.value)) as {confirmed:boolean;rows:UsageRow[]};
  if(!baseline.confirmed)throw Error('Previous export was interrupted');
  const increments=compatibilityIncrements(baseline.rows,rows);
  this.db.exec('BEGIN IMMEDIATE');
  try{const insert=this.db.prepare('INSERT INTO legacy(payload) VALUES(?)');for(const row of increments)insert.run(JSON.stringify(row));
   this.db.prepare("UPDATE meta SET value=? WHERE key='compat-export'").run(JSON.stringify({confirmed:true,rows}));this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
  this.legacyRows.push(...increments);
 }
 exportCheckpoint(rows:UsageRow[],confirmed:boolean){
  if(!this.db||this.pending.size)throw Error('Usage facts not durable');
  this.db.prepare("INSERT INTO meta(key,value) VALUES('compat-export',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({confirmed,rows}));
 }
 legacy():UsageRow[]{return this.legacyRows;}
 list():UsageFact[]{return [...this.records.values()].sort((a,b)=>a.startedAt.localeCompare(b.startedAt)||a.eventId.localeCompare(b.eventId));}
 byResponse(hash:string):UsageFact[]{return [...(this.responses.get(hash)??[])].map(id=>this.records.get(id)!);}
 put(value:UsageEvent):{previous?:UsageFact;current:UsageFact}{
  const current=eventSchema.parse({...value,eventId:value.eventId??randomUUID()});
  const previous=this.records.get(current.eventId);
  if(previous){
   // Repeated observations cannot move a billed request to a different identity.
   for(const key of ['startedAt','keyId','sourceId','model','target'] as const)if(current[key]!==previous[key])throw Error('Usage request identity changed');
   for(const key of ['responseHash','billingAccountHash','threadHash','parentThreadHash'] as const){
    if(current[key]&&previous[key]&&current[key]!==previous[key])throw Error('Usage request identity changed');
    current[key]??=previous[key];
   }
   if(!current.taskKind||current.taskKind==='unknown')current.taskKind=previous.taskKind;
   current.outcome??=previous.outcome;current.measurementSource??=previous.measurementSource;
   for(const key of ['inputTokens','outputTokens','cachedTokens','cacheWriteTokens','reasoningTokens','reportedTotalTokens'] as const)if(current[key]==null&&previous[key]!=null)current[key]=previous[key];
  }
  this.remember(current);this.pending.set(current.eventId,current);this.flush();
  return {previous,current};
 }
 /** Storage failure never escapes into an inference stream; retry the same identities. */
 flush(){
  if(!this.pending.size||!this.db)return;
  try{
   this.db!.exec('BEGIN IMMEDIATE');
   try{const put=this.db!.prepare('INSERT INTO facts(id,response_hash,started_at,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET response_hash=excluded.response_hash,payload=excluded.payload');
    for(const current of this.pending.values())put.run(current.eventId,current.responseHash??null,current.startedAt,JSON.stringify(current));
    this.db!.exec('COMMIT');
   }catch(error){this.db!.exec('ROLLBACK');throw error;}
   this.pending.clear();this.warning='';
  }catch{this.warning=`${this.pending.size} 条用量明细尚未写入磁盘，当前仅保存在内存中；请检查磁盘空间和资料目录权限。`;}
 }
 /** Match the existing calendar-day retention, including its local timezone boundary. */
 prune(day:string){
  if(!this.db||this.pending.size||this.prunedDay===day)return;
  const timestamp=new Date(`${day}T00:00:00`).toISOString();
  try{
   this.db.exec('BEGIN IMMEDIATE');
   try{this.db.prepare('DELETE FROM facts WHERE started_at < ?').run(timestamp);this.db.prepare("DELETE FROM legacy WHERE json_extract(payload,'$.day') < ?").run(day);this.db.exec('COMMIT');}
   catch(error){this.db.exec('ROLLBACK');throw error;}
   this.legacyRows=this.legacyRows.filter(row=>row.day>=day);
   for(const [id,fact] of this.records)if(fact.startedAt<timestamp){this.records.delete(id);if(fact.responseHash){const ids=this.responses.get(fact.responseHash);ids?.delete(id);if(!ids?.size)this.responses.delete(fact.responseHash);}}
   this.prunedDay=day;
  }catch{/* Retain data and retry next time; pruning cannot affect inference. */}
 }
 close(){this.flush();this.db?.close();}
}
