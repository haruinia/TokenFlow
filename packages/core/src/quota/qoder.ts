// Qoder 官方 CLI 额度：套餐、加购和组织资源包，单位为 Credits。
// GET https://openapi.qoder.sh/api/v2/quota/usage
import { clampPercent, num, percent, pick, record, str, parseJSON } from './shared.js';
import type { QuotaProvider, QuotaWindow } from './types.js';

export const qoderQuota: QuotaProvider = {
  id: 'qoder',
  async fetch(call) {
    const response = await call({
      method: 'GET',
      url: 'https://openapi.qoder.sh/api/v2/quota/usage',
      header: {
        Authorization: 'Bearer $TOKEN$',
        Accept: 'application/json',
        'Cosy-ClientType': 'CLIProxyAPI',
      },
    });

    const raw = parseJSON(response, 'Qoder 用量');
    const root = record(raw) ?? {};
    const data = record(root.data) ?? record(root.quota) ?? record(root.result) ?? root;

    const windows: QuotaWindow[] = [];

    // Same aliases as qodercli: snake_case first, and the organization package may arrive as a shared quota.
    for(const [id,keys,label] of [['userQuota',['user_quota','userQuota'],'套餐 Credits'],['addOnQuota',['add_on_quota','addOnQuota'],'加购 Credits'],['orgResourcePackage',['org_resource_package','orgResourcePackage','shared_quota','sharedQuota'],'组织资源包']] as const){
      const entry=record(pick(data,...keys));if(!entry||entry.available===false)continue;
      const total=num(pick(entry,'total','cap'));let used=num(entry.used);const remaining=num(entry.remaining);
      if(used===undefined&&total!==undefined&&remaining!==undefined)used=Math.max(0,total-remaining);
      const ratio=num(entry.percentage);
      const usedPercent=total!==undefined&&total<=0?null:percent(used,total)??(ratio===undefined?null:clampPercent(ratio*100));
      if(total!==undefined||used!==undefined||usedPercent!==null)windows.push({id,label,used,limit:total,usedPercent,unit:'Credits',...(total===0?{note:'此资源包未分配额度，不表示免费或无限额。'}:{})});
    }

    // 若有子列表（如不同模型的配额或周期配额）
    const items = Array.isArray(data.items) ? data.items : Array.isArray(data.limits) ? data.limits : Array.isArray(data.quotas) ? data.quotas : [];

    items.forEach((item, index) => {
      const entry = record(item);
      if (!entry) return;

      const label = str(pick(entry, 'name', 'label', 'model', 'title', 'type')) ?? `配额 ${index + 1}`;
      const total = num(pick(entry, 'total', 'limit', 'capacity', 'max'));
      const remain = num(pick(entry, 'remain', 'remaining', 'left'));
      let used = num(pick(entry, 'used', 'consumed', 'usage'));
      const unit = str(pick(entry, 'unit', 'unitName')) ?? '次';

      if (used === undefined && total !== undefined && remain !== undefined) {
        used = Math.max(0, total - remain);
      }

      const p = clampPercent(pick(entry, 'usedPercent', 'used_percent', 'percent')) ?? percent(used, total);

      if (total !== undefined || used !== undefined || p !== null) {
        windows.push({
          id: `item-${index}`,
          label,
          usedPercent: p,
          used,
          limit: total,
          unit,
        });
      }
    });

    // 如果没有列表项，尝试从 data 根级读取单一配额指标
    if (!windows.length) {
      const total = num(pick(data, 'total', 'limit', 'totalQuota', 'capacity'));
      const remain = num(pick(data, 'remain', 'remaining', 'left'));
      let used = num(pick(data, 'used', 'consumed', 'usage', 'usedQuota'));
      if (used === undefined && total !== undefined && remain !== undefined) {
        used = Math.max(0, total - remain);
      }
      const p = clampPercent(pick(data, 'usedPercent', 'used_percent', 'percent', 'percentage')) ?? percent(used, total);

      if (total !== undefined || used !== undefined || p !== null) {
        windows.push({
          id: 'primary',
          label: str(pick(data, 'plan', 'name', 'level')) ?? '月度算力',
          usedPercent: p,
          used,
          limit: total,
          unit: str(pick(data, 'unit')) ?? '次',
        });
      }
    }

    const plan = str(pick(data, 'plan', 'planName', 'tier', 'level', 'userType')) ?? 'Qoder';

    if (!windows.length) {
      return {
        plan,
        windows: [],
        note: '官方暂未返回额度数据，无法据此判断是否有剩余额度。',
      };
    }

    return {
      plan,
      windows,
    };
  },
};
