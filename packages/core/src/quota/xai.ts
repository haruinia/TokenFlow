// xAI Grok 订阅额度：cli-chat-proxy 的 billing 接口（周 credits + 月度金额）。
// 订阅接口不可用时退回 api.x.ai/v1/me 只确认账号可访问（付费 API 账号没有订阅额度）。不发起任何计费的模型请求。
import { isoFromAny, num, percent, pick, record, str, parseJSON, clampPercent, QuotaHTTPError, type Record_ } from './shared.js';
import type { QuotaCall, QuotaProvider, QuotaReport, QuotaWindow } from './types.js';

const headers = {
  Authorization: 'Bearer $TOKEN$', 'x-xai-token-auth': 'xai-grok-cli', 'x-grok-client-version': '1.0.62',
  accept: '*/*', 'user-agent': 'grok-pager/1.0.62 grok-shell/1.0.62 (macos; aarch64)',
};
const cents = (value: unknown) => {const n = num(value); return n === undefined ? undefined : n / 100;};

function billingWindows(config: Record_ | undefined): QuotaWindow[] {
  if (!config) return [];
  const windows: QuotaWindow[] = [];
  const period = record(pick(config, 'currentPeriod', 'current_period'));
  const periodEnd = isoFromAny(pick(period, 'end') ?? pick(config, 'billingPeriodEnd', 'billing_period_end'));
  const credit = clampPercent(pick(config, 'creditUsagePercent', 'credit_usage_percent'));
  if (credit !== null) windows.push({id: 'credits', label: `${(str(period?.type) ?? '').toLowerCase().includes('month') ? '月度' : '本周'} credits`, usedPercent: credit, resetsAt: periodEnd});
  const products = pick(config, 'productUsage', 'product_usage');
  if (Array.isArray(products)) products.forEach((item, index) => {
    const entry = record(item); if (!entry) return;
    windows.push({id: `product-${index}`, label: str(entry.product) ?? `产品 ${index + 1}`, usedPercent: clampPercent(pick(entry, 'usagePercent', 'usage_percent')), resetsAt: periodEnd});
  });
  const limit = cents(pick(config, 'monthlyLimit', 'monthly_limit')); const used = cents(config.used);
  if (limit !== undefined || used !== undefined) {
    const included = used !== undefined && limit ? Math.min(used, limit) : used;
    windows.push({id: 'monthly', label: '月度包含额度', usedPercent: percent(included, limit), used: included, limit, unit: 'USD', resetsAt: isoFromAny(pick(config, 'billingPeriodEnd', 'billing_period_end')) ?? periodEnd});
  }
  const cap = cents(pick(config, 'onDemandCap', 'on_demand_cap'));
  const onDemand = cents(pick(config, 'onDemandUsed', 'on_demand_used')) ?? (used !== undefined && limit !== undefined ? Math.max(0, used - limit) : undefined);
  if (cap !== undefined && cap > 0) windows.push({id: 'on-demand', label: '按需上限', usedPercent: percent(onDemand, cap), used: onDemand, limit: cap, unit: 'USD'});
  return windows;
}

async function billing(call: QuotaCall, url: string) {
  const payload = record(parseJSON(await call({method: 'GET', url, header: headers}), 'xAI 账单'));
  return billingWindows(record(payload?.config));
}

export const xaiQuota: QuotaProvider = {
  id: 'xai',
  async fetch(call): Promise<QuotaReport> {
    const [weekly, monthly] = await Promise.allSettled([
      billing(call, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'),
      billing(call, 'https://cli-chat-proxy.grok.com/v1/billing'),
    ]);
    const seen = new Set<string>();
    const windows = [...(weekly.status === 'fulfilled' ? weekly.value : []), ...(monthly.status === 'fulfilled' ? monthly.value : [])]
      .filter(window => !seen.has(window.id) && seen.add(window.id));
    if (windows.length) return {plan: 'subscription', windows};
    // 订阅账单不可用：确认 API 账号身份，但不能得到额度。
    const me = await call({method: 'GET', url: 'https://api.x.ai/v1/me', header: {Authorization: 'Bearer $TOKEN$', accept: 'application/json'}});
    if (me.statusCode >= 200 && me.statusCode < 300) return {plan: 'paid-api', windows: [], note: 'xAI 账号可访问 API，但未提供订阅额度接口；按用量计费请在 x.ai 控制台查看。'};
    const failure = weekly.status === 'rejected' ? weekly.reason : monthly.status === 'rejected' ? monthly.reason : undefined;
    throw failure instanceof QuotaHTTPError ? failure : new Error('xAI 额度接口未返回数据。');
  },
};
