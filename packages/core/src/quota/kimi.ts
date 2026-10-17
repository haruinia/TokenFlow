// Kimi Code 用量：GET https://api.kimi.com/coding/v1/usages
// 返回 {usage?: {...}, limits?: [{name|title|scope, window:{duration,timeUnit}, detail:{used,limit,remaining,reset*}}]}
import { clampPercent, isoAfterSeconds, isoFromAny, num, percent, pick, record, str, parseJSON, type Record_ } from './shared.js';
import type { QuotaProvider, QuotaWindow } from './types.js';

const unitLabel: Record<string, string> = {second: '秒', minute: '分钟', hour: '小时', day: '天', week: '周', month: '月'};
const durationLabel = (duration: unknown, unit: unknown) => {
  const n = num(duration); if (!n) return undefined;
  const key = (str(unit) ?? 'minute').toLowerCase().replace(/s$/, '');
  return `${n} ${unitLabel[key] ?? key}`;
};
const resetsAt = (data: Record_) =>
  isoFromAny(pick(data, 'reset_at', 'resetAt', 'reset_time', 'resetTime')) ?? isoAfterSeconds(pick(data, 'reset_in', 'resetIn', 'ttl'));

function toWindow(id: string, data: Record_, fallbackLabel: string): QuotaWindow | undefined {
  const limit = num(data.limit); let used = num(data.used);
  const remaining = num(data.remaining);
  if (used === undefined && remaining !== undefined && limit !== undefined) used = limit - remaining;
  if (used === undefined && limit === undefined) return undefined;
  return {id, label: str(data.name) ?? str(data.title) ?? fallbackLabel, usedPercent: percent(used, limit), used, limit, unit: '次', resetsAt: resetsAt(data)};
}

export const kimiQuota: QuotaProvider = {
  id: 'kimi',
  async fetch(call) {
    const raw = parseJSON(await call({method: 'GET', url: 'https://api.kimi.com/coding/v1/usages', header: {Authorization: 'Bearer $TOKEN$'}}), 'Kimi 用量');
    const payload = record(raw) ?? {};
    if (typeof payload.code === 'number' && payload.code !== 0) {
      throw new Error(`Kimi 接口提示：${str(payload.message) ?? str(payload.msg) ?? `错误码 ${payload.code}`}`);
    }
    const envelope = record(payload.data) ?? payload;
    const data = record(envelope.quota) ?? envelope;
    const windows: QuotaWindow[] = [];
    // The server sends snake_case (`limit_5h.used_ratio`, `reset_time`); the official client renames them internally.
    const ratios=record(data.usages);
    for(const [id,wire,label] of [['limit5h','limit_5h','5 小时'],['limit7d','limit_7d','7 天'],['monthTotal','limit_month_total','月度总额度'],['monthCode','limit_month_code','月度 Code 额度']] as const){
      const entry=record(ratios?.[wire])??record(ratios?.[id]);const ratio=num(entry?.used_ratio??entry?.usedRatio);
      if(ratio!==undefined&&ratio>=0)windows.push({id,label,usedPercent:clampPercent(ratio*100),resetsAt:isoFromAny(entry?.reset_time??entry?.resetAt)});
    }
    const limits = Array.isArray(data.limits) ? data.limits : Array.isArray(data.rate_limits) ? data.rate_limits : Array.isArray(payload.limits) ? payload.limits : [];
    limits.forEach((item, index) => {
      const entry = record(item); if (!entry) return;
      const detail = record(entry.detail) ?? entry;
      const window = record(entry.window) ?? {};
      const fallback = str(entry.name) ?? str(entry.title) ?? str(entry.scope) ??
        durationLabel(pick(window, 'duration') ?? pick(entry, 'duration') ?? pick(detail, 'duration'), pick(window, 'timeUnit') ?? pick(entry, 'timeUnit') ?? pick(detail, 'timeUnit')) ?? `限额 ${index + 1}`;
      const result = toWindow(`limit-${index}`, detail, fallback);
      if (result) windows.push(result);
    });
    const usage = record(data.usage) ?? record(data.usages) ?? record(payload.usage);
    if (usage) {const summary = toWindow('summary', usage, '周用量'); if (summary) windows.push(summary);}
    if (!windows.length) return {windows:[],note:'官方暂未返回额度数据，无法据此判断是否有剩余额度。可在 Kimi Code 官方控制台查看。'};
    return {windows};
  },
};
