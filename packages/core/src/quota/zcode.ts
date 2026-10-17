// The stored Z.AI business token belongs to the Coding Plan API, not chat OAuth userinfo.
import { record, str, num, isoFromAny, parseJSON } from './shared.js';
import type { QuotaProvider, QuotaWindow } from './types.js';

/** `unit`/`number` describe the window length (unit 3 = hours, 6 = weeks); `number` is never a quota amount. */
function windowLength(item: Record<string, unknown>) {
  const unit = num(item.unit), count = num(item.number);
  if (unit === 3) return `${count ?? 5} 小时`;
  if (unit === 6) return count && count > 1 ? `${count} 周` : '每周';
  return undefined;
}

function windowLabel(item: Record<string, unknown>, index: number) {
  const type = str(item.type), length = windowLength(item);
  const kind = type === 'TOKENS_LIMIT' || type === 'CREDIT_LIMIT' ? '模型用量' : type === 'TIME_LIMIT' ? '工具用量' : type ?? `额度 ${index + 1}`;
  return length ? `${length}${kind}` : kind;
}

export const zcodeQuota: QuotaProvider = {
  id: 'zcode',
  async fetch(call, account) {
    const bigmodel = account.domain === 'bigmodel.cn';
    const plan = bigmodel ? 'GLM Coding Plan' : 'Z.AI Coding Plan';
    const url = bigmodel ? 'https://bigmodel.cn/api/monitor/usage/quota/limit' : 'https://api.z.ai/api/monitor/usage/quota/limit';
    let response = await call({method: 'GET', url, header: {Authorization: '$TOKEN$', Accept: 'application/json'}});
    // BigModel's header format is not published; retry once in the common Bearer form.
    if (bigmodel && (response.statusCode === 401 || response.statusCode === 403)) {
      response = await call({method: 'GET', url, header: {Authorization: 'Bearer $TOKEN$', Accept: 'application/json'}});
    }
    const payload = record(parseJSON(response, 'ZCode 编程套餐额度')) ?? {};
    // This is an authenticated business response, not an expired credential.
    if (payload.code === 500 && str(payload.msg)?.includes('当前用户不存在coding plan')) {
      return {plan: `未开通 ${plan}`, windows: [], note: `授权已连接，但官方未查到此账号的 ${plan}。该授权的编程模型可能无法调用；ZCode 套餐额度暂未读取。`};
    }
    if (payload.success === false || (payload.code !== undefined && ![0, 200].includes(Number(payload.code)))) {
      throw new Error('ZCode 编程套餐额度查询未成功，请到官方页面确认套餐状态。');
    }
    const data = record(payload.data);
    if (!data) throw new Error('ZCode 额度接口未返回套餐信息。');
    const windows: QuotaWindow[] = [];
    for (const [index, raw] of (Array.isArray(data.limits) ? data.limits : []).entries()) {
      const item = record(raw); if (!item) continue;
      const limit = num(item.usage);
      const used = num(item.currentValue) ?? (limit !== undefined && num(item.remaining) !== undefined ? limit - num(item.remaining)! : undefined);
      const percentage = num(item.percentage);
      windows.push({id: `limit-${index}`, label: windowLabel(item, index),
        used, limit, usedPercent: percentage !== undefined ? Math.max(0, Math.min(100, percentage)) : limit && used !== undefined ? Math.max(0, Math.min(100, used / limit * 100)) : null,
        resetsAt: isoFromAny(item.nextResetTime)});
    }
    return {plan: str(data.level) ? `${plan} · ${str(data.level)}` : plan, windows,
      ...(!windows.length ? {note: `官方接口未返回额度窗口，请在${bigmodel ? '智谱开放平台' : ' Z.AI '}官方页面核对。`} : {})};
  },
};
