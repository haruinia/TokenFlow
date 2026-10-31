// 额度层公共类型。额度层只读：每个 Provider 一个模块，通过 CLIProxyAPI 的管理接口 `/api-call`
// 用已登录账号的凭据（`$TOKEN$` 由上游替换，桌面端不接触 token）查询官方用量接口，并归一化为窗口列表。
import type { LoginProviderId } from '../login/types.js';

/** 一个额度窗口：如 5 小时 / 7 天 / 本周 credits / 月度美元额度。 */
export type QuotaWindow = {
  id: string; label: string;
  /** 已用百分比 0–100；上游只给剩余比例或原始计数时由各 Provider 换算。 */
  usedPercent: number | null;
  used?: number; limit?: number; remaining?: number; unit?: string;
  /** ISO 时间，窗口重置时刻。 */
  resetsAt?: string;
  note?: string;
};
export type QuotaReport = {plan?: string; windows: QuotaWindow[]; note?: string; resetCredits?:number};

export type QuotaRequest = {method: 'GET' | 'POST'; url: string; header: Record<string, string>; data?: string};
export type QuotaResponse = {statusCode: number; header: Record<string, string[]>; body: string};
/** 由 router 层提供：把请求交给 CLIProxyAPI `/api-call`，并绑定到某个 auth_index。 */
export type QuotaCall = (request: QuotaRequest) => Promise<QuotaResponse>;

/** router 层从 auth-files 摘要中提取的非敏感账号信息。 */
export type QuotaAccount = {domain?:string; provider: string; email?: string; projectId?: string; chatgptAccountId?: string; planType?: string; accountType?: string};

export type QuotaProvider = {
  readonly id: LoginProviderId;
  fetch(call: QuotaCall, account: QuotaAccount): Promise<QuotaReport>;
};

/** 归一化后的单账号额度快照，进入 UI。 */
export type AccountQuota = {
  accountId: string; provider: LoginProviderId | 'cursor'; status: 'ok' | 'error';
  observedAt: string; lastSuccessfulAt?: string; plan?: string; windows: QuotaWindow[]; note?: string; error?: string; resetCredits?:number;
};
