export type LoginProviderId = 'codex' | 'claude' | 'claude-manual' | 'antigravity' | 'kimi' | 'xai' | 'qoder' | 'workbuddy' | 'workbuddy-overseas' | 'zcode' | 'zcode-bigmodel' | 'trae';
/** `code`：官方页面显示授权码，由用户粘贴回来，不占用本机端口。 */
export type LoginFlowKind = 'callback' | 'device' | 'code';

/** 上游 `*-auth-url` 接口经过校验后的启动结果。 */
export type LoginStart = {state: string; url: string; userCode?: string; expiresInMs?: number};

/** 每个 Provider 各自实现的登录定义。 */
export type LoginProvider = {
  readonly id: LoginProviderId;
  readonly label: string;
  readonly hint: string;
  readonly flow: LoginFlowKind;
  /** CLIProxyAPI 管理接口路径，如 `/codex-auth-url`。 */
  readonly route: string;
  /** CLIProxyAPI auth 文件中的 provider 名，用于确认账号已保存。 */
  readonly accountProvider: string;
  /** CLIProxyAPI `/v1/models` 返回的 `type` 字段，用于把模型路由回本 Provider。 */
  readonly modelTypes: readonly string[];
  /** 只放行本 Provider 的官方 HTTPS 授权地址。 */
  validateAuthorizationURL(raw: string): URL;
  /** 解析并校验 `*-auth-url` 响应。 */
  parseStart(result: unknown): LoginStart;
  /** 仅回调流程：桌面端自有的 loopback 回调监听参数与提交给上游的 provider 名。 */
  readonly callback?: {port: number; path: string; upstream: string};
  /** 仅授权码流程：粘贴的 `code#state` 提交给上游时使用的 provider 名。 */
  readonly manualCode?: {upstream: string};
};

export type LoginSession = {
  id: string; provider: LoginProviderId; flow: LoginFlowKind; status: string; message: string;
  url?: string; userCode?: string; expiresAt?: string;
  diagnostic?:{stage:import('./diagnostics.js').LoginStage;code:string;reason:string;httpStatus?:number};
};
export type InternalLogin = LoginSession & {state?: string; callbackSubmitted?: boolean;lastPollIssue?:string};

export type LoginOptions = {openExternal?: (url: string) => Promise<void>; pollIntervalMs?: number; loginTimeoutMs?: number};

/** 登录层对 router 层的依赖：进程启动、管理接口与账号刷新。 */
export type LoginHost = {
  start(): Promise<unknown>;
  request(path: string, method?: string, body?: unknown): Promise<unknown>;
  refreshAccounts(): Promise<unknown>;
  accounts(): ReadonlyArray<{provider: string}>;
  modelCount(): number;
  log(message: string): void;
  closing(): boolean;
  options: LoginOptions;
};
