import {qoderAuthorization,type QoderAuthorization} from './qoder-authorizations.js';
import {qoderProfile,qoderCredentialSchema,QoderIdentityError} from './qoder-credentials.js';
import {retryOfficialRead,OfficialReadTransportError,refreshNetworkHint} from './official-refresh.js';
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
import {readUpstreamError} from './upstream-errors.js';
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
// Optional capacity metadata must not invalidate an otherwise callable catalog.
const modelCapacity = z.number().int().positive().safe().optional().catch(undefined);
const modelSchema = z.object({id: z.string(), display_name: z.string().optional(), type: z.string().optional(), owned_by: z.string().optional(), supportedInputModalities:z.array(z.string()).optional(),context_length:modelCapacity,context_window:modelCapacity,inputTokenLimit:modelCapacity});
const qoderProfilesSchema=z.record(z.object({email:z.string().email().max(200),checkedAt:z.number().finite()}));
const apiCallSchema = z.object({status_code: z.number().int(), header: z.record(z.array(z.string())).default({}), body: z.string().default('')});
export function revokedCredential(file:{status?:string;status_message?:string}){return file.status==='error'&&/\b(?:invalid_grant|token_revoked|refresh_token_revoked|refresh_token_reused|refresh_token_expired)\b/i.test(file.status_message??'');}
function credentialTokenRevision(raw:Record<string,unknown>){return typeof raw.access_token==='string'&&raw.access_token?createHash('sha256').update(JSON.stringify([raw.access_token,raw.refresh_token])).digest('hex'):undefined;}
export type LocalAccount = {id: string; provider: string; label: string; nativeClients?:string[]; authorizations?:QoderAuthorization[]; status: string; disabled: boolean; unavailable: boolean; retryable?:boolean; authenticationRequired?:boolean; isDuplicate?: boolean;credentialAlias?:boolean;preferredCredentialId?:string;credentialCount?:number; modelError?:string; models?: string[]};
/** `provider` 为承接该模型的登录 Provider；未知类型（如 Gemini API Key）为空。 */
// Unknown capabilities remain unknown; never infer vision from a model name.
function modelImageCapabilities(model:z.infer<typeof modelSchema>,provider:string){
 const contextWindow=model.context_length??model.context_window??model.inputTokenLimit;
 const capacity=contextWindow?{contextWindow}:{};
 const modalities=model.supportedInputModalities;
 if(!modalities?.length)return capacity;
 // Preserve the upstream declaration; Qoder forwards images in message content.
 return {...capacity,capabilities:{text:true,tools:true,images:provider!=='cursor'&&modalities.some(value=>value.toLowerCase()==='image')}};
}
export type LocalModel = {id: string; displayName?: string; provider?: LoginProviderId | 'cursor' | 'api';textOnly?:boolean;contextWindow?:number;capabilities?:{text:boolean;tools:boolean;images:boolean}};
export type CLIProxyOptions = LoginOptions & {cursorLocalPath?:string;outboundProxyURL?:string;networkSnapshot?:()=>NetworkSnapshot;secrets?:{get:(name:string)=>Promise<string>;set:(name:string,value:string)=>Promise<void>};apiConfig?:()=>string;apiModelIDs?:()=>string[]};

export class CLIProxyManager {
  readonly cursor:CursorProvider;
  private credentialHistory:CredentialHistory;
  private cursorLoginSelected=false;
  private authIDs = new Map<string,string>();
  private credentialGroups=new Map<string,string[]>();
  private credentialAliases:Record<string,string>={};
  private child?: ChildProcess;
  private busy = false;
  private closing = false;
  private requests = new AbortController();
  private startTask?: Promise<LocalAgentSnapshot>;
  private refreshTask?: Promise<LocalAgentSnapshot>;
  private refreshScope?: string;
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
  private revokedTokens=new Map<string,string>();
  private qoderIdentityAttempts=new Map<string,{revision:string;at:number;message:string;reauthorize:boolean}>();
  private qoderProfileAttempts=new Map<string,number>();
  private names = new Map<string, string>();
  private quotaTargets = new Map<string, {authIndex: string; account: QuotaAccount}>();
  private async credentialRevision(id:string){
    const name=this.names.get(id);if(!name||name.includes('/')||name.includes('\\'))return undefined;
    try{return credentialTokenRevision(JSON.parse(await readConfig(join(this.root,'cliproxy','auth',name))??'{}'));}catch{return undefined;}
  }
  private quotas: Record<string, AccountQuota> = {};
  private get quotaBusy():boolean{return !!this.quotaTask||this.quotaProviderTasks.size>0;}
  private models: LocalModel[] = [];
  private apiModels=new Set<string>();
  private configurationTask:Promise<void>=Promise.resolve();
  private apiSyncTask?:Promise<boolean>;
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
    this.cursor=new CursorProvider(root,options.secrets??{get:async()=>'',set:async()=>{throw new Error('Credential storage unavailable');}},options.openExternal,options.cursorLocalPath);
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
    for(const id of Object.keys(this.credentialAliases)){if(accounts.some(a=>a.id===id))continue;const group=this.credentialGroups.get(id),account=accounts.find(a=>group?.includes(a.id)&&!a.isDuplicate);if(account)accounts.push({...account,id,isDuplicate:true,credentialAlias:true,preferredCredentialId:account.id,authorizations:undefined});}
    return structuredClone({state: this.state, loginState: this.login_.state, port: this.port,...(this.apiSyncTask?{apiRoutesSyncing:true}:{}),
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
    this.publishAPIModels([]);
    if(this.state!=='running'||!ids.length)return;
    // Saving is bounded, but a slow registration must continue without requiring
    // another save or interrupting active requests by restarting the sidecar.
    const task=this.apiSyncTask??=this.synchronizeAPIModelsInBackground(ids).finally(()=>{this.apiSyncTask=undefined;});
    let timer:NodeJS.Timeout|undefined;
    try{if(await Promise.race([task,new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),4000);})]))return;}
    finally{clearTimeout(timer);}
    throw new RunnerCoreError('API 来源已保存，模型路由仍在同步，系统会自动重试。',{statusCode:503,code:'api_routes_pending'});
  }
  private async synchronizeAPIModelsInBackground(ids:string[]) {
    const deadline=Date.now()+60000;
    while(this.state==='running'&&!this.closing&&!this.requests.signal.aborted&&Date.now()<deadline){
      try{
        const live=z.object({data:z.array(modelSchema)}).parse(await this.request('/models','GET',undefined,false,1500));
        const available=new Set(live.data.map(m=>m.id));this.publishAPIModels(available);
        // Consult current configuration so edits/removals made while waiting cannot
        // resurrect old routes or leave a newly saved source out of the sync.
        if((this.options.apiModelIDs?.()??ids).every(id=>available.has(id)))return true;
      }catch{/* A reload may briefly stop serving. */}
      await new Promise(r=>setTimeout(r,100));
    }
    if(this.state==='running'&&!this.closing)this.log('API 来源已保存，但模型路由同步超时，请检查网关状态。');
    return false;
  }
  private async request(path: string, method = 'GET', body?: unknown, management = true, timeoutMs = 10000): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${this.port}${management ? '/v0/management' : '/v1'}${path}`, {
      method, headers: {Authorization: `Bearer ${management ? this.managementKey : this.key}`, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.requests.signal]), redirect: 'error',
    }).catch(error => {
      if(path==='/api-call')throw new QuotaTransportError('额度查询连接失败或超时。');
      if(path.startsWith('/auth-files/models?'))throw new OfficialReadTransportError('模型目录连接失败或超时。');
      const failure=safeFailure(error);
      if(path.includes('-auth-url')&&failure.code==='timeout')throw new Error('等待本机网关生成授权链接超时；网关可能仍在等待厂商服务。请检查网络与代理后重试，此错误不代表本机网关已停止。');
      throw new Error(`无法完成本机网关请求：${failure.reason}。请检查服务状态后重试。`);
    });
    if (!response.ok) {
      if(path.includes('-auth-url')){
        const body=await readUpstreamError(response);let message='';
        try{const parsed=JSON.parse(body);message=typeof parsed.error==='string'?parsed.error:typeof parsed.error?.message==='string'?parsed.error.message:'';}catch{/* Only classify recognized error fields. */}
        const failure=safeFailure(message);
        if(failure.code==='unknown')throw new Error(`授权服务请求失败（HTTP ${response.status}），尚未生成授权链接。服务未返回明确原因，请稍后重试。`);
        throw new Error(`本机网关已响应，但生成授权链接失败（HTTP ${response.status}）：${failure.reason}。请检查对应厂商的网络与代理连接后重试。`);
      }
      if(path.includes('-local-credential')&&response.status===404){
        const detail=await readUpstreamError(response);
        if(detail.includes('local Trae sign-in has expired'))throw nativeConflict('Trae 本机访问令牌和刷新授权均已过期，请在 Trae 重新登录后再导入。');
        if(detail.includes('ZCode local credential encryption'))throw nativeConflict('无法解密此设备的 ZCode 登录，请确认使用原系统用户与原加密配置，或在 TokenFlow 重新授权。');
        throw nativeConflict('未找到可导入的本机授权：登录可能不存在、已过期或无法读取。请先打开对应客户端确认登录，再重试。');
      }
      await response.body?.cancel();
      if(path.startsWith('/auth-files/models?')&&transientQuotaStatus(response.status))throw new OfficialReadTransportError(`模型目录连接失败（HTTP ${response.status}）。`);
      if(path==='/api-call'&&transientQuotaStatus(response.status))throw new QuotaTransportError(`额度上游连接失败（HTTP ${response.status}），网关已响应。`);
      if(path==='/api-call')throw new Error(response.status>=500?`额度上游连接失败（HTTP ${response.status}），网关已响应。请稍后重试或检查网络与代理；不代表账号授权丢失。`:`额度查询网关请求失败（HTTP ${response.status}），请刷新网关状态后重试。`);
      throw new Error(`Local Agent 接口请求失败（HTTP ${response.status}）。请检查网关状态后重试。`);
    }
    return response.json().catch(error => {if(path.startsWith('/auth-files/models?')&&!(error instanceof SyntaxError))throw new OfficialReadTransportError('模型目录连接中断或超时。');if(path==='/api-call'&&!(error instanceof SyntaxError))throw new QuotaTransportError('额度查询连接中断或超时。');throw new Error('Local Agent 返回了无效响应，请重启服务后重试。');});
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
      const isScript = /\.[cm]?js$/i.test(this.binary);
      const child = spawn(isScript ? process.execPath : this.binary, isScript ? [this.binary, '-config', this.configPath] : ['-config', this.configPath], {
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
      await this.apiSyncTask;
      await this.terminate(this.child); this.child = undefined; this.state = 'stopped';
      await this.refreshTask?.catch(() => undefined); await this.quotaTask?.catch(() => undefined);
      await Promise.allSettled([...this.quotaProviderTasks.values()]);
      this.models = []; this.log('Local Agent 已停止'); return this.snapshot();
    } finally {this.busy = false;}
  }
  /** 从每个账号的模型目录建立独立命名空间，实际注册到网关，而非只改显示文本。 */
  refreshAccounts(provider?:LoginProviderId,refreshUsage=true,accountId?:string): Promise<LocalAgentSnapshot> {
    const scope=accountId??provider;
    if (this.refreshTask) return !this.refreshScope||this.refreshScope===scope?this.refreshTask:this.refreshTask.catch(()=>undefined).then(()=>this.refreshAccounts(provider,refreshUsage,accountId));
    clearTimeout(this.refreshTimer);
    this.refreshScope=scope;
    this.refreshTimer=undefined;
    this.refreshTask = this.loadAccounts(provider,refreshUsage,accountId).finally(() => {
      this.refreshTask = undefined;
      this.refreshScope=undefined;
      if(!accountId&&this.state==='running'&&!this.closing&&!this.requests.signal.aborted){
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
  private async repairQoderIdentity(file:z.infer<typeof accountSchema>,raw:Record<string,unknown>,force:boolean,retryChanged=true):Promise<{raw:Record<string,unknown>;message?:string;reauthorize?:boolean}>{
    if(typeof raw.access_token!=='string'||!raw.access_token||typeof raw.uid==='string'&&raw.uid.trim()||file.disabled)return {raw};
    const revision=credentialTokenRevision(raw)!;
    const previous=this.qoderIdentityAttempts.get(file.name);
    if(!force&&previous?.revision===revision&&Date.now()-previous.at<300000)return {raw,message:previous.message,reauthorize:previous.reauthorize};
    let message='Qoder 账号身份尚未补全，请稍后刷新重试。',reauthorize=false;
    try{
      if(file.auth_index===undefined)throw Error();
      const result=apiCallSchema.parse(await this.request('/api-call','POST',{auth_index:String(file.auth_index),method:'GET',url:'https://openapi.qoder.sh/api/v1/userinfo',header:{Authorization:'Bearer $TOKEN$',Accept:'application/json'},data:''},true,15000));
      if(result.status_code===401||result.status_code===403)throw new QoderIdentityError('Qoder 授权无法恢复账号身份，请重新授权。',true);
      if(result.status_code!==200)throw Error();
      const profile=qoderProfile(JSON.parse(result.body));
      // api-call may refresh the access token. Never replace concurrent credentials with the old bytes.
      const path=join(this.root,'cliproxy','auth',file.name),current=JSON.parse(await readConfig(path)??'null');
      if(!current||credentialTokenRevision(current)!==revision){this.qoderIdentityAttempts.delete(file.name);if(current&&retryChanged)return this.repairQoderIdentity(file,current,true,false);return {raw:current??raw,message:'Qoder 凭据已更新，请刷新以重新校验账号身份。'};}
      const repaired={...current,...profile,type:'qoder',...(file.disabled!==undefined?{disabled:file.disabled}:{})};
      await this.request(`/auth-files?name=${encodeURIComponent(file.name)}`,'POST',repaired);
      this.qoderIdentityAttempts.delete(file.name);
      file.status='active';file.status_message=undefined;file.unavailable=false;
      return {raw:repaired};
    }catch(error){
      if(error instanceof QoderIdentityError){message=error.message;reauthorize=error.reauthorize;}
      else message='Qoder 账号身份自动补全暂时失败，请检查网络后刷新；原授权已保留。';
    }
    this.qoderIdentityAttempts.set(file.name,{revision,at:Date.now(),message,reauthorize});
    return {raw,message,reauthorize};
  }
  private async pruneExpiredQoder(accounts:LocalAccount[],credentials:Map<string,{raw:Record<string,unknown>}>,identities:Map<string,string>){
    let removed=0;
    for(const account of accounts.filter(a=>a.provider==='qoder'&&a.authenticationRequired)){
      const group=this.credentialGroups.get(account.id)??[];
      const sibling=accounts.find(a=>group.includes(a.id)&&!a.disabled&&!a.unavailable&&!a.authenticationRequired&&credentialPreference(credentials.get(a.id)?.raw??{})[0]===2&&a.models?.some(model=>this.models.some(m=>m.id===model)));
      const name=this.names.get(account.id),identity=identities.get(account.id),expected=credentials.get(account.id)?.raw;
      if(!sibling||!name||!identity||!expected)continue;
      try{
        const path=join(this.root,'cliproxy','auth',name),raw=await readConfig(path);
        // A grant refreshed or replaced during catalog discovery is not eligible for removal.
        if(!raw||JSON.stringify(JSON.parse(raw))!==JSON.stringify(expected))continue;
        const archive=join(this.root,'revoked-credentials');await mkdir(archive,{recursive:true,mode:0o700});await chmod(archive,0o700);await writeFile(join(archive,`${createHash('sha256').update(name+raw).digest('hex')}.json`),raw,{mode:0o600});
        // Keep old scoped API keys bound to this exact account identity after removal/restart.
        const aliases={...this.credentialAliases,[account.id]:identity},aliasPath=join(this.root,'credential-aliases.json');
        await writeFile(aliasPath+'.tmp',JSON.stringify(aliases),{mode:0o600});await rename(aliasPath+'.tmp',aliasPath);this.credentialAliases=aliases;
        // Recheck immediately before deletion, including the surviving grant.
        if(await readConfig(path)!==raw)continue;
        const siblingName=this.names.get(sibling.id),siblingRaw=siblingName&&await readConfig(join(this.root,'cliproxy','auth',siblingName));
        if(!siblingRaw||JSON.stringify(JSON.parse(siblingRaw))!==JSON.stringify(credentials.get(sibling.id)?.raw))continue;
        await this.request(`/auth-files?name=${encodeURIComponent(name)}`,'DELETE');delete this.quotas[account.id];removed++;
      }catch{this.log('已保留暂时无法安全清理的失效授权，下次刷新后重试。');}
    }
    if(removed)this.log(`已自动清理 ${removed} 份失效 Qoder 授权，保留同账号的可用授权。`);
    return removed>0;
  }
  private async loadAccounts(providerScope?:LoginProviderId,refreshUsage=true,accountId?:string):Promise<LocalAgentSnapshot> {
    if (this.state !== 'running') throw new Error('请先启动 Local Agent');
    try {
      const result = z.object({files: z.array(accountSchema)}).parse(await this.request('/auth-files'));
      if(providerScope)result.files=result.files.filter(file=>(file.provider??file.type)===providerScope);
      if(accountId)result.files=result.files.filter(file=>file.name===this.names.get(accountId));
      // Keep terminal failures for confirmation unless a verified Qoder sibling can replace them.
      this.credentialAliases=z.record(z.string().regex(/^[a-f0-9]{24}$/),z.string().regex(/^[a-f0-9]{64}$/)).parse(JSON.parse(await readConfig(join(this.root,'credential-aliases.json'))??'{}'));
      // Quota and catalog errors alone are not revocation.
      result.files=result.files.filter(file=>!file.runtime_only);
      const retained=accountId?this.accounts.filter(account=>account.id!==accountId):providerScope?this.accounts.filter(account=>account.provider!==providerScope):[];
      const retainedIDs=new Set(retained.map(account=>account.id));
      const names = new Map([...this.names].filter(([id])=>retainedIDs.has(id)));
      const authIDs = new Map([...this.authIDs].filter(([id])=>retainedIDs.has(id)));
      const quotaTargets = new Map([...this.quotaTargets].filter(([id])=>retainedIDs.has(id)));
      // Local display names never change the upstream authentication identity.
      let accountLabels:Record<string,string>={};
      try{accountLabels=z.record(z.string().trim().min(1).max(200)).parse(JSON.parse(await readConfig(join(this.root,'account-labels.json'))??'{}'));}catch{/* Optional local display metadata. */}
      const profilePath=join(this.root,'qoder-profiles.json');
      let qoderProfiles:Record<string,{email:string;checkedAt:number}>={};
      try{qoderProfiles=qoderProfilesSchema.parse(JSON.parse(await readConfig(profilePath)??'{}'));}catch{/* Display metadata can be fetched again. */}
      let profilesChanged=false;
      const unresolvedQoder=new Set<string>();
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
        const recovery=provider==='qoder'&&!file.name.includes('/')&&!file.name.includes('\\')?await this.repairQoderIdentity(file,identity,providerScope==='qoder'&&refreshUsage):undefined;
        if(recovery)identity=recovery.raw;
        const unsupportedZcode=provider==='zcode'&&(identity.native_oauth===true||typeof identity.oauth_access_token==='string'||file.name.startsWith('local-zcode-'));
        if(unsupportedZcode)unresolvedQoder.add(id);
        if(recovery?.message)unresolvedQoder.add(id);
        if(Object.keys(identity).length)await this.credentialHistory.remember(provider,[identity]);
        const identityKey=credentialIdentity(provider,identity,file);if(identityKey)identities.set(id,identityKey);
        credentials.set(id,{raw:identity,modified:file.modtime});
        const expired=typeof identity.access_token==='string'&&!!identity.access_token&&credentialPreference(identity)[0]===0;
        const revision=credentialTokenRevision(identity);
        if(this.revokedTokens.has(id)&&this.revokedTokens.get(id)!==revision)this.revokedTokens.delete(id);
        if(revision&&revokedCredential(file))this.revokedTokens.set(id,revision);
        const authenticationRequired=expired||revokedCredential(file)||!!revision&&this.revokedTokens.get(id)===revision;
        const uid=credentialSubject(identity)??file.uid;
        let profileEmail=provider==='qoder'&&uid?qoderProfiles[uid]?.email:undefined;
        if(provider==='qoder'&&uid&&!credentialEmail(file.email)&&!credentialEmail(identity.email)&&file.auth_index!==undefined&&!file.disabled&&!expired){
          const checkedAt=qoderProfiles[uid]?.checkedAt??0;
          const force=providerScope==='qoder'&&refreshUsage;
          if((force||Date.now()-checkedAt>86400000)&&(force||Date.now()-(this.qoderProfileAttempts.get(uid)??0)>300000)){
            this.qoderProfileAttempts.set(uid,Date.now());
            try{
              const response=apiCallSchema.parse(await this.request('/api-call','POST',{auth_index:String(file.auth_index),method:'GET',url:'https://openapi.qoder.sh/api/v1/userinfo',header:{Authorization:'Bearer $TOKEN$',Accept:'application/json'},data:''},true,5000));
              if(response.status_code===200){
                const user=JSON.parse(response.body),email=credentialEmail(user?.email);
                if(String(user?.id??user?.user_id??user?.uid??'')===uid&&email&&email.length<=200){
                  profileEmail=email;qoderProfiles[uid]={email,checkedAt:Date.now()};profilesChanged=true;
                }
              }
            }catch{/* Missing profile metadata must never block the saved account or expose upstream content. */}
          }
        }
        if (file.auth_index !== undefined) quotaTargets.set(id, {authIndex: String(file.auth_index), account: {provider, email: file.email, domain:provider==='trae'&&typeof identity.host==='string'?identity.host:provider==='zcode'&&identity.provider==='bigmodel'?'bigmodel.cn':typeof identity.domain==='string'?identity.domain:undefined,
          projectId: file.project_id, accountType: file.account_type, chatgptAccountId: file.id_token?.chatgpt_account_id, planType: file.id_token?.plan_type}});
        return {
          ...(accountId?{preferredCredentialId:this.accounts.find(account=>account.id===id)?.preferredCredentialId,credentialCount:this.accounts.find(account=>account.id===id)?.credentialCount,isDuplicate:this.accounts.find(account=>account.id===id)?.isDuplicate}:{}),
          id, provider, label: accountLabels[id]??accountLabel(provider,profileEmail?{...file,email:credentialEmail(file.email)??credentialEmail(identity.email)??profileEmail}:file,{...identity,uid}),
          // Product eligibility is independent of installation, native login and enabled state.
          ...(provider==='qoder'?{nativeClients:['qoder','qoder-ide']}:provider==='workbuddy'?{nativeClients:[workbuddyLoginTarget(typeof identity.domain==='string'?identity.domain:undefined)].filter((id):id is NonNullable<typeof id>=>!!id)}:{}),
          status: file.status ?? 'unknown',
          ...(recovery?.message?{modelError:recovery.message,models:[]}:{}),
          ...(unsupportedZcode?{modelError:'ZCode 已停止本机凭证导入，请通过官网授权添加账号。旧记录已保留，可手动删除。',models:[]}:{}),
          ...(provider==='doubao'?{modelError:'旧接入将豆包与 MarsCode 混用，现已停用；原记录保留。',models:[]}:{}),
          disabled: file.disabled ?? false,
          unavailable: authenticationRequired||unresolvedQoder.has(id)||file.unavailable||false,
          authenticationRequired,
          // Runtime errors/cooldowns are not revoked credentials. The sidecar owns their retry deadlines.
          retryable: !expired&&!file.disabled&&!revokedCredential(file)&&(!!recovery?.message&&!recovery.reauthorize||Number.isFinite(Date.parse(file.next_retry_after??''))||(file.status==='error'&&!file.unavailable)),
        };
      }))];
      // Multiple grants for one UID share the verified profile, including grants
      // that skipped a concurrent lookup or are currently disabled.
      for(const account of accounts){
        const raw=credentials.get(account.id)?.raw,uid=raw&&credentialSubject(raw);
        if(account.provider==='qoder'&&uid&&qoderProfiles[uid]&&!accountLabels[account.id])account.label=credentialEmail(account.label)??qoderProfiles[uid].email;
      }
      if(profilesChanged)try{
        const temp=`${profilePath}.tmp`;await writeFile(temp,JSON.stringify(qoderProfiles),{mode:0o600});await rename(temp,profilePath);
      }catch{/* Keep verified labels in this snapshot if the optional cache cannot be written. */}
      const groups=new Map<string,LocalAccount[]>();
      for(const account of accounts){const key=identities.get(account.id)??account.id;const group=groups.get(key)??[];group.push(account);groups.set(key,group);}
      const credentialGroups=new Map([...this.credentialGroups].filter(([id])=>id===accountId||retainedIDs.has(id)));
      for(const group of groups.values()){
        if(accountId)continue;
        const preference=(a:LocalAccount)=>a.provider==='qoder'?{raw:credentials.get(a.id)?.raw??{}}:credentials.get(a.id)??{raw:{}};
        group.sort((a,b)=>Number(a.disabled)-Number(b.disabled)||Number(a.unavailable&&!a.retryable)-Number(b.unavailable&&!b.retryable)||compareCredentials(preference(a),preference(b))||a.id.localeCompare(b.id));
        for(const account of group){
          if(group.length>1){account.preferredCredentialId=group[0].id;account.credentialCount=group.length;account.isDuplicate=account.id!==group[0].id;}
          if(identities.has(account.id))credentialGroups.set(account.id,group.map(a=>a.id));
        }
      }
      for(const [alias,identity] of Object.entries(this.credentialAliases)){if(names.has(alias))continue;const group=groups.get(identity);if(group?.length)credentialGroups.set(alias,group.map(a=>a.id));}
      const retainedModels=new Set(retained.flatMap(account=>account.models??[]));
      const aliases: typeof this.aliases = accountId?Object.fromEntries(Object.entries(this.aliases).map(([provider,entries])=>[provider,entries.filter(entry=>retainedModels.has(entry.alias))])):providerScope?structuredClone(Object.fromEntries(Object.entries(this.aliases).filter(([id])=>id!==providerScope))):{};
      const discoveredAccounts = new Set<string>(unresolvedQoder);
      const catalog = new Map<string, LocalModel>(accountId?this.models.filter(model=>retainedModels.has(model.id)).map(model=>[model.id,model]):providerScope?this.models.filter(model=>model.provider!==providerScope).map(model=>[model.id,model]):[]);

      // 1. 从每个已启用账号的凭据文件目录建立模型发现
      await Promise.all(accounts.filter(a => !a.disabled && !a.authenticationRequired && !unresolvedQoder.has(a.id) && isLoginProvider(a.provider)&&(!providerScope||a.provider===providerScope)&&(!accountId||a.id===accountId)).map(async account => {
        const provider = account.provider as LoginProviderId;
        try {
          // Sidecar catalog states do not expose upstream HTTP status. Retry opaque
          // lookup failures twice as requested, but never unsupported catalogs.
          const res = await retryOfficialRead(async attempt=>z.object({models: z.array(modelSchema),catalog:z.object({status:z.enum(['live','stale','unavailable','unsupported']),verifiedAt:z.string().optional(),reason:z.string().optional()}).nullish()}).parse(await this.request(`/auth-files/models?name=${encodeURIComponent(names.get(account.id)!)}&refresh=${providerScope||attempt>1?'true':'cached'}`,'GET',undefined,true,10000)),{signal:this.requests.signal,retryResult:result=>result.catalog?.status==='stale'||result.catalog?.status==='unavailable',onRetry:attempt=>this.log(`${provider} 模型目录暂时不可用，自动尝试 ${attempt}/3。`)});
          if(res.catalog?.status==='live'&&!res.models.length)account.modelError='来源返回的当前可用模型列表为空。';
          if(res.catalog?.status==='stale')account.modelError='官方目录暂时刷新失败，使用最近 15 分钟内确认的列表。可以切换网络后刷新试试。';
          if(res.catalog?.status==='unavailable'&&!account.modelError)account.modelError='尚未获取到官方模型目录，已隐藏未经验证的旧型号。请检查来源授权，也可以切换网络后刷新试试。';
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
        } catch {account.models=[];account.modelError='模型目录刷新未完成，已隐藏未经验证的型号。可以切换网络后刷新试试。';discoveredAccounts.add(account.id);}
      }));

      // 2. 结合网关实时已注册的 /v1/models，为已启用提供商补充可用模型
      try {
        const live = z.object({data: z.array(modelSchema)}).parse(await this.request('/models', 'GET', undefined, false));
        for (const model of accountId?[]:live.data) {
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
      for(const account of accounts.filter(a=>a.provider==='qoder'&&!a.isDuplicate)){
        const ids=credentialGroups.get(account.id)??[account.id];
        account.authorizations=await Promise.all(ids.flatMap(id=>{const grant=accounts.find(a=>a.id===id);if(!grant)return [];return [(async()=>{let raw=credentials.get(id)?.raw??{};const name=names.get(id)??'';try{if(name&&!name.includes('/')&&!name.includes('\\'))raw=JSON.parse(await readConfig(join(this.root,'cliproxy','auth',name))??'{}');}catch{}return qoderAuthorization(raw,grant,name,id===account.id);})()];}));
      }
      this.credentialGroups=credentialGroups;this.accounts = accounts; this.names = names; this.authIDs = authIDs; this.quotaTargets = quotaTargets;
      for(const id of this.revokedTokens.keys())if(!names.has(id))this.revokedTokens.delete(id);
      this.quotas = Object.fromEntries(Object.entries(this.quotas).filter(([id]) => names.has(id)));
      this.models = [...catalog.values()].filter(m => accountId&&retainedModels.has(m.id)||providerScope&&m.provider!==providerScope||available.has(m.id)).sort((a,b) => a.id.localeCompare(b.id));
      this.publishAPIModels(available);
      if(!accountId&&await this.pruneExpiredQoder(accounts,credentials,identities))return this.loadAccounts(providerScope,refreshUsage);
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
    if(account?.authenticationRequired)throw Object.assign(new Error('来源账号的登录授权已失效，请在账号授权中重新登录或确认移除。'),{statusCode:401,code:'source_auth_expired'});
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
        const identity=raw as Record<string,unknown>;
        return {id:a.id,accountId:typeof identity.uid==='string'||typeof identity.uid==='number'?String(identity.uid):null,email:credentialEmail(identity.email),domain:pool==='workbuddy'?workbuddyLoginDomain(typeof identity.domain==='string'?identity.domain:undefined):undefined,enterpriseId:typeof identity.enterprise_id==='string'?identity.enterprise_id:'',switchable:p.success&&!reason,reason};
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
    let qoderProfiles:z.infer<typeof qoderProfilesSchema>={};
    try{qoderProfiles=qoderProfilesSchema.parse(JSON.parse(await readConfig(join(this.root,'qoder-profiles.json'))??'{}'));}catch{/* Missing profile evidence leaves native usage unlinked. */}
    const text=(v:unknown)=>typeof v==='string'&&v.trim()?v.trim().slice(0,320):typeof v==='number'&&Number.isSafeInteger(v)?String(v):null;
    const rows=await Promise.all(this.accounts.filter(a=>!a.isDuplicate&&['codex','claude','antigravity','workbuddy','qoder'].includes(a.provider)).map(async a=>{
      try{
        const name=this.names.get(a.id);if(!name||name.includes('/')||name.includes('\\'))return null;
        const raw=JSON.parse(await readConfig(join(this.root,'cliproxy','auth',name))??'null');if(!raw||typeof raw!=='object')return null;
        const provider=a.provider==='workbuddy'?workbuddyLoginTarget(text(raw.domain)??undefined):a.provider;if(!provider)return null;
        // Qoder grants can omit email; only reuse the profile verified against this exact UID.
        const qoderUID=provider==='qoder'?credentialSubject(raw):undefined;
        const email=credentialEmail(raw.email)??(qoderUID?credentialEmail(qoderProfiles[qoderUID]?.email):undefined)??null;
        const accountId=provider==='codex'?text(raw.account_id):provider==='claude'?text(raw.account_uuid):provider==='antigravity'?email:provider==='qoder'?qoderUID??null:text(raw.uid);
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
    if(this.credentialAliases[id]&&!this.names.has(id))id=this.preferredCredential(id,model);
    const account=this.accounts.find(a=>a.id===id);
    if(!account||account.disabled)throw nativeConflict('请选择有效的官方账号。');
    if(provider!=='claude'||model)this.sourceAuth(id,model??account?.models?.[0]??'');
    return this.nativeCredentialFile(provider,id);
  }
  async importCredential(provider:'codex'|'claude'|'qoder'|'antigravity'|'workbuddy'|'zcode'|'trae',credential:Record<string,unknown>,onlyNew=false) {
    await this.start();
    if(provider==='zcode'&&(credential.native_oauth===true||typeof credential.oauth_access_token==='string'))throw nativeConflict('ZCode 不支持本机凭证导入，请通过官网授权添加账号。');
    const complete=provider==='codex'?['access_token','refresh_token','id_token'].every(key=>typeof credential[key]==='string'&&!!credential[key]):provider==='qoder'?qoderCredentialSchema.safeParse(credential).success:['workbuddy','zcode','trae'].includes(provider)?typeof credential.access_token==='string'&&!!credential.access_token.trim():nativeCredentialSchema.safeParse(credential).success;
    if(!complete){if(onlyNew)return this.snapshot();throw nativeConflict('本机登录凭据不完整，请先在客户端完成登录。');}
    const identity=credentialIdentity(provider,credential)??credentialFingerprint(credential);
    // Each authorization remains a separate file. Re-reading one grant updates only that grant.
    const fingerprint=credentialFingerprint(credential);
    let name=`local-${provider}-${identity.slice(0,16)}-${fingerprint.slice(0,16)}.json`;let previous:Record<string,unknown>={};
    for(const account of this.accounts.filter(a=>a.provider===provider)){
      try{const existingName=this.names.get(account.id);if(!existingName||existingName.includes('/')||existingName.includes('\\'))continue;
        const raw=JSON.parse(await readConfig(join(this.root,'cliproxy','auth',existingName))??'null') as Record<string,unknown>;
        // A Qoder account holds exactly one live native grant and the token rotates on refresh,
        // so the same subject must reuse its file instead of accumulating unrefreshable stale copies.
        const subject=credentialSubject(credential);
        const sameGrant=provider==='qoder'?!!subject&&credentialSubject(raw)===subject:credentialFingerprint(raw)===fingerprint&&(credentialIdentity(provider,raw)??credentialFingerprint(raw))===identity;
        if(sameGrant){
          if(compareCredentials({raw:credential},{raw})>=0)return onlyNew?this.snapshot():this.refreshAccounts(provider);
          name=existingName;previous=raw;break;
        }
      }catch{/* Incomplete grants never suppress a new import. */}
    }
    await this.credentialHistory.remember(provider,[credential]);
    await this.request(`/auth-files?name=${encodeURIComponent(name)}`,'POST',{...previous,...credential,type:provider});
    return this.refreshAccounts();
  }
  async removeExpiredAccount(id:string){
    const previous=this.snapshot().accounts.find(a=>a.id===id);
    if(previous&&isLoginProvider(previous.provider))await this.refreshAccounts(previous.provider,false);
    const account=this.snapshot().accounts.find(a=>a.id===id);
    if(this.cursor.owns(id)){if(!account?.authenticationRequired)throw Object.assign(new Error('此账号没有已确认失效的授权，请刷新后检查。'),{statusCode:409});await this.cursor.remove(id);return this.snapshot();}
    const expired=(this.credentialGroups.get(id)??[id]).filter(candidate=>this.accounts.find(a=>a.id===candidate)?.authenticationRequired);
    if(!account||!expired.length)throw Object.assign(new Error('此账号没有已确认失效的授权，请刷新后检查。'),{statusCode:409});
    const records:Record<string,unknown>[]=[];
    for(const candidate of expired){const name=this.names.get(candidate);if(!name)continue;const raw=await readConfig(join(this.root,'cliproxy','auth',name));if(raw){records.push(JSON.parse(raw));const archive=join(this.root,'revoked-credentials');await mkdir(archive,{recursive:true,mode:0o700});await chmod(archive,0o700);await writeFile(join(archive,`${createHash('sha256').update(name+raw).digest('hex')}.json`),raw,{mode:0o600});}await this.request(`/auth-files?name=${encodeURIComponent(name)}`,'DELETE');delete this.quotas[candidate];}
    if(records.length)await this.credentialHistory.forget(account.provider,records);
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
  async refreshAccount(id:string):Promise<LocalAgentSnapshot> {
    if(this.credentialAliases[id]&&!this.names.has(id))id=this.preferredCredential(id);
    const account=this.snapshot().accounts.find(account=>account.id===id);
    if(!account)throw Object.assign(new Error('账号已变更，请刷新账号列表'),{statusCode:404});
    if(this.cursor.owns(id)){await this.cursor.refresh(true,id);return this.snapshot();}
    if(!isLoginProvider(account.provider))return this.snapshot();
    await this.refreshAccounts(account.provider,false,account.provider==='qoder'?undefined:id);
    return this.loadQuota(account.provider,id);
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
  private async loadQuota(providerScope:LoginProviderId|'cursor',accountId?:string) {
    if (this.state !== 'running') throw new Error('请先启动 Local Agent');
    const targets = this.accounts.filter(account => !account.disabled && !account.isDuplicate && account.provider===providerScope && (!accountId||account.id===accountId) && isLoginProvider(account.provider) && !!quotaProviders[account.provider as LoginProviderId] && this.quotaTargets.has(account.id));
    await Promise.all(targets.map(async account => {
      const provider = account.provider as LoginProviderId;
      const quotaProvider = quotaProviders[provider];
      if (!quotaProvider) return;
      const {authIndex, account: info} = this.quotaTargets.get(account.id)!;
      const checkedRevision=provider==='codex'?await this.credentialRevision(account.id):undefined;
      const signal=this.requests.signal;
      const call = (request: QuotaRequest): Promise<QuotaResponse> => retryQuotaCall(async()=>{
        if(!this.accounts.some(a=>a.id===account.id&&!a.disabled))throw new Error('账号已停用或移除，已停止额度查询。');
        return apiCallSchema.transform(r => ({statusCode: r.status_code, header: r.header, body: r.body}))
          .parse(await this.request('/api-call', 'POST', {auth_index: authIndex, method: request.method, url: request.url, header: request.header, data: request.data ?? ''}, true, 45000));
      },signal,attempt=>this.log(`${provider} 额度连接暂时失败，自动尝试 ${attempt}/3。`));
      const observedAt = new Date().toISOString();
      try {
        const report = await quotaProvider.fetch(call, info);
        if (signal.aborted||!this.accounts.some(a=>a.id===account.id&&!a.disabled)||!this.names.has(account.id)) return;
        this.quotas[account.id] = {accountId: account.id, provider, status: 'ok', observedAt, plan: report.plan, windows: report.windows, note: report.note};
      } catch (error) {
        const is401 = error instanceof QuotaHTTPError && error.status === 401;
        const is403 = error instanceof QuotaHTTPError && error.status === 403;
        const revoked=is401&&provider==='codex'&&error.code==='token_revoked'&&!!checkedRevision&&checkedRevision===await this.credentialRevision(account.id);
        const isMissingProject = error instanceof Error && error.message.includes('project_id');
        // A bare 401 is ambiguous. Codex's explicit revocation code is evidence
        // only for the exact token checked, never a replacement saved mid-request.
        const message = revoked ? '登录授权已失效：官方已撤销此授权，请重新登录或确认移除。'
          : is401 ? '额度接口暂未通过认证（HTTP 401），已保留授权；可稍后重查或重新登录。'
          : isMissingProject ? '账号缺少关联项目（project_id），无法调用 Google 模型。请重新连接。'
          : is403 ? '访问受限（HTTP 403），当前凭据权限不足或账号受限。'
          : error instanceof z.ZodError ? '上游 api-call 响应格式异常。'
          : error instanceof Error ? error.message : '额度查询失败。';
        if (signal.aborted||!this.accounts.some(a=>a.id===account.id&&!a.disabled)||!this.names.has(account.id)) return;
        if(revoked){
          this.revokedTokens.set(account.id,checkedRevision!);
          const current=this.accounts.find(a=>a.id===account.id)!;
          current.authenticationRequired=true;current.unavailable=true;current.retryable=false;current.models=[];
        }
        const previous=this.quotas[account.id];
        const lastSuccessfulAt=previous?.status==='ok'?previous.observedAt:previous?.lastSuccessfulAt;
        this.quotas[account.id] = {accountId: account.id, provider, status: 'error', observedAt, windows: lastSuccessfulAt?previous.windows:[], ...(lastSuccessfulAt?{lastSuccessfulAt,plan:previous.plan}:{}), error: `${message.slice(0, 260)}${revoked||message.includes(refreshNetworkHint)?'':` ${refreshNetworkHint}`}`};
      }
    }));
    if(providerScope==='cursor')await this.cursor.refresh();
    const success=targets.filter(account=>this.quotas[account.id]?.status==='ok').length;
    if(providerScope!=='cursor')this.log(`${providerScope} 额度查询：${success} 成功，${targets.length-success} 失败，${targets.length} 个可查询账号${targets.length?'':'（没有可查询账号，未发起额度请求）'}`);
    return this.snapshot();
  }
  // 登录层入口：所有 Provider 共用同一个会话控制器。
  async login(provider: LoginProviderId | 'cursor') {this.cursorLoginSelected=provider==='cursor';if(provider==='cursor'){if(this.login_.isPending())throw new Error('请先完成当前授权');await this.cursor.beginLogin();}else{if(['starting','waiting_for_browser'].includes(this.cursor.snapshot().login?.status??''))throw new Error('请先完成 Cursor 授权');await this.login_.login(provider);}return this.snapshot();}
  private async readLocalCredential(provider:'trae'|'workbuddy'|'workbuddy-ai'){
    const route=provider==='workbuddy-ai'?'/workbuddy-local-credential?region=overseas':`/${provider}-local-credential`;
    return z.object({credential:z.object({access_token:z.string().trim().min(1).max(30000)}).passthrough()}).parse(await this.request(route)).credential;
  }
  async localImportStatus(provider:'trae'){
    const common={readOnly:true,pids:[],backup:null,gatewayConnected:false};
    try{
      const raw=await this.readLocalCredential(provider),identity=credentialIdentity(provider,raw)??credentialFingerprint(raw);
      const accounts=await Promise.all(this.accounts.filter(a=>a.provider===provider).map(async a=>{
        const name=this.names.get(a.id);let saved:Record<string,unknown>={};
        if(name&&!name.includes('/')&&!name.includes('\\'))try{saved=JSON.parse(await readConfig(join(this.root,'cliproxy','auth',name))??'{}');}catch{/* Do not match unreadable grants. */}
        return {id:a.id,accountId:credentialIdentity(provider,saved)??credentialFingerprint(saved),email:credentialEmail(saved.email),switchable:false,reason:'请在官方客户端切换本机登录。'};
      }));
      return {...common,revision:credentialFingerprint(raw),loginState:'signed-in' as const,accountId:identity,email:credentialEmail(raw.email),displayName:typeof raw.username==='string'?raw.username:credentialSubject(raw),accounts};
    }catch(error){
      return {...common,revision:'unreadable',loginState:'unreadable' as const,readError:error instanceof Error?error.message:'本机登录暂时无法读取，请稍后刷新。',accounts:[]};
    }
  }
  async importLocal(provider: 'trae' | 'workbuddy' | 'workbuddy-ai' | 'zcode' | 'cursor', onlyNew=false) {
    if(provider==='zcode')throw nativeConflict('ZCode 不支持本机凭证导入，请通过官网授权添加账号。');
    if(provider==='cursor'){await this.cursor.importLocal();return this.snapshot();}
    if (this.state !== 'running') await this.start();
    // Preview is management-only: native readers return credentials to this process,
    // never to the renderer, and do not save over a refreshed pool grant.
    const credential=await this.readLocalCredential(provider);
    const result=await this.importCredential(provider==='workbuddy-ai'?'workbuddy':provider,credential,onlyNew);
    this.log(`已完成 ${provider} 本机凭据导入`);
    return result;
  }

  async openLogin(id: string) {if(this.cursor.snapshot().login?.id===id){await this.cursor.openLogin(id);return this.snapshot();}await this.login_.open(id); return this.snapshot();}
  async submitCallback(id: string, value: string) {await this.login_.submitCallback(id, value); return this.snapshot();}
  async cancelLogin(id: string) {if(this.cursor.snapshot().login?.id===id){this.cursor.cancelLogin(id);return this.snapshot();}await this.login_.cancel(id); return this.snapshot();}
  async shutdown() {this.closing = true;this.networkCheckAbort?.abort();try{await this.cursor.close(); this.login_.close(); await this.stop(); await this.refreshTask?.catch(() => undefined); await this.quotaTask?.catch(() => undefined);await Promise.allSettled([...this.quotaProviderTasks.values()]);await this.networkCheckTask;}finally{await this.network?.close();this.network=undefined;}}
}

export type LocalAgentSnapshot = ReturnType<CLIProxyManager['snapshot']> & {accountsLoading?:boolean;apiSources?:import('./api-sources.js').ApiSource[]};
