import { callbackProvider } from './callback-flow.js';
import type { LoginProvider } from './types.js';

const spec = {
  id: 'claude', label: 'Claude', hint: '使用 Claude 账号授权',
  route: '/anthropic-auth-url', accountProvider: 'claude', modelTypes: ['claude', 'anthropic'],
  authorization: {host: 'claude.ai', path: '/oauth/authorize'},
  // Claude Code 2.1.3xx opens claude.com/cai/…, which redirects to claude.ai with the same parameters.
  alternateAuthorization: [{host: 'claude.com', path: '/cai/oauth/authorize'}],
  callback: {port: 54545, path: '/callback', upstream: 'anthropic'},
} as const;

function withRedirect(provider: LoginProvider, redirect: string): LoginProvider {
  const validateAuthorizationURL = (raw: string) => {
    const url = provider.validateAuthorizationURL(raw);
    if (url.searchParams.get('redirect_uri') !== redirect) throw new Error('上游返回了非预期的授权回调地址。');
    return url;
  };
  return {...provider, validateAuthorizationURL, parseStart(result) {const started = provider.parseStart(result); validateAuthorizationURL(started.url); return started;}};
}

/** Claude 账号。授权码流程，官方回跳到 localhost:54545。 */
export const claude = withRedirect(callbackProvider(spec), 'http://localhost:54545/callback');

/** 与 Claude Code 的手动登录相同：官方页面显示 `code#state`，粘贴回来即可，不需要本机端口。 */
export const claudeManual: LoginProvider = {
  ...withRedirect(callbackProvider({...spec, id: 'claude-manual', label: 'Claude（授权码）', route: '/anthropic-auth-url?mode=manual'}), 'https://platform.claude.com/oauth/code/callback'),
  flow: 'code', callback: undefined, manualCode: {upstream: 'anthropic'},
};
