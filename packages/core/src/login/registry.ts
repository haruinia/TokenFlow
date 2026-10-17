// Provider 注册表与模型路由反查。
import { z } from 'zod';
import { codex } from './codex.js';
import { claude, claudeManual } from './claude.js';
import { antigravity } from './antigravity.js';
import { kimi } from './kimi.js';
import { xai } from './xai.js';
import { qoder } from './qoder.js';
import { workbuddy, workbuddyOverseas } from './workbuddy.js';
import { zcode, zcodeBigModel } from './zcode.js';
import { trae } from './trae.js';
import type { LoginProvider, LoginProviderId } from './types.js';

export const loginProviders: Readonly<Record<LoginProviderId, LoginProvider>> = {
  codex, claude, 'claude-manual':claudeManual, antigravity, kimi, xai, qoder, workbuddy, 'workbuddy-overseas':workbuddyOverseas, zcode, 'zcode-bigmodel':zcodeBigModel, trae,
};
export const loginProviderIds = Object.keys(loginProviders) as [LoginProviderId, ...LoginProviderId[]];
export const loginProviderSchema = z.enum(loginProviderIds);
export const isLoginProvider = (value: string): value is LoginProviderId => value in loginProviders;
/** Second sign-in entries that save into another platform's account list. */
const secondaryLogins=new Set<LoginProviderId>(['claude-manual','workbuddy-overseas','zcode-bigmodel']);

/** 给 UI 的 Provider 目录（不含任何敏感信息）。 */
export const loginProviderCatalog = () => loginProviderIds.filter(id=>!secondaryLogins.has(id)).map(id => {
  const {label, hint, flow} = loginProviders[id];
  return {id, label, hint, flow};
});

export function validateAuthorizationURL(raw: string, provider: LoginProviderId) {
  return loginProviders[loginProviderSchema.parse(provider)].validateAuthorizationURL(raw);
}

/** 由 `/v1/models` 的 `type` / `owned_by` 反查该模型由哪个登录 Provider 的账号承接。 */
export function routeModelToProvider(type?: string, ownedBy?: string): LoginProviderId | undefined {
  for (const id of loginProviderIds) {
    const types = loginProviders[id].modelTypes;
    if ((type && types.includes(type)) || (ownedBy && types.includes(ownedBy))) return id;
  }
  return undefined;
}
