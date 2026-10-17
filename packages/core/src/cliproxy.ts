import {CredentialHistory} from './credential-history.js';
import {credentialIdentity,credentialFingerprint,compareCredentials,credentialPreference,credentialSubject,credentialEmail} from './credential-identity.js';
import {desktopCredentialSchema,desktopPoolProvider,workbuddyLoginDomain,workbuddyLoginIssue,workbuddyLoginTarget,type DesktopProvider} from './desktop-accounts.js';
import { retryQuotaCall, QuotaTransportError, transientQuotaStatus } from './quota/retry.js';
import {qoderAccountingReader} from './qoder-accounting.js';
import {accountLabel} from './account-label.js';
import { nativeCredentialSchema, nativeConflict, type NativeProvider } from './native-accounts.js';
import { readConfig } from './agent-connections.js';
import { CursorProvider,cursorCatalog } from './cursor.js';
import { RunnerCoreError } from './errors.js';
// Router 层：受管 CLIProxyAPI 进程、管理接口、已保存账号与模型路由表。
// 对话层始终发送 Responses 请求到 127.0.0.1:<port>/v1；CLIProxyAPI 按模型转换为各家协议，
// 并路由到登录层保存的账号。登录流程本身见 ./login。
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile, chmod, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { safeEnvironment } from './process-environment.js';
import {createNetworkProxy,type NetworkSnapshot} from './network-proxy.js';
import {checkNetwork,type NetworkCheckReport} from './network-check.js';
import {safeFailure} from './login/diagnostics.js';
import { LoginController, loginProviderCatalog, isLoginProvider, routeModelToProvider, type LoginOptions, type LoginProviderId } from './login/index.js';
import { quotaProviders, QuotaHTTPError, type AccountQuota, type QuotaAccount, type QuotaRequest, type QuotaResponse } from './quota/index.js';

export { validateAuthorizationURL } from './login/index.js';
export type { LoginSession } from './login/index.js';
export type { AccountQuota, QuotaWindow } from './quota/index.js';

const accountSchema = z.object({
  id: z.string().optional(), name: z.string(), provider: z.string().optional(), type: z.string().optional(),
  status_message: z.string().optional(), email: z.string().optional(), label: z.string().optional(), status: z.string().optional(),
  nickname:z.string().optional(),uid:z.string().optional(),
  disabled: z.boolean().optional(), unavailable: z.boolean().optional(),
  next_retry_after: z.string().optional(),
  runtime_only: z.boolean().optional(),modtime:z.string().optional(),
  // 额度查询所需的非敏感字段；auth_index 只留在进程内，不进快照。
  auth_index: z.union([z.string(), z.number()]).optional(), project_id: z.string().optional(), account_type: z.string().optional(),
  id_token: z.object({chatgpt_account_id: z.string().optional(), plan_type: z.string().optional()}).passthrough().optional(),
});
const modelSchema = z.object({id: z.string(), display_name: z.string().optional(), type: z.string().optional(), owned_by: z.string().optional(), supportedInputModalities:z.array(z.string()).optional()});
const apiCallSchema = z.object({status_code: z.number().int(), header: z.record(z.array(z.string())).default({}), body: z.string().default('')});
export function revokedCredential(file:{status?:string;status_message?:string}){return file.status==='error'&&/\b(?:invalid_grant|refresh_token_revoked|refresh_token_reused|refresh_token_expired)\b/i.test(file.status_message??'');}
export type LocalAccount = {id: string; provider: string; label: string; nativeClients?:string[]; status: string; disabled: boolean; unavailable: boolean; retryable?:boolean; isDuplicate?: boolean;preferredCredentialId?:string;credentialCount?:number; modelError?:string; models?: string[]};
/** `provider` 为承接该模型的登录 Provider；未知类型（如 Gemini API Key）为空。 */
// Unknown capabilities remain unknown; never infer vision from a model name.
function modelImageCapabilities(model:z.infer<typeof modelSchema>,provider:string){
 const modalities=model.supportedInputModalities;
 if(!modalities?.length)return {};
 // These adapters currently drop image payloads, even for a multimodal base model.
 return {capabilities:{text:true,tools:true,images:!['qoder','cursor'].includes(provider)&&modalities.some(value=>value.toLowerCase()==='image')}};
}
export type LocalModel = {id: string; displayName?: string; provider?: LoginProviderId | 'cursor' | 'api';textOnly?:boolean;capabilities?:{text:boolean;tools:boolean;images:boolean}};
export type CLIProxyOptions = LoginOptions & {outboundProxyURL?:string;networkSnapshot?:()=>NetworkSnapshot;secrets?:{get:(name:string)=>Promise<string>;set:(name:string,value:string)=>Promise<void>};apiConfig?:()=>string;apiModelIDs?:()=>string[]};

export class CLIProxyManager {
  readonly cursor:CursorProvider;
  private credentialHistory:CredentialHistory;
  private cursorLoginSelected=false;
  private authIDs = new Map<string,string>();
  private credentialGroups=new Map<string,string[]>();
  private child?: ChildProcess;
  private busy = false;
  private closing = false;
  private requests = new AbortController();
  private startTask?: Promise<LocalAgentSnapshot>;
  private refreshTask?: Promise<LocalAgentSnapshot>;
  private refreshScope?: LoginProviderId;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private emptyRefreshes = 0;
  private providerRefreshTimes=new Map<string,number>();
  private providerRefreshTasks=new Map<string,Promise<LocalAgentSnapshot>>();
  private quotaTask?: Promise<LocalAgentSnapshot>;
  private quotaProviderTasks=new Map<LoginProviderId|'cursor',Promise<LocalAgentSnapshot>>();
  private aliases: Record<string, {name: string; alias: string; fork: boolean}[]> = {};
  private lastError?: string;
  private recent: string[] = [];
  private configPath: string;
  private state = 'stopped';
  private managementKey = randomBytes(32).toString('hex');
  private accounts: LocalAccount[] = [];
  private names = new Map<string, string>();
  private quotaTargets = new Map<string, {authIndex: string; account: QuotaAccount}>();
  private quotas: Record<string, AccountQuota> = {};
  private get quotaBusy():boolean{return !!this.quotaTask||this.quotaProviderTasks.size>0;}
  private models: LocalModel[] = [];
  private apiModels=new Set<string>();
  private configurationTask:Promise<void>=Promise.resolve();
  private network?:Awaited<ReturnType<typeof createNetworkProxy>>;
  private networkCheck?:NetworkCheckReport;
  private networkCheckTask?:Promise<NetworkCheckReport>;
  private networkCheckAbort?:AbortController;
  async checkNetwork(){
    if(this.networkCheckTask)return this.networkCheckTask;
    this.networkCheckAbort=new AbortController();
    this.networkCheckTask=checkNetwork({port:this.port,key:this.key,managementKey:this.managementKey,signal:this.networkCheckAbort.signal,log:message=>this.log(message)}).then(report=>{this.networkCheck=report;return report;}).finally(()=>{this.networkCheckTask=undefined;this.networkCheckAbort=undefined;});
    return this.networkCheckTask;
  }
  accountBaseURL(id:string){const info=this.quotaTargets.get(id)?.account;return info?.provider==='workbuddy'&&['www.workbuddy.ai','https://www.workbuddy.ai'].includes(info.domain??'')?'https://www.workbuddy.ai':undefined;}
  private publishAPIModels(ids:Iterable<string>){
    const configured=new Set(this.options.apiModelIDs?.()??[]);
    // A stale refresh during a reload must not erase an already confirmed route.
    // Removed/disabled configured models are never retained.
    this.apiModels=new Set([...this.apiModels].filter(id=>configured.has(id)));
    for(const id of ids)if(/^api-[a-f0-9]{24}\//.test(id)&&configured.has(id))this.apiModels.add(id);
  }
  apiModelAvailable(id:string){return this.state==='running'&&this.apiModels.has(id);}
  private accountError?: string;
  private readonly login_: LoginController;
  constructor(readonly root: string, readonly binary: string, private key: string,
    readonly port = 8317, private options: CLIProxyOptions = {}) {
    this.credentialHistory=new CredentialHistory(root,options.secrets);
    this.cursor=new CursorProvider(root,options.secrets??{get:async()=>'',set:async()=>{throw new Error('Credential storage unavailable');}},options.openExternal);
    this.configPath = join(root, 'cliproxy', 'config.yaml');
    this.login_ = new LoginController({
      start: () => this.start(), request: (path, method, body) => this.request(path, method, body),
      refreshAccounts: () => this.refreshAccounts(), accounts: () => this.accounts, modelCount: () => this.models.length,
      log: message => this.log(message), closing: () => this.closing, options: this.options,
    });
  }
  snapshot() {
    const cursor=this.cursor.snapshot();
    const accounts=this.accounts.map(account=>{const ids=this.credentialGroups.get(account.id);return !account.isDuplicate&&ids?.length?{...account,models:[...new Set(this.accounts.filter(a=>ids.includes(a.id)&&!a.disabled&&(!a.unavailable||a.retryable)).flatMap(a=>a.models??[]))]}:account;});
    return structuredClone({state: this.state, loginState: this.login_.state, port: this.port,
      logs: this.recent,...(this.networkCheck?{networkCheck:this.networkCheck}:{}),...(this.options.networkSnapshot||this.network?{network:this.options.networkSnapshot?.()??this.network!.snapshot()}:{}), accounts: [...accounts,...cursor.accounts], models: [...this.models,...(this.state==='running'?cursor.models:[])], accountError: this.accountError, lastError: this.lastError,
      quotas: {...this.quotas,...cursor.quotas}, quotaBusy: this.quotaBusy, providers: [...loginProviderCatalog(),cursorCatalog], login: this.cursorLoginSelected?cursor.login:this.login_.snapshot()});
  }
  isLoadingAccounts(){return !!this.startTask||!!this.refreshTask||!!this.refreshTimer;}
  /** 内部 sidecar 地址和密钥；不含 Cursor SDK 模型，不进 snapshot / 日志。 */
  gateway() {
    return {baseURL: `http://127.0.0.1:${this.port}/v1`, apiKey: this.key, running: this.state === 'running'};
  }
  async setClientKey(value: string) {
    const key = value.trim();
    if (key.length < 8 || key.length > 256) throw new Error('API Key 长度须为 8–256 个字符。');
    if (!/^[\x21-\x7e]+$/.test(key)) throw new Error('API Key 只能包含可见 ASCII 字符，不能有空格或换行。');
    if (key === this.managementKey) throw new Error('不能使用内部管理密钥作为 API Key。');
    if (key === this.key) return this.gateway();
    if (this.login_.isPending()) throw new Error('请先完成或取消当前账号授权，再更改 API Key。');
    this.key = key;
    await this.configure();
    if (this.child) {await this.stop(); await this.start();}
    this.log('已更新本机 API Key');
    return this.gateway();
  }
  private log(message: string) {
    this.recent.push(`${new Date().toISOString()} ${message}`);
    this.recent = this.recent.slice(-100);
  }
  configure() {
    const task=this.configurationTask.catch(()=>undefined).then(()=>this.writeConfiguration());
    this.configurationTask=task;
    return task;
  }
  private async writeConfiguration() {
    const dir = join(this.root, 'cliproxy');
    await mkdir(join(dir, 'auth'), {recursive: true, mode: 0o700});
    await chmod(dir, 0o700);
    // Upstream management stays on loopback. Neither key is returned to the renderer.
    const yaml = `host: "127.0.0.1"\nport: ${this.port}\nauth-dir: ${JSON.stringify(join(dir, 'auth'))}\napi-keys:\n  - ${JSON.stringify(this.key)}\nremote-management:\n  allow-remote: false\n  secret-key: ${JSON.stringify(this.managementKey)}\n  disable-control-panel: true\ndebug: false\nlogging-to-file: false\nrequest-log: false\nrequest-retry: 0\noauth-model-alias: ${JSON.stringify(this.aliases)}\n`;
    const outboundProxy=this.options.outboundProxyURL??this.network?.url;
    await writeFile(this.configPath+'.tmp', yaml+(outboundProxy?`proxy-url: ${JSON.stringify(outboundProxy)}\n`:'')+(this.options.apiConfig?.()??''), {mode: 0o600});
    await rename(this.configPath+'.tmp',this.configPath);
    await chmod(this.configPath, 0o600);
  }
  async synchronizeAPIModels(ids:string[]) {
    await this.configure();
    if(this.state!=='running'||!ids.length)return;
    for(let attempt=0;attempt<40;attempt++){
      try{const live=z.object({data:z.array(modelSchema)}).parse(await this.request('/models','GET',undefined,false,1500));this.publishAPIModels(live.data.map(m=>m.id));if(ids.every(id=>this.apiModels.has(id)))return;}catch{/* A reload may briefly stop serving. */}
      await new Promise(r=>setTimeout(r,100));
    }
    throw new RunnerCoreError('API 来源已保存，但网关模型路由尚未同步。请稍后重新保存，或重启网关；不会切换到其他来源。',{statusCode:503,code:'api_routes_pending'});
  }
  private async request(path: string, method = 'GET', body?: unknown, management = true, timeoutMs = 10000): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${this.port}${management ? '/v0/management' : '/v1'}${path}`, {
      method, headers: {Authorization: `Bearer ${management ? this.managementKey : this.key}`, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.requests.signal]), redirect: 'error',
    }).catch(() => {throw path==='/api-call'?new QuotaTransportError('额度查询连接失败或超时。'):new Error('无法连接 Local Agent，请检查服务状态后重试。');});
    if (!response.ok) {
      await response.body?.cancel();
      if(path==='/api-call'&&transientQuotaStatus(response.status))throw new QuotaTransportError(`额度上游连接失败（HTTP ${response.status}），网关已响应。`);
      if(path==='/api-call')throw new Error(response.status>=500?`额度上游连接失败（HTTP ${response.status}），网关已响应。请稍后重试或检查网络与代理；不代表账号授权丢失。`:`额度查询网关请求失败（HTTP ${response.status}），请刷新网关状态后重试。`);
      throw new Error(`Local Agent 接口请求失败（HTTP ${response.status}）。请检查网关状态后重试。`);
    }
    return response.json().catch(error => {if(path==='/api-call'&&!(error instanceof SyntaxError))throw new QuotaTransportError('额度查询连接中断或超时。');throw new Error('Local Agent 返回了无效响应，请重启服务后重试。');});
  }
  start(): Promise<LocalAgentSnapshot> {
    if (this.startTask) return this.startTask;
    this.startTask = this.startProcess().finally(() => {this.startTask = undefined;});
    return this.startTask;
  }
  private async startProcess() {
    if (this.closing) throw new Error('Local Agent 正在退出');
    if (this.busy) throw new Error('Local Agent 正在启动或停止');
    if (this.child) return this.snapshot();
    void this.cursor.load().catch(()=>this.log('Cursor 授权读取失败，其他来源继续可用。'));
    this.busy = true;
    this.emptyRefreshes = 0;
    this.providerRefreshTimes.clear();
    this.state = 'starting'; this.lastError = undefined; this.requests = new AbortController();
    try {
      if(!this.options.outboundProxyURL&&!this.network)this.network=await createNetworkProxy();
      await this.configure();
      await new Promise<void>((resolve, reject) => {
        const server = createServer();
        server.once('error', () => reject(new Error(`端口 ${this.port} 已被占用，未接管已有服务。`)));
        server.listen(this.port, '127.0.0.1', () => server.close(() => resolve()));
      });
      const child = spawn(this.binary, ['-config', this.configPath], {
        env: safeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], cwd: join(this.root, 'cliproxy'),
      });
      this.child = child;
      let failure: Error | undefined;
      child.on('error', () => {
        failure = new Error('CLIProxyAPI 二进制无法启动；请先运行 npm run sidecar:build');
        this.state = 'failed'; this.child = undefined;
      });
      child.on('exit', code => {
        if (this.child === child) this.child = undefined;
        this.state = code === 0 ? 'stopped' : 'failed';
        this.login_.fail('Local Agent 已退出，请重新启动并连接账号。');
        this.log(`Local Agent 已退出 (${code})`);
      });
      // Retain only validated Qoder billing scalars; discard all other sidecar output.
      for(const stream of [child.stdout,child.stderr]) {
        const receive=qoderAccountingReader(message=>this.log(message));
        stream?.on('data',receive);
      }
      for (let i = 0; i < 100; i++) {
        if (failure) throw failure;
        if (child.exitCode !== null) throw new Error('CLIProxyAPI 启动失败');
        let ready = false;
        try {
          const response = await fetch(`http://127.0.0.1:${this.port}/v1/models`, {
            headers: {Authorization: `Bearer ${this.key}`}, signal: AbortSignal.timeout(500),
          });
          ready = response.ok; await response.body?.cancel();
        } catch { /* Readiness may lag process startup. */ }
        if (ready) {
          this.state = 'running'; this.log('Local Agent 已就绪');
          await this.refreshAccounts().catch(() => undefined);
          return this.snapshot();
        }
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('CLIProxyAPI 健康检查超时');
    } catch (error) {
      await this.terminate(this.child); this.child = undefined; this.state = 'failed';
      this.lastError = error instanceof Error ? error.message : '网关启动失败'; this.log(this.lastError); throw error;
    } finally { this.busy = false; }
  }
  private async terminate(child?: ChildProcess) {
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
      child.once('exit', () => {clearTimeout(timer); resolve();});
      child.once('error', () => {clearTimeout(timer); resolve();});
      child.kill('SIGTERM');
    });
  }
  async stop() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer=undefined;
    if (this.startTask) await this.startTask.catch(() => undefined);
    if (this.busy) throw new Error('Local Agent 正在切换状态');
    this.busy = true;
    try {
      if (this.login_.isPending()) {
        try {await this.login_.cancel(this.login_.snapshot()!.id);}
        catch {this.log('无法确认授权取消；停止进程以终止本次授权。');}
      }
      clearTimeout(this.refreshTimer);
      this.refreshTimer=undefined;
      this.requests.abort();
      await this.terminate(this.child); this.child = undefined; this.state = 'stopped';
      await this.refreshTask?.catch(() => undefined); await this.quotaTask?.catch(() => undefined);
      await Promise.allSettled([...this.quotaProviderTasks.values()]);
      this.models = []; this.log('Local Agent 已停止'); return this.snapshot();
    } finally {this.busy = false;}
  }
  /** 从每个账号的模型目录建立独立命名空间，实际注册到网关，而非只改显示文本。 */
  refreshAccounts(provider?:LoginProviderId,refreshUsage=true): Promise<LocalAgentSnapshot> {
    if (this.refreshTask) return !this.refreshScope||this.refreshScope===provider?this.refreshTask:this.refreshTask.catch(()=>undefined).then(()=>this.refreshAccounts(provider,refreshUsage));
    clearTimeout(this.refreshTimer);
    this.refreshScope=provider;
    this.refreshTimer=undefined;
    this.refreshTask = this.loadAccounts(provider,refreshUsage).finally(() => {
      this.refreshTask = undefined;
      this.refreshScope=undefined;
      if(this.state==='running'&&!this.closing&&!this.requests.signal.aborted){
        const pending=!!this.accountError||this.accounts.some(a=>!a.disabled&&!a.unavailable&&!a.models?.length&&!a.modelError);
        this.emptyRefreshes=pending?this.emptyRefreshes+1:0;
        if(pending&&this.emptyRefreshes<=10){
          this.refreshTimer=setTimeout(()=>{void this.refreshAccounts().catch(()=>undefined);},1000);
          this.refreshTimer.unref();
        }else if(pending)this.accountError='账号或模型同步未完成，请点击刷新重试。';
      }
    });
    return this.refreshTask;
  }
  private async loadAccounts(providerScope?:LoginProviderId,refreshUsage=true) {
    if (this.state !== 'running') throw new Error('请先启动 Local Agent');
    try {
      const result = z.object({files: z.array(accountSchema)}).parse(await this.request('/auth-files'));
      if(providerScope)result.files=result.files.filter(file=>(file.provider??file.type)===providerScope);
      // Only explicit terminal OAuth refresh errors prove revocation; quota 401/403 and duplicate labels do not.
      const removed=new Set<string>();
      for(const file of result.files.filter(revokedCredential)){
        if(file.name.includes('/')||file.name.includes('\\'))continue;
        try{
          const raw=await readConfig(join(this.root,'cliproxy','auth',file.name));if(raw===null)continue;
          const archive=join(this.root,'revoked-credentials');await mkdir(archive,{recursive:true,mode:0o700});await chmod(archive,0o700);
          await writeFile(join(archive,`${createHash('sha256').update(file.name+raw).digest('hex')}.json`),raw,{mode:0o600});
          await this.request(`/auth-files?name=${encodeURIComponent(file.name)}`,'DELETE');removed.add(file.name);
        }catch{/* Keep the credential if archival or removal fails; never log its contents. */}
      }
      result.files=result.files.filter(file=>!removed.has(file.name)&&!file.runtime_only);
      const retained=providerScope?this.accounts.filter(account=>account.provider!==providerScope):[];
      const retainedIDs=new Set(retained.map(account=>account.id));
      const names = new Map([...this.names].filter(([id])=>retainedIDs.has(id)));
      const authIDs = new Map([...this.authIDs].filter(([id])=>retainedIDs.has(id)));
      const quotaTargets = new Map([...this.quotaTargets].filter(([id])=>retainedIDs.has(id)));
      // Local display names never change the upstream authentication identity.
      let accountLabels:Record<string,string>={};
      try{accountLabels=z.record(z.string().trim().min(1).max(200)).parse(JSON.parse(await readConfig(join(this.root,'account-labels.json'))??'{}'));}catch{/* Optional local display metadata. */}
      const identities=new Map<string,string>();const credentials=new Map<string,{raw:Record<string,unknown>;modified?:unknown}>();
      const accounts: LocalAccount[] = [...retained,...await Promise.all(result.files.map(async file => {
        const id = createHash('sha256').update(file.name).digest('hex').slice(0, 24);
        names.set(id, file.name);
        if(file.id)authIDs.set(id,file.id);
        const provider = file.provider ?? file.type ?? 'unknown';
        let identity:Record<string,unknown>={};
        if(!file.name.includes('/')&&!file.name.includes('\\')){
          try{const raw=await readConfig(join(this.root,'cliproxy','auth',file.name));if(raw)identity=JSON.parse(raw);}catch{/* Keep the sidecar label if the credential is being refreshed. */}
        }
        if(Object.keys(identity).length)await this.credentialHistory.remember(provider,[identity]);
        const identityKey=credentialIdentity(provider,identity,file);if(identityKey)identities.set(id,identityKey);
        credentials.set(id,{raw:identity,modified:file.modtime});
        const expired=typeof identity.access_token==='string'&&!!identity.access_token&&credentialPreference(identity)[0]===0;
        if (file.auth_index !== undefined) quotaTargets.set(id, {authIndex: String(file.auth_index), account: {provider, email: file.email, domain:provider==='trae'&&typeof identity.host==='string'?identity.host:provider==='zcode'&&identity.provider==='bigmodel'?'bigmodel.cn':typeof identity.domain==='string'?identity.domain:undefined,
          projectId: file.project_id, accountType: file.account_type, chatgptAccountId: file.id_token?.chatgpt_account_id, planType: file.id_token?.plan_type}});
        return {
          id, provider, label: accountLabels[id]??accountLabel(provider,file,{...identity,uid:identity.uid??credentialSubject(identity)}),
          // Product eligibility is independent of installation, native login and enabled state.
          ...(provider==='qoder'?{nativeClients:['qoder','qoder-ide']}:provider==='workbuddy'?{nativeClients:[workbuddyLoginTarget(typeof identity.domain==='string'?identity.domain:undefined)].filter((id):id is NonNullable<typeof id>=>!!id)}:{}),
          status: file.status ?? 'unknown',
          ...(provider==='doubao'?{modelError:'旧接入将豆包与 MarsCode 混用，现已停用；原记录保留。',models:[]}:{}),
          disabled: file.disabled ?? false,
          unavailable: expired||file.unavailable||false,
          // Runtime errors/cooldowns are not revoked credentials. The sidecar owns their retry deadlines.
          retryable: !expired&&!file.disabled&&!revokedCredential(file)&&(Number.isFinite(Date.parse(file.next_retry_after??''))||(file.status==='error'&&!file.unavailable)),
        };
      }))];
      const groups=new Map<string,LocalAccount[]>();
      for(const account of accounts){const key=identities.get(account.id)??account.id;const group=groups.get(key)??[];group.push(account);groups.set(key,group);}
      const credentialGroups=new Map([...this.credentialGroups].filter(([id])=>retainedIDs.has(id)));
      for(const group of groups.values()){
        group.sort((a,b)=>Number(a.disabled)-Number(b.disabled)||Number(a.unavailable&&!a.retryable)-Number(b.unavailable&&!b.retryable)||compareCredentials(credentials.get(a.id)??{raw:{}},credentials.get(b.id)??{raw:{}})||a.id.localeCompare(b.id));
        for(const account of group){
          if(group.length>1){account.preferredCredentialId=group[0].id;account.credentialCount=group.length;account.isDuplicate=account.id!==group[0].id;}
          if(identities.has(account.id))credentialGroups.set(account.id,group.map(a=>a.id));
        }
      }
      const aliases: typeof this.aliases = providerScope?structuredClone(Object.fromEntries(Object.entries(this.aliases).filter(([id])=>id!==providerScope))):{};
      const discoveredAccounts = new Set<string>();
      const catalog = new Map<string, LocalModel>(providerScope?this.models.filter(model=>model.provider!==providerScope).map(model=>[model.id,model]):[]);

      // 1. 从每个已启用账号的凭据文件目录建立模型发现
      await Promise.all(accounts.filter(a => !a.disabled && isLoginProvider(a.provider)&&(!providerScope||a.provider===providerScope)).map(async account => {
        const provider = account.provider as LoginProviderId;
        try {
          const res = z.object({models: z.array(modelSchema),catalog:z.object({status:z.enum(['live','stale','unavailable','unsupported']),verifiedAt:z.string().optional(),reason:z.string().optional()}).nullish()}).parse(await this.request(`/auth-files/models?name=${encodeURIComponent(names.get(account.id)!)}&refresh=${providerScope?'true':'cached'}`,'GET',undefined,true,10000));
          if(res.catalog?.status==='live'&&!res.models.length)account.modelError='来源返回的当前可用模型列表为空。';
          if(res.catalog?.status==='stale')account.modelError='官方目录暂时刷新失败，使用最近 15 分钟内确认的列表，稍后自动重试。';
          if(res.catalog?.status==='unavailable')account.modelError='尚未获取到官方模型目录，已隐藏未经验证的旧型号。请刷新或检查来源授权。';
          if(res.catalog?.status==='unsupported')account.modelError='该来源暂未提供可验证的账号模型目录，已隐藏内置旧型号。';
          if(res.catalog&&['unavailable','unsupported'].includes(res.catalog.status))res.models=[];
          discoveredAccounts.add(account.id);
          account.models = [...new Set(res.models.map(m=>m.id.startsWith(`${provider}/`)?m.id:`${provider}/${m.id}`))];
          for (const model of res.models) {
            if (!model.id) continue;
            const baseId = model.id.startsWith(`${provider}/`) ? model.id.slice(provider.length + 1) : model.id;
            const id = `${provider}/${baseId}`;
            if (catalog.has(id)) continue;
            catalog.set(id, {id, provider, ...(model.display_name?.trim()?{displayName:model.display_name.trim()}: {}),...modelImageCapabilities(model,provider)});
            (aliases[provider] ??= []).push({name: baseId, alias: id, fork: true});
          }
        } catch {account.models=[];account.modelError='模型目录刷新未完成，已隐藏未经验证的型号，稍后自动重试。';discoveredAccounts.add(account.id);}
      }));

      // 2. 结合网关实时已注册的 /v1/models，为已启用提供商补充可用模型
      try {
        const live = z.object({data: z.array(modelSchema)}).parse(await this.request('/models', 'GET', undefined, false));
        for (const model of live.data) {
          if (!model.id) continue;
          if(/^api-[a-f0-9]{24}\//.test(model.id))continue;
          let provider: LoginProviderId | undefined;
          let baseId = model.id;
          if (model.id.includes('/')) {
            const parts = model.id.split('/');
            if (isLoginProvider(parts[0])) {
              provider = parts[0] as LoginProviderId;
              baseId = parts.slice(1).join('/');
            }
          }
          if (!provider) {
            provider = routeModelToProvider(model.type, model.owned_by);
          }
          if (provider && (!providerScope||provider===providerScope) && isLoginProvider(provider) && accounts.some(a => !a.disabled && a.provider === provider)) {
            const id = `${provider}/${baseId}`;
            // A provider-wide registry may lag account refresh. Never resurrect a
            // removed route once every active account supplied its own catalog.
            const sourceAccounts = accounts.filter(a=>!a.disabled&&a.provider===provider);
            if(sourceAccounts.every(a=>discoveredAccounts.has(a.id))&&!sourceAccounts.some(a=>a.models?.includes(id)))continue;
            if (!catalog.has(id)) {
              catalog.set(id, {id, provider, ...(model.display_name?.trim()?{displayName:model.display_name.trim()}: {}),...modelImageCapabilities(model,provider)});
              (aliases[provider] ??= []).push({name: baseId, alias: id, fork: true});
            }
          }
        }
      } catch { /* 网关可能处于启动初始期 */ }

      const normalized = Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)).map(([id, entries]) => [id, entries.sort((a,b) => a.name.localeCompare(b.name))]));
      if (JSON.stringify(normalized) !== JSON.stringify(this.aliases)) {
        await this.request('/oauth-model-alias', 'PUT', normalized);
        this.aliases = normalized;
        // The management save may have used a config snapshot from before a new API source.
        await this.configure();
      }

      // Only publish routes confirmed under their callable namespaced ID.
      let available = new Set<string>();
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const models = z.object({data: z.array(modelSchema)}).parse(await this.request('/models', 'GET', undefined, false));
          available = new Set(models.data.map(m => m.id));
          // A config reload can temporarily unregister API routes as well as account routes.
          const allConfirmed = [...catalog.values()].every(m => available.has(m.id)) && (this.options.apiModelIDs?.()??[]).every(id=>available.has(id));
          if (allConfirmed) break;
        } catch { /* 重试以避免瞬态网络延迟 */ }
        await new Promise(r => setTimeout(r, 100));
      }
      // Publish the discovered accounts and confirmed routes in one synchronous step.
      // Polling must not see new account models while their namespace is still registering.
      this.credentialGroups=credentialGroups;this.accounts = accounts; this.names = names; this.authIDs = authIDs; this.quotaTargets = quotaTargets;
      this.quotas = Object.fromEntries(Object.entries(this.quotas).filter(([id]) => names.has(id)));
      this.models = [...catalog.values()].filter(m => providerScope&&m.provider!==providerScope||available.has(m.id)).sort((a,b) => a.id.localeCompare(b.id));
      this.publishAPIModels(available);
      this.accountError = this.models.length < catalog.size || (this.options.apiModelIDs?.()??[]).some(id=>!this.apiModels.has(id)) ? '模型路由正在同步，网关会自动重试。' : accounts.some(a=>!a.disabled&&!a.unavailable&&!a.models?.length&&!a.modelError) ? '授权已读取，正在同步可用模型…' : undefined;
      // Load quotas after startup / new login without delaying account discovery or the workspace.
      if(refreshUsage)void (this.quotaTask ?? Promise.resolve()).then(() => {
        if (this.state === 'running' && this.accounts.some(a => !a.disabled && (!providerScope||a.provider===providerScope) && (!this.quotas[a.id] || Date.now() - Date.parse(this.quotas[a.id].observedAt) > 300000))) return this.refreshQuota(providerScope);
      }).catch(() => undefined);
    } catch (error) {
      if(!providerScope)this.models = [];
      const failure=safeFailure(error);
      const message=`账号或模型读取失败：${failure.reason}（${failure.code}）。网关会自动重试。`;
      if(this.accountError!==message)this.log(message);
      this.accountError = message;
      throw new Error(this.accountError);
    }
    return this.snapshot();
  }
  async setAccountEnabled(id: string, enabled: boolean) {
    if(this.cursor.owns(id)){await this.cursor.setEnabled(enabled,id);return this.snapshot();}
    const name = this.names.get(id);
    if (!name) throw new Error('账号已变更，请刷新账号列表');
    for(const candidate of this.credentialGroups.get(id)??[id]){const name=this.names.get(candidate);if(name)await this.request('/auth-files/status','PATCH',{name,disabled:!enabled});}
    return this.refreshAccounts();
  }
  private preferredCredential(id:string,model?:string){
    return (this.credentialGroups.get(id)??[id]).find(candidate=>{const a=this.accounts.find(a=>a.id===candidate);return a&&!a.disabled&&(!a.unavailable||a.retryable)&&(!model||a.models?.includes(model));})??id;
  }
  sourceAuth(id:string,model:string,retryKnownModel=false) {
    if(this.cursor.owns(id)){if(this.state!=='running')throw Object.assign(new Error('网关未启动'),{statusCode:409});return this.cursor.assertSource(id,model);}
    const selected=this.preferredCredential(id,model);
    const account=this.accounts.find(a=>a.id===selected);
    const authID=this.authIDs.get(selected);
    // /models hides models during some cooldowns. An already scoped request must
    // still reach the pinned sidecar, which enforces retry deadlines and auth.
    if(this.state!=='running'||!account||account.disabled||(!retryKnownModel&&account.unavailable&&!account.retryable)||!account.models?.includes(model)||(!retryKnownModel&&!this.models.some(m=>m.id===model))||!authID)
      throw Object.assign(new Error('源账号或模型当前不可用，请刷新授权；不会切换到其他账号。'),{statusCode:409});
    return authID;
  }
  async codexNativeAccounts(includeInactive=false) {
    return Promise.all(this.accounts.filter(a=>a.provider==='codex'&&(includeInactive||!a.disabled&&(!a.unavailable||a.retryable))).map(async account=>{
      try{
        const name=this.names.get(account.id);
        if(!name||name.includes('/')||name.includes('\\'))throw new Error();
        const raw=JSON.parse(await readConfig(join(this.root,'cliproxy','auth',name))??'null');
        const complete=['access_token','refresh_token','id_token','account_id'].every(k=>typeof raw?.[k]==='string'&&raw[k].length>0);
        return {id:account.id,accountId:typeof raw?.account_id==='string'?raw.account_id:null,email:typeof raw?.email==='string'?raw.email:null,switchable:complete,reason:complete?'':'缺少完整登录凭据，请重新授权'};
      }catch{return {id:account.id,accountId:null,email:null,switchable:false,reason:'授权文件暂不可读取'};}
    }));
  }
  // Server-only export for native Codex login switching. Never include credentials in snapshots.
  async codexCredential(id:string,model:string) {
    this.sourceAuth(id,model);id=this.preferredCredential(id,model);
    const account=this.accounts.find(a=>a.id===id);
    const name=this.names.get(id);
    if(account?.provider!=='codex'||!name||name.includes('/')||name.includes('\\'))throw new Error('请选择有效的 Codex 账号');
    try{return JSON.parse(await readConfig(join(this.root,'cliproxy','auth',name))??'null') as unknown;}
    catch{throw new Error('读取账号授权失败，请重新连接该账号。');}
  }
  // Server-only SDK credential access; never include the token in snapshots.
  async workbuddyCredential(id:string,model:string){
    this.sourceAuth(id,model,true);id=this.preferredCredential(id,model);
    const account=this.accounts.find(a=>a.id===id),name=this.names.get(id);
    if(account?.provider!=='workbuddy'||!name||name.includes('/')||name.includes('\\'))throw new Error('请选择有效的 WorkBuddy 账号');
    return JSON.parse(await readConfig(join(this.root,'cliproxy','auth',name))??'null') as unknown;
  }
  async desktopNativeAccounts(provider:DesktopProvider){
    const pool=desktopPoolProvider(provider);
    const rows=await Promise.all(this.accounts.filter(a=>a.provider===pool&&!a.disabled).map(async a=>{
      try{const raw=await this.nativeCredentialFile(pool,a.id),p=desktopCredentialSchema.safeParse(raw);
        if(pool==='workbuddy'&&workbuddyLoginTarget((raw as {domain?:string})?.domain)!==provider)return null;
        const reason=p.success?(pool==='workbuddy'?workbuddyLoginIssue(p.data.domain,provider):''):'登录凭据不完整或已过期，请刷新账号或重新授权';
        return {id:a.id,accountId:p.success?p.data.uid:null,email:p.success?p.data.email:null,domain:p.success&&pool==='workbuddy'?workbuddyLoginDomain(p.data.domain):undefined,enterpriseId:p.success?p.data.enterprise_id??'':undefined,switchable:p.success&&!reason,reason};
      }catch{return {id:a.id,switchable:false,reason:'授权文件暂不可读取'};}
    }));return rows.filter((row):row is NonNullable<typeof row>=>row!==null);
  }
  async desktopCredential(provider:DesktopProvider,id:string){
    const pool=desktopPoolProvider(provider);
    if(!this.accounts.some(a=>a.id===id&&a.provider===pool&&!a.disabled))throw nativeConflict('请选择有效的官方账号。');
    const raw=await this.nativeCredentialFile(pool,id);
    if(pool==='workbuddy'){const issue=workbuddyLoginIssue((raw as {domain?:string})?.domain,provider);if(issue)throw nativeConflict(issue);}
    return raw;
  }
  async nativeAccounts(provider:NativeProvider,includeInactive=false) {
    return Promise.all(this.accounts.filter(a=>a.provider===provider&&(includeInactive||!a.disabled)).map(async account=>{
      try{const raw=await this.nativeCredentialFile(provider,account.id),parsed=nativeCredentialSchema.safeParse(raw);
        return {id:account.id,email:parsed.success?parsed.data.email:null,accountId:parsed.success?parsed.data.account_uuid:null,organizationId:parsed.success?parsed.data.organization_uuid:null,switchable:parsed.success,reason:parsed.success?'':'缺少完整登录凭据（邮箱、令牌或有效期），请重新授权'};
      }catch{return {id:account.id,email:null,switchable:false,reason:'授权文件暂不可读取'};}
    }));
  }
  /** Historical accounting needs identity, not today's switching eligibility.
   * Include expired/disabled grants, collapse duplicate authorizations, and never
   * return tokens. Region, enterprise and project remain separate identities. */
  async nativeUsageAccounts(){
    const text=(v:unknown)=>typeof v==='string'&&v.trim()?v.trim().slice(0,320):typeof v==='number'&&Number.isSafeInteger(v)?String(v):null;
    const rows=await Promise.all(this.accounts.filter(a=>!a.isDuplicate&&['codex','claude','antigravity','workbuddy','qoder'].includes(a.provider)).map(async a=>{
      try{
        const name=this.names.get(a.id);if(!name||name.includes('/')||name.includes('\\'))return null;
        const raw=JSON.parse(await readConfig(join(this.root,'cliproxy','auth',name))??'null');if(!raw||typeof raw!=='object')return null;
        const email=credentialEmail(raw.email)??null,provider=a.provider==='workbuddy'?workbuddyLoginTarget(text(raw.domain)??undefined):a.provider;if(!provider)return null;
        const accountId=provider==='codex'?text(raw.account_id):provider==='claude'?text(raw.account_uuid):provider==='antigravity'?email:text(raw.uid);
        const organizationId=provider==='claude'?text(raw.organization_uuid):provider==='antigravity'?text(raw.project_id):a.provider==='workbuddy'?text(raw.enterprise_id):null;
        return {id:a.id,provider,accountId,email,organizationId,label:a.label};
      }catch{return null;}
    }));return [...rows.filter((row):row is NonNullable<typeof row>=>row!==null),...this.cursor.nativeUsageAccounts()];
  }
  private async nativeCredentialFile(provider:NativeProvider|DesktopProvider,id:string){
    id=this.preferredCredential(id);
    const account=this.accounts.find(a=>a.id===id),name=this.names.get(id);
    if(account?.provider!==provider||!name||name.includes('/')||name.includes('\\'))throw nativeConflict('请选择对应客户端的有效账号。');
    try{return JSON.parse(await readConfig(join(this.root,'cliproxy','auth',name))??'null') as unknown;}
    catch{throw nativeConflict('读取账号授权失败，请重新连接该账号。');}
  }
  async nativeCredential(provider:NativeProvider,id:string,model?:string){
    const account=this.accounts.find(a=>a.id===id);
    if(!account||account.disabled)throw nativeConflict('请选择有效的官方账号。');
    if(provider!=='claude'||model)this.sourceAuth(id,model??account?.models?.[0]??'');
    return this.nativeCredentialFile(provider,id);
  }
  async importCredential(provider:'codex'|'claude',credential:Record<string,unknown>,onlyNew=false) {
    await this.start();
    const complete=provider==='codex'?['access_token','refresh_token','id_token'].every(key=>typeof credential[key]==='string'&&!!credential[key]):nativeCredentialSchema.safeParse(credential).success;
    if(!complete){if(onlyNew)return this.snapshot();throw nativeConflict('本机登录凭据不完整，请先在客户端完成登录。');}
    const identity=credentialIdentity(provider,credential)??credentialFingerprint(credential);
    // Each authorization remains a separate file. Re-reading one grant updates only that grant.
    const fingerprint=credentialFingerprint(credential);
    let name=`local-${provider}-${identity.slice(0,16)}-${fingerprint.slice(0,16)}.json`;
    for(const account of this.accounts.filter(a=>a.provider===provider)){
      try{const existingName=this.names.get(account.id);if(!existingName||existingName.includes('/')||existingName.includes('\\'))continue;
        const raw=JSON.parse(await readConfig(join(this.root,'cliproxy','auth',existingName))??'null') as Record<string,unknown>;
        if((credentialIdentity(provider,raw)??credentialFingerprint(raw))===identity&&credentialFingerprint(raw)===fingerprint){
          if(compareCredentials({raw:credential},{raw})>=0)return this.snapshot();
          name=existingName;break;
        }
      }catch{/* Incomplete grants never suppress a new import. */}
    }
    await this.credentialHistory.remember(provider,[credential]);
    await this.request(`/auth-files?name=${encodeURIComponent(name)}`,'POST',{...credential,type:provider});
    return this.refreshAccounts();
  }
  async deleteAccount(id: string) {
    if(this.cursor.owns(id)){await this.cursor.remove(id);return this.snapshot();}
    const name = this.names.get(id);
    if (!name) throw new Error('账号已变更，请刷新账号列表');
    const records:Record<string,unknown>[]=[];
    for(const candidate of this.credentialGroups.get(id)??[id]){const name=this.names.get(candidate);if(name){const raw=await readConfig(join(this.root,'cliproxy','auth',name));if(raw)records.push(JSON.parse(raw));await this.request(`/auth-files?name=${encodeURIComponent(name)}`,'DELETE');}delete this.quotas[candidate];}
    if(records.length)await this.credentialHistory.forget(this.accounts.find(a=>a.id===id)!.provider,records);
    this.log(`已删除账号凭据：${name}`);
    return this.refreshAccounts();
  }
  /**
   * 额度层入口：对每个已启用账号，用 CLIProxyAPI `/api-call` 携带该账号凭据查询官方用量接口。
   * token 由上游替换 `$TOKEN$`，桌面端只拿到用量响应；失败信息只保留桌面端自己的描述。
   */
  refreshQuota(provider?:LoginProviderId|'cursor'): Promise<LocalAgentSnapshot> {
    if(!provider){
      if(this.quotaTask)return this.quotaTask;
      const providers=[...new Set(this.accounts.filter(account=>!account.disabled&&isLoginProvider(account.provider)&&quotaProviders[account.provider as LoginProviderId]&&this.quotaTargets.has(account.id)).map(account=>account.provider as LoginProviderId))];
      this.quotaTask=Promise.all([...providers,'cursor' as const].map(id=>this.refreshQuota(id))).finally(()=>{this.quotaTask=undefined;}).then(()=>this.snapshot());
      return this.quotaTask;
    }
    const existing=this.quotaProviderTasks.get(provider);if(existing)return existing;
    this.providerRefreshTimes.set(provider,Date.now());
    const task=this.loadQuota(provider).finally(()=>{this.providerRefreshTimes.set(provider,Date.now());this.quotaProviderTasks.delete(provider);}).then(()=>this.snapshot());
    this.quotaProviderTasks.set(provider,task);
    return task;
  }
  refreshProvider(provider:LoginProviderId|'cursor',force=true):Promise<LocalAgentSnapshot> {
    const existing=this.providerRefreshTasks.get(provider);if(existing)return existing;
    const checked=this.providerRefreshTimes.get(provider);
    if(!force&&checked!==undefined&&Date.now()-checked<300000)return Promise.resolve(this.snapshot());
    this.providerRefreshTimes.set(provider,Date.now());
    const task=(async()=>{
      if(provider==='cursor'&&!force){await this.cursor.load();await this.cursor.refreshIfStale();return this.snapshot();}
      if(provider!=='cursor'){this.emptyRefreshes=0;await this.refreshAccounts(provider,false);}
      return this.refreshQuota(provider);
    })().finally(()=>{this.providerRefreshTimes.set(provider,Date.now());this.providerRefreshTasks.delete(provider);});
    this.providerRefreshTasks.set(provider,task);return task;
  }
  private async loadQuota(providerScope:LoginProviderId|'cursor') {
    if (this.state !== 'running') throw new Error('请先启动 Local Agent');
    const targets = this.accounts.filter(account => !account.disabled && !account.isDuplicate && account.provider===providerScope && isLoginProvider(account.provider) && !!quotaProviders[account.provider as LoginProviderId] && this.quotaTargets.has(account.id));
    await Promise.all(targets.map(async account => {
      const provider = account.provider as LoginProviderId;
      const quotaProvider = quotaProviders[provider];
      if (!quotaProvider) return;
      const {authIndex, account: info} = this.quotaTargets.get(account.id)!;
      const signal=this.requests.signal;
      const call = (request: QuotaRequest): Promise<QuotaResponse> => retryQuotaCall(async()=>{
        if(!this.accounts.some(a=>a.id===account.id&&!a.disabled))throw new Error('账号已停用或移除，已停止额度查询。');
        return apiCallSchema.transform(r => ({statusCode: r.status_code, header: r.header, body: r.body}))
          .parse(await this.request('/api-call', 'POST', {auth_index: authIndex, method: request.method, url: request.url, header: request.header, data: request.data ?? ''}, true, 45000));
      },signal,attempt=>this.log(`${provider} 额度连接暂时失败，自动尝试 ${attempt}/5。`));
      const observedAt = new Date().toISOString();
      try {
        const report = await quotaProvider.fetch(call, info);
        if (signal.aborted||!this.accounts.some(a=>a.id===account.id&&!a.disabled)||!this.names.has(account.id)) return;
        this.quotas[account.id] = {accountId: account.id, provider, status: 'ok', observedAt, plan: report.plan, windows: report.windows, note: report.note};
      } catch (error) {
        const is401 = error instanceof QuotaHTTPError && error.status === 401;
        const is403 = error instanceof QuotaHTTPError && error.status === 403;
        const isMissingProject = error instanceof Error && error.message.includes('project_id');
        // A quota endpoint rejection does not prove the model credential is revoked.
        // Keep the independent source pool intact; upstream inference owns auth refresh/status.
        const message = is401 ? '额度接口暂未通过认证（HTTP 401），已保留授权；可稍后重查或重新登录。'
          : isMissingProject ? '账号缺少关联项目（project_id），无法调用 Google 模型。请重新连接。'
          : is403 ? '访问受限（HTTP 403），当前凭据权限不足或账号受限。'
          : error instanceof z.ZodError ? '上游 api-call 响应格式异常。'
          : error instanceof Error ? error.message : '额度查询失败。';
        if (signal.aborted||!this.accounts.some(a=>a.id===account.id&&!a.disabled)||!this.names.has(account.id)) return;
        const previous=this.quotas[account.id];
        const lastSuccessfulAt=previous?.status==='ok'?previous.observedAt:previous?.lastSuccessfulAt;
        this.quotas[account.id] = {accountId: account.id, provider, status: 'error', observedAt, windows: lastSuccessfulAt?previous.windows:[], ...(lastSuccessfulAt?{lastSuccessfulAt,plan:previous.plan}:{}), error: message.slice(0, 300)};
      }
    }));
    if(providerScope==='cursor')await this.cursor.refresh();
    const success=targets.filter(account=>this.quotas[account.id]?.status==='ok').length;
    if(providerScope!=='cursor')this.log(`${providerScope} 额度查询：${success} 成功，${targets.length-success} 失败，${targets.length} 个可查询账号${targets.length?'':'（没有可查询账号，未发起额度请求）'}`);
    return this.snapshot();
  }
  // 登录层入口：所有 Provider 共用同一个会话控制器。
  async login(provider: LoginProviderId | 'cursor') {this.cursorLoginSelected=provider==='cursor';if(provider==='cursor'){if(this.login_.isPending())throw new Error('请先完成当前授权');await this.cursor.beginLogin();}else{if(['starting','waiting_for_browser'].includes(this.cursor.snapshot().login?.status??''))throw new Error('请先完成 Cursor 授权');await this.login_.login(provider);}return this.snapshot();}
  async importLocal(provider: 'trae' | 'workbuddy' | 'workbuddy-ai' | 'zcode' | 'cursor', onlyNew=false) {
    if(provider==='cursor'){await this.cursor.importLocal();return this.snapshot();}
    if (this.state !== 'running') await this.start();
    // Startup must never replace a pool credential refreshed independently of the native app.
    if(onlyNew&&this.accounts.some(account=>account.provider===provider))return this.snapshot();
    // WorkBuddyAI (international) saves into the WorkBuddy account list with the overseas service domain.
    await this.request(provider==='workbuddy-ai'?'/workbuddy-import-local?region=overseas':`/${provider}-import-local`, 'POST', {});
    this.log(`已完成 ${provider} 本机凭据导入`);
    await this.refreshAccounts();
    return this.snapshot();
  }
  async openLogin(id: string) {if(this.cursor.snapshot().login?.id===id){await this.cursor.openLogin(id);return this.snapshot();}await this.login_.open(id); return this.snapshot();}
  async submitCallback(id: string, value: string) {await this.login_.submitCallback(id, value); return this.snapshot();}
  async cancelLogin(id: string) {if(this.cursor.snapshot().login?.id===id){this.cursor.cancelLogin(id);return this.snapshot();}await this.login_.cancel(id); return this.snapshot();}
  async shutdown() {this.closing = true;this.networkCheckAbort?.abort();try{await this.cursor.close(); this.login_.close(); await this.stop(); await this.refreshTask?.catch(() => undefined); await this.quotaTask?.catch(() => undefined);await Promise.allSettled([...this.quotaProviderTasks.values()]);await this.networkCheckTask;}finally{await this.network?.close();this.network=undefined;}}
}

export type LocalAgentSnapshot = ReturnType<CLIProxyManager['snapshot']> & {accountsLoading?:boolean;apiSources?:import('./api-sources.js').ApiSource[]};
