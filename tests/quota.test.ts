import { describe, expect, it } from 'vitest';
import { quotaProviders, type QuotaRequest, type QuotaResponse } from '../packages/core/src/quota/index.js';

const json = (body: unknown, statusCode = 200): QuotaResponse => ({statusCode, header: {}, body: JSON.stringify(body)});
const responder = (routes: Record<string, QuotaResponse | ((request: QuotaRequest) => QuotaResponse)>) => {
  const calls: QuotaRequest[] = [];
  const call = async (request: QuotaRequest) => {
    calls.push(request);
    const key = Object.keys(routes).find(prefix => request.url.startsWith(prefix));
    const route = key ? routes[key] : json({error: 'upstream-secret'}, 404);
    return typeof route === 'function' ? route(request) : route;
  };
  return {call, calls};
};

describe('quota layer', () => {
  it('routes overseas WorkBuddy quota only to its verified region',async()=>{
    const calls:QuotaRequest[]=[];const call=async(r:QuotaRequest)=>{calls.push(r);return json({Packages:[]});};
    await quotaProviders.workbuddy.fetch(call,{provider:'workbuddy',domain:'www.workbuddy.ai'});
    await quotaProviders.workbuddy.fetch(call,{provider:'workbuddy',domain:'www.workbuddy.ai.evil.test'});
    expect(calls.map(r=>new URL(r.url).host)).toEqual(['www.workbuddy.ai','copilot.tencent.com']);
  });
  it('normalizes Kimi limits and summary usage, using remaining when used is absent', async () => {
    const {call, calls} = responder({'https://api.kimi.com/coding/v1/usages': json({
      usage: {used: 120, limit: 1000, resetAt: '2026-09-14T00:00:00Z'},
      limits: [{name: '5h window', window: {duration: 5, timeUnit: 'hour'}, detail: {used: 30, limit: 100, reset_in: 3600}},
        {window: {duration: 1, timeUnit: 'week'}, detail: {remaining: 700, limit: 1000, reset_at: 1789000000}}],
    })});
    const report = await quotaProviders.kimi.fetch(call, {provider: 'kimi'});
    expect(calls[0].header.Authorization).toBe('Bearer $TOKEN$');
    expect(report.windows.map(w => [w.id, w.label, Math.round(w.usedPercent!), w.used, w.limit])).toEqual([
      ['limit-0', '5h window', 30, 30, 100], ['limit-1', '1 周', 30, 300, 1000], ['summary', '周用量', 12, 120, 1000]]);
    expect(report.windows[1].resetsAt).toBe(new Date(1789000000 * 1000).toISOString());
    expect(Date.parse(report.windows[0].resetsAt!) - Date.now()).toBeGreaterThan(3500 * 1000);
  });
  it('merges xAI weekly credits with monthly dollars, and falls back to /v1/me for paid API accounts', async () => {
    const subscription = responder({
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits': json({config: {currentPeriod: {type: 'WEEKLY', end: '2026-09-14T00:00:00Z'}, creditUsagePercent: 42.5, productUsage: [{product: 'grok-build', usagePercent: 10}]}}),
      'https://cli-chat-proxy.grok.com/v1/billing': json({config: {monthlyLimit: {val: 3000}, used: {val: 3250}, onDemandCap: {val: 5000}, billingPeriodEnd: '2026-10-01T00:00:00Z'}}),
    });
    const report = await quotaProviders.xai.fetch(subscription.call, {provider: 'xai'});
    expect(report.plan).toBe('subscription');
    expect(report.windows.map(w => [w.id, w.usedPercent, w.used, w.limit])).toEqual([
      ['credits', 42.5, undefined, undefined], ['product-0', 10, undefined, undefined], ['monthly', 100, 30, 30], ['on-demand', 5, 2.5, 50]]);
    expect(report.windows[0].resetsAt).toBe('2026-09-14T00:00:00.000Z');
    expect(subscription.calls.every(c => c.header['x-xai-token-auth'] === 'xai-grok-cli')).toBe(true);

    const paid = responder({'https://cli-chat-proxy.grok.com': json({error: 'nope'}, 403), 'https://api.x.ai/v1/me': json({id: 'user'})});
    const fallback = await quotaProviders.xai.fetch(paid.call, {provider: 'xai'});
    expect(fallback.plan).toBe('paid-api'); expect(fallback.windows).toEqual([]); expect(fallback.note).toContain('订阅额度');

    const broken = responder({'https://cli-chat-proxy.grok.com': json({error: 'secret-body'}, 401), 'https://api.x.ai/v1/me': json({}, 401)});
    await expect(quotaProviders.xai.fetch(broken.call, {provider: 'xai'})).rejects.toThrow(/HTTP 401/);
    await expect(quotaProviders.xai.fetch(broken.call, {provider: 'xai'})).rejects.not.toThrow(/secret-body/);
  });
  it('reads Codex windows with account header, and Claude windows with plan from profile', async () => {
    const codex = responder({'https://chatgpt.com/backend-api/wham/usage': json({plan_type: 'plus',
      rate_limit: {limit_reached: true, primary_window: {used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 7200}, secondary_window: {used_percent: 55, limit_window_seconds: 604800, reset_at: 1789000000}},
      additional_rate_limits: [{limit_name: 'code-review', rate_limit: {primary_window: {used_percent: 5}}}], rate_limit_reset_credits: {available_count: 2}})});
    const report = await quotaProviders.codex.fetch(codex.call, {provider: 'codex', chatgptAccountId: 'acct-1'});
    expect(codex.calls[0].header['Chatgpt-Account-Id']).toBe('acct-1');
    expect(report.plan).toBe('plus'); expect(report.note).toContain('2');
    expect(report.windows.map(w => [w.label, w.usedPercent, w.note])).toEqual([
      ['Codex · 5 小时', 12, '已达上限'], ['Codex · 7 天', 55, '已达上限'], ['code-review · 主窗口', 5, undefined]]);
    expect(report.windows[1].resetsAt).toBe(new Date(1789000000 * 1000).toISOString());

    const claude = responder({'https://api.anthropic.com/api/oauth/usage': json({five_hour: {utilization: 33, resets_at: '2026-09-09T08:00:00Z'}, seven_day_opus: {utilization: 61, resets_at: null}, limits: [{group: 'extra', kind: 'weekly', percent: 9, is_active: true},
      {group: 'weekly', kind: 'model', percent: 20, scope: {model: {display_name: 'Opus'}}}, {group: 'weekly', kind: 'model', percent: 30, scope: {model: {display_name: 'Sonnet'}}}]}),
      'https://api.anthropic.com/api/oauth/profile': json({account: {has_claude_max: true}})});
    const claudeReport = await quotaProviders.claude.fetch(claude.call, {provider: 'claude'});
    expect(claudeReport.plan).toBe('Max');
    expect(claudeReport.windows.map(w => [w.id, w.usedPercent, w.resetsAt])).toEqual([['five_hour', 33, '2026-09-09T08:00:00.000Z'], ['seven_day_opus', 61, undefined], ['limit-0', 9, undefined], ['limit-1', 20, undefined], ['limit-2', 30, undefined]]);
    expect(claudeReport.windows.slice(3).map(w => w.label)).toEqual(['weekly · model · Opus', 'weekly · model · Sonnet']);
  });
  it('preserves both Antigravity quota groups by preferring the production summary over the partial daily summary', async () => {
    const thirdParty={displayName:'Claude and GPT models',buckets:[{bucketId:'3p-weekly',window:'weekly',remainingFraction:0.49},{bucketId:'3p-5h',window:'5h',remainingFraction:1}]};
    const gemini={displayName:'Gemini Models',buckets:[{bucketId:'gemini-weekly',window:'weekly',remainingFraction:1},{bucketId:'gemini-5h',window:'5h',remainingFraction:1}]};
    const {call,calls}=responder({
      'https://daily-cloudcode-pa.googleapis.com':json({groups:[thirdParty]}),
      'https://cloudcode-pa.googleapis.com':json({groups:[gemini,thirdParty]}),
    });
    const report=await quotaProviders.antigravity.fetch(call,{provider:'antigravity',projectId:'proj'});
    expect(report.windows.map(w=>[w.id,w.usedPercent])).toEqual([['gemini-weekly',0],['gemini-5h',0],['3p-weekly',51],['3p-5h',0]]);
    expect(calls).toHaveLength(1);expect(calls[0].url).toBe('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary');
  });
  it('walks Antigravity endpoints on 403/404, converts remaining fraction to used percent and requires project id', async () => {
    const {call, calls} = responder({
      'https://cloudcode-pa.googleapis.com': json({error: 'forbidden-secret'}, 403),
      'https://daily-cloudcode-pa.googleapis.com': json({groups: [{displayName: 'Gemini', buckets: [{bucketId: 'daily', displayName: '每日', window: 'DAILY', remainingFraction: 0.25, resetTime: '2026-09-10T00:00:00Z'}]}]}),
    });
    const report = await quotaProviders.antigravity.fetch(call, {provider: 'antigravity', projectId: 'proj'});
    expect(calls).toHaveLength(2); expect(calls[0].data).toBe('{"project":"proj"}');
    expect(report.windows).toEqual([{id: 'daily', label: 'Gemini · 每日', usedPercent: 75, resetsAt: '2026-09-10T00:00:00.000Z'}]);
    await expect(quotaProviders.antigravity.fetch(call, {provider: 'antigravity'})).rejects.toThrow('project_id');
  });
  it('parses WorkBuddy packages, calculating used percent and remaining credits', async () => {
    const {call, calls} = responder({
      'https://copilot.tencent.com/billing/meter/get-user-resource-summary': json({
        code: 0,
        msg: 'OK',
        data: {
          Packages: [
            {PackageCode: 'TCACA_code_007_month_resource_pack', CycleTotalCapacity: '1800', CycleRemainCapacity: '1800', CycleUsedCapacity: '0', CapacityUnit: 'credits'},
            {PackageCode: 'TCACA_code_008_month_resource_pack', CycleTotalCapacity: '500', CycleRemainCapacity: '36.5', CycleUsedCapacity: '463.5', CapacityUnit: 'credits'},
          ],
        },
      }),
    });
    const report = await quotaProviders.workbuddy.fetch(call, {provider: 'workbuddy'});
    expect(calls[0].header.Authorization).toBe('Bearer $TOKEN$');
    expect(calls[0].header['X-Product']).toBe('SaaS');
    expect(report.plan).toContain('多套餐包');
    expect(report.windows.map(w => [w.id, w.label, w.usedPercent, w.used, w.limit, w.unit])).toEqual([
      ['pack-0', 'MONTH RESOURCE PACK', 0, 0, 1800, '点'],
      ['pack-1', 'MONTH RESOURCE PACK', 92.7, 463.5, 500, '点'],
    ]);
    expect(report.note).toContain('1,837');

    // Fallback when packages empty: 额度状态未知，不能误报为无限制
    const empty = responder({'https://copilot.tencent.com/billing/meter/get-user-resource-summary': json({Packages: []})});
    const emptyReport = await quotaProviders.workbuddy.fetch(empty.call, {provider: 'workbuddy'});
    expect(emptyReport.windows).toHaveLength(0);
    expect(emptyReport.note).toContain('额度暂未提供');
    expect(emptyReport.note).not.toContain('无活跃');

    // 同样适用于 data 为空对象的情况（FIX-003）
    const blank = responder({'https://copilot.tencent.com/billing/meter/get-user-resource-summary': json({code: 0, msg: 'OK', data: {}})});
    const blankReport = await quotaProviders.workbuddy.fetch(blank.call, {provider: 'workbuddy'});
    expect(blankReport.windows).toHaveLength(0);
    expect(blankReport.note).toContain('额度暂未提供');
  });
  it('parses Qoder quota usage items and calculates percentages', async () => {
    const {call, calls} = responder({
      'https://openapi.qoder.sh/api/v2/quota/usage': json({
        data: {
          plan: '企业高级版',
          items: [
            {name: '高级推理模型', total: 200, used: 50, unit: '次'},
            {name: '日常代码补全', total: 1000, remaining: 800, unit: '次'},
          ],
        },
      }),
    });
    const report = await quotaProviders.qoder.fetch(call, {provider: 'qoder'});
    expect(calls[0].header.Authorization).toBe('Bearer $TOKEN$');
    expect(calls[0].header['Cosy-ClientType']).toBe('CLIProxyAPI');
    expect(report.plan).toBe('企业高级版');
    expect(report.windows.map(w => [w.id, w.label, w.usedPercent, w.used, w.limit])).toEqual([
      ['item-0', '高级推理模型', 25, 50, 200],
      ['item-1', '日常代码补全', 20, 200, 1000],
    ]);
  });
  it('reports ZCode and Trae status separately', async () => {
    const {call, calls} = responder({
      'https://api.z.ai/api/monitor/usage/quota/limit': json({success: true, data: {level: 'PRO', limits: [{type: 'TOKENS_LIMIT', percentage: 25, usage: 1000, currentValue: 250, nextResetTime: 1790427600000}]}}),
    });
    const zcodeReport = await quotaProviders.zcode.fetch(call, {provider: 'zcode'});
    expect(calls[0].header.Authorization).toBe('$TOKEN$');
    expect(zcodeReport.plan).toBe('Z.AI Coding Plan · PRO');
    expect(zcodeReport.windows[0]).toMatchObject({usedPercent: 25, used: 250, limit: 1000});
    expect(zcodeReport.windows[0].resetsAt).toBe(new Date(1790427600000).toISOString());
  });
  it('reads BigModel Coding Plan quota on bigmodel.cn and labels windows by length', async () => {
    const urls: string[] = []; const auth: string[] = [];
    const report = await quotaProviders.zcode.fetch(async request => {
      urls.push(request.url); auth.push(request.header.Authorization);
      return auth.length === 1 ? {statusCode: 401, header: {}, body: '{}'} : json({success: true, data: {level: 'lite', limits: [
        {type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10},
        {type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 40},
        {type: 'TIME_LIMIT', unit: 5, number: 1, usage: 100, currentValue: 3},
      ]}});
    }, {provider: 'zcode', domain: 'bigmodel.cn'});
    expect(urls).toEqual(Array(2).fill('https://bigmodel.cn/api/monitor/usage/quota/limit'));
    expect(auth).toEqual(['$TOKEN$', 'Bearer $TOKEN$']);
    expect(report.plan).toBe('GLM Coding Plan · lite');
    expect(report.windows.map(w => [w.label, w.usedPercent, w.limit])).toEqual([['5 小时模型用量', 10, undefined], ['每周模型用量', 40, undefined], ['工具用量', 3, 100]]);

  });
  it('does not turn a ZCode authentication error into a ready account', async () => {
    await expect(quotaProviders.zcode.fetch(async () => ({statusCode: 401, header: {}, body: '{}'}), {provider: 'zcode'})).rejects.toThrow();
  });
});


it('reads the current Qoder account and organization Credits response instead of hiding quota',async()=>{
 const actual={userType:'pro',totalUsagePercentage:0.51,isQuotaExceeded:false,userQuota:{total:3000,used:1512,remaining:1488,percentage:0.51,unit:'Credits'},orgResourcePackage:{used:0,remaining:6000,percentage:0,unit:'Credits',cap:6000,available:true}};
 const report=await quotaProviders.qoder.fetch(async()=>json(actual),{provider:'qoder'});
 expect(report.windows.map(w=>[w.id,w.used,w.limit,w.usedPercent])).toEqual([['userQuota',1512,3000,50.4],['orgResourcePackage',0,6000,0]]);
 const snake=await quotaProviders.qoder.fetch(async()=>json({user_quota:{total:100,used:25,remaining:75},add_on_quota:{total:50,used:5},shared_quota:{cap:200,used:20,available:true}}),{provider:'qoder'});
 expect(snake.windows.map(w=>[w.id,w.used,w.limit])).toEqual([['userQuota',25,100],['addOnQuota',5,50],['orgResourcePackage',20,200]]);
});
it('distinguishes missing Kimi quota from zero allowance and recognizes ratio windows',async()=>{
 const missing=await quotaProviders.kimi.fetch(async()=>json({}),{provider:'kimi'});expect(missing.windows).toEqual([]);expect(missing.note).toContain('未返回');expect(missing.note).not.toContain('暂无用量');
 const report=await quotaProviders.kimi.fetch(async()=>json({usages:{limit_5h:{used_ratio:0.25,reset_time:'2026-09-23T00:00:00Z'},limit_month_code:{used_ratio:1}},boosterWallet:null}),{provider:'kimi'});
 expect(report.windows.map(w=>[w.id,w.usedPercent])).toEqual([['limit5h',25],['monthCode',100]]);expect(report.windows[0].resetsAt).toBe('2026-09-23T00:00:00.000Z');
 const camel=await quotaProviders.kimi.fetch(async()=>json({usages:{limit7d:{usedRatio:0.5}}}),{provider:'kimi'});expect(camel.windows.map(w=>w.label)).toEqual(['7 天']);
 const zero=await quotaProviders.kimi.fetch(async()=>json({usage:{used:0,limit:0}}),{provider:'kimi'});expect(zero.windows[0].limit).toBe(0);expect(zero.windows[0].usedPercent).toBeNull();
});

it('distinguishes a ZCode account without Coding Plan from authentication or unknown business errors', async () => {
 const noPlan = await quotaProviders.zcode.fetch(async () => json({code: 500, msg: '当前用户不存在coding plan', success: false}), {provider: 'zcode'});
 expect(noPlan.plan).toContain('未开通'); expect(noPlan.windows).toEqual([]); expect(noPlan.note).not.toContain('重新登录');
 await expect(quotaProviders.zcode.fetch(async () => json({code: 500, msg: 'temporary failure', success: false}), {provider: 'zcode'})).rejects.toThrow('未成功');
});

it('does not present a zero-sized Qoder resource package as 100% remaining',async()=>{
 const report=await quotaProviders.qoder.fetch(async()=>json({userQuota:{total:0,used:0,remaining:0,percentage:0},addOnQuota:{total:800,used:67,remaining:733,percentage:0.08}}),{provider:'qoder'});
 expect(report.windows[0]).toMatchObject({limit:0,usedPercent:null,note:expect.stringContaining('未分配额度')});
 expect(report.windows[1].usedPercent).toBe(67/800*100);
});
