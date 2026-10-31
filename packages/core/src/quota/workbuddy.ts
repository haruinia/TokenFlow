// 腾讯 WorkBuddy / CodeBuddy 用量与额度：
// POST https://copilot.tencent.com/billing/meter/get-user-resource-summary
// 返回 {Packages: [{PackageCode, CycleTotalCapacity, CycleRemainCapacity, CycleUsedCapacity, CapacityUnit}]}
import { num, percent, pick, record, str, parseJSON, type Record_ } from './shared.js';
import type { QuotaProvider, QuotaWindow } from './types.js';

export const workbuddyQuota: QuotaProvider = {
  id: 'workbuddy',
  async fetch(call, account) {
    const base=account.domain==='www.workbuddy.ai'||account.domain==='https://www.workbuddy.ai'?'https://www.workbuddy.ai':'https://copilot.tencent.com';
    const response = await call({
      method: 'POST',
      url: base+'/billing/meter/get-user-resource-summary',
      header: {
        Authorization: 'Bearer $TOKEN$',
        'X-Product': 'SaaS',
        'Content-Type': 'application/json',
      },
      data: '{}',
    });

    const payload = record(parseJSON(response, 'WorkBuddy 用量')) ?? {};
    const data = record(payload.data) ?? payload;
    const packages = Array.isArray(data.Packages) ? data.Packages : Array.isArray(data.packages) ? data.packages : Array.isArray(payload.Packages) ? payload.Packages : Array.isArray(payload.packages) ? payload.packages : [];

    const windows: QuotaWindow[] = [];
    let totalAll = 0;
    let usedAll = 0;
    let remainAll = 0;
    let hasValidData = false;

    packages.forEach((item, index) => {
      const entry = record(item);
      if (!entry) return;

      let code = str(pick(entry, 'PackageName', 'packageName', 'name', 'PackageCode', 'packageCode', 'package_code')) ?? `套餐包 ${index + 1}`;
      if (code.startsWith('TCACA_code_')) {
        const cleaned = code.replace(/^TCACA_code_\d+_?/, '').replace(/_/g, ' ').trim();
        if (cleaned) code = cleaned.toUpperCase();
      }
      const total = num(pick(entry, 'CycleTotalCapacity', 'cycleTotalCapacity', 'total'));
      const remain = num(pick(entry, 'CycleRemainCapacity', 'cycleRemainCapacity', 'remain', 'remaining'));
      let used = num(pick(entry, 'CycleUsedCapacity', 'cycleUsedCapacity', 'used'));
      const rawUnit = str(pick(entry, 'CapacityUnit', 'capacityUnit', 'unit'));
      const unit = rawUnit && rawUnit.toLowerCase() === 'credits' ? '点' : rawUnit ?? '点';

      if (used === undefined && total !== undefined && remain !== undefined) {
        used = Math.max(0, total - remain);
      }

      if (total !== undefined || used !== undefined) {
        hasValidData = true;
        if (total !== undefined) totalAll += total;
        if (used !== undefined) usedAll += used;
        if (remain !== undefined) remainAll += remain;

        windows.push({
          id: `pack-${index}`,
          label: code,
          usedPercent: percent(used, total),
          used,
          limit: total,
          remaining:remain,
          unit,
        });
      }
    });

    if (!hasValidData && !windows.length) {
      // 官方接口返回空包或字段缺失时，额度状态为未知——不能据此推断账号无限制。
      return {
        plan: '账号已连接',
        windows: [],
        note: '额度暂未提供：接口未返回资源包数据，不表示免费或无限额，请以腾讯官方页面为准。',
      };
    }

    return {
      plan: packages.length > 1 ? `多套餐包 (${packages.length})` : windows[0]?.label ?? '个人套餐',
      windows,
      note: remainAll > 0 ? `剩余可用算力：${Math.round(remainAll).toLocaleString()} 点` : undefined,
    };
  },
};
