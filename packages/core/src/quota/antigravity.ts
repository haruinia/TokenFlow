// Antigravity 额度：POST v1internal:retrieveUserQuotaSummary {project}，返回 groups[].buckets[]（remainingFraction）。
import { isoFromAny, num, pick, record, str, parseJSON, QuotaHTTPError } from './shared.js';
import type { QuotaProvider, QuotaWindow } from './types.js';

const urls = [
  // Match upstream Management Center: daily first, using the Hub identity below.
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
];
const headers = {
  Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json',
  'User-Agent': 'antigravity/hub/2.23.0 darwin/arm64',
};

export const antigravityQuota: QuotaProvider = {
  id: 'antigravity',
  async fetch(call, account) {
    if (!account.projectId) throw new Error('账号缺少 project_id，无法查询 Antigravity 额度。');
    let failure: Error | undefined;
    const windows: QuotaWindow[] = [];
    let summaryLoaded=false,modelsLoaded=false;
    for (const url of urls) {
      try {
        const payload = record(parseJSON(await call({method: 'POST', url, header: headers, data: JSON.stringify({project: account.projectId})}), 'Antigravity 额度')) ?? {};
        const groups = Array.isArray(payload.groups) ? payload.groups : [];
        groups.forEach((group, gi) => {
          const entry = record(group); if (!entry) return;
          const groupLabel = str(pick(entry, 'displayName', 'display_name')) ?? `额度组 ${gi + 1}`;
          const buckets = Array.isArray(entry.buckets) ? entry.buckets : [];
          buckets.forEach((bucket, bi) => {
            const item = record(bucket); if (!item) return;
            const remaining = num(pick(item, 'remainingFraction', 'remaining_fraction')); if (remaining === undefined) return;
            const window = str(item.window);
            windows.push({
              id: str(pick(item, 'bucketId', 'bucket_id')) ?? `${gi}-${bi}`,
              label: `${groupLabel} · ${str(pick(item, 'displayName', 'display_name')) ?? window ?? `窗口 ${bi + 1}`}`,
              usedPercent: Math.max(0, Math.min(100, (1 - remaining) * 100)),
              resetsAt: isoFromAny(pick(item, 'resetTime', 'reset_time')),
            });
          });
        });
        if (windows.length) {summaryLoaded=true;break;}
        failure = new Error('Antigravity 额度接口未返回配额组。');
      } catch (error) {
        failure = error instanceof Error ? error : new Error('Antigravity 额度查询失败。');
        // 403/404 表示该端点不适用于此账号，继续尝试下一个；其他错误也继续，最后统一上报。
        if (error instanceof QuotaHTTPError && ![403, 404].includes(error.status)) break;
      }
    }
    // Summary currently omits Gemini for some accounts. Model quota is a
    // separate source; read it even after a successful summary. Never infer a
    // shared pool merely because two models have equal remaining fractions.
    for(const url of urls){
      try{
        const payload=record(parseJSON(await call({method:'POST',url:url.replace('retrieveUserQuotaSummary','fetchAvailableModels'),header:headers,data:JSON.stringify({project:account.projectId})}),'Antigravity 模型额度'));
        const models=record(payload?.models);if(!models)continue;
        const before=windows.length;
        for(const [id,value] of Object.entries(models)){
          const model=record(value),quota=record(pick(model,'quotaInfo','quota_info'));
          if(model?.isInternal===true||model?.is_internal===true)continue;
          const remaining=num(pick(quota,'remainingFraction','remaining_fraction'));if(remaining===undefined)continue;
          windows.push({id:`model:${id}`,label:`${str(pick(model,'displayName','display_name'))??id} · 模型额度`,usedPercent:Math.max(0,Math.min(100,(1-remaining)*100)),resetsAt:isoFromAny(pick(quota,'resetTime','reset_time')),note:'上游按模型报告，可能共享额度，不可累加。'});
        }
        if(windows.length>before){modelsLoaded=true;break;}
      }catch(error){
        failure=error instanceof Error?error:new Error('Antigravity 模型额度查询失败。');
        if(error instanceof QuotaHTTPError&&![403,404].includes(error.status))break;
      }
    }
    if(windows.length)return {windows,...(!modelsLoaded?{note:'模型额度未获取，当前仅显示汇总额度。'}:!summaryLoaded?{note:'汇总额度未获取，当前仅显示模型额度。'}:{})};
    throw failure ?? new Error('Antigravity 额度查询失败。');
  },
};
