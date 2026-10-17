import type { UsageRow as GatewayUsageRow } from '../../../packages/core/src/usage-ledger';
export type UsageRow=GatewayUsageRow&{origin?:'gateway'|'native';channel?:'official'|'api'|'unknown';provider?:string;nativeAccountId?:string;nativeEmailHash?:string;nativeOrganizationId?:string;nativeAccountLabel?:string;nativeAccountEvidence?:'otel'|'conflict'|'login-snapshot'|'billing'};

/** Time windows offered next to every usage summary. */
export type RangeId = 'today' | '7d' | '30d' | 'all';
export const ranges: { id: RangeId; label: string; days: number }[] = [
  { id: 'today', label: '今天', days: 1 },
  { id: '7d', label: '7 天', days: 7 },
  { id: '30d', label: '30 天', days: 30 },
  { id: 'all', label: '全部', days: 0 },
];
export const rangeDays = (id: RangeId) => ranges.find(item => item.id === id)?.days ?? 7;
export const rangeLabel = (id: RangeId) => id === 'all' ? '全部时间' : id === 'today' ? '今天' : `近 ${rangeDays(id)} 天`;
/** Short form for stat captions, e.g. "近 7 天 Tokens". */
export const rangeShort = (id: RangeId) => id === 'all' ? '累计' : rangeLabel(id);

export type UsageTotals = {
  requests: number; failed: number; unmeasured: number;
  unknownCacheTokens:number;cacheWriteTokens:number;reasoningTokens:number;toolCalls:number;toolResults:number;generationMs:number;tokensPerSecond:number|null;inputTokens: number; cachedTokens: number; uncachedTokens: number; outputTokens: number; totalTokens: number;
  /** cached / input over the calls whose upstream reported cache usage; null when none did. */
  hitRate: number | null;
  durationMs: number; toolsMeasured:boolean; avgMs: number | null; last?: string;
};

export function totalsOf(rows: readonly UsageRow[]): UsageTotals {
  let requests = 0, failed = 0, unmeasured = 0, inputTokens = 0, cachedTokens = 0, cacheBase = 0, outputTokens = 0, durationMs = 0;
  let cacheWriteTokens=0,reasoningTokens=0,toolCalls=0,toolResults=0,generationMs=0,timedOutputTokens=0;
  let last: string | undefined;let measuredRequests=0;let toolsMeasured=false;
  for (const row of rows) {
    if(row.origin!=='native')measuredRequests+=row.requests;
    if(row.toolCalls!==undefined||row.toolResults!==undefined)toolsMeasured=true;
    cacheWriteTokens+=row.cacheWriteTokens??0;reasoningTokens+=row.reasoningTokens??0;toolCalls+=row.toolCalls??0;toolResults+=row.toolResults??0;generationMs+=row.generationMs??0;timedOutputTokens+=row.timedOutputTokens??0;
    requests += row.requests; failed += row.failed; unmeasured += row.unmeasured;
    inputTokens += row.inputTokens; cachedTokens += row.cachedTokens; cacheBase += row.cacheBaseTokens;
    outputTokens += row.outputTokens; durationMs += row.durationMs;
    if (!last || row.last > last) last = row.last;
  }
  return {
    unknownCacheTokens:Math.max(0,inputTokens-cacheBase),cacheWriteTokens,reasoningTokens,toolCalls,toolResults,generationMs,tokensPerSecond:generationMs>0?timedOutputTokens*1000/generationMs:null,requests, failed, unmeasured, inputTokens, cachedTokens, outputTokens, durationMs, last,
    uncachedTokens: Math.max(0, inputTokens - cachedTokens - cacheWriteTokens),
    totalTokens: inputTokens + outputTokens,
    hitRate: cacheBase > 0 ? Math.min(1, cachedTokens / cacheBase) : null,
    toolsMeasured,avgMs: measuredRequests ? Math.round(durationMs / measuredRequests) : null,
  };
}

export type UsageGroup = { key: string; totals: UsageTotals; rows: UsageRow[] };
/** Groups rows, biggest token consumer first; ties go to the most recent. */
export function groupUsage(rows: readonly UsageRow[], keyOf: (row: UsageRow) => string): UsageGroup[] {
  const groups = new Map<string, UsageRow[]>();
  for (const row of rows) { const key = keyOf(row); const list = groups.get(key); if (list) list.push(row); else groups.set(key, [row]); }
  return [...groups].map(([key, list]) => ({ key, rows: list, totals: totalsOf(list) }))
    .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens || (b.totals.last ?? '').localeCompare(a.totals.last ?? '') || a.key.localeCompare(b.key));
}

const pad = (value: number) => String(value).padStart(2, '0');
export const localDay = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
/** Tokens per calendar day, oldest first, with quiet days kept as zero so the chart keeps its shape. */
export function dailyTokens(rows: readonly UsageRow[], span: number, now = new Date()): { day: string; tokens: number }[] {
  const byDay = new Map<string, number>();
  for (const row of rows) byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.inputTokens + row.outputTokens);
  return Array.from({ length: span }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (span - 1 - index));
    const day = localDay(date);
    return { day, tokens: byDay.get(day) ?? 0 };
  });
}
/** Chart length for a range: the range itself, or the span since the first record (at most 60 days) for "all". */
export function chartSpan(id: RangeId, rows: readonly UsageRow[], now = new Date()): number {
  if (id !== 'all') return rangeDays(id);
  const first = rows.reduce((min, row) => !min || row.day < min ? row.day : min, '');
  if (!first) return 7;
  const [year, month, day] = first.split('-').map(Number);
  const spanDays = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(year, month - 1, day).getTime()) / 86_400_000) + 1;
  return Math.min(60, Math.max(7, spanDays));
}

/** Display only: keep stored values and calculations exact, abbreviate large counts with 万／亿. */
const tokenFormat=new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1});
export const formatTokens = (value: number) => tokenFormat.format(value);
export const compactTokens = formatTokens;
/** Whole percent like the official statistics; a real but tiny share never shows as 0%. */
export function percentText(rate: number | null): string {
  if (rate === null) return '—';
  if (rate > 0 && rate < 0.005) return '<1%';
  if (rate < 1 && rate >= 0.995) return '99%';
  return `${Math.round(rate * 100)}%`;
}
export function durationText(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
  return `${Math.round(ms / 60_000)} 分钟`;
}

/** Account authorization usage: gateway calls served by the platform's accounts, and local requests proven to use its official login. */
export function spentByPlatform(row:UsageRow,platform:{id:string;accounts:readonly {id:string}[]}){
 if(row.origin==='native')return row.channel==='official'&&(row.provider===platform.id||platform.id==='workbuddy'&&row.provider==='workbuddy-ai');
 return platform.accounts.some(account=>account.id===row.sourceId)||row.channel!=='api'&&row.model.startsWith(platform.id+'/');
}

/** Account or API source behind a ledger row; models served by the account catalog keep their provider prefix. */
export const sourceKey = (row: UsageRow) => row.sourceId || (row.origin==='native'?`native:${row.provider??row.target}:${row.channel??'unknown'}:${row.nativeAccountId??''}:${row.nativeEmailHash??''}${row.nativeOrganizationId?`:${row.nativeOrganizationId}`:''}`:undefined) || (row.model.match(/^api-([a-f0-9]{24})\//)?.[1] ?? `provider:${row.model.split('/')[0]}`);
