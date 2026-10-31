import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {accountTokens,type TokenMeasurement} from './usage-accounting.js';
import {compatibilityRows} from './usage-compatibility.js';
import {UsageFacts,type UsageFact} from './usage-facts.js';

/**
 * Persistent token statistics, one row per day / Agent / Key / source / model.
 * Only counters are stored: never prompts, completions or credentials.
 *
 * `inputTokens` includes cache reads/writes. Total = input + output + unclassified;
 * cache and reasoning subsets are never added twice. `cacheBaseTokens` is the input of the calls whose upstream
 * reported cache usage at all, which keeps the hit rate honest for providers that never report it.
 */
const count = z.number().int().nonnegative();
const rowSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  target: z.string().max(80),
  keyId: z.string().max(80),
  keyName: z.string().max(160),
  sourceId: z.string().max(80),
  model: z.string().max(300),
  requests: count, failed: count, unmeasured: count,
  credits:z.number().finite().nonnegative().optional(),
  inputTokens: count, cachedTokens: count, cacheBaseTokens: count, outputTokens: count,
  durationMs: count,cacheWriteTokens:count.optional(),reasoningTokens:count.optional(),toolCalls:count.optional(),toolResults:count.optional(),generationMs:count.optional(),timedOutputTokens:count.optional(),
  last: z.string(),
  unclassifiedTokens:count.optional(),completeRequests:count.optional(),partialRequests:count.optional(),unknownRequests:count.optional(),conflictRequests:count.optional(),legacyRequests:count.optional(),cancelledRequests:count.optional(),truncatedRequests:count.optional(),
  billingAccountHash:z.string().optional(),taskKind:z.enum(["main","subagent","compaction","unknown"]).optional(),
});
export type UsageRow = z.infer<typeof rowSchema>;
const fileSchema = z.object({ producer:z.string().optional(),version: z.literal(1), rows: z.array(rowSchema) });

export type UsageEvent = TokenMeasurement & {
  eventId?:string;responseHash?:string;billingAccountHash?:string;threadHash?:string;parentThreadHash?:string;taskKind?:"main"|"subagent"|"compaction"|"unknown";outcome?:"completed"|"failed"|"cancelled"|"truncated";measurementSource?:"gateway"|"native-reconciled";
  target: string; keyId: string; keyName: string; sourceId: string; model: string;
  startedAt: string; durationMs: number; status: number;
  inputTokens: number | null; cachedTokens: number | null; outputTokens: number | null;cacheWriteTokens?:number|null;reasoningTokens?:number|null;toolCalls?:number;toolResults?:number;generationMs?:number;timedOutputTokens?:number;
};

const MAX_ROWS = 20000;
const pad = (value: number) => String(value).padStart(2, '0');
/** Local calendar day, so "today" matches what the user sees on their clock. */
export const dayOf = (value: string | number | Date) => {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const daysAgo = (days: number, now: number) => { const date = new Date(now); date.setDate(date.getDate() - days); return dayOf(date); };
const clamp = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)));

export class UsageLedger {
  private rows = new Map<string, UsageRow>();
  private facts!:UsageFacts;private closed=false;
  private timer?: NodeJS.Timeout;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  /** Set when the file could not be read or saved; counters in memory stay correct. */
  private fileWarning='';private reconciliationWarning='';private exportBlocked=false;
  get warning(){return this.facts?.warning||this.reconciliationWarning||this.fileWarning;}
  private constructor(private path: string, private retentionDays: number, private flushDelay: number) {}

  static async open(root: string, options: { retentionDays?: number; flushDelay?: number } = {}) {
    const ledger = new UsageLedger(join(root, 'usage-ledger.json'), options.retentionDays ?? 180, options.flushDelay ?? 1500);
    let producer:string|undefined,hasSummary=false;
    try {
      const parsed = fileSchema.parse(JSON.parse(await readFile(ledger.path, 'utf8')));
      producer=parsed.producer;hasSummary=true;
      for (const row of parsed.rows) ledger.rows.set(ledger.keyOf(row), row);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Keep the unreadable file for inspection instead of silently overwriting it.
        await rename(ledger.path, `${ledger.path}.unreadable`).catch(() => undefined);
        ledger.fileWarning = '用量汇总文件无法读取，已保留为 usage-ledger.json.unreadable；可用的请求明细将重新汇总。';
      }
    }
    ledger.facts=await UsageFacts.open(root,[...ledger.rows.values()]);
    try{if(hasSummary)ledger.facts.reconcileLegacy([...ledger.rows.values()],producer);}catch{
      const backup=`${ledger.path}.unreconciled-${Date.now()}`;
      const preserved=await readFile(ledger.path).then(data=>writeFile(backup,data,{mode:0o600})).then(()=>true).catch(()=>false);
      ledger.exportBlocked=!preserved;
      ledger.reconciliationWarning=preserved?'旧版本汇总变化无法可靠对账，原汇总已另存为 unreconciled 文件；请核对后补计。':'旧版本汇总无法可靠对账且备份失败；已停止覆盖汇总文件，请求明细仍保留，请检查目录权限。';
    }
    ledger.facts.prune(daysAgo(ledger.retentionDays,Date.now()));
    ledger.rebuild();
    ledger.prune();
    ledger.schedule();
    return ledger;
  }

  private keyOf(row: Pick<UsageRow, 'day' | 'target' | 'keyId' | 'sourceId' | 'model' | 'billingAccountHash' | 'taskKind'>) {
    return [row.day, row.target, row.keyId, row.sourceId, row.model,row.billingAccountHash??'',row.taskKind??'unknown'].join('\n');
  }

  private merge(row:UsageRow){
    const key=this.keyOf(row),old=this.rows.get(key);if(!old){this.rows.set(key,{...row});return;}
    for(const field of ['requests','failed','unmeasured','inputTokens','cachedTokens','cacheBaseTokens','outputTokens','durationMs','cacheWriteTokens','reasoningTokens','toolCalls','toolResults','generationMs','timedOutputTokens','unclassifiedTokens','completeRequests','partialRequests','unknownRequests','conflictRequests','legacyRequests','cancelledRequests','truncatedRequests'] as const){
      if(row[field]!==undefined)old[field]=clamp((old[field]??0)+row[field]!);
    }
    if(row.credits!==undefined)old.credits=(old.credits??0)+row.credits;
    if(row.last>old.last)old.last=row.last;old.keyName=row.keyName;
  }
  private fromFact(event:UsageFact):UsageRow{
    const {quality,...tokens}=accountTokens(event);
    return {day:dayOf(event.startedAt),target:event.target,keyId:event.keyId,keyName:event.keyName,sourceId:event.sourceId,model:event.model,
      requests:1,failed:event.status>=400?1:0,unmeasured:quality==='complete'?0:1,...tokens,
      completeRequests:quality==='complete'?1:0,partialRequests:quality==='partial'?1:0,unknownRequests:quality==='unknown'?1:0,conflictRequests:quality==='conflict'?1:0,legacyRequests:0,
      cancelledRequests:event.outcome==='cancelled'||event.status===499?1:0,truncatedRequests:event.outcome==='truncated'?1:0,
      durationMs:event.durationMs,last:event.startedAt,billingAccountHash:event.billingAccountHash,taskKind:event.taskKind??'unknown',
      toolCalls:event.toolCalls,toolResults:event.toolResults,generationMs:event.generationMs,timedOutputTokens:event.timedOutputTokens};
  }
  private rebuild(){
    this.rows.clear();for(const row of this.facts.legacy())this.merge({...row,legacyRequests:row.requests,completeRequests:0,partialRequests:0,unknownRequests:0,conflictRequests:0});
    for(const event of this.facts.list())this.merge(this.fromFact(event));
    this.prune();
  }
  add(event: UsageEvent) {
    const {previous,current}=this.facts.put(event);
    if(previous)this.rebuild();else this.merge(this.fromFact(current));
    this.schedule();
  }
  /** Inference must complete even if a provider emits invalid accounting metadata. */
  record(event:UsageEvent){
    try{this.add(event);}catch{this.fileWarning='部分请求的计量元数据无效，未纳入统计；模型响应不受影响。';}
  }
  /** Only an unambiguous response identity may fill an incomplete gateway fact. */
  reconcile(samples:readonly {responseHash?:string;inputTokens:number;outputTokens:number;cachedTokens:number;cacheWriteTokens?:number;reasoningTokens?:number;nativeCacheKnown?:boolean;nativeCacheWriteKnown?:boolean;nativeReasoningKnown?:boolean;nativeThreadId?:string;nativeParentThreadId?:string;taskKind?:UsageEvent['taskKind'];model?:string}[]){
    let updated=0;
    for(const sample of samples){
      if(!sample.responseHash)continue;const matches=this.facts.byResponse(sample.responseHash);if(matches.length!==1)continue;
      const fact=matches[0];if(fact.threadHash&&sample.nativeThreadId&&fact.threadHash!==sample.nativeThreadId)continue;
      if(fact.inputTokens!==null&&fact.inputTokens!==sample.inputTokens||fact.outputTokens!==null&&fact.outputTokens!==sample.outputTokens)continue;
      if(sample.nativeCacheKnown&&fact.cachedTokens!=null&&fact.cachedTokens!==sample.cachedTokens||sample.nativeCacheWriteKnown&&fact.cacheWriteTokens!=null&&fact.cacheWriteTokens!==sample.cacheWriteTokens||sample.nativeReasoningKnown&&fact.reasoningTokens!=null&&fact.reasoningTokens!==sample.reasoningTokens)continue;
      const measurement={inputTokens:fact.inputTokens??sample.inputTokens,outputTokens:fact.outputTokens??sample.outputTokens,
        cachedTokens:fact.cachedTokens??(sample.nativeCacheKnown?sample.cachedTokens:null),
        cacheWriteTokens:fact.cacheWriteTokens??(sample.nativeCacheWriteKnown?sample.cacheWriteTokens:null),
        reasoningTokens:fact.reasoningTokens??(sample.nativeReasoningKnown?sample.reasoningTokens:null)};
      if(accountTokens({...fact,...measurement}).quality==='conflict')continue;
      if(fact.parentThreadHash&&sample.nativeParentThreadId&&fact.parentThreadHash!==sample.nativeParentThreadId)continue;
      const filled=Object.entries(measurement).some(([key,value])=>value!=null&&fact[key as keyof UsageFact]==null);
      const next={...fact,...(filled?{...measurement,measurementSource:'native-reconciled' as const}:{}),
        threadHash:fact.threadHash??sample.nativeThreadId,parentThreadHash:fact.parentThreadHash??sample.nativeParentThreadId,
        taskKind:fact.taskKind&&fact.taskKind!=='unknown'?fact.taskKind:sample.taskKind??fact.taskKind};
      if(JSON.stringify(next)===JSON.stringify(fact))continue;
      this.facts.put(next);updated++;
    }
    if(updated){this.rebuild();this.schedule();}return updated;
  }
  /** Metadata only, bounded for inspection. No raw request/response content is stored. */
  recent(limit=100){return limit<=0?[]:this.facts.list().slice(-Math.min(1000,limit)).reverse().map(row=>({...row}));}

  /** Rows from the last `days` calendar days including today; 0 means everything kept. */
  list(days = 0, now = Date.now()): UsageRow[] {
    const cutoff = days > 0 ? daysAgo(days - 1, now) : '';
    return [...this.rows.values()].filter(row => row.day >= cutoff).map(row => ({ ...row }));
  }

  firstDay() { let first = ''; for (const row of this.rows.values()) if (!first || row.day < first) first = row.day; return first; }

  private prune(now = Date.now()) {
    const cutoff = daysAgo(this.retentionDays, now);
    for (const [key, row] of this.rows) if (row.day < cutoff) this.rows.delete(key);
    if (this.rows.size > MAX_ROWS) {
      const ordered = [...this.rows.entries()].sort((a, b) => a[1].day.localeCompare(b[1].day));
      for (const [key] of ordered.slice(0, this.rows.size - MAX_ROWS)) this.rows.delete(key);
    }
  }

  private schedule() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.flushDelay);
    this.timer.unref?.();
  }

  /** Writes pending counters; failures are reported through `warning` and retried on the next call. */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.writing = this.writing.then(async () => {
      this.facts.flush();
      this.facts.prune(daysAgo(this.retentionDays,Date.now()));
      if (!this.dirty) return;
      if(!this.facts.available||this.exportBlocked)return;
      this.dirty = false;
      this.prune();
      try {
        const temporary = `${this.path}.tmp`;
        const rows=compatibilityRows([...this.rows.values()]);
        this.facts.exportCheckpoint(rows,false);
        await writeFile(temporary, JSON.stringify({ version: 1, producer:'tokenflow-facts-v1',rows }), { mode: 0o600 });
        await rename(temporary, this.path);
        this.facts.exportCheckpoint(rows,true);
        this.fileWarning = '';
      } catch {
        this.dirty = true;
        this.fileWarning = '用量汇总暂时无法写入磁盘；请检查资料目录权限。';
      }
    });
    return this.writing;
  }

  async close() { if(this.closed)return;await this.flush();this.closed=true;this.facts.close(); }
}
