import { deviceProvider } from './device-flow.js';

/** 使用官方 CLI 轮询授权，回调由 ZCode 服务器接收。 */
const provider = deviceProvider({
  id: 'zcode',
  label: 'ZCode',
  hint: '智谱 ZCode / Z.AI 账号授权',
  route: '/zcode-auth-url',
  accountProvider: 'zcode',
  modelTypes: ['zcode'],
  verification: { host: 'chat.z.ai', path: '/api/oauth/authorize' },
  requireUserCode: false,
});

const callback = 'https://zcode.z.ai/api/v1/oauth/cli/callback/';

export const zcode = {
  ...provider,
  validateAuthorizationURL(raw: string) {
    const url = provider.validateAuthorizationURL(raw);
    if (url.searchParams.get('redirect_uri') !== callback + 'zai') {
      throw new Error('ZCode 授权回调配置已过期，请更新 Local Agent 后重新连接。');
    }
    return url;
  },
  parseStart(result: unknown) {
    const started = provider.parseStart(result);
    this.validateAuthorizationURL(started.url);
    return started;
  },
};

/** 智谱开放平台（BigModel）账号走同一套 ZCode CLI 轮询，在 bigmodel.cn 登录。 */
const bigmodelProvider = deviceProvider({
  id: 'zcode-bigmodel',
  label: 'ZCode（智谱 BigModel）',
  hint: '智谱开放平台 BigModel 账号授权',
  route: '/zcode-auth-url?provider=bigmodel',
  accountProvider: 'zcode',
  modelTypes: [],
  verification: { host: 'bigmodel.cn', path: '/login' },
  requireUserCode: false,
});

export const zcodeBigModel = {
  ...bigmodelProvider,
  validateAuthorizationURL(raw: string) {
    const url = bigmodelProvider.validateAuthorizationURL(raw);
    if (!url.searchParams.get('redirect_uri')?.startsWith(callback)) {
      throw new Error('ZCode 授权回调配置已过期，请更新 Local Agent 后重新连接。');
    }
    return url;
  },
  parseStart(result: unknown) {
    const started = bigmodelProvider.parseStart(result);
    this.validateAuthorizationURL(started.url);
    return started;
  },
};
