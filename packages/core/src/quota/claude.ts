// Claude 订阅用量：GET https://api.anthropic.com/api/oauth/usage（utilization 为百分比）+ profile 取套餐。
import { isoFromAny, pick, record, str, parseJSON, clampPercent } from './shared.js';
import type { QuotaProvider, QuotaWindow } from './types.js';

const headers = {Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20'};
const knownWindows: Array<[string, string]> = [
  ['five_hour', '5 小时'], ['seven_day', '7 天'], ['seven_day_oauth_apps', '7 天 · OAuth 应用'],
  ['seven_day_opus', '7 天 · Opus'], ['seven_day_sonnet', '7 天 · Sonnet'], ['seven_day_cowork', '7 天 · Cowork'],
];

export const claudeQuota: QuotaProvider = {
  id: 'claude',
  async fetch(call) {
    const [usage, profile] = await Promise.allSettled([
      call({method: 'GET', url: 'https://api.anthropic.com/api/oauth/usage', header: headers}),
      call({method: 'GET', url: 'https://api.anthropic.com/api/oauth/profile', header: headers}),
    ]);
    if (usage.status === 'rejected') throw usage.reason;
    const payload = record(parseJSON(usage.value, 'Claude 用量')) ?? {};
    const windows: QuotaWindow[] = [];
    for (const [key, label] of knownWindows) {
      const window = record(payload[key]); if (!window) continue;
      windows.push({id: key, label, usedPercent: clampPercent(window.utilization), resetsAt: isoFromAny(window.resets_at)});
    }
    const limits = payload.limits;
    if (Array.isArray(limits)) limits.forEach((item, index) => {
      const entry = record(item); if (!entry || entry.is_active === false) return;
      // Per-model weekly limits share group/kind; only the scoped model tells them apart.
      const model = str(record(record(entry.scope)?.model)?.display_name);
      const label = [str(entry.group), str(entry.kind), model].filter(Boolean).join(' · ') || `限额 ${index + 1}`;
      if (windows.some(w => w.label === label)) return;
      windows.push({id: `limit-${index}`, label, usedPercent: clampPercent(entry.percent), resetsAt: isoFromAny(entry.resets_at)});
    });
    if (!windows.length) throw new Error('Claude 用量接口未返回额度窗口。');
    let plan: string | undefined;
    if (profile.status === 'fulfilled' && profile.value.statusCode < 300) {
      try {
        const info = record(JSON.parse(profile.value.body));
        const account = record(info?.account);
        plan = account?.has_claude_max ? 'Max' : account?.has_claude_pro ? 'Pro' : str(record(info?.organization)?.organization_type);
      } catch { /* 套餐仅作展示 */ }
    }
    return {plan, windows};
  },
};
