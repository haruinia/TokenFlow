import {callbackPage} from './callback-page.js';
// 授权码 + 本机 loopback 回调流程（Codex / Claude / Antigravity）。
import { createServer as createHTTPServer, type Server, type RequestListener } from 'node:http';
import { z } from 'zod';
import type { LoginProvider, LoginProviderId } from './types.js';

export type CallbackSpec = {
  id: LoginProviderId; label: string; hint: string; route: string; accountProvider: string; modelTypes: readonly string[];
  authorization: {host: string; path: string};
  /** Other official authorization pages for the same client, e.g. a newer domain that redirects to the old one. */
  alternateAuthorization?: ReadonlyArray<{host: string; path: string}>;
  callback: {port: number; path: string; upstream: string};
};
const startSchema = z.object({status: z.literal('ok'), url: z.string(), state: z.string().min(1)});

export function callbackProvider(spec: CallbackSpec): LoginProvider {
  const allowed = [spec.authorization, ...(spec.alternateAuthorization ?? [])];
  const validateAuthorizationURL = (raw: string) => {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !allowed.some(page => url.hostname === page.host && url.pathname === page.path) ||
        url.port || url.username || url.password || url.hash) throw new Error('上游返回了非预期的授权地址。');
    return url;
  };
  return {
    id: spec.id, label: spec.label, hint: spec.hint, flow: 'callback', route: spec.route,
    accountProvider: spec.accountProvider, modelTypes: spec.modelTypes, callback: spec.callback,
    validateAuthorizationURL,
    parseStart(result) {
      const parsed = startSchema.parse(result);
      const url = validateAuthorizationURL(parsed.url);
      const stateFromRedirect = (() => {
        const redirect = url.searchParams.get('redirect_url');
        if (!redirect) return null;
        try {
          const target = new URL(redirect);
          return target.searchParams.get('state') ?? (spec.id === 'trae' ? target.searchParams.get('login_trace_id') : null);
        } catch {
          return null;
        }
      })();
      const state = url.searchParams.get('state') ?? stateFromRedirect;
      if (state !== parsed.state) throw new Error('授权会话校验失败，请重新连接。');
      return {state: parsed.state, url: url.href};
    },
  };
}

/** 校验用户粘贴或浏览器回跳的 localhost 回调地址属于本次会话。 */
export function validateCallbackURL(provider: LoginProvider, value: string, state: string) {
  if (!provider.callback) throw new Error(`${provider.label} 使用设备码授权，不需要回调地址。`);
  const url = new URL(value);
  // Trae echoes login_trace_id as loginTraceID; it does not echo OAuth state.
  if (provider.id === 'trae') {
    const trace = url.searchParams.get('loginTraceID');
    if (trace && (trace !== state || (url.searchParams.has('state') && url.searchParams.get('state') !== trace))) throw new Error('授权会话校验失败，请重新连接。');
    if (trace) url.searchParams.set('state', trace);
    const host = url.searchParams.get('host');
    if (host) {
      const api = new URL(host);
      if (api.protocol !== 'https:' || !api.hostname.endsWith('.trae.ai') || api.port || api.username || api.password || api.pathname !== '/' || api.search || api.hash) throw new Error('Trae 返回了非预期的服务地址。');
    }
  }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== String(provider.callback.port) ||
      url.pathname !== provider.callback.path || url.username || url.password || url.hash || url.searchParams.get('state') !== state ||
      (!url.searchParams.get('code') && !url.searchParams.get('error') && !url.searchParams.get('authCodeInfo') && !(provider.id === 'trae' && url.searchParams.get('userJwt') && url.searchParams.get('refreshToken')))) throw new Error('请粘贴本次授权完成后的完整 localhost 回调地址，不能使用旧会话地址。');
  return url;
}

/** 校验粘贴的授权码：官方页面显示 `code#state`，state 必须属于本次会话。 */
export function parseManualCode(value: string, state: string) {
  const [code, pasted, ...rest] = value.trim().split('#');
  if (!code || pasted !== state || rest.length || !/^[\w.~-]+$/.test(code)) throw new Error('请粘贴本次授权页面显示的完整授权码（含 # 后半段），不能使用旧会话的授权码。');
  return {code, state};
}

/** 上游 web-UI 转发器绑定 0.0.0.0；这里改为只监听 loopback 的自有回调。 */
export async function listenForCallback(provider: LoginProvider, submit: (redirectURL: string) => Promise<unknown>): Promise<Server[]> {
  const callback = provider.callback;
  if (!callback) return [];
  const {port, path} = callback;
  const handler: RequestListener = async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.method !== 'GET' || ![`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(request.headers.host ?? '') ||
        request.url?.split('?')[0] !== path) {response.writeHead(400); response.end('无效授权回调。'); return;}
    try {
      await submit(`http://localhost:${port}${request.url}`);
      response.end(callbackPage(true));
    } catch {response.writeHead(400); response.end(callbackPage(false));}
  };
  const servers: Server[] = [];
  try {
    for (const host of ['127.0.0.1', '::1']) {
      const server = createHTTPServer(handler);
      server.requestTimeout = 10000; server.headersTimeout = 5000;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen({port, host, ipv6Only: host === '::1'}, resolve);
        });
      } catch (error) {
        if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
      servers.push(server); server.unref();
    }
  } catch (error) {
    for (const server of servers) server.close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // The official redirect URIs are registered with a fixed port, so another port cannot be used instead.
      const sharing = port === 1455 ? '（Codex 官方登录、终端里的 codex login 和 Trae 授权都使用这个端口）' : '';
      const fallback = provider.id === 'claude' ? '也可以改用「授权码登录」，不需要本机端口。' : '';
      throw new Error(`授权回调端口 ${port} 已被占用${sharing}。请先完成或关闭其他登录流程后重试。${fallback}`);
    }
    throw new Error(`授权回调端口 ${port} 无法监听。请关闭其他登录流程后重试。`);
  }
  return servers;
}
