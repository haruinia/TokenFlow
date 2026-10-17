import {CursorLocalLogin} from './cursor-local.js';
import { apiModelRoute } from '../../../apps/shared/api-endpoint.js';
import {QoderIdeLogin,type QoderIdeOptions} from './qoder-ide-login.js';
import {registerFileCleanup} from './file-cleanup-routes.js';
import type {FileCleanupOptions} from './file-cleanup.js';
import {maintenanceStorage} from './maintenance-storage.js';
import {maintenanceUsage,maintenanceUsageQuery,type MaintenanceUsageQuery} from './maintenance-usage.js';
import {DesktopAccounts,type DesktopAccountOptions,type DesktopProvider} from './desktop-accounts.js';
import {maintenanceContext,type MaintenanceContext} from './maintenance-conversations.js';
import {modelProbeInput,probeModelHTTP,type ModelProbeInput} from './maintenance-http.js';
import {CodexSwitchLifecycle} from './codex-switch-lifecycle.js';
import {WorkBuddySDKProvider} from './codebuddy.js';
import {CodexThreadMigration} from './codex-thread-migration.js';
import {PiTerminalLifecycle} from './pi-terminal-lifecycle.js';
import {ClaudeTerminalLifecycle} from './claude-terminal-lifecycle.js';
import {ClaudeDesktopConnections,type ClaudeDesktopOptions} from './claude-desktop.js';
import {claudeDesktopModelLimit} from '../../../apps/shared/claude-desktop-models.js';
import { LocalMaintenance } from './local-maintenance.js';
import { ApiSources, parseApiSourceInput, apiModelID } from './api-sources.js';
import { detectProtocol, validateQuickSource, sourceNameFromURL } from './api-protocol.js';
import { NativeAccounts, nativeCredentialSchema, nativeProviderSchema, type NativeProvider } from './native-accounts.js';
import { ClaudeAccountStore, claudeSettingsState, type CredentialStore } from './claude-accounts.js';
import { AntigravityAccountStore, antigravityDatabasePath } from './antigravity-accounts.js';
import { upstreamIdle } from './upstream-idle.js';
import { GatewayContext, GatewayContextError } from './gateway-context.js';
import {CodexContext,codexContextScope,portableCodexItem} from './codex-context.js';
import { CodexAccounts } from './codex-accounts.js';
import { AgentInstallationManager,detectAgent } from './agent-installation.js';
import {LocalUsageIndex} from './local-usage-index.js';
import {CursorNativeUsage} from './cursor-native-usage.js';
import {mergeLocalUsageRows,recentLocalUsageRows} from './local-usage.js';
import {UsageAttribution,mapNativeAccounts} from './usage-attribution.js';
import {NativeUsageLogins} from './native-usage-logins.js';
import {AgentUpdates} from './agent-updates.js';
import { AgentConnections, modelSelectionSchema, modelSelectionsSchema, type ModelSelection, agentProcesses, targetSchema, type AgentPaths, type Target } from './agent-connections.js';
import { modelLabel } from './model-label.js';
import { QoderLifecycle } from './agent-lifecycle.js';
import { localCredential } from './local-credentials.js';
import { upstreamError,readUpstreamError } from './upstream-errors.js';
import { MaintenanceApproval,approvalPolicy } from './maintenance-approval.js';
import { GatewayMaintenance, maintenanceSelection, maintenanceChain, type MaintenanceChain } from './gateway-maintenance.js';
import { SwitchJournal, type SwitchAction } from './switch-journal.js';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import staticPlugin from '@fastify/static';
import { z } from 'zod';
import { createServer } from './server.js';
import { ResponsesProvider, providerSchema, defaultProvider, type ProviderConfig, type ProbeResult } from './providers.js';
import { GatewayActivity, observeUsage } from './gateway-activity.js';
import {GatewayTraces,requestTrace} from './gateway-traces.js';
import {nativeActivityTrace,nativeActivitySummary} from './activity-traces.js';
import type {ResponseObservation} from './gateway-observation.js';
import { UsageLedger } from './usage-ledger.js';
import { GatewayKeys, gatewayKeyInput, allowsProtocol, type GatewayKey } from './gateway-keys.js';
import { CLIProxyManager, type LocalAgentSnapshot, type LocalModel } from './cliproxy.js';
import { isLoginProvider, loginProviderIds } from './login/index.js';
import { RunnerCoreError } from './errors.js';

export type Secrets = {canEncrypt?:()=>boolean;persistent?:boolean;get:(name:string)=>Promise<string>; set:(name:string,value:string)=>Promise<void>;remove?:(name:string)=>Promise<void>};
export type ServiceOptions = {outboundProxyURL?:string;networkSnapshot?:()=>import('./network-proxy.js').NetworkSnapshot;fileCleanup?:FileCleanupOptions;qoderIde?:QoderIdeOptions;claudeDesktop?:ClaudeDesktopOptions;claudeDesktopChange?:(work:()=>Promise<unknown>)=>Promise<unknown>;claudeTerminalChange?:(work:()=>Promise<unknown>)=>Promise<unknown>;desktopAccounts?:DesktopAccountOptions;desktopProcesses?:(target:DesktopProvider|'qoder-ide')=>Promise<number[]>;desktopAccountChange?:(target:DesktopProvider|'qoder-ide',work:()=>Promise<unknown>)=>Promise<unknown>;workbuddySDKFactory?:(proxy:CLIProxyManager)=>Pick<WorkBuddySDKProvider,'response'|'close'>;antigravityPath?:string;cursorLocalPath?:string;claudeCredentialStore?:CredentialStore|null;nativeProcesses?:(target:NativeProvider)=>Promise<number[]>;agentPaths?:Partial<AgentPaths>;agentProcesses?:(target:Target)=>Promise<number[]>;root:string;binary:string;token:string;localKey:string;secrets:Secrets;credentialWarnings?:()=>string[];uiRoot?:string;proxyPort?:number;openExternal?:(url:string)=>Promise<void>};
const clientCredential=(headers:{authorization?:string;'x-api-key'?:string|string[]})=>{
  const bearer=headers.authorization?.replace(/^Bearer /,'')??'';
  const apiKey=typeof headers['x-api-key']==='string'?headers['x-api-key']:'';
  return {value:bearer||apiKey,conflict:!!bearer&&!!apiKey&&bearer!==apiKey};
};
const same=(a:string,b:string)=>{const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length && timingSafeEqual(left,right);};
export async function createDesktopService(options:ServiceOptions) {
  const proxyPort=z.number().int().min(1).max(65535).parse(options.proxyPort??8317);
  const root=resolve(options.root);
  await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);
  const ledger=await UsageLedger.open(root);
  const activity=new GatewayActivity(ledger);const traces=await GatewayTraces.open(root);
  const gatewayKeys=await GatewayKeys.open(root);
  const gatewayContext=await GatewayContext.open(root);
  const settingsPath=join(root,'settings.json');
  let config:ProviderConfig={...defaultProvider};
  config.baseURL=`http://127.0.0.1:${proxyPort}/v1`;
  try {
    const raw = JSON.parse(await readFile(settingsPath, 'utf8'));
    const parsed = providerSchema.safeParse(raw);
    if (parsed.success) {
      config = parsed.data;
    } else {
      console.warn('settings.json 配置格式不符合规范，降级为默认设置启动:', parsed.error);
    }
  } catch(e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('读取 settings.json 失败，降级为默认设置启动:', e);
    }
  }
  const apiSources=await ApiSources.open(root,options.secrets,config);
  const proxy=new CLIProxyManager(root,options.binary,options.localKey,proxyPort,{outboundProxyURL:options.outboundProxyURL,networkSnapshot:options.networkSnapshot,openExternal:options.openExternal,secrets:options.secrets,apiConfig:()=>apiSources.sidecarConfig(),apiModelIDs:()=>apiSources.sidecarModelIDs()});
  const localSnapshot=async():Promise<LocalAgentSnapshot>=>{
    const sources=await apiSources.list();const local=proxy.snapshot();
    return {...local,accountsLoading:discovery.state==='loading'||proxy.isLoadingAccounts(),apiSources:sources,models:[...local.models,...sources.filter(s=>s.enabled&&s.hasKey).flatMap(s=>s.models.filter(model=>proxy.apiModelAvailable(apiModelID(s.id,model))).map(model=>({id:apiModelID(s.id,model),displayName:modelLabel([],apiModelID(s.id,model),sources),provider:'api' as const})))]};
  };
  const resolveSource=(id:string,model:string,retryKnownModel=false)=>{
    if(apiSources.has(id)){if(proxy.snapshot().state!=='running')throw Object.assign(new Error('网关未启动'),{statusCode:409});apiSources.assert(id,model);if(!proxy.apiModelAvailable(model))throw new RunnerCoreError('API 模型路由暂不可用，请重新保存来源或重启网关。',{code:'api_model_unavailable',statusCode:409});return '';}
    return proxy.sourceAuth(id,model,retryKnownModel);
  };
  // Saving a pinned selection does not require a successful live availability check.
  // Keep source ownership validation separate from execution-time authorization.
  const validateSavedSelections=async(selections:ModelSelection[],retained:ModelSelection[]=[])=>{
    const accounts=proxy.snapshot().accounts,sources=await apiSources.list();
    for(const choice of selections){
      const known=retained.some(item=>item.sourceId===choice.sourceId&&item.model===choice.model)
        ||accounts.some(account=>account.id===choice.sourceId&&account.models?.includes(choice.model))
        ||sources.some(source=>source.id===choice.sourceId&&source.models.some(model=>apiModelID(source.id,model)===choice.model));
      if(!known)throw Object.assign(new Error('所选模型尚未绑定此来源，请先从来源模型列表选择。'),{statusCode:409});
    }
  };
  let probe:ProbeResult|undefined;
  let probing=false;
  const key=()=>config.kind==='cliproxy'?Promise.resolve(proxy.gateway().apiKey):options.secrets.get(config.kind);
  const workbuddySDK=options.workbuddySDKFactory?.(proxy)??new WorkBuddySDKProvider(root,(sourceId,model)=>proxy.workbuddyCredential(sourceId,model));
  const cursorFetch=(model:string,sourceId=model.startsWith('workbuddy/')?proxy.snapshot().accounts.find(a=>a.provider==='workbuddy'&&!a.disabled&&a.models?.includes(model))?.id:proxy.cursor.id,owner='workspace'):typeof fetch|undefined=>{
    if(!/^(cursor|workbuddy)\//.test(model))return;
    return async(input,init)=>{
      const request=new Request(input,init);const url=new URL(request.url);const gateway=new URL(proxy.gateway().baseURL);
      if(url.origin!==gateway.origin||!url.pathname.startsWith('/v1/'))throw new Error('Cursor transport destination mismatch');
      if(proxy.snapshot().state!=='running'||!sourceId)throw new Error('Cursor source unavailable');
      resolveSource(sourceId,model);
      const route=url.pathname.slice('/v1/'.length);
      if(route==='models'&&request.method==='GET'){const models=model.startsWith('workbuddy/')?(proxy.snapshot().accounts.find(a=>a.id===sourceId)?.models??[]).map(id=>({id,object:'model',owned_by:'workbuddy'})):proxy.cursor.snapshot().models.map(m=>({id:m.id,object:'model',owned_by:'cursor'}));return Response.json({object:'list',data:models});}
      const body=await request.json() as {model:string};if(body.model!==model)throw new Error('Cursor model scope mismatch');
      const send=(path:string,value:unknown)=>model.startsWith('workbuddy/')?workbuddySDK.response(sourceId!,path,value,request.signal):proxy.cursor.response(path,value,request.signal,sourceId);
      return ['responses','responses/compact'].includes(route)?gatewayContext.response(route,body,owner,sourceId,send):send(route,body);
    };
  };
  const provider=async()=>new ResponsesProvider(config,await key(),undefined,config.kind==='cliproxy'?cursorFetch(config.model):undefined);
  const app=createServer({allowedOrigins:[]});
  let mutationOwner:string|undefined;
  let selectionClearOwner:string|undefined;
  const maintenanceRequests=new Set<string>();
  app.addHook('onResponse',async req=>{if(mutationOwner===req.id)mutationOwner=undefined;if(selectionClearOwner===req.id)selectionClearOwner=undefined;maintenanceRequests.delete(req.id);});
  app.addHook('onRequest',async(req,reply)=>{
    const hostHeader=req.headers.host??'';
    if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(hostHeader))return reply.code(403).send({error:'Invalid Host'});
    const origin=req.headers.origin;
    if(origin && origin!==`http://${hostHeader}`)return reply.code(403).send({error:'Invalid Origin'});
    const route=req.routeOptions.url??req.url;
    if(route.startsWith('/api/')||route.startsWith('/v1/')){
      const credential=clientCredential(req.headers);
      if(credential.conflict)return reply.code(401).send({error:'Conflicting API credentials'});
      const bearer=credential.value;
      const cookie=(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('agent_session='))?.slice(14)??'';
      if(route.startsWith('/v1/') && gatewayKeys.authenticate(bearer)) return;
      // An explicit bad bearer must not fall back to an administrator browser cookie.
      if(!(bearer ? same(bearer,options.token) : same(cookie,options.token)))return reply.code(401).send({error:'Local API authentication required'});
    }
  });
  app.addHook('preValidation',async(req,reply)=>{
    const route=req.routeOptions.url;
    if(req.method!=='GET'&&route?.startsWith('/api/')&&!route.startsWith('/api/file-cleanup')&&fileCleanup.isCleaning())return reply.code(409).send({error:'文件清理正在进行，请等待完成后再操作。'});
    if(req.method!=='GET'&&route?.startsWith('/api/maintenance')){
      if(selectionClearOwner||(route==='/api/maintenance/selection'&&maintenanceRequests.size))return reply.code(409).send({error:'维修设置正在处理，请稍后重试。'});
      maintenanceRequests.add(req.id);if(route==='/api/maintenance/selection')selectionClearOwner=req.id;
      const localRun=localMaintenance.snapshot();
      if(localRun.active&&localRun.runs[0]?.kind==='upgrade'&&!['/api/maintenance/stop','/api/maintenance/local/stop'].includes(route))return reply.code(409).send({error:'升级正在执行，请等待完成后启动维修或修改权限。'});
    }
    if((req.method==='PUT'&&(route==='/api/settings'||route==='/api/local-agent/gateway'||route==='/api/sources/:id'))||(req.method==='DELETE'&&(route==='/api/local-agent/accounts/:id'||route==='/api/sources/:id'||route==='/api/maintenance/selection'))||(req.method==='POST'&&['/api/maintenance/local/upgrade','/api/sources','/api/sources/quick','/api/sources/:id/models','/api/sources/:id/check','/api/native-accounts/:provider/switch','/api/native-accounts/:provider/restore','/api/codex-accounts/switch','/api/codex-accounts/restore','/api/claude-desktop/connect','/api/claude-desktop/restore','/api/claude-desktop/official','/api/claude-desktop/restart','/api/a2a/connect','/api/a2a/codex-migration/restore','/api/a2a/program','/api/a2a/restart','/api/a2a/restore','/api/a2a/delete','/api/a2a/import','/api/providers/probe','/api/local-agent/:action','/api/local-agent/login/:action','/api/local-agent/accounts/:id','/api/local-agent/import-local/:provider'].includes(route??''))) {
      if(localMaintenance.snapshot().active)return reply.code(409).send({error:'本地诊断或升级正在运行，请等待完成后修改配置。'});
      if(mutationOwner)return reply.code(409).send({error:'另一个启动或配置操作正在进行，请稍后重试。'});
      mutationOwner=req.id;
    }
  });
  app.get('/api/settings',async()=>({provider:config,hasKey:!!await key(),probe,credentialWarnings:[...(options.credentialWarnings?.()??[]),...apiSources.warnings()]}));
  const fileCleanup=registerFileCleanup(app,root,options.fileCleanup,()=>{
    if(mutationOwner||localMaintenance.snapshot().active||maintenance.snapshot().status==='running'||maintenance.snapshot().readiness.status==='checking'||approval.isBusy())throw Object.assign(new Error('配置切换、诊断或维修正在进行，请等待完成后再清理文件。'),{statusCode:409});
  });
  app.put('/api/settings',async(req)=>{
    if(probing)throw Object.assign(new Error('能力探测正在进行'),{statusCode:409});
    const input=z.object({provider:providerSchema,apiKey:z.string().max(4096).optional()}).strict().parse(req.body);
    if(input.provider.kind==='cliproxy' && input.provider.baseURL!==`http://127.0.0.1:${proxy.port}/v1`)throw new Error('受管 Local Agent 地址固定；已有服务请选择 Custom');
    if(input.apiKey!==undefined && input.provider.kind!=='cliproxy')await options.secrets.set(input.provider.kind,input.apiKey);
    await writeFile(settingsPath,JSON.stringify(input.provider,null,2),{mode:0o600});config=input.provider;probe=undefined;return {provider:config};
  });
  app.get('/api/providers/models',async()=>({data:await(await provider()).listModels()}));
  app.post('/api/providers/probe',async()=>{if(!config.model)throw Object.assign(new Error('请先选择模型'),{statusCode:400});if(probing)throw Object.assign(new Error('探测正在进行'),{statusCode:409});probing=true;try{probe=await(await provider()).probe();return probe;}finally{probing=false;}});
  const localOperation=async<T>(operation:()=>Promise<T>):Promise<T>=>{
    try{return await operation();}
    catch(error){throw new RunnerCoreError(error instanceof Error?error.message:'Local Agent 操作失败',{code:'local_agent_error',statusCode:400});}
  };
  const connections=new AgentConnections(root,options.agentPaths,options.agentProcesses);
  const claudeDesktop=new ClaudeDesktopConnections(options.secrets,options.claudeDesktop);
  const claudeTerminal=new ClaudeTerminalLifecycle(undefined,undefined,undefined,{},dirname(connections.paths.claude));
  const switchJournal=new SwitchJournal(join(root,'switch-failures.json'));await switchJournal.load();
  const switchActions:Record<string,SwitchAction>={'/api/a2a/connect':'connect','/api/a2a/restore':'restore','/api/a2a/codex-migration/restore':'migration-restore','/api/codex-accounts/switch':'official-switch','/api/codex-accounts/restore':'official-restore','/api/native-accounts/:provider/switch':'official-switch','/api/native-accounts/:provider/restore':'official-restore'};
  app.addHook('onError',async(req,_,error)=>{
    try{
      const action=req.method==='POST'?switchActions[req.routeOptions.url??'']:undefined;if(!action)return;
      const status=error instanceof Error&&'issues' in error?400:typeof (error as {statusCode?:unknown}).statusCode==='number'?(error as {statusCode:number}).statusCode:500;
      if(status===401||status===403)return;
      const body=req.body&&typeof req.body==='object'?req.body as Record<string,unknown>:{};
      const named=typeof body.target==='string'&&targetSchema.safeParse(body.target).success?body.target:undefined;
      const provider=(req.params as {provider?:string}).provider;
      let target=named??(provider&&['claude','codex','antigravity','workbuddy','workbuddy-ai','qoder','qoder-ide'].includes(provider)?provider:undefined);
      if(!target&&(req.routeOptions.url??'').includes('codex'))target='codex';
      if(!target&&typeof body.id==='string'){try{target=(await connections.status()).find(item=>item.connection?.id===body.id||item.backups.some(record=>record.id===body.id))?.id;}catch{/* The original error is the one the client is waiting on. */}}
      const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?error.code:undefined;
      await switchJournal.record({action,target:target??'unknown',...(typeof body.model==='string'?{model:body.model}:{}),...(typeof body.sourceId==='string'?{sourceId:body.sourceId}:{}),message:error instanceof Error?error.message:'切换失败',code});
    }catch{/* A journal failure must not replace the switch error. */}
  });
  app.addHook('onResponse',async(req,reply)=>{
    const action=req.method==='POST'?switchActions[req.routeOptions.url??'']:undefined;if(!action||reply.statusCode>=400)return;
    try{
      const body=(req.body??{}) as Record<string,unknown>,provider=(req.params as {provider?:string}).provider;
      let target=typeof body.target==='string'?body.target:provider;
      if(!target&&(req.routeOptions.url??'').includes('codex'))target='codex';
      if(!target&&typeof body.id==='string')target=(await connections.status()).find(t=>t.backups.some(b=>b.id===body.id))?.id;
      await switchJournal.record({action,target:target??'unknown',outcome:'completed',message:'配置操作已完成；对话实际回复需另行验证。',...(typeof body.sourceId==='string'?{sourceId:body.sourceId}:{}),...(typeof body.model==='string'?{model:body.model}:{})});
    }catch{/* Logging must not change the result of a completed switch. */}
  });
  const attribution=await UsageAttribution.open(root);let attributionWarning='';
  app.post('/local-telemetry/codex/v1/logs',{bodyLimit:1024*1024},async(req,reply)=>{if(!same(String(req.headers['x-tokenflow-recorder']??''),attribution.token))return reply.code(401).send({error:'Recorder authentication required'});attribution.accept(req.body);return {};});
  const enableAttribution=async()=>{const address=app.server.address();if(address&&typeof address==='object')try{await attribution.enable(connections.paths.codex,`http://127.0.0.1:${address.port}`);}catch{attributionWarning='Codex 请求账号记录尚未启用，未收到证据的请求继续显示未确认。';}};
  app.addHook('onListen',enableAttribution);
  const localUsage=new LocalUsageIndex(root,connections.paths,()=>{const address=app.server.address();return [proxy.port,...(address&&typeof address==='object'?[address.port]:[])];},options.cursorLocalPath?{cursor:[options.cursorLocalPath]}:{});
  const cursorNativeUsage=await CursorNativeUsage.open(root,()=>proxy.cursor.nativeUsageReaders());
  // A managed Agent uses the model selected here even if an existing conversation retains an older model ID.
  // Bind by saved connection key, never by its editable display name or by an arbitrary single-model key.
  const fixedRoutes=new Map<string,{target:Target|'claude-desktop';sourceId:string;model:string;selections?:ModelSelection[];modelAliases?:Record<string,string>}>((await connections.status()).flatMap(t=>t.connection?.state==='applied'?[[t.connection.keyId,{target:t.id,sourceId:t.connection.sourceId,model:t.connection.model,selections:t.connection.selections,modelAliases:t.connection.modelAliases}] as const]:[]));
  const desktopRoute=await claudeDesktop.route().catch(()=>null);if(desktopRoute?.keyId&&desktopRoute.selections[0])fixedRoutes.set(desktopRoute.keyId,{target:'claude-desktop',...desktopRoute.selections[0],selections:desktopRoute.selections,modelAliases:desktopRoute.modelAliases});
  const codexContext=new CodexContext(root,connections.paths.codex,gatewayContext);
  const codexContextScopes=async()=>((await connections.status()).find(t=>t.id==='codex')?.backups??[]).flatMap(record=>(record.selections??[record]).map(item=>({owner:record.keyId,source:item.sourceId,model:item.model})));
  const codexLifecycle=new CodexSwitchLifecycle(()=>options.agentProcesses?options.agentProcesses('codex'):agentProcesses('codex'));
  const codexChange=<T>(restart:boolean,work:()=>Promise<T>)=>restart?codexLifecycle.change(work):work();
  const codexThreads=new CodexThreadMigration(root,connections.paths.codex,()=>options.agentProcesses?options.agentProcesses('codex'):agentProcesses('codex'));
  const prepareCodexOfficial=async()=>codexContext.prepareOfficial(await codexContextScopes(),async()=>options.agentProcesses?options.agentProcesses('codex'):agentProcesses('codex'));
  const restoreCodexHistory=async(compatibility:boolean,model?:string|(()=>Promise<string|undefined>))=>{
    if(compatibility)await prepareCodexOfficial();else await codexContext.repairLineage(async()=>options.agentProcesses?options.agentProcesses('codex'):agentProcesses('codex'));
    return codexThreads.restore(model);
  };
  const codexAccounts=new CodexAccounts(root,connections.paths.codex,options.agentProcesses?()=>options.agentProcesses!('codex'):undefined);
  const claudeAccountStore=new ClaudeAccountStore(connections.paths.claude,options.claudeCredentialStore);
  const antigravityAccountStore=new AntigravityAccountStore(options.antigravityPath??await antigravityDatabasePath());
  const desktopAccounts=Object.fromEntries((['workbuddy','workbuddy-ai','qoder'] as const).map(provider=>[provider,new DesktopAccounts(provider,options.secrets,()=>options.desktopProcesses?options.desktopProcesses(provider):provider!=='workbuddy-ai'&&options.agentProcesses?options.agentProcesses(provider):agentProcesses(provider),options.desktopAccounts)])) as Record<DesktopProvider,DesktopAccounts>;
  const nativeAccounts={
    claude:new NativeAccounts(join(root,'claude-account-backup.json'),claudeAccountStore,()=>options.nativeProcesses?options.nativeProcesses('claude'):options.agentProcesses?options.agentProcesses('claude'):agentProcesses('claude')),
    antigravity:new NativeAccounts(join(root,'antigravity-account-backup.json'),antigravityAccountStore,()=>options.nativeProcesses?options.nativeProcesses('antigravity'):agentProcesses('antigravity')),
  };
  const nativeUsageLogins=await NativeUsageLogins.open(root);
  let nativeLoginObservation:Promise<void>|undefined,nativeLoginTimer:ReturnType<typeof setInterval>|undefined;
  const observeNativeLogins=()=>nativeLoginObservation??=(async()=>{
    const [codex,claude,antigravity,workbuddy,workbuddyAI,qoder]=await Promise.all([codexAccounts.usageLogin().catch(()=>null),claudeAccountStore.usageLogin().catch(()=>null),antigravityAccountStore.usageLogin().catch(()=>null),desktopAccounts.workbuddy.usageLogin().catch(()=>null),desktopAccounts['workbuddy-ai'].usageLogin().catch(()=>null),desktopAccounts.qoder.usageLogin().catch(()=>null)]);
    await nativeUsageLogins.observe({codex,claude,antigravity,workbuddy,'workbuddy-ai':workbuddyAI,qoder});
  })().finally(()=>{nativeLoginObservation=undefined;});
  await observeNativeLogins();
  app.addHook('onListen',async()=>{await observeNativeLogins();nativeLoginTimer=setInterval(()=>void observeNativeLogins(),5000);nativeLoginTimer.unref();});
  const nativeUsageSnapshot=async()=>{
    await observeNativeLogins();const snapshot=localUsage.snapshot();
    const cursor=cursorNativeUsage.snapshot(snapshot);
    const accounts=await proxy.nativeUsageAccounts();
    const rows=mergeLocalUsageRows([...snapshot.rows,...cursor.rows]),recent=recentLocalUsageRows([...(snapshot.recent??[]),...cursor.rows]);
    return {...snapshot,rows:mapNativeAccounts(rows,accounts,nativeUsageLogins.accounts()),recent:mapNativeAccounts(recent,accounts,nativeUsageLogins.accounts()),coverage:[...snapshot.coverage.filter(c=>c.target!=='cursor'),cursor.coverage],scanning:snapshot.scanning||cursor.scanning,warning:snapshot.warning||nativeUsageLogins.warning||cursor.warning};
  };
  const desktopLifecycle=new QoderLifecycle();
  let discoveryTask:Promise<void>|undefined;
  let startupCheckTimer:ReturnType<typeof setTimeout>|undefined;
  let serviceClosing=false;
  const discovery:{state:'idle'|'loading'|'ready';unavailable:string[]}={state:'idle',unavailable:[]};
  const discoverLocal=()=>discoveryTask??=(async()=>{
    discovery.state='loading';
    try{await proxy.start();for(const target of ['codex','claude'] as const){
      try{await proxy.importCredential(target,await localCredential(target,connections.paths,options.claudeCredentialStore),true);}
      catch{discovery.unavailable.push(target);}
    }
    for(const provider of ['workbuddy','zcode','trae'] as const){
      try{await proxy.importLocal(provider,true);}catch{discovery.unavailable.push(provider);}
    }}finally{
      discovery.state='ready';
      // Once per startup, after local authorization discovery; polling never spends quota.
      const deadline=Date.now()+30000;
      const checkWhenDiscovered=async()=>{
        if(serviceClosing||selectionClearOwner||!maintenance.snapshot().selection||maintenance.snapshot().readiness.status!=='unchecked')return;
        try{maintenance.check(await maintenanceTransport());}
        catch{if(Date.now()<deadline)startupCheckTimer=setTimeout(checkWhenDiscovered,500);}
      };
      void checkWhenDiscovered();
    }
  })();
  const maintenance=new GatewayMaintenance(root);await maintenance.load();
  const localMaintenance=new LocalMaintenance(root,connections,{processes:options.agentProcesses,gateway:()=>({port:proxy.port,state:proxy.snapshot().state}),source:async id=>{
    const source=(await apiSources.list()).find(s=>s.id===id&&s.enabled);if(source)return {baseURL:source.baseURL,name:source.name};
    const account=proxy.snapshot().accounts.find(a=>a.id===id&&!a.disabled);if(!account)return;
    const endpoints:Record<string,string>={qoder:'https://api3.qoder.sh',workbuddy:'https://copilot.tencent.com'};
    return {baseURL:proxy.accountBaseURL(id)??endpoints[account.provider],name:account.provider,kind:'account' as const};
  }});await localMaintenance.load();
  const directKeys=new Set<string>();
  const validateSelection=async(selected:{sourceId:string;model:string;channel?:string})=>{
    if(selected.channel!=='direct')return resolveSource(selected.sourceId,selected.model);
    const source=apiSources.assert(selected.sourceId,selected.model);
    if(apiModelRoute(source,selected.model).protocol!=='responses'||!(await apiSources.list()).find(s=>s.id===selected.sourceId)?.hasKey)throw Object.assign(new Error('备用通道仅支持有可读取密钥的 Responses API 来源'),{statusCode:409});
    return '';
  };
  const restoreConnection=async(id:string,approval?:{revision:string;allowRunning:boolean},officialModel?:string|(()=>Promise<string|undefined>),restoreHistory=true)=>{
    const target=(await connections.status()).find(t=>t.backups.some(b=>b.id===id));
    if(target?.id==='codex'){
      if(approval&&target.revision!==approval.revision)throw Object.assign(new Error('配置已变化，请刷新后重试。'),{statusCode:409});
      // Provider routing must be reconciled before removing its definition.
      await restoreCodexHistory(restoreHistory,officialModel??(()=>connections.officialModel(id)));
    }
    const record=await connections.restore(id,approval);fixedRoutes.delete(record.keyId);
    if(gatewayKeys.list().some(key=>key.id===record.keyId))await gatewayKeys.remove(record.keyId);
    return record;
  };
  const migrationStatus=async()=>({...await codexThreads.status(),lifecyclePhase:codexLifecycle.phase});
  const inspectConnections=async()=>{const threadMigration=await migrationStatus();return {discovery,gateway:{state:proxy.snapshot().state,models:(await localSnapshot()).models},targets:(await connections.status()).map(target=>target.id==='codex'?{...target,threadMigration}:target),switchFailures:switchJournal.list()};};
  const inspectMaintenance=async(chain?:MaintenanceChain,interfaceAgent?:Target)=>{
    const all=await inspectConnections();const local=await localSnapshot();
    const snapshot={...all,targets:chain?all.targets.filter(t=>t.id===chain.target):all.targets};
    const reviews=await Promise.all(snapshot.targets.filter(t=>t.connection).map(async t=>{
      const record=t.connection!;let review;try{review=await connections.review(record.id);}catch{return {id:record.id,target:t.id,checks:[{name:'读取接入配置失败，其他链路信息仍可检查',ok:false}],liveCallVerified:false};}const key=gatewayKeys.list().find(k=>k.id===record.keyId);
      let sourceAvailable=true;try{for(const item of record.selections??[record])resolveSource(item.sourceId,item.model);}catch{sourceAvailable=false;}
      review.checks.push({name:'Key 已启用且授权模型与目标协议',ok:!!key?.enabled&&(record.selections??[record]).every(item=>key.models.includes(item.model))&&allowsProtocol(key.agents,t.id==='claude'?'messages':t.id==='workbuddy'||t.id==='workbuddy-ai'?'chat/completions':'responses')&&(record.selections?record.selections.every(item=>key.modelSources?.[item.model]===item.sourceId):key.sourceId===record.sourceId)},{name:'源账号与模型可用',ok:sourceAvailable});
      review.checks.push({name:'Key 额度可用',ok:!!key&&(key.tokenLimit===null||(!key.unmeteredRequests&&key.usedTokens<key.tokenLimit))});
      return review;
    }));
    const target=snapshot.targets[0];
    const record=chain?.connectionId?target?.backups.find(r=>r.id===chain.connectionId):target?.connection;
    const sourceId=chain?.sourceId??record?.sourceId;const model=chain?.model??record?.model;
    const source=local.accounts.find(a=>a.id===sourceId)??local.apiSources?.find(s=>s.id===sourceId);
    let sourceAvailable=false;if(sourceId&&model)try{resolveSource(sourceId,model);sourceAvailable=true;}catch{}
    const keys=gatewayKeys.list().filter(k=>chain?(k.id===record?.keyId||k.sourceId===sourceId&&!!model&&k.models.includes(model)):false);
    const login=async(read:()=>Promise<Record<string,unknown>>)=>{try{const {revision:_,...status}=await read();return status;}catch(error){return {error:error instanceof Error?error.message:'读取失败'};}};
    const nativeLogin=!chain||chain.target==='codex'||chain.target==='claude'?{
      ...(!chain||chain.target==='codex'?{codex:await login(()=>codexAccounts.status())}:{}),
      ...(!chain||chain.target==='claude'?{claude:await login(()=>nativeAccounts.claude.status())}:{}),
    }:undefined;
    const selectedAgent=interfaceAgent??chain?.target??null;
    const switchFailures=switchJournal.list();
    return {...snapshot,reviews,nativeLogin,selectedAgent,latestSwitchFailure:switchFailures[0]??null,selectedAgentSwitchFailure:selectedAgent?switchFailures.find(item=>item.target===selectedAgent)??null:null,switchFailures:switchFailures.slice(0,8),targets:snapshot.targets.map(t=>({...t,backups:t.backups.filter((b,i)=>i<5||b.id===chain?.connectionId)})),gateway:{state:local.state,selectedModel:local.models.find(m=>m.id===model),modelCount:local.models.length},
      chain:chain?{requested:chain,source:source?{...source,models:undefined}:null,sourceAvailable,quota:sourceId?local.quotas[sourceId]:undefined,
        selectedModel:model,record:record??null,matchesInstalled:!!target?.connection&&target.connection.sourceId===sourceId&&target.connection.model===model,
        targetProtocol:chain.target==='claude'?'messages':['workbuddy','workbuddy-ai','pi','deepseek'].includes(chain.target)?'chat/completions':'responses',
        manualSetupRequired:false,keys:keys.map(k=>({id:k.id,enabled:k.enabled,agents:k.agents,models:k.models,tokenLimit:k.tokenLimit,usedTokens:k.usedTokens}))}:null,
      recentCalls:activity.snapshot().recent.filter(c=>!chain||keys.some(k=>k.id===c.keyId)&&c.model===model).slice(0,12)};

  };
  const internalKeys=new Map<string,Promise<{key:{id:string};apiKey:string}>>();
  // Unbinding retires credentials, not the direct channel's per-run allowance.
  const directBudgets=new Map<string,number>();
  const ownedInternalKeys=async(reviewerCacheID?:string)=>{
    const owned=await Promise.all([...internalKeys].filter(([cacheID])=>cacheID!==reviewerCacheID).map(async([cacheID,saved])=>({cacheID,created:await saved.catch(()=>undefined)})));
    if(owned.some(({created})=>created&&gatewayKeys.list().find(key=>key.id===created.key.id)?.pendingRequests))throw Object.assign(new Error('内部模型请求尚未结算，请稍后再取消。'),{statusCode:409});
    return owned;
  };
  const releaseInternalKeys=async(owned:Awaited<ReturnType<typeof ownedInternalKeys>>)=>{
    for(const {cacheID,created} of owned){
      const current=created&&gatewayKeys.list().find(key=>key.id===created.key.id);
      if(current){
        if(directKeys.has(current.id))directBudgets.set(cacheID,current.unmeteredRequests?0:Math.max(0,(current.tokenLimit??32000)-current.usedTokens));
        await gatewayKeys.remove(current.id);
      }
      if(created)directKeys.delete(created.key.id);internalKeys.delete(cacheID);
    }
  };
  const apiTransport=async(selected:{sourceId:string;model:string;channel?:string},owner:string)=>{
    await validateSelection(selected);
    const cacheID=`${owner}:${selected.sourceId}:${selected.model}:${selected.channel??'gateway'}`;
    let saved=internalKeys.get(cacheID);
    if(!saved){saved=gatewayKeys.create(gatewayKeyInput.parse({name:`内部 · ${owner}`,models:[selected.model],sourceId:selected.sourceId,...(selected.channel==='direct'?{tokenLimit:directBudgets.get(cacheID)??32000,agents:['openai']}:{} )}));internalKeys.set(cacheID,saved);}
    const created=await saved;if(selected.channel==='direct')directKeys.add(created.key.id);const gateway=proxy.gateway();
    const transportFetch:typeof fetch=async(input,init)=>{
      const request=new Request(input,init);const url=new URL(request.url);
      if(url.origin!==new URL(gateway.baseURL).origin||url.pathname!=='/v1/responses')throw new Error('Internal model transport destination mismatch');
      request.signal.throwIfAborted();
      const headers=new Headers(request.headers);headers.delete('X-Token-Flow-Auth');headers.set('authorization',`Bearer ${created.apiKey}`);
      const address=app.server.address();
      if(address&&typeof address!=='string')return fetch(`http://127.0.0.1:${address.port}${url.pathname}`,{method:request.method,headers,body:await request.text(),signal:request.signal,redirect:'error'});
      const flat:Record<string,string>={};headers.forEach((value,name)=>{flat[name]=value;});
      const response=await app.inject({method:'POST',url:url.pathname,headers:flat,payload:await request.text()});
      request.signal.throwIfAborted();return new Response(new Uint8Array(response.rawPayload),{status:response.statusCode,headers:{'content-type':String(response.headers['content-type']??'application/json')}});
    };
    return {baseURL:gateway.baseURL,apiKey:created.apiKey,authID:'',fetch:transportFetch};
  };
  const maintenanceTransport=async()=>{
    const selection=maintenance.snapshot().selection;if(!selection)throw new Error('请先指定维修模型');
    if(apiSources.has(selection.sourceId))return apiTransport(selection,'维修模型');
    const gateway=proxy.gateway();return {baseURL:gateway.baseURL,apiKey:gateway.apiKey,authID:resolveSource(selection.sourceId,selection.model),fetch:cursorFetch(selection.model,selection.sourceId,'maintenance')};
  };
  let maintenanceOrigin='http://127.0.0.1:9527';
  const approval=new MaintenanceApproval(async(proposal,policy)=>{
    const selected=policy.reviewer??maintenance.snapshot().selection;if(!selected)throw new Error('请先选择审批模型');
    if(apiSources.has(selected.sourceId))return maintenance.reviewProposal(proposal,selected,await apiTransport(selected,'审批模型'));
    const gateway=proxy.gateway();return maintenance.reviewProposal(proposal,selected,{baseURL:gateway.baseURL,apiKey:gateway.apiKey,authID:resolveSource(selected.sourceId,selected.model),fetch:cursorFetch(selected.model,selected.sourceId,'approval')});
  },()=>maintenance.settled(),async(result)=>{
    const record=result as {id:string;target:Target;model:string;sourceId:string;state:string};
    await startMaintenance('审批后的维修已执行。请重新读取当前配置和接入状态，确认是否正确；明确区分配置检查与真实客户端调用，说明是否需要重启或选模型。',false,{target:record.target,sourceId:record.sourceId,model:record.model,...(record.state!=='restored'?{connectionId:record.id}:{})},true);
  });
  const validateConnectionSelections=async(input:{target:Target;sourceId:string;model:string;selections?:ModelSelection[]})=>{
    const target=(await connections.status()).find(target=>target.id===input.target);
    const retained=(target?.backups??[]).flatMap(record=>record.selections??[{sourceId:record.sourceId,model:record.model}]);
    await validateSavedSelections(input.selections??[{sourceId:input.sourceId,model:input.model}],retained);
  };
  const applyConnection=async(input:{target:Target;sourceId:string;model:string;revision:string;tokenLimit:number|null;allowRunning:boolean;replaceId?:string;rewrite?:boolean;selections?:ModelSelection[];fastModel?:string;fastSourceId?:string},origin:string)=>{
    const selections=input.selections??[{sourceId:input.sourceId,model:input.model}];
    if(!selections.some(item=>item.sourceId===input.sourceId&&item.model===input.model))throw Object.assign(new Error('默认模型必须在已选模型中'),{statusCode:400});
    if(input.fastModel&&!selections.some(item=>item.sourceId===input.fastSourceId&&item.model===input.fastModel))throw Object.assign(new Error('快速模型必须在已选模型中'),{statusCode:400});
    await validateConnectionSelections(input);
    if(input.target==='codex'){await codexContext.repairLineage(async()=>options.agentProcesses?options.agentProcesses('codex'):agentProcesses('codex'));await codexThreads.prepare(input.model,selections.map(item=>item.model));}
    const created=await gatewayKeys.create(gatewayKeyInput.parse({name:`A2A · ${input.target}`,models:selections.map(item=>item.model),agents:[['workbuddy','workbuddy-ai','qoder','pi','deepseek'].includes(input.target)?'openai':input.target],...(input.selections?{modelSources:Object.fromEntries(selections.map(item=>[item.model,item.sourceId]))}:{sourceId:input.sourceId}),tokenLimit:input.tokenLimit}));
    try{
      const local=await localSnapshot(),catalog=local.models;
      const record=await connections.apply({...input,modelLabels:Object.fromEntries(selections.map(item=>[item.model,modelLabel(catalog,item.model,local.apiSources)])),modelImages:Object.fromEntries(selections.map(item=>[item.model,catalog.find(model=>model.id===item.model)?.capabilities?.images===true])),keyId:created.key.id,key:created.apiKey,origin});
      fixedRoutes.set(record.keyId,{target:record.target,sourceId:record.sourceId,model:record.model,selections:record.selections,modelAliases:record.modelAliases});
      if(input.replaceId){const previous=(await connections.status()).flatMap(t=>t.backups).find(r=>r.id===input.replaceId);if(previous){fixedRoutes.delete(previous.keyId);if(gatewayKeys.list().some(k=>k.id===previous.keyId))await gatewayKeys.remove(previous.keyId);}}
      if(input.target==='codex')await codexThreads.migrate(input.model,selections.map(item=>item.model));
      const verification=await connections.review(record.id);if(!verification.checks.every(c=>c.ok))throw new Error('写入后的配置复查未通过，接入记录和备份已保留，请生成维修方案。');return {...record,verification};
    }catch(error){const owned=(await connections.status()).some(t=>t.backups.some(b=>b.keyId===created.key.id));if(!owned)await gatewayKeys.remove(created.key.id);throw error;}
  };
  const proposeRepair=async(chain:MaintenanceChain|undefined,origin:string,rewrite=false)=>{
    if(!chain||!chain.sourceId||!chain.model)throw new Error('请先在 A2A 选择完整的源模型和可自动配置的目标。');
    const target=targetSchema.parse(chain.target);resolveSource(chain.sourceId,chain.model,true);
    const current=(await connections.status()).find(t=>t.id===target)!;
    if(!rewrite&&current.connection?.model===chain.model&&current.connection.sourceId===chain.sourceId&&current.configurationState==='configured'){
      const call=activity.snapshot().recent.find(c=>c.keyId===current.connection!.keyId&&c.model===chain.model);
      return {needed:false,reason:call&&call.status>=400?(call.error?.code??'call_failed'):'configuration_matches',message:call&&call.status>=400?`接口、Key 和模型配置一致，但最近调用失败。${call.error?.message??`HTTP ${call.status}，请继续检查调用链路。`} 如需更换配置，请在维修对话中说明希望更换的来源和模型。`:'接口、Key 和模型配置一致。如需更换来源、模型或重新生成 Key，请在维修对话中说明希望更换的来源和模型。'};
    }
    const selections=current.connection?.selections?.some(item=>item.sourceId===chain.sourceId&&item.model===chain.model)?current.connection.selections:undefined;
    const fastModel=selections&&current.connection?.fastModel&&selections.some(item=>item.model===current.connection?.fastModel)?current.connection.fastModel:undefined;
    const preview=await connections.preview(target,origin,chain.model,true,selections,fastModel);
    const oldKey=current.connection?gatewayKeys.list().find(k=>k.id===current.connection!.keyId):undefined;
    const tokenLimit=oldKey?.tokenLimit!=null?(oldKey.unmeteredRequests?0:Math.max(0,oldKey.tokenLimit-oldKey.usedTokens)):null;
    const fastSourceId=fastModel?selections?.find(item=>item.model===fastModel)?.sourceId:undefined;
    const input={target,...(selections?{selections}:{}),...(fastModel&&fastSourceId?{fastModel,fastSourceId}:{}),sourceId:chain.sourceId,model:chain.model,revision:preview.revision,replaceId:preview.replaceId,allowRunning:true,tokenLimit,rewrite:true};
    const code=JSON.stringify({operation:'replace_gateway_connection',...input,path:preview.path,previousModel:preview.previousModel,configuration:preview.routing,key:'生成仅授权此来源和模型的新 Key，写入成功后撤销旧 Key',scope:'更新此 Agent 的接口地址、Key、主模型与辅助模型；保留无关设置',backup:'写入前保存完整原配置和本次替换前配置，审批后文件变化则停止',runningProcesses:preview.pids,after:'重新读取配置并复查；请重启目标 Agent 后选用模型',originalProviderLogin:'保留，不修改'},null,2);
    return approval.propose(`将 ${current.name} 修复为 ${chain.model}`,code,()=>applyConnection(input,origin));
  };
  const proposeRestore=async(id:string,chain?:MaintenanceChain)=>{
    const target=(await connections.status()).find(t=>t.backups.some(b=>b.id===id));
    if(!target||chain&&(target.id!==chain.target||chain.connectionId&&chain.connectionId!==id))throw new Error('只能还原当前选定链路的接入记录。');
    const code=JSON.stringify({operation:'restore_connection',id,target:target.id,path:target.path,revision:target.revision,runningProcesses:target.pids,allowRunning:true,restore:'恢复该记录保存的原配置并撤销对应 Key；外部变更时停止',after:'复查配置，重启目标 Agent'},null,2);
    return approval.propose(`还原 ${target.name} 原接口`,code,()=>restoreConnection(id,{revision:target.revision,allowRunning:true}));
  };
  const readMaintenanceUsage=async(context:MaintenanceContext,query:MaintenanceUsageQuery={})=>{
    const native=await nativeUsageSnapshot();
    const rows=[...ledger.list(0).map(row=>({...row,origin:'gateway',provider:proxy.snapshot().accounts.find(a=>a.id===row.sourceId)?.provider??row.model.split('/')[0]})),...native.rows];
    return {...maintenanceUsage(rows,context,query),scanning:native.scanning,coverage:native.coverage,warning:native.warning||ledger.warning||attributionWarning||attribution.warning||''};
  };
  const inspectCodexHistory=async(chain?:MaintenanceChain)=>{
    const target=(await connections.status()).find(t=>t.id==='codex')!;const login=await codexAccounts.status();
    const expected=target.connection?{provider:'token_flow',model:target.connection.model,allowedModels:(target.connection.selections??[target.connection]).map(s=>s.model)}:{provider:login.provider,model:login.model??undefined};
    return {current:{provider:expected.provider,model:expected.model,accountId:login.accountId,email:login.email,runningProcesses:login.pids.length,connectionId:target.connection?.id??null,configurationRevision:target.revision},requested:chain??null,
      switchHistory:switchJournal.history('codex').slice(0,15),configurationHistory:target.backups.slice(0,10).map(({id,createdAt,state,sourceId,model})=>({id,createdAt,state,sourceId,model})),
      threads:await codexThreads.inspect(expected),migration:await migrationStatus(),historyCoverage:'切换日志从启用记录后开始；更早的成功操作仅以配置备份和迁移记录为证据，不补猜历史账号。'};
  };
  const proposeCodexHistory=async(chain?:MaintenanceChain)=>{
    if(chain&&chain.target!=='codex')throw new Error('请先选择 Codex 作为维修对象。');
    const evidence=await inspectCodexHistory(chain),login=await codexAccounts.status();
    const target=(await connections.status()).find(t=>t.id==='codex')!;
    if(!evidence.threads.available)throw new Error('未读取到 Codex 对话数据库，不能生成修复方案。');
    if(!['openai','token_flow'].includes(evidence.current.provider))throw new Error('当前是其他自定义来源，请先确认期望的账号和模型，再生成修复方案。');
    if(evidence.current.provider==='token_flow'&&!target.connection)throw new Error('当前网关配置没有可验证的接入记录，请先确认并重新应用目标接入，再修复旧对话。');
    if(chain?.sourceId&&(chain.sourceId!==target.connection?.sourceId||chain.model!==target.connection?.model))throw new Error('期望的接入与当前配置不一致，请先确认并完成目标切换，再修复旧对话。');
    const code=JSON.stringify({operation:'align_codex_history',target:'codex',expected:evidence.threads.expected,accountId:evidence.current.accountId,configurationRevision:target.revision,historyFingerprint:evidence.threads.fingerprint,mismatched:evidence.threads.mismatched,precondition:'请先保存工作并完全退出 Codex，再同意执行。不会自动结束正在运行的任务。',effect:'沿用当前已生效的账号与接入方式；备份后修复旧对话来源，保留可用的历史模型。',verification:'复查对话来源/模型与当前配置是否一致；实际回复需重新打开旧对话验证。'},null,2);
    return approval.propose('保存工作并退出 Codex 后，修复旧对话来源',code,async()=>{
      const current=(await connections.status()).find(t=>t.id==='codex')!;
      const currentLogin=await codexAccounts.status(),history=await inspectCodexHistory(chain);
      if(current.revision!==target.revision||currentLogin.revision!==login.revision||history.threads.fingerprint!==evidence.threads.fingerprint)throw new Error('配置、账号或对话状态已变化，请重新诊断。');
      if(current.pids.length||currentLogin.pids.length)throw new Error('Codex 仍在运行，请保存工作并退出后重新生成方案。');
      let result;
      if(current.connection){const allowed=(current.connection.selections??[current.connection]).map(item=>item.model);await codexThreads.prepare(current.connection.model,allowed);result=await codexThreads.migrate(current.connection.model,allowed);}
      else result=await restoreCodexHistory(true,()=>connections.currentOfficialModel());
      const verification=await inspectCodexHistory(chain);
      if(verification.threads.mismatched)throw new Error('仍有旧对话来源不一致，备份保留，请重新诊断。');
      await switchJournal.record({action:'migration-restore',target:'codex',outcome:'completed',message:'旧对话路由已复查与当前配置一致；实际回复尚未验证。',model:evidence.current.model??undefined});
      return {...result,verification,liveReplyVerified:false};
    },{manualOnly:true});
  };
  const readMaintenancePage=async(context:MaintenanceContext)=>{
    if(context.page==='cleanup')return {fileCleanup:fileCleanup.report()};
    if(context.page==='settings')return {gateway:{state:proxy.snapshot().state,modelCount:proxy.snapshot().models.length},fileCleanup:fileCleanup.report()};
    if(context.page==='usage')return readMaintenanceUsage(context);
    if(context.page==='agents')return context.intent==='codex-history'?inspectCodexHistory({target:'codex'}):inspectMaintenance({target:context.target??'codex'},context.target);
    if(context.page==='activity'){
      const days=context.range==='today'?1:context.range==='7d'?7:context.range==='30d'?30:0;
      const native=await nativeUsageSnapshot(),attributed=native.recent;
      const selected=context.traceId?.startsWith('native-')?attributed.find(row=>`native-${row.sampleId}`===context.traceId):undefined;
      return {selected:context.traceId?(selected?nativeActivityTrace(selected):traces.get(context.traceId)??null):null,
        recent:[...(context.origin==='native'?[]:traces.list({days,limit:12,keyId:context.keyId,sourceId:context.sourceId})),...(context.origin==='gateway'?[]:attributed.filter(row=>maintenanceUsage([row],context).requests>0).slice(0,12).map(nativeActivitySummary))].sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,12),scanning:native.scanning,warning:native.warning||traces.warning};
    }
    const snapshot=proxy.snapshot();const accounts=snapshot.accounts.filter(a=>(!context.sourceId||a.id===context.sourceId)&&(!context.provider||a.provider===context.provider));
    return {accounts:context.page==='accounts'?accounts.map(({id,label,provider,disabled,models})=>({id,label,provider,disabled,models})):undefined,
      quotas:context.page==='accounts'?Object.fromEntries(accounts.map(a=>[a.id,snapshot.quotas[a.id]])):undefined,
      apiSources:context.page==='apis'?(await apiSources.list()).filter(s=>!context.sourceId||s.id===context.sourceId):undefined,
      keys:context.page==='proxy'?gatewayKeys.list().filter(key=>key.exported&&(!context.keyId||key.id===context.keyId)).map(({id,name,enabled,models,modelSources,sourceId,usedTokens,tokenLimit})=>({id,name,enabled,models,modelSources,sourceId,usedTokens,tokenLimit})):undefined,
      usage:['accounts','apis','proxy'].includes(context.page)?await readMaintenanceUsage(context):undefined};
  };
  const probeControllers=new Set<AbortController>();let probeActive=false;const probeTimes:number[]=[];
  app.addHook('preClose',async()=>{for(const controller of probeControllers)controller.abort();});
  const probeMaintenanceModel=async(input:ModelProbeInput,context:MaintenanceContext,chain:MaintenanceChain|undefined,signal:AbortSignal)=>{
    input=modelProbeInput.parse(input);signal.throwIfAborted();
    const target=input.target??context.target??chain?.target;
    const installed=target?(await connections.status()).find(t=>t.id===target):undefined;
    const sourceId=input.sourceId??context.sourceId??chain?.sourceId??installed?.connection?.sourceId;
    const model=input.model??context.model??chain?.model??installed?.connection?.model;
    if(!sourceId||!model)throw new Error('请从已保存来源选择明确的账号和模型。官方直连客户端没有受管模型时，仅可检查本机配置、网络与已有错误记录。');
    await validateSavedSelections([{sourceId,model}]);
    const key=context.keyId?gatewayKeys.list().find(k=>k.id===context.keyId):undefined;
    if(context.keyId&&(!key?.enabled||!key.models.includes(model)||(key.modelSources?.[model]??key.sourceId)!==sourceId))throw new Error('所选 Key 未启用或未授权该来源和模型，请先检查 Key 配置。');
    const protocol=input.protocol??(target==='claude'?'messages':target&&['workbuddy','workbuddy-ai','pi','deepseek'].includes(target)?'chat/completions':'responses');
    if(key&&!allowsProtocol(key.agents,protocol))throw new Error('所选 Key 未授权该协议，请先检查协议权限。');
    const address=app.server.address();if(!address||typeof address==='string')return {passed:false,category:'gateway_not_listening',sourceId,model,protocol,message:'本机 HTTP 服务尚未监听，未发送模型请求。'};
    if(probeActive)throw new Error('已有模型诊断请求正在执行，请等待完成。');
    const now=Date.now();while(probeTimes.length&&probeTimes[0]<now-60000)probeTimes.shift();if(probeTimes.length>=6)throw new Error('一分钟内已执行 6 次最小调用，请先分析已有结果。');
    probeActive=true;probeTimes.push(now);const controller=new AbortController();probeControllers.add(controller);let created:Awaited<ReturnType<typeof gatewayKeys.create>>|undefined;
    try{
      created=await gatewayKeys.create(gatewayKeyInput.parse({name:'内部 · 维修实际调用检查',models:[model],sourceId,tokenLimit:4096}));
      const result=await probeModelHTTP(protocol,model,(body,requestSignal)=>fetch(`http://127.0.0.1:${address.port}/v1/${protocol}`,{method:'POST',headers:{authorization:`Bearer ${created!.apiKey}`,'content-type':'application/json',...(protocol==='messages'?{'anthropic-version':'2023-06-01'}:{})},body:JSON.stringify(body),redirect:'error',signal:requestSignal}),AbortSignal.any([signal,controller.signal]));
      return {...result,sourceId,model,target,configurationState:installed?.configurationState,selectedKeyChecked:!!key,clientVerified:false,credentialMode:'使用绑定所选来源和模型的临时诊断 Key，测试后撤销；没有读取或验证客户端保存的原 Key。'};
    }finally{probeActive=false;probeControllers.delete(controller);if(created)await gatewayKeys.remove(created.key.id);}
  };
  const startMaintenance=async(prompt:string,_allowRestore=false,chain:MaintenanceChain|undefined=maintenance.snapshot().chain,preserveApproval=false,interfaceAgent?:Target,context:MaintenanceContext|undefined=maintenance.snapshot().context)=>{
    if(context&&context.page!=='agents'){chain=undefined;interfaceAgent=undefined;}
    if(!preserveApproval&&JSON.stringify(chain)!==JSON.stringify(maintenance.snapshot().chain))approval.clear();
    const scope=context??{page:'agents' as const,target:chain?.target??interfaceAgent??'codex'};
    const inspect=async()=>({pageContext:scope,selectedAgent:null,chain:null,...(scope.page==='agents'&&scope.intent!=='codex-history'?await inspectMaintenance(chain??{target:scope.target??'codex'},interfaceAgent):{}),pageData:scope.page==='agents'&&scope.intent!=='codex-history'?undefined:await readMaintenancePage(scope)});const origin=maintenanceOrigin;
    return maintenance.start(prompt,await maintenanceTransport(),{inspect,cleanup:async scan=>{if(scan&&!['scanning','cleaning'].includes(fileCleanup.snapshot().status))fileCleanup.start();return fileCleanup.report();},httpProbe:(input,signal)=>probeMaintenanceModel(input,scope,chain,signal),storage:()=>maintenanceStorage(root,connections.paths),historyRepair:()=>{if(scope.page!=='agents'||scope.target!=='codex')throw new Error('请在维修对象中选择 Codex 后生成旧对话修复方案。');return proposeCodexHistory(chain);},readPage:()=>readMaintenancePage(scope),usage:query=>readMaintenanceUsage(scope,query),codexHistory:()=>inspectCodexHistory(chain),configurations:async()=>{
      const local=await localSnapshot();return {targets:await connections.status(),gatewayOrigin:origin,sources:[...local.accounts.filter(a=>!a.disabled).map(a=>({sourceId:a.id,name:a.provider,models:a.models??[]})),...(local.apiSources??[]).filter(s=>s.enabled&&s.hasKey).map(s=>({sourceId:s.id,name:s.name,models:s.models.map(m=>apiModelID(s.id,m))}))],keyHandling:'服务端生成专用 Key；不要索取或输出用户密钥。'};
    },configure:input=>proposeRepair(input,origin,true),diagnose:(input,signal)=>localMaintenance.diagnostic(input,signal),upgrade:()=>{if(chain&&chain.target!=='codex')throw new Error('当前链路不是 Codex，请由用户选择 Codex 后检查升级。');return localMaintenance.prepareUpgrade();},propose:()=>proposeRepair(chain,origin),refresh:async()=>{await proxy.refreshAccounts();return inspect();},repair:async()=>proposeRepair(chain,origin),restore:async id=>proposeRestore(id,chain)},false,chain,context);
  };

  const codexAccountStatus=async()=>({...await codexAccounts.status(),accounts:await proxy.codexNativeAccounts(),gatewayConnected:!!(await connections.status()).find(t=>t.id==='codex')?.connection});
  app.get('/api/codex-accounts',codexAccountStatus);
  const nativeSwitchInput=z.object({revision:z.string().regex(/^[a-f0-9]{64}$/),allowRunning:z.boolean().default(false),restartCodex:z.boolean().default(false),restoreHistory:z.boolean().default(true)});
  app.post('/api/codex-accounts/switch',async req=>{

    const input=nativeSwitchInput.extend({sourceId:z.string().regex(/^[a-f0-9]{24}$/),model:z.string().min(1).max(300)}).strict().parse(req.body);
    const credential=await proxy.codexCredential(input.sourceId,input.model);
    // Verify the chosen login before disconnecting a working gateway.
    await codexAccounts.checkSwitch(input,credential);
    return codexChange(input.restartCodex,async()=>{
    const target=(await connections.status()).find(t=>t.id==='codex')!;
    if(target.connection)await restoreConnection(target.connection.id,{revision:target.revision,allowRunning:input.allowRunning},input.model.slice('codex/'.length),input.restoreHistory);
    else await restoreCodexHistory(input.restoreHistory,input.model.slice('codex/'.length));
    const switched=await codexAccounts.switch({...input,revision:target.connection?(await codexAccounts.status()).revision:input.revision},credential);
    await enableAttribution();return {...await codexAccountStatus(),message:switched.message};
    });
  });
  app.post('/api/codex-accounts/restore',async req=>{

    const input=nativeSwitchInput.strict().parse(req.body);const status=await codexAccounts.status();
    if(status.revision!==input.revision)throw Object.assign(new Error('本机登录或配置已变化，请刷新后重试。'),{statusCode:409});
    if(!status.backup)throw Object.assign(new Error('没有可还原的账号切换备份。'),{statusCode:409});
    return codexChange(input.restartCodex,async()=>{
    const target=(await connections.status()).find(t=>t.id==='codex')!;
    const officialModel=()=>codexAccounts.restoreModel();
    if(target.connection)await restoreConnection(target.connection.id,{revision:target.revision,allowRunning:input.allowRunning},officialModel,input.restoreHistory);
    else await restoreCodexHistory(input.restoreHistory,officialModel);
    await codexAccounts.restore({...input,revision:target.connection?(await codexAccounts.status()).revision:input.revision});await enableAttribution();return codexAccountStatus();
    });
  });
  const nativeStatus=async(provider:NativeProvider)=>({...await nativeAccounts[provider].status(),accounts:await proxy.nativeAccounts(provider),gatewayConnected:provider==='claude'&&!!(await connections.status()).find(t=>t.id==='claude')?.connection});
  const qoderIdeLogin=new QoderIdeLogin(options.qoderIde,options.secrets,()=>options.desktopProcesses?options.desktopProcesses('qoder-ide'):agentProcesses('qoder-ide'));
  const officialProvider=z.enum(['claude','antigravity','workbuddy','workbuddy-ai','qoder','qoder-ide']);
  const desktopStatus=async(provider:DesktopProvider|'qoder-ide',refresh=false)=>{const status=await (provider==='qoder-ide'?qoderIdeLogin:desktopAccounts[provider]).status(refresh);return {...status,...(provider==='workbuddy-ai'?{installation:await detectAgent('workbuddy-ai')}:{}),accounts:(await proxy.desktopNativeAccounts(provider==='qoder-ide'?'qoder':provider)).map(a=>status.unavailableReason?{...a,switchable:false,reason:status.unavailableReason}:a),gatewayConnected:!!(await connections.status()).find(t=>t.id===provider)?.connection};};
  const cursorLocalLogin=new CursorLocalLogin(options.cursorLocalPath);
  app.get('/api/native-accounts/cursor',async req=>({...await cursorLocalLogin.status((req.query as {refresh?:string}).refresh==='1'),readOnly:true,pids:[],backup:null,gatewayConnected:false,accounts:proxy.cursor.snapshot().accounts.map(a=>({id:a.id,email:a.label,switchable:false,reason:'请在 Cursor 客户端切换本机登录。'}))}));
  app.get('/api/native-accounts/:provider',async req=>{const provider=officialProvider.parse((req.params as {provider:string}).provider);return provider==='workbuddy'||provider==='workbuddy-ai'||provider==='qoder'||provider==='qoder-ide'?desktopStatus(provider,(req.query as {refresh?:string}).refresh==='1'):nativeStatus(provider);});
  for(const action of ['switch','restore'] as const)app.post(`/api/native-accounts/:provider/${action}`,async req=>{
    const provider=officialProvider.parse((req.params as {provider:string}).provider);
    if(provider==='workbuddy'||provider==='workbuddy-ai'||provider==='qoder'||provider==='qoder-ide'){
      const schema=z.object({revision:z.string().regex(/^[a-f0-9]{64}$/)});
      const input=(action==='switch'?schema.extend({sourceId:z.string().regex(/^[a-f0-9]{24}$/)}).strict():schema.strict()).parse(req.body);
      const manager=provider==='qoder-ide'?qoderIdeLogin:desktopAccounts[provider];
      await manager.check(input.revision,action==='restore');
      const prepared='sourceId' in input?await manager.prepare(await proxy.desktopCredential(provider==='qoder-ide'?'qoder':provider,input.sourceId as string)):null;
      let saved=false;
      // Desktop custom-model providers are independent of the client's official login.
      const work=async()=>{if(provider==='qoder-ide')await qoderIdeLogin.apply(input.revision,prepared);else await desktopAccounts[provider].apply(input.revision,prepared);saved=true;};
      try{await (options.desktopAccountChange?options.desktopAccountChange(provider,work):desktopLifecycle.change(provider,work));}
      catch(error){if(saved)throw Object.assign(new Error(`${action==='restore'?'原登录已恢复':'所选登录已保存，原登录备份仍保留'}，但客户端重新打开未确认。请手动打开并检查登录状态。`),{statusCode:409});throw error;}
      return desktopStatus(provider);
    }
    if(provider==='claude'){
      const schema=z.object({revision:z.string().regex(/^[a-f0-9]{64}$/),restart:z.boolean().default(false)});
      const input:{revision:string;restart:boolean;sourceId?:string;model?:string}=(action==='switch'?schema.extend({sourceId:z.string().regex(/^[a-f0-9]{24}$/),model:z.string().min(1).max(300).optional()}).strict():schema.strict()).parse(req.body);
      const latest=await nativeStatus('claude');if(latest.revision!==input.revision)throw Object.assign(new Error('本机登录或配置已变化，请刷新后重试。'),{statusCode:409});
      const credential=input.sourceId?nativeCredentialSchema.parse(await proxy.nativeCredential('claude',input.sourceId,input.model)):undefined;
      if(credential&&!(credential.scopes??credential.scope?.split(/\s+/)??['user:inference']).includes('user:inference'))throw Object.assign(new Error('账号没有 Claude Code 推理权限，请重新授权。'),{statusCode:409});
      const target=(await connections.status()).find(t=>t.id==='claude');
      if(credential)await nativeAccounts.claude.preflightSwitch(input,credential,target?.connection?claudeSettingsState(await connections.restoration(target.connection.id)):undefined);
      else await nativeAccounts.claude.preflightRestore(input.revision);
      const work=async()=>{
        const state=await nativeStatus('claude');if(state.revision!==input.revision||state.pids.length)throw Object.assign(new Error('Claude Code 登录或进程已变化，请退出其他会话后重试。'),{statusCode:409});
        const target=(await connections.status()).find(t=>t.id==='claude');
        if(target?.connection)await restoreConnection(target.connection.id,{revision:target.revision,allowRunning:false});
        const revision=(await nativeAccounts.claude.status()).revision;
        if(credential)await nativeAccounts.claude.switch({revision,model:'model' in input?input.model:undefined},credential);else await nativeAccounts.claude.restore({revision});
      };
      const restarted=input.restart?await (options.claudeTerminalChange?options.claudeTerminalChange(work):claudeTerminal.change(work)):await work();
      return {...await nativeStatus('claude'),message:restarted&&typeof restarted==='object'&&'message' in restarted?String(restarted.message):'Claude Code 登录已保存，下次启动生效。'};
    }
    if(action==='switch'){
      const input=z.object({revision:z.string().regex(/^[a-f0-9]{64}$/),sourceId:z.string().regex(/^[a-f0-9]{24}$/),model:z.string().min(1).max(300).optional()}).strict().parse(req.body);
      await nativeAccounts[provider].switch(input,await proxy.nativeCredential(provider,input.sourceId,input.model));
    }else await nativeAccounts[provider].restore(z.object({revision:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body));
    return nativeStatus(provider);
  });
  app.get('/api/a2a',inspectConnections);
  app.get('/api/a2a/codex-migration',migrationStatus);
  // All restore entry points keep persisted thread providers consistent with config.
  app.post('/api/a2a/codex-migration/restore',async req=>{
    const input=z.object({restartCodex:z.boolean().default(false),restoreHistory:z.boolean().default(true)}).strict().parse(req.body??{});
    return codexChange(input.restartCodex,async()=>{
      const target=(await connections.status()).find(t=>t.id==='codex')!;
      if(target.connection)return restoreConnection(target.connection.id,{revision:target.revision,allowRunning:false},undefined,input.restoreHistory);
      return restoreCodexHistory(input.restoreHistory,()=>connections.currentOfficialModel());
    });
  });
  const agentInstallation=new AgentInstallationManager(options.agentProcesses??agentProcesses,options.openExternal);
  const agentUpdates=new AgentUpdates();
  app.get('/api/a2a/program-updates',async()=>({updates:Object.fromEntries(await Promise.all(targetSchema.options.map(async target=>[target,await agentUpdates.check(target,await detectAgent(target))])))}));
  app.post('/api/a2a/program',async req=>{

    const {target,action}=z.object({target:targetSchema,action:z.enum(['install','update'])}).strict().parse(req.body);
    return agentInstallation.manage(target,action);
  });
  const qoderLifecycle=new QoderLifecycle();const piTerminal=new PiTerminalLifecycle(connections.paths.pi);
  app.get('/api/a2a/terminal-sessions',async req=>{const {target}=z.object({target:z.enum(['claude','pi']).default('claude')}).parse(req.query);return {sessions:await (target==='pi'?piTerminal:claudeTerminal).sessions(),canRestartIDE:process.platform==='darwin'};});
  app.post('/api/a2a/restart',async req=>{

    const session=z.object({pid:z.number().int().positive(),tty:z.string().regex(/^(ttys[0-9]+|pts\/[0-9]+|tty[0-9]+|\?\?)$/),cwd:z.string().min(1).max(4096),started:z.string().max(80).optional(),executable:z.string().max(4096).optional()}).strict();
    const input=z.discriminatedUnion('target',[z.object({target:z.enum(['codex','qoder','qoder-ide','workbuddy','workbuddy-ai','deepseek'])}).strict(),z.object({target:z.literal('pi'),session:session.optional()}).strict(),z.object({target:z.literal('claude'),client:z.enum(['vscode','terminal']),session:session.optional()}).strict()]).parse(req.body);
    if(input.target==='pi'){const current=(await connections.status()).find(t=>t.id==='pi');return piTerminal.restart(input.session,current?.connection?.model);}
    if(input.target==='claude'&&input.client==='terminal'){return claudeTerminal.restart(input.session);}
    return input.target==='codex'?codexLifecycle.change(async()=>({message:'Codex 已重新打开，已加载保存的配置。'})):qoderLifecycle.restart(input.target);
  });
  const claudeDesktopChange=(work:()=>Promise<unknown>)=>options.claudeDesktopChange?options.claudeDesktopChange(work):process.platform==='linux'?work():qoderLifecycle.change('claude-desktop',work);
  const claudeDesktopStatus=async()=>({...await claudeDesktop.status(),installation:await detectAgent('claude-desktop'),automaticRestart:process.platform==='darwin'||process.platform==='win32'});
  app.get('/api/claude-desktop',claudeDesktopStatus);
  app.post('/api/claude-desktop/connect',async req=>{
    const input=z.object({revision:z.string().regex(/^[a-f0-9]{64}$/),selections:z.array(modelSelectionSchema).min(1).max(claudeDesktopModelLimit),fast:modelSelectionSchema.optional()}).strict().refine(value=>!value.fast||value.selections.some(item=>item.model===value.fast?.model&&item.sourceId===value.fast.sourceId),'快速模型必须在已选模型中').parse(req.body);
    const prior=await claudeDesktop.check(input.revision);await validateSavedSelections(input.selections,prior.selections);
    const created=await gatewayKeys.create(gatewayKeyInput.parse({name:'A2A · Claude Desktop',agents:['claude'],models:input.selections.map(s=>s.model),modelSources:Object.fromEntries(input.selections.map(s=>[s.model,s.sourceId])),tokenLimit:null}));
    let saved=false;
    try{await claudeDesktopChange(async()=>{
      const local=await localSnapshot();
      await claudeDesktop.connect({revision:input.revision,selections:input.selections,fastModel:input.fast?.model,origin:`http://${req.headers.host}`,keyId:created.key.id,key:created.apiKey,labels:Object.fromEntries(input.selections.map(s=>[s.model,modelLabel(local.models,s.model,local.apiSources)]))});saved=true;
      const applied=await claudeDesktop.route();
      fixedRoutes.set(created.key.id,{target:'claude-desktop',...input.selections[0],selections:input.selections,modelAliases:applied?.modelAliases});
      if(prior.keyId){fixedRoutes.delete(prior.keyId);if(gatewayKeys.list().some(k=>k.id===prior.keyId))await gatewayKeys.remove(prior.keyId);}
    });}catch(error){const current=await claudeDesktop.status().catch(()=>null);if(!saved&&current?.keyId!==created.key.id)await gatewayKeys.remove(created.key.id);if(saved)throw Object.assign(new Error('Claude Desktop 模型配置已保存，重新打开未确认。请手动打开 Claude Desktop；原登录和恢复备份保留。'),{statusCode:409});throw error;}
    return {...await claudeDesktopStatus(),message:process.platform==='linux'?'配置已保存，请重新打开 Claude Desktop。':'Claude Desktop 已重新打开，请在新会话确认模型。'};
  });
  for(const action of ['restore','official'] as const)app.post(`/api/claude-desktop/${action}`,async req=>{
    const {revision}=z.object({revision:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);
    const prior=await claudeDesktop.check(revision);let saved=false;
    if(action==='restore'&&!prior.backup)throw Object.assign(new Error('没有可恢复的 Claude Desktop 接入备份。'),{statusCode:409});
    try{await claudeDesktopChange(async()=>{if(prior.backup){await claudeDesktop.restore(revision);saved=true;if(prior.keyId){fixedRoutes.delete(prior.keyId);if(gatewayKeys.list().some(k=>k.id===prior.keyId))await gatewayKeys.remove(prior.keyId);}}});}
    catch(error){if(saved)throw Object.assign(new Error('Claude Desktop 原配置已恢复，重新打开未确认。请手动打开 Claude Desktop。'),{statusCode:409});throw error;}
    return {...await claudeDesktopStatus(),message:action==='official'?`${process.platform==='linux'?'请手动打开':'已打开'} Claude Desktop。请在客户端账号菜单完成官方登录或切换；Claude CLI 授权不会替换 Claude Desktop 登录。`:'已恢复接入前的配置，原官方登录数据保留。'};
  });
  app.post('/api/claude-desktop/restart',async req=>{z.object({}).strict().parse(req.body??{});return qoderLifecycle.restart('claude-desktop');});
  app.post('/api/a2a/import',async req=>{
    const {target}=z.object({target:z.enum(['codex','claude'])}).strict().parse(req.body);
    try{return await proxy.importCredential(target,await localCredential(target,connections.paths,options.claudeCredentialStore));}
    catch(error){throw Object.assign(new Error(error instanceof z.ZodError?'本地凭据不是支持的 OAuth 格式，请在账号授权页重新授权。':error instanceof Error?error.message:'导入失败'),{statusCode:400});}
  });
  app.post('/api/a2a/connect',async req=>{

    const input=z.object({replaceId:z.string().uuid().optional(),rewrite:z.boolean().default(false),allowRunning:z.boolean().default(false),restartCodex:z.boolean().default(false),target:targetSchema,selections:modelSelectionsSchema.optional(),sourceId:z.string().regex(/^[a-f0-9]{24}$/),model:z.string().min(1).max(300),fastSourceId:z.string().regex(/^[a-f0-9]{24}$/).optional(),fastModel:z.string().min(1).max(300).optional(),revision:z.string().regex(/^[a-f0-9]{64}$/),tokenLimit:z.number().int().min(0).max(1e12).nullable().default(null)}).strict().refine(input=>!input.rewrite||!!input.replaceId,'重新应用需要当前接入记录').refine(input=>(input.fastSourceId===undefined)===(input.fastModel===undefined),'快速模型需要同时提供来源和模型').parse(req.body);
    if(input.replaceId)approval.clear();
    if(input.restartCodex&&input.target!=='codex')throw Object.assign(new Error('自动迁移重启仅支持 Codex。'),{statusCode:400});
    // Validate the revision and saved source bindings before interrupting the running application.
    if(input.restartCodex){const target=(await connections.status()).find(t=>t.id==='codex')!;if(target.revision!==input.revision)throw Object.assign(new Error('配置已变化，请刷新后重试。'),{statusCode:409});await validateConnectionSelections(input);}
    const record=await codexChange(input.restartCodex,()=>applyConnection(input,`http://${req.headers.host}`));
    maintenanceOrigin=`http://${req.headers.host}`;
    return record;
  });
  app.post('/api/a2a/restore',async req=>{

    const input=z.object({id:z.string().uuid(),revision:z.string().regex(/^[a-f0-9]{64}$/).optional(),allowRunning:z.boolean().default(false),restartCodex:z.boolean().default(false),restoreHistory:z.boolean().default(true)}).strict().refine(v=>!v.allowRunning||!!v.revision,'运行中还原需要当前配置版本').parse(req.body);
    approval.clear();
    if(input.restartCodex){const target=(await connections.status()).find(t=>t.backups.some(b=>b.id===input.id));if(target?.id!=='codex'||target.revision!==input.revision)throw Object.assign(new Error('Codex 配置已变化，请刷新后重试。'),{statusCode:409});}
    return codexChange(input.restartCodex,()=>restoreConnection(input.id,input.revision?{revision:input.revision,allowRunning:input.allowRunning}:undefined,undefined,input.restoreHistory));
  });
  app.post('/api/a2a/delete',async req=>{

    const input=z.object({id:z.string().uuid(),revision:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);
    approval.clear();
    const targets=await connections.status();const previous=targets.flatMap(t=>t.backups);
    const deleting=targets.find(t=>t.backups.some(b=>b.id===input.id));
    if(deleting?.id==='codex'&&(await codexThreads.status()).restorable){if(deleting.revision!==input.revision)throw Object.assign(new Error('配置已变化，请刷新后重试。'),{statusCode:409});await prepareCodexOfficial();await codexThreads.restore(()=>connections.officialModel(input.id));}
    const record=await connections.remove(input.id,input.revision);
    for(const keyId of [record.keyId,previous.find(r=>r.id===record.supersedes)?.keyId]){
      if(keyId)fixedRoutes.delete(keyId);
      if(keyId&&gatewayKeys.list().some(k=>k.id===keyId))await gatewayKeys.remove(keyId);
    }
    return record;
  });
  app.get('/api/maintenance',async()=>({...maintenance.snapshot(),...approval.snapshot()}));
  app.delete('/api/maintenance/selection',async()=>{

    const state=maintenance.snapshot();
    if(state.status==='running'||state.readiness.status==='checking'||approval.isBusy())throw Object.assign(new Error('维修检测、模型审批或执行正在运行，请结束后再取消维修模型。'),{statusCode:409});
    const reviewer=approval.snapshot().policy.reviewer;
    const owned=await ownedInternalKeys(reviewer?`审批模型:${reviewer.sourceId}:${reviewer.model}:${reviewer.channel??'gateway'}`:undefined);
    await maintenance.clearSelection();
    if(approval.snapshot().proposal?.status==='pending')approval.clear();
    if(!reviewer)approval.configure({mode:'manual'});
    await releaseInternalKeys(owned);
    return {...maintenance.snapshot(),...approval.snapshot()};
  });
  app.post('/api/maintenance/reset',async()=>{if(approval.isBusy())throw Object.assign(new Error('维修正在执行'),{statusCode:409});const result=maintenance.reset();approval.clear();await maintenance.flushHistory();return result;});
  app.get('/api/maintenance/history',async()=>({conversations:maintenance.history()}));
  app.get('/api/maintenance/history/:id',async req=>maintenance.conversation(z.string().uuid().parse((req.params as {id:string}).id)));
  app.post('/api/maintenance/history/:id/resume',async req=>{if(approval.isBusy())throw Object.assign(new Error('维修正在执行'),{statusCode:409});const result=maintenance.resume(z.string().uuid().parse((req.params as {id:string}).id));approval.clear();await maintenance.flushHistory();return result;});
  app.post('/api/maintenance/stop',async()=>{await Promise.all([maintenance.close(),localMaintenance.stop()]);return maintenance.snapshot();});
  app.put('/api/maintenance',async req=>{const input=maintenanceSelection.parse(req.body);await validateSelection(input);approval.clear();await maintenance.select(input);return maintenance.check(await maintenanceTransport());});
  app.post('/api/maintenance/http-probe',async(req,reply)=>{
    const input=modelProbeInput.parse(req.body);const controller=new AbortController();const cancel=()=>{if(!reply.raw.writableEnded)controller.abort();};reply.raw.once('close',cancel);
    try{return await probeMaintenanceModel(input,{page:'agents',target:input.target},undefined,controller.signal);}finally{reply.raw.off('close',cancel);}
  });
  app.post('/api/maintenance/check',async()=>maintenance.check(await maintenanceTransport()));
  app.put('/api/maintenance/approval-policy',async req=>{
    const policy=approvalPolicy.parse(req.body);if(policy.reviewer)await validateSelection(policy.reviewer);return approval.configure(policy);
  });
  app.post('/api/maintenance/propose',async req=>{
    const {chain,rewrite}=z.object({chain:maintenanceChain.optional(),rewrite:z.boolean().default(false)}).strict().parse(req.body);
    if(chain&&JSON.stringify(chain)!==JSON.stringify(maintenance.snapshot().chain))approval.clear();
    return proposeRepair(chain??maintenance.snapshot().chain,`http://${req.headers.host}`,rewrite);
  });
  app.post('/api/maintenance/approve',async req=>{const input=z.object({id:z.string().uuid(),approve:z.boolean()}).strict().parse(req.body);return approval.decide(input.id,input.approve);});
  app.post('/api/maintenance/run',async req=>{
    maintenanceOrigin=`http://${req.headers.host}`;
    const {prompt,allowRestore,chain,interfaceAgent,context}=z.object({prompt:z.string().trim().min(1).max(8000).default('请自动检查选定的 A2A 链路，从源授权、模型、网关、Key、目标配置、备份和进程定位问题。工具异常后继续分析，给出证据和下一步；已有信息不要再问用户。'),allowRestore:z.boolean().default(false),chain:maintenanceChain.optional(),interfaceAgent:targetSchema.optional(),context:maintenanceContext.optional()}).strict().parse(req.body);
    if(chain?.connectionId){const target=(await connections.status()).find(t=>t.id===chain.target);const record=target?.backups.find(r=>r.id===chain.connectionId);if(!record)throw Object.assign(new Error('接入记录与目标不匹配，请刷新后重试。'),{statusCode:400});}
    return startMaintenance(prompt,allowRestore,chain??maintenance.snapshot().chain,false,interfaceAgent,context);
  });
  app.get('/api/maintenance/local',async()=>localMaintenance.snapshot());
  app.post('/api/maintenance/local/diagnose',async req=>{const input=z.object({target:targetSchema.default('codex'),sourceId:z.string().regex(/^[a-f0-9]{24}$/).optional()}).strict().parse(req.body);return localMaintenance.startDiagnostic(input.target,input.sourceId);});
  app.post('/api/maintenance/local/stop',async()=>localMaintenance.stop());
  app.post('/api/maintenance/local/documentation',async req=>{z.object({}).strict().parse(req.body);const url='https://learn.chatgpt.com/docs/codex/cli';if(options.openExternal)await options.openExternal(url);return {url,opened:!!options.openExternal};});
  app.post('/api/maintenance/local/upgrade-plan',async req=>{z.object({}).strict().parse(req.body);return localMaintenance.prepareUpgrade();});
  app.post('/api/maintenance/local/upgrade',async req=>{const input=z.object({id:z.string().uuid(),approve:z.literal(true)}).strict().parse(req.body);if(maintenance.snapshot().status==='running'||maintenance.snapshot().readiness.status==='checking'||['reviewing','executing'].includes(approval.snapshot().proposal?.status??''))throw Object.assign(new Error('维修或审批正在运行，请结束后再升级'),{statusCode:409});return localMaintenance.executeUpgrade(input.id);});
  app.get('/api/gateway/activity',async()=>activity.snapshot());
  app.get('/api/activity/traces',async req=>{
    const {days,limit,origin}=z.object({days:z.coerce.number().int().min(0).max(3650).default(7),limit:z.coerce.number().int().min(1).max(300).default(100),origin:z.enum(['all','native','gateway']).default('all')}).parse(req.query);
    const native=await nativeUsageSnapshot(),nativeRows=native.recent,cutoff=new Date();cutoff.setHours(0,0,0,0);cutoff.setDate(cutoff.getDate()-Math.max(0,days-1));
    const records=[...(origin==='native'?[]:traces.list({days,limit}).map(row=>({...row,origin:'gateway' as const}))),...(origin==='gateway'?[]:nativeRows.filter(row=>!days||Date.parse(row.last)>=cutoff.getTime()).map(row=>({...nativeActivitySummary(row),accountLabel:row.nativeAccountLabel})))].sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,limit);
    return {records,scanning:native.scanning,coverage:native.coverage,warning:origin==='gateway'?traces.warning:native.warning||traces.warning||''};
  });
  app.get('/api/activity/traces/:id',async(req,reply)=>{
    const id=z.string().regex(/^(?:native-[a-f0-9]{64}|[a-f0-9-]{36})$/).parse((req.params as {id:string}).id);
    const native=id.startsWith('native-')?(await nativeUsageSnapshot()).recent.find(row=>`native-${row.sampleId}`===id):undefined;
    const attributed=native;
    const record=attributed?{...nativeActivityTrace(attributed),accountLabel:attributed.nativeAccountLabel}:id.startsWith('native-')?undefined:traces.get(id);
    return record?{record}:reply.code(404).send({error:'记录已过期或本机索引尚未完成。'});
  });

  // Day-by-day counters that survive restarts; `days=0` returns everything kept.
  app.get('/api/gateway/traces',async req=>{const filter=z.object({target:z.string().max(80).optional(),sourceId:z.string().max(80).optional(),keyId:z.string().max(80).optional(),kind:z.enum(['api']).optional(),days:z.coerce.number().int().min(0).max(3650).default(7),limit:z.coerce.number().int().min(1).max(300).default(100)}).parse(req.query);return {records:traces.list(filter),...(traces.warning?{warning:traces.warning}:{})};});
  app.get('/api/gateway/traces/:id',async(req,reply)=>{const id=z.string().uuid().parse((req.params as {id:string}).id);const record=traces.get(id);return record?{record}:reply.code(404).send({error:'轨迹已过期或不存在。'});});
  app.delete('/api/gateway/traces',async()=>{await traces.clear();return {message:'本机轨迹已清空，用量总计保留。'};});
  app.get('/api/gateway/usage',async req=>{const {days}=z.object({days:z.coerce.number().int().min(0).max(3650).default(30)}).parse(req.query);return {generatedAt:new Date().toISOString(),days,since:ledger.firstDay(),rows:ledger.list(days),...(ledger.warning?{warning:ledger.warning}:{})};});
  app.get('/api/usage/overview',async req=>{
    const {days}=z.object({days:z.coerce.number().int().min(0).max(3650).default(7)}).parse(req.query);
    const native=await nativeUsageSnapshot();
    const sources=new Set((await apiSources.list()).map(s=>s.id));
    const gateway=ledger.list(0).map(row=>({...row,origin:'gateway' as const,channel:sources.has(row.sourceId)||row.model.startsWith('api-')?'api' as const:'official' as const,provider:row.model.split('/')[0]}));
    const nativeRows=native.rows;
    const allRows=[...gateway,...nativeRows];const cutoff=new Date();cutoff.setDate(cutoff.getDate()-Math.max(0,days-1));const day=`${cutoff.getFullYear()}-${String(cutoff.getMonth()+1).padStart(2,'0')}-${String(cutoff.getDate()).padStart(2,'0')}`;const keep=(r:{day:string})=>!days||r.day>=day;
    return {rows:gateway.filter(keep),nativeRows:nativeRows.filter(keep),combinedRows:allRows.filter(keep),allRows,coverage:native.coverage,scanning:native.scanning,generatedAt:native.updatedAt??new Date().toISOString(),warning:native.warning||ledger.warning||attributionWarning||attribution.warning||'',note:'本机记录与网关用量合并；带有 TokenFlow 路由标记的本机请求不重复累计。新用量可按当时的本机登录识别账号并标注；无法确认的历史用量单独显示，官方额度不换算为 Token。'};
  });
  app.get('/api/gateway-keys', async()=>({keys:gatewayKeys.list()}));
  const scopedInput = async (body: unknown, existingId?: string, modelOnly=false) => {
    const existing=existingId?gatewayKeys.list().find(key=>key.id===existingId):undefined;
    const input = gatewayKeyInput.parse({...((existing)?{agents:existing.agents,tokenLimit:existing.tokenLimit,sourceId:existing.sourceId,modelSources:existing.modelSources}:{}),...(typeof body==='object'&&body?body:{})});
    const previous = existingId ? gatewayKeys.list().find(key=>key.id===existingId)?.models ?? [] : [];
    const local=await localSnapshot();
    const savedModels=[...local.accounts.flatMap(account=>account.models??[]),...(local.apiSources??[]).flatMap(source=>source.models.map(model=>apiModelID(source.id,model)))];
    const known = new Set([...local.models.map(m=>m.id),...savedModels,...previous]);
    if(input.models.some(id=>!known.has(id))) throw Object.assign(new Error('请选择已加载的模型；新模型需在账号连接后授权。'),{statusCode:400});
    // Retain exact bindings offline; new selections must belong to the saved source catalog.
    const sameSources=existing&&(input.modelSources?input.models.every(model=>input.modelSources?.[model]===(existing.modelSources?.[model]??existing.sourceId)):input.sourceId===existing.sourceId);
    const reduction=existing&&sameSources&&(!input.enabled||existing.enabled)
      &&input.models.every(model=>existing.models.includes(model))&&input.agents.every(agent=>existing.agents.includes(agent))
      &&(existing.tokenLimit===null||input.tokenLimit!==null&&input.tokenLimit<=existing.tokenLimit);
    const pending:ModelSelection[]=[];
    if(input.modelSources){
      if(input.sourceId||input.models.some(model=>!input.modelSources?.[model]))throw Object.assign(new Error('逐模型来源必须完整，不能同时指定单一来源'),{statusCode:400});
      for(const model of input.models){const source=input.modelSources[model];if((!modelOnly&&!reduction)||!existing?.models.includes(model)||(existing.modelSources?.[model]??existing.sourceId)!==source)pending.push({sourceId:source,model});}
    }else if(input.sourceId&&!reduction)pending.push(...input.models.map(model=>({sourceId:input.sourceId!,model})));
    if(existing&&!modelOnly){for(const choice of pending)resolveSource(choice.sourceId,choice.model);}
    else if(pending.length)await validateSavedSelections(pending);
    return input;
  };
  app.post('/api/gateway-keys', async(req,reply)=>{
    const created=await gatewayKeys.create(await scopedInput(req.body),true);
    const keyStored=options.secrets.persistent!==false;
    if(keyStored)try{await options.secrets.set(`gateway-key-${created.key.id}`,created.apiKey);}catch{
      await gatewayKeys.remove(created.key.id);
      throw Object.assign(new Error('Key 未生成：系统加密存储不可用，请解锁后重试。'),{statusCode:409});
    }
    reply.header('cache-control','no-store');return {...created,keyStored};
  });
  app.post('/api/gateway-keys/:id/reveal',async(req,reply)=>{
    const id=z.string().uuid().parse((req.params as {id:string}).id);
    const key=gatewayKeys.list().find(key=>key.id===id);
    if(!key)throw Object.assign(new Error('Key 不存在'),{statusCode:404});
    if(!key.exported)throw Object.assign(new Error('旧 Key 未保存可恢复副本，请使用当时保存的 Key；地址和模型仍可复制。'),{statusCode:409});
    reply.header('cache-control','no-store');
    const apiKey=await options.secrets.get(`gateway-key-${id}`);
    if(!apiKey)throw Object.assign(new Error('无法读取完整 Key：旧版仅保存校验哈希，或系统加密存储暂不可用。请使用原先保存的 Key，或创建新 Key。'),{statusCode:409});
    if(!gatewayKeys.list().some(key=>key.id===id))throw Object.assign(new Error('Key 已删除'),{statusCode:404});
    return {apiKey};
  });
  const keyUpdates=new Map<string,Promise<unknown>>();
  const updateKey=async(id:string,work:()=>Promise<GatewayKey>)=>{
    const update=(keyUpdates.get(id)??Promise.resolve()).catch(()=>{}).then(work);
    keyUpdates.set(id,update);
    try{return await update;}finally{if(keyUpdates.get(id)===update)keyUpdates.delete(id);}
  };
  app.put('/api/gateway-keys/:id/models',async req=>{
    const id=z.string().uuid().parse((req.params as {id:string}).id);
    const {selections}=z.object({selections:z.array(z.object({sourceId:z.string().regex(/^[a-f0-9]{24}$/),model:z.string().min(3).max(300)}).strict()).max(2000)}).strict().parse(req.body);
    if(new Set(selections.map(item=>item.model)).size!==selections.length)throw Object.assign(new Error('同一模型只能选择一个来源账号'),{statusCode:400});
    return updateKey(id,async()=>{
      const existing=gatewayKeys.list().find(key=>key.id===id);
      if(!existing)throw Object.assign(new Error('Key 不存在'),{statusCode:404});
      if(!existing.exported&&(existing.sourceId||existing.modelSources))throw Object.assign(new Error('此 Key 由本地 Agent 或维修流程管理，请在对应入口修改模型。'),{statusCode:409});
      const input=await scopedInput({name:existing.name,purpose:existing.purpose,enabled:existing.enabled,sourceId:undefined,models:selections.map(item=>item.model),modelSources:Object.fromEntries(selections.map(item=>[item.model,item.sourceId]))},id,true);
      return gatewayKeys.updateModels(id,input.models,input.modelSources??{});
    });
  });
  app.put('/api/gateway-keys/:id', async req=>{
    const id=z.string().uuid().parse((req.params as {id:string}).id);
    return updateKey(id,async()=>gatewayKeys.update(id,await scopedInput(req.body,id)));
  });
  app.post('/api/gateway-keys/:id/reset-usage',async req=>gatewayKeys.resetUsage(z.string().uuid().parse((req.params as {id:string}).id)));
  app.delete('/api/gateway-keys/:id', async req=>{const id=z.string().uuid().parse((req.params as {id:string}).id);const result=await gatewayKeys.remove(id);await options.secrets.remove?.(`gateway-key-${id}`);return result;});
  const sourceDependencies=async(id:string)=>{
    const targets=(await connections.status()).filter(t=>t.connection&&(t.connection.selections??[t.connection]).some(item=>item.sourceId===id)).map(t=>({id:t.id,name:t.name,model:t.connection!.model}));
    const keys=gatewayKeys.list().filter(k=>k.sourceId===id||Object.values(k.modelSources??{}).includes(id)||k.models.some(m=>m.startsWith(`api-${id}/`))).map(k=>({id:k.id,name:k.name,models:k.models}));
    return {targets,keys,repair:maintenance.snapshot().selection?.sourceId===id,reviewer:approval.snapshot().policy.reviewer?.sourceId===id};
  };
  const sourceID=(req:{params:unknown})=>z.string().regex(/^[a-f0-9]{24}$/).parse((req.params as {id:string}).id);
  const synchronizeSources=async()=>{try{await proxy.synchronizeAPIModels((await apiSources.list()).filter(s=>s.enabled).flatMap(s=>s.models.map(m=>apiModelID(s.id,m))));return undefined;}catch{return '来源已保存，但模型路由暂未同步。请稍后重新保存或重启网关。';}};
  app.post('/api/sources/:id/reveal-key',async(req,reply)=>{
    const id=z.string().regex(/^[a-f0-9]{24}$/).parse((req.params as {id:string}).id);
    reply.header('cache-control','no-store');
    if(!apiSources.has(id))throw Object.assign(new Error('来源不存在'),{statusCode:404});
    const apiKey=await apiSources.keyFor(id);
    if(!apiKey)throw Object.assign(new Error('密钥暂不可读取，请解锁系统安全存储后重试。'),{statusCode:409});
    return {apiKey};
  });
  app.get('/api/sources',async()=>({sources:await apiSources.list()}));
  app.get('/api/sources/:id/usage',async req=>sourceDependencies(sourceID(req)));
  app.post('/api/sources',async req=>{const source=await apiSources.save(parseApiSourceInput(req.body));const routingError=await synchronizeSources();return {...source,...(routingError?{routingError}:{})};});
  const assertSourceEditable=async(id:string,acknowledge?:boolean)=>{
    const deps=await sourceDependencies(id);
    const used=deps.targets.length||deps.keys.length||deps.repair||deps.reviewer;
    if(used&&!acknowledge)throw new RunnerCoreError('此来源仍被连接或密钥使用。请查看影响后确认修改；也可以先停用。',{statusCode:409,code:'api_source_in_use'});
    if(maintenance.snapshot().status==='running'||maintenance.snapshot().readiness.status==='checking'||['reviewing','executing'].includes(approval.snapshot().proposal?.status??''))throw new RunnerCoreError('维修或审批正在调用模型，请结束后再修改来源。',{statusCode:409,code:'api_source_busy'});
  };
  app.put('/api/sources/:id',async req=>{
    const id=sourceID(req);const input=parseApiSourceInput(req.body);await assertSourceEditable(id,input.acknowledge);
    const source=await apiSources.save(input,id);const routingError=await synchronizeSources();return {...source,...(routingError?{routingError}:{})};
  });
  // Discover the protocol from URL + key + model; the optional name is a display label.
  app.post('/api/sources/quick',async(req,reply)=>{

    const input=z.object({id:z.string().regex(/^[a-f0-9]{24}$/).optional(),name:z.string().trim().min(1).max(80).optional(),baseURL:z.string().max(2048),apiKey:z.string().max(4096).optional(),model:z.string().max(20000),acknowledge:z.boolean().optional()}).strict().safeParse(req.body);
    if(!input.success)throw new RunnerCoreError('请填写 URL、API Key 和模型名称。',{statusCode:400,code:'api_source_invalid'});
    const {id,acknowledge}=input.data;const old=id?(await apiSources.list()).find(s=>s.id===id):undefined;
    if(id&&!old)throw new RunnerCoreError('API 来源已变更，请刷新。',{statusCode:409,code:'api_source_conflict'});
    const models=[...new Set(input.data.model.split(/[\n,，]/).map(m=>m.trim()).filter(Boolean))];
    if(old&&input.data.name!==undefined&&input.data.name!==old.name&&!input.data.apiKey?.trim()&&input.data.baseURL.trim()===old.baseURL&&JSON.stringify(models)===JSON.stringify(old.models)){
      return apiSources.save({name:input.data.name??old.name,baseURL:old.baseURL,protocol:old.protocol,enabled:old.enabled,models:old.models},id);
    }
    const apiKey=input.data.apiKey?.trim()||(id?await apiSources.keyFor(id):'');
    if(!apiKey)throw new RunnerCoreError(id?'API 密钥暂不可读取，请重新填写 API Key。':'请填写 API Key。',{statusCode:400,code:'api_source_invalid'});
    const checked=validateQuickSource({baseURL:input.data.baseURL,apiKey,model:input.data.model});
    if(id)await assertSourceEditable(id,acknowledge);
    const controller=new AbortController();const cancel=()=>{if(!reply.raw.writableEnded)controller.abort();};reply.raw.once('close',cancel);
    try{
      const modelRoutes:NonNullable<import('./api-sources.js').ApiSource['modelRoutes']>=Object.create(null);
      const timeout=AbortSignal.timeout(80000),signal=AbortSignal.any([controller.signal,timeout]);
      // Limit concurrent probes; each model stops as soon as the preferred protocol works.
      try{
        for(let offset=0;offset<checked.models.length;offset+=3){
          await Promise.all(checked.models.slice(offset,offset+3).map(async model=>{
            try{modelRoutes[model]=await detectProtocol({baseURL:input.data.baseURL,apiKey,model},signal);}
            catch(error){throw new RunnerCoreError(`模型 ${model} 验证未通过：${error instanceof Error?error.message:'接口不可用'}。未保存本次修改。`,{statusCode:400,code:error instanceof RunnerCoreError?error.code:'api_source_rejected'});}
          }));
        }
      }catch(error){controller.abort();if(timeout.aborted)throw new RunnerCoreError('模型协议验证超时，未保存本次修改。请减少模型数量或稍后重试。',{statusCode:400,code:'api_source_timeout'});throw error;}
      if(signal.aborted)throw new RunnerCoreError('已取消验证，未保存本次修改。',{statusCode:400,code:'api_source_cancelled'});
      const found=modelRoutes[checked.models[0]];
      const source=await apiSources.save({name:input.data.name??old?.name??sourceNameFromURL(found.baseURL),baseURL:found.baseURL,protocol:found.protocol,modelRoutes,enabled:old?.enabled??true,models:checked.models,...(input.data.apiKey?.trim()?{apiKey}:{})},id);
      const routingError=await synchronizeSources();return {...source,...(routingError?{routingError}:{})};
    }finally{reply.raw.off('close',cancel);}
  });
  app.delete('/api/sources/:id',async req=>{
    const id=sourceID(req);const deps=await sourceDependencies(id);
    if(deps.targets.length||deps.keys.length||deps.repair||deps.reviewer)throw new RunnerCoreError('此来源仍被连接、客户端 Key 或维修模型使用。请先切换或还原、移除关联 Key；可先停用。',{statusCode:409,code:'api_source_in_use'});
    await apiSources.remove(id);await synchronizeSources();return {deleted:true};
  });
  app.post('/api/sources/:id/models',async(req,reply)=>{
    const controller=new AbortController();const cancel=()=>{if(!reply.raw.writableEnded)controller.abort();};reply.raw.once('close',cancel);
    try{return {models:await apiSources.models(sourceID(req),controller.signal)};}
    finally{reply.raw.off('close',cancel);if(mutationOwner===req.id)mutationOwner=undefined;}
  });
  app.post('/api/sources/:id/check',async req=>{
    const id=sourceID(req);const {model}=z.object({model:z.string().min(1).max(300)}).strict().parse(req.body);resolveSource(id,model);
    const created=await gatewayKeys.create(gatewayKeyInput.parse({name:'来源最小验证',models:[model],sourceId:id,tokenLimit:4096}));
    try{
      const response=await app.inject({method:'POST',url:'/v1/responses',headers:{host:'127.0.0.1:9527',authorization:`Bearer ${created.apiKey}`},payload:{model,input:'Reply OK only.',max_output_tokens:128,store:false,stream:false}});
      let data:{status?:string;output?:{type?:string;content?:{type?:string;text?:string}[]}[]}={};try{data=response.json();}catch{/* Invalid output is a failed check, not permission to retry. */}
      const passed=response.statusCode===200&&data.status==='completed'&&Array.isArray(data.output)&&data.output.some(v=>v.type==='message'&&v.content?.some(c=>c.type==='output_text'&&typeof c.text==='string'&&!!c.text.trim()));
      const message=passed?'最小文本调用通过；未验证工具、图片或客户端。':response.statusCode===200?'接口有响应，但未返回完整文本；可能达到输出上限，不能据此判断权限失效。':`最小调用未通过（HTTP ${response.statusCode}）；请检查地址、协议、密钥和模型权限。`;
      await apiSources.record(id,model,passed,message);return {passed,message};
    }finally{await gatewayKeys.remove(created.key.id);}
  });
  app.get('/api/local-agent',localSnapshot);
  app.post('/api/local-agent/network-check',async()=>{await proxy.checkNetwork();return localSnapshot();});
  app.get('/api/local-agent/gateway',async()=>proxy.gateway());
  app.put('/api/local-agent/gateway',async req=>{

    const input=z.object({apiKey:z.string().max(256).optional()}).strict().parse(req.body??{});
    const next=(input.apiKey??'').trim()||randomBytes(32).toString('hex');
    const gateway=await localOperation(()=>proxy.setClientKey(next));
    await options.secrets.set('cliproxy',next).catch(()=>{throw Object.assign(new Error('密钥已写入当前 Local Agent，但未能保存到系统密钥存储；重启应用后会恢复为旧密钥。'),{statusCode:500});});
    return gateway;
  });
  // 登录层动作（codex/claude/antigravity/kimi/xai）与服务生命周期动作共用一个入口。
  app.post('/api/local-agent/providers/:provider/refresh',async req=>{

    const provider=z.enum([...loginProviderIds,'cursor']).parse((req.params as {provider:string}).provider);
    const {force}=z.object({force:z.boolean().default(true)}).strict().parse(req.body??{});
    return localOperation(()=>proxy.refreshProvider(provider,force));
  });
  app.post('/api/local-agent/:action',async req=>{const action=z.enum(['start','stop','restart','refresh','quota','cursor',...loginProviderIds]).parse((req.params as {action:string}).action);if(action==='cursor'||isLoginProvider(action))return localOperation(()=>proxy.login(action));if(action==='refresh')return localOperation(async()=>{await proxy.cursor.refresh();return proxy.refreshAccounts();});if(action==='quota')return localOperation(async()=>{await proxy.refreshAccounts();return proxy.refreshQuota();});if(action==='restart')return localOperation(async()=>{await proxy.stop();return proxy.start();});return localOperation(()=>proxy[action]());});
  app.post('/api/local-agent/login/:action',async req=>{

    const action=z.enum(['open','cancel','callback']).parse((req.params as {action:string}).action);
    const input=z.object({id:z.string().uuid(),redirectURL:z.string().max(8192).optional()}).strict().parse(req.body);
    if(action==='open')return localOperation(()=>proxy.openLogin(input.id));
    if(action==='cancel')return localOperation(()=>proxy.cancelLogin(input.id));
    if(!input.redirectURL)throw Object.assign(new Error('请输入完整回调地址'),{statusCode:400});
    return localOperation(()=>proxy.submitCallback(input.id,input.redirectURL!));
  });
  app.post('/api/local-agent/accounts/:id',async req=>{
    const {enabled}=z.object({enabled:z.boolean()}).strict().parse(req.body);
    const id=z.string().regex(/^[a-f0-9]{24}$/).parse((req.params as {id:string}).id);
    return localOperation(()=>proxy.setAccountEnabled(id,enabled));
  });
  app.delete('/api/local-agent/accounts/:id',async req=>{

    const id=z.string().regex(/^[a-f0-9]{24}$/).parse((req.params as {id:string}).id);
    return localOperation(()=>proxy.deleteAccount(id));
  });
  app.post('/api/local-agent/import-local/:provider',async req=>{

    const provider=z.enum(['trae','workbuddy','workbuddy-ai','zcode','cursor']).parse((req.params as {provider:string}).provider);
    return localOperation(()=>proxy.importLocal(provider));
  });
  // Stable authenticated gateway for external local AI clients. Translation is performed by CLIProxyAPI.
  for(const path of ['models','responses','responses/compact','chat/completions','messages','messages/count_tokens'])app.route({method:path==='models'?'GET':'POST',url:`/v1/${path}`,bodyLimit:16*1024*1024,handler:async(req,reply)=>{
    const bearer=clientCredential(req.headers).value;
    const client=gatewayKeys.authenticate(bearer);
    if(bearer && !same(bearer,options.token) && !client) return reply.code(401).send({error:{message:'Invalid or disabled API key',type:'authentication_error'}});
    const fixed=client&&fixedRoutes.get(client.id);
    if(path!=='models'&&fixed?.modelAliases){
      const requested=z.object({model:z.string().min(1).max(300)}).parse(req.body).model;
      const alias=fixed.target==='workbuddy'||fixed.target==='workbuddy-ai'?requested.replace(/^custom-local:/,''):requested;
      if(Object.hasOwn(fixed.modelAliases,alias))req.body={...(req.body as Record<string,unknown>),model:fixed.modelAliases[alias]};
    }
    if(path!=='models'&&fixed&&!fixed.selections&&client.sourceId===fixed.sourceId&&client.models.length===1&&client.models[0]===fixed.model){
      z.object({model:z.string().min(1).max(300)}).parse(req.body);
      req.body={...(req.body as Record<string,unknown>),model:fixed.model};
      reply.header('X-Token-Flow-Model',fixed.model);
    }
    const started=Date.now();const traceRequest=requestTrace(req.body);let traceResponse:ResponseObservation={tools:[]};let recorded=false;let callError:{code:string;message:string}|undefined;
    const record=(status:number,usage:{inputTokens:number|null;outputTokens:number|null;cachedTokens?:number|null;cacheWriteTokens?:number|null;reasoningTokens?:number|null}={inputTokens:null,outputTokens:null})=>{
      if(recorded||path==='models')return;recorded=true;
      const rawModel=(req.body as {model?:unknown})?.model;
      const model=typeof rawModel==='string'&&(client?.models.includes(rawModel)||proxy.snapshot().models.some(m=>m.id===rawModel)||!client)?rawModel.slice(0,300):'未授权模型';
      // Statistics follow the Agent that owns a connection Key, and the account or API that served the call.
      const target=!client?'workspace':fixed?fixed.target:client.name.startsWith('内部 · ')?'internal':'key';
      const sourceId=client?.modelSources?.[model]??client?.sourceId??apiSources.sourceFor(model)?.id??'';
      const call={keyId:client?.id??'workspace',agent:client?.name??'工作台调试',target,sourceId,model,protocol:path,startedAt:new Date(started).toISOString(),durationMs:Date.now()-started,status,inputTokens:usage.inputTokens,cachedTokens:usage.cachedTokens??null,cacheWriteTokens:usage.cacheWriteTokens??null,reasoningTokens:usage.reasoningTokens??null,outputTokens:usage.outputTokens,...(callError?{error:callError}:{})};
      const tools=path==='messages/count_tokens'?{toolCalls:0,toolResults:0}:traces.record(call,traceRequest,traceResponse);
      activity.record({...call,...tools,...(traceResponse.generationMs&&usage.outputTokens!==null?{generationMs:traceResponse.generationMs,timedOutputTokens:usage.outputTokens}:{})});
    };
    let reservation:string|undefined;let settled=false;
    const settle=async(usage:{inputTokens:number|null;outputTokens:number|null},uncertain:boolean)=>{
      if(!client||!reservation||settled)return;settled=true;
      try{await gatewayKeys.settle(client.id,reservation,usage,uncertain);}catch{app.log.error('客户端 Key 用量写入失败；在途状态保留，后续有限额请求将被阻止。');}
    };
    // Revalidate an idle Cursor catalog when it is actually used, not on a timer.
    const requestedModel=(req.body as {model?:unknown}|undefined)?.model;
    if(typeof requestedModel==='string'&&requestedModel.startsWith('cursor/')&&(!client||client.models.includes(requestedModel))||path==='models'&&client?.models.some(model=>model.startsWith('cursor/')))await proxy.cursor.refreshIfStale();
    let selectedAuth:string|undefined;
    if(client) {
      const direct=directKeys.has(client.id)&&path.startsWith('responses');
      const directSource=direct&&client.sourceId?(await apiSources.list()).find(s=>s.id===client.sourceId&&s.enabled&&s.hasKey):undefined;
      const available:LocalModel[]=[...(await localSnapshot()).models,...(directSource?directSource.models.filter(id=>apiModelRoute(directSource,id).protocol==='responses').map(id=>({id:apiModelID(directSource.id,id),provider:'api' as const})):[])].filter(model=>client.models.includes(model.id));
      if(client.modelSources){
        if(path==='models'){
          for(let index=available.length-1;index>=0;index--){const sourceId=client.modelSources[available[index].id];try{if(!sourceId)throw new Error('Not selected');resolveSource(sourceId,available[index].id);}catch{available.splice(index,1);}}
        }else{
          const model=z.object({model:z.string().min(1).max(300)}).parse(req.body).model;
          const sourceId=client.modelSources[model];
          if(client.models.includes(model)){
            if(!sourceId){record(403);return reply.code(403).send({error:{message:'Model is not configured for this Agent',type:'model_not_allowed'}});}
            try{selectedAuth=resolveSource(sourceId,model,true);}catch{record(503);return reply.code(503).send({error:{message:'Selected source account is unavailable',type:'source_unavailable'}});}
          }
        }
      }else if(client.sourceId){
        const sourceAuth=(model:string)=>directSource&&apiModelRoute(directSource,model).protocol==='responses'?(apiSources.assert(client.sourceId!,model),''):resolveSource(client.sourceId!,model,path!=='models');
        if(path==='models'){
          for(let index=available.length-1;index>=0;index--)try{sourceAuth(available[index].id);}catch{available.splice(index,1);}
        }else{
          const model=z.object({model:z.string().min(1).max(300)}).parse(req.body).model;
          if(client.models.includes(model))try{selectedAuth=sourceAuth(model);}catch{record(503);return reply.code(503).send({error:{message:'Selected source account is unavailable',type:'source_unavailable'}});}
        }
      }
      if(path==='models'){
        const sources=await apiSources.list();
        return {object:'list',data:available.map(model=>{
          const id=fixed?.target==='workbuddy'||fixed?.target==='workbuddy-ai'?Object.entries(fixed.modelAliases??{}).find(([,route])=>route===model.id)?.[0]??model.id:model.id;
          const name=id!==model.id?id:modelLabel(available,model.id,sources);
          return {id,object:'model',owned_by:model.provider,name,display_name:name,...(model.capabilities?{capabilities:model.capabilities}:model.textOnly?{capabilities:{text:true,tools:false,images:false}}:{})};
        })};
      }
      if(!allowsProtocol(client.agents,path)){record(403);return reply.code(403).send({error:{message:'This API key does not allow this agent protocol',type:'agent_not_allowed'}});}
      const model=z.object({model:z.string().min(1).max(300)}).parse(req.body).model;
      if(!client.models.includes(model)){record(403);return reply.code(403).send({error:{message:`此 Key 未授权请求模型。请将主模型、辅助模型及项目级配置统一为已授权的模型 ID（含提供商前缀）：${client.models.slice(0,5).join('、')||'暂无授权模型'}。无需重新登录厂商账号。`,type:'model_not_allowed'}});}
      if(!selectedAuth&&!available.some(item=>item.id===model)){record(503);return reply.code(503).send({error:{message:'Model is currently unavailable; check the provider account and gateway',type:'model_unavailable'}});}
      if(path!=='messages/count_tokens'){
        try{reservation=await gatewayKeys.reserve(client.id,model,path);}catch(error){const code=(error as {statusCode?:number}).statusCode??503;record(code);return reply.code(code).send({error:{message:error instanceof Error?error.message:'Quota check failed',type:'key_quota_error'}});}
      }
    }
    const apiSource=apiSources.sourceFor((req.body as {model?:string})?.model??'');
    if(/^api-[a-f0-9]{24}\//.test((req.body as {model?:string})?.model??'')&&!apiSource){record(503);await settle({inputTokens:null,outputTokens:null},false);return reply.code(503).send({error:{message:'API source or model unavailable',type:'source_unavailable'}});}
    if(apiSource){try{if(client&&directKeys.has(client.id)&&path.startsWith('responses')&&apiModelRoute(apiSource,(req.body as {model:string}).model).protocol==='responses')apiSources.assert(apiSource.id,(req.body as {model:string}).model);else resolveSource(apiSource.id,(req.body as {model:string}).model);}catch{record(503);await settle({inputTokens:null,outputTokens:null},false);return reply.code(503).send({error:{message:'API source unavailable',type:'source_unavailable'}});}}
    const upstreamURL=client||apiSource?proxy.gateway().baseURL:config.baseURL;
    const upstreamKey=client||apiSource?proxy.gateway().apiKey:await key();
    const abort=upstreamIdle();
    reply.raw.once('close',()=>abort.abort());
    try {
      const cursorModel=typeof (req.body as {model?:unknown})?.model==='string'&&(req.body as {model:string}).model.startsWith('cursor/');
      if(cursorModel&&proxy.snapshot().state!=='running'){record(503);await settle({inputTokens:null,outputTokens:null},false);abort.close();return reply.code(503).send({error:{message:'网关未启动',type:'provider_error'}});}
      const send=async(route:string,body:unknown)=>{
        const protocol=apiSource?apiModelRoute(apiSource,(body as {model:string}).model).protocol:undefined;
        const native=apiSource&&(protocol==='responses'&&route.startsWith('responses')||protocol==='chat'&&route==='chat/completions'||protocol==='messages'&&route.startsWith('messages'));
        if(native){const headers:Record<string,string>={};for(const name of ['anthropic-version','anthropic-beta'])if(typeof req.headers[name]==='string')headers[name]=req.headers[name];return abort.watch(await apiSources.response(apiSource.id,route,body as {model:string},abort.signal,headers));}
        return abort.watch(await fetch(`${upstreamURL.replace(/\/$/,'')}/${route}`,{method:req.method,headers:{...(selectedAuth?{'X-Token-Flow-Auth':selectedAuth}:{}),Authorization:`Bearer ${upstreamKey}`,'Content-Type':'application/json',...(typeof req.headers['anthropic-version']==='string'?{'anthropic-version':req.headers['anthropic-version']}:{}),...(typeof req.headers['anthropic-beta']==='string'?{'anthropic-beta':req.headers['anthropic-beta']}:{}),...(typeof req.headers['x-stainless-lang']==='string'?{'x-stainless-lang':req.headers['x-stainless-lang']}:{})},body:req.method==='POST'?JSON.stringify(body):undefined,redirect:'error',signal:abort.signal}));
      };
      const model=(req.body as {model?:string})?.model;
      const bridgeContext=(path==='responses'||path==='responses/compact')&&!!(client||config.kind==='cliproxy'||apiSource)&&typeof model==='string'&&(fixed?.target==='codex'||/^(qoder|workbuddy|cursor)\//.test(model)||!!apiSource);
      const workbuddyModel=!!model?.startsWith('workbuddy/')&&!apiSource;
      const sdkSourceId=client?.modelSources?.[model!]??client?.sourceId??proxy.snapshot().accounts.find(a=>a.provider==='workbuddy'&&!a.disabled&&a.models?.includes(model!))?.id;
      const dispatch=cursorModel?async(route:string,body:unknown)=>abort.watch(await proxy.cursor.response(route,body,abort.signal,client?.modelSources?.[model!]??client?.sourceId)):workbuddyModel&&path!=='messages/count_tokens'?async(route:string,body:unknown)=>{if(!sdkSourceId)throw new Error('WorkBuddy source unavailable');return abort.watch(await workbuddySDK.response(sdkSourceId,route,body,abort.signal));}:send;
      const response=bridgeContext?await gatewayContext.response(path,req.body as {model:string},client?.id??'workspace',client?.modelSources?.[model]??client?.sourceId??apiSource?.id??upstreamURL,dispatch,fixed?.target==='codex'?{scope:codexContextScope,normalize:portableCodexItem,recover:async item=>codexContext.recover(item,await codexContextScopes())}:undefined):await dispatch(path,req.body);
      if(!response.ok){
        await settle({inputTokens:null,outputTokens:null},response.status>=500);
        if(cursorModel){record(response.status);abort.close();return reply.code(response.status).send(await response.json());}
        const error=upstreamError(response.status,await readUpstreamError(response));
        callError={code:error.type==='source_policy_blocked'?'source_policy_blocked':error.code??error.type,message:error.message};record(response.status);
        await response.body?.cancel().catch(()=>{});abort.close();
        return reply.code(response.status).send({...(path==='messages'?{type:'error'}:{}),error});
      }
      if(response.headers.has('x-token-flow-transport'))reply.header('X-Token-Flow-Transport',response.headers.get('x-token-flow-transport')!);
      if(cursorModel&&response.headers.has('x-token-flow-output-limit'))reply.header('X-Token-Flow-Output-Limit',response.headers.get('x-token-flow-output-limit')!);
      if(bridgeContext&&response.headers.has('x-token-flow-compaction'))reply.header('X-Token-Flow-Compaction',response.headers.get('x-token-flow-compaction')!);
      reply.code(response.status).header('Content-Type',response.headers.get('content-type')??'application/json').header('Cache-Control','no-store');
      if(!response.body){record(response.status);await settle({inputTokens:null,outputTokens:null},true);abort.close();return '';}
      const source=Readable.fromWeb(response.body as never);
      const stream=observeUsage((response.headers.get('content-type')??'').includes('text/event-stream'),async usage=>{if(abort.timedOut)callError={code:'upstream_idle_timeout',message:'上游连续 120 秒未返回数据，请稍后重试或缩短对话。'};else if(usage.failed&&!callError)callError=traceResponse.error??{code:'upstream_incomplete_response',message:'上游响应未完整结束。'};record(abort.timedOut?504:callError?.code==='upstream_stream_error'||usage.failed?502:abort.signal.aborted?499:response.status,usage);await settle(usage,abort.signal.aborted||usage.failed||usage.inputTokens===null||usage.outputTokens===null);},details=>{traceResponse=details;});
      source.once('error',()=>{callError={code:'upstream_stream_error',message:'上游连接中断。'};abort.abort();stream.destroy();});stream.once('close',()=>{abort.close();source.destroy();});
      reply.raw.once('close',()=>stream.destroy());
      source.pipe(stream);return reply.send(stream);
    }catch(error){
      const status=error instanceof GatewayContextError?error.statusCode:abort.timedOut?504:abort.signal.aborted?499:502;
      callError={code:abort.timedOut?'upstream_idle_timeout':status===499?'request_cancelled':error instanceof GatewayContextError?'context_error':'upstream_connection_error',message:abort.timedOut?'上游连续 120 秒未返回数据，请稍后重试或缩短对话。':status===499?'客户端已取消请求。':error instanceof GatewayContextError?error.message:'无法连接上游服务，或连接已中断。'};
      const measured=error instanceof GatewayContextError?error.usage as {input_tokens?:number;output_tokens?:number}|undefined:undefined;
      const tokens=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
      const usage={inputTokens:tokens(measured?.input_tokens),outputTokens:tokens(measured?.output_tokens)};
      record(status,usage);await settle(usage,status>=500&&(usage.inputTokens===null||usage.outputTokens===null));abort.close();
      return reply.code(status).send({error:{code:callError.code,message:callError.message,type:error instanceof GatewayContextError?'context_error':abort.timedOut?'timeout_error':'provider_error'}});
    }
  }});
  if(options.uiRoot)await app.register(staticPlugin,{root:resolve(options.uiRoot),prefix:'/'});
  app.addHook('onClose',async()=>{serviceClosing=true;clearInterval(nativeLoginTimer);await nativeLoginObservation;await nativeUsageLogins.close();await cursorNativeUsage.close();await workbuddySDK.close();clearTimeout(startupCheckTimer);await localUsage.close();await attribution.close();await ledger.close();await traces.close();await localMaintenance.close();await maintenance.close();await approval.close();await proxy.shutdown();await apiSources.close();for(const saved of internalKeys.values()){const created=await saved.catch(()=>undefined);if(created&&gatewayKeys.list().some(k=>k.id===created.key.id))await gatewayKeys.remove(created.key.id);}});
  return {app,proxy,discoverLocal};
}
