// Codex（ChatGPT 订阅）用量：GET https://chatgpt.com/backend-api/wham/usage
import { isoAfterSeconds, isoFromAny, num, pick, record, str, parseJSON, clampPercent, windowLabel, type Record_ } from './shared.js';
import type { QuotaProvider, QuotaWindow } from './types.js';

const headers = {
  Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json',
  'User-Agent': 'codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)',
};

function rateLimitWindows(prefix: string, label: string, info: Record_ | undefined): QuotaWindow[] {
  if (!info) return [];
  const windows: QuotaWindow[] = [];
  for (const [key, name] of [['primary', '主窗口'], ['secondary', '次窗口']] as const) {
    const window = record(pick(info, `${key}_window`, `${key}Window`)); if (!window) continue;
    const seconds = num(pick(window, 'limit_window_seconds', 'limitWindowSeconds'));
    windows.push({
      id: `${prefix}-${key}`, label: `${label} · ${windowLabel(seconds) ?? name}`,
      usedPercent: clampPercent(pick(window, 'used_percent', 'usedPercent')),
      resetsAt: isoFromAny(pick(window, 'reset_at', 'resetAt')) ?? isoAfterSeconds(pick(window, 'reset_after_seconds', 'resetAfterSeconds')),
      note: pick(info, 'limit_reached', 'limitReached') === true ? '已达上限' : undefined,
    });
  }
  return windows;
}

export const codexQuota: QuotaProvider = {
  id: 'codex',
  async fetch(call, account) {
    const header: Record<string, string> = {...headers};
    if (account.chatgptAccountId) header['Chatgpt-Account-Id'] = account.chatgptAccountId;
    const payload = record(parseJSON(await call({method: 'GET', url: 'https://chatgpt.com/backend-api/wham/usage', header}), 'Codex 用量')) ?? {};
    const windows = rateLimitWindows('codex', 'Codex', record(pick(payload, 'rate_limit', 'rateLimit')));
    const additional = pick(payload, 'additional_rate_limits', 'additionalRateLimits');
    if (Array.isArray(additional)) additional.forEach((item, index) => {
      const entry = record(item); if (!entry) return;
      const name = str(pick(entry, 'limit_name', 'limitName')) ?? str(pick(entry, 'metered_feature', 'meteredFeature')) ?? `附加限额 ${index + 1}`;
      windows.push(...rateLimitWindows(`extra-${index}`, name, record(pick(entry, 'rate_limit', 'rateLimit'))));
    });
    const credits = num(pick(record(pick(payload, 'rate_limit_reset_credits', 'rateLimitResetCredits')), 'available_count', 'availableCount'));
    if (!windows.length) throw new Error('Codex 用量接口未返回额度窗口。');
    return {plan: str(pick(payload, 'plan_type', 'planType')) ?? account.planType, windows,
      note: credits ? `可用限额重置券 ${credits} 张` : undefined};
  },
};
