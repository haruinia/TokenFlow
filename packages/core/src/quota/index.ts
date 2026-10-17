// 额度层入口：按登录 Provider 注册额度查询实现。
import type { LoginProviderId } from '../login/types.js';
import { codexQuota } from './codex.js';
import { claudeQuota } from './claude.js';
import { antigravityQuota } from './antigravity.js';
import { kimiQuota } from './kimi.js';
import { xaiQuota } from './xai.js';
import { workbuddyQuota } from './workbuddy.js';
import { qoderQuota } from './qoder.js';
import { zcodeQuota } from './zcode.js';
import { traeQuota } from './trae.js';
import type { QuotaProvider } from './types.js';

export const quotaProviders: Readonly<Record<LoginProviderId, QuotaProvider>> = {
  codex: codexQuota,
  claude: claudeQuota,
  'claude-manual': claudeQuota,
  antigravity: antigravityQuota,
  kimi: kimiQuota,
  xai: xaiQuota,
  workbuddy: workbuddyQuota,
  'workbuddy-overseas':workbuddyQuota,
  qoder: qoderQuota,
  zcode: zcodeQuota,
  'zcode-bigmodel': zcodeQuota,
  trae: traeQuota,
};
export { QuotaHTTPError } from './shared.js';
export type { AccountQuota, QuotaAccount, QuotaCall, QuotaProvider, QuotaReport, QuotaRequest, QuotaResponse, QuotaWindow } from './types.js';
