import {AgentAccountSkeleton,AgentFieldSkeleton} from './AgentLoading';
import {officialLoginHeld} from '../../shared/native-login-identity';
import {hasNativeLogin} from './native-login-visibility';
import {OfficialAccountIdentity,UnpooledNativeAccount} from './OfficialAccountIdentity';
import {NativeLoginStatus} from './NativeLoginStatus';
import {QoderIdePanel} from './QoderIdePanel';
import {CodexRoutingMode} from './CodexRoutingMode';
import {AgentUsageDetails} from './AgentUsageDetails';
import {ClaudeDesktopPanel} from './ClaudeDesktopPanel';
import {useClaudeDesktopStatus} from './claude-desktop-status';
import {useOfficialLoginConfirm} from './OfficialLoginConfirm';
import {Thinking,LoadingSkeleton,LoadError} from './LoadingState';
import {ColumnDivider} from './ColumnDivider';
import {ScrollRail} from './ScrollRail';
import {localDay} from './usage-model';
import type {AgentInstallation} from '../../../packages/core/src/agent-installation';
import type {AgentUpdate} from '../../../packages/core/src/agent-updates';
import type {AgentConnections} from '../../../packages/core/src/agent-connections';
import { useEffect, useRef, useState,type ReactNode } from 'react';
import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';
import type { MaintenanceChain } from '../../../packages/core/src/gateway-maintenance';
import type { GatewayCall } from '../../../packages/core/src/gateway-activity';
import { requestJSON } from './request';
import { readForSession } from './session-read';
import { connectionEvidence, type AgentTarget } from './connection-evidence';
import { type Choice } from './flow-model';
import { compactTokens, formatTokens, percentText, rangeLabel, totalsOf } from './usage-model';
import type { UsageData } from './usage-data';
import { UsageFold, modelManufacturer } from './UsagePanel';
import {DragHandle,dropOrder,orderModels,useModelOrder} from './display-order';
import { isSourceSelectionAvailable, sourceSelectionState, sourceLabel, sourceOptions } from './source-options';
import { qualifiedModelLabel as modelLabel } from './model-label';
import { useNativeLogin } from './native-login';
import { FlowDialog } from './FlowDialog';
import {useListReturn} from './list-return';
import { AgentModelPicker } from './AgentModelPicker';
import { SwitchTabs } from './SwitchTabs';
import { QuotaDetails } from './QuotaDetails';
import { Icon } from './Icons';
import { ProviderIcon } from './ProviderIcon';
import type { Notify } from './notify';

type Login=ReturnType<typeof useNativeLogin>;
const tabKey='token-flow.usage.tab';
const agentGroup=(id:string)=>id==='workbuddy-ai'?'workbuddy':id==='qoder-ide'?'qoder':id;
export function savedAgentTab(){try{return agentGroup(localStorage.getItem(tabKey)??'codex');}catch{return 'codex';}}
const hiddenKey=(target:string)=>`token-flow.agent.${target}.hidden`;
const post=(body:unknown)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const choiceId=(choice:Choice)=>`model:${choice.sourceId}/${choice.model}`;
const unavailableSelectionMessage='部分所选来源已停用，或模型已不在当前列表中，可保留选择或移除。';
const codexMigrationStage=(progress:AgentTarget['threadMigration'])=>progress?.lifecyclePhase==='stopping'?'正在退出 Codex…':progress?.lifecyclePhase==='opening'?'正在重新打开 Codex…':progress?.phase==='backup'?`正在备份旧对话 ${progress.done} / ${progress.total}…`:progress?.phase==='migrating'||progress?.phase==='restoring'?`正在${progress.phase==='restoring'?'还原':'迁移'}旧对话 ${progress.done} / ${progress.total}…`:progress?.lifecyclePhase==='changing'?'正在应用配置并检查需要处理的对话…':'正在准备应用更改…';

function problemOf(target:AgentTarget,calls:GatewayCall[],available:ReturnType<typeof sourceOptions>,local:LocalAgentSnapshot){
 const connection=target.connection;
 if(target.error)return target.error;
 if(!connection)return '';
 if((connection.selections??[connection]).some(item=>sourceSelectionState(local,item,available)==='unavailable'))return unavailableSelectionMessage;
 if(target.configurationState==='missing')return '网关配置已移除，可重新应用所选模型。';
 if(target.configurationState==='changed')return '配置已被其他应用或手动修改，可重新应用所选模型。';
 if(target.configurationState!=='configured')return '暂时无法确认接入配置，请打开维修检查。';
 const evidence=connectionEvidence(target,calls,available,local);
 return evidence.tone==='attention'?evidence.label:'';
}

export function AgentsPage({local,calls,usage,notify,onRepair,onAgent,localError,reloadLocal}:{local:LocalAgentSnapshot;calls:GatewayCall[];usage:UsageData;notify:Notify;onRepair:(chain:MaintenanceChain,intent?:'codex-history')=>void;onAgent:(id:string)=>void;localError:string;reloadLocal:()=>Promise<void>}){
 const [workbuddyClient,setWorkbuddyClient]=useState<'workbuddy'|'workbuddy-ai'>(()=>{try{return (localStorage.getItem('token-flow.workbuddy.client')??localStorage.getItem(tabKey))==='workbuddy-ai'?'workbuddy-ai':'workbuddy';}catch{return 'workbuddy';}});
 const [qoderClient,setQoderClient]=useState<'qoder'|'qoder-ide'>(()=>{try{return localStorage.getItem('token-flow.qoder.client')==='qoder-ide'?'qoder-ide':'qoder';}catch{return 'qoder';}});
 const [claudeClient,setClaudeClient]=useState<'terminal'|'desktop'>(()=>{try{return localStorage.getItem('token-flow.claude.client')==='desktop'?'desktop':'terminal';}catch{return 'terminal';}});
 const desktop=useClaudeDesktopStatus(claudeClient==='desktop');
 const [loadError,setLoadError]=useState('');
 const [targets,setTargets]=useState<AgentTarget[]>();
 const [updates,setUpdates]=useState<Record<string,AgentUpdate>>({});
 const refreshUpdates=async(reload=true)=>{try{setUpdates((await readForSession('agent-updates',()=>requestJSON<{updates:Record<string,AgentUpdate>}>('/api/a2a/program-updates',undefined,20000),reload)).updates);}catch{/* Offline checks never imply an available update. */}};
 const [tab,setTab]=useState(savedAgentTab);
 const refresh=async(reload=true)=>{try{setTargets((await readForSession('agent-targets',()=>requestJSON<{targets:AgentTarget[]}>('/api/a2a'),reload)).targets);setLoadError('');}catch(error){setLoadError('暂时无法读取本机 Agent，请检查连接后重试。');throw error;}};
 useEffect(()=>{void refresh(false).catch(()=>{});const changed=()=>void refresh().catch(()=>{});window.addEventListener('tokenflow:native-login-changed',changed);return()=>window.removeEventListener('tokenflow:native-login-changed',changed);},[]);
 useEffect(()=>{void refreshUpdates(false);},[]);
 const logins:Record<string,Login>={codex:useNativeLogin('codex',local),claude:useNativeLogin('claude',local),workbuddy:useNativeLogin('workbuddy',local),'workbuddy-ai':useNativeLogin('workbuddy-ai',local),qoder:useNativeLogin('qoder',local),'qoder-ide':useNativeLogin('qoder-ide',local)};
 const available=sourceOptions(local);
 const choose=(id:string)=>{setTab(id);onAgent(id);try{localStorage.setItem(tabKey,id);}catch{/* Only remembers the open tab. */}};
 const target=targets?.find(t=>t.id===tab)??targets?.[0];
 useEffect(()=>{onAgent(target?.id==='workbuddy'?workbuddyClient:target?.id==='qoder'?qoderClient:target?.id??tab);},[target?.id,tab,workbuddyClient,qoderClient,onAgent]);

 const refreshOfficialAccounts=async(provider:string)=>{const pool=provider==='workbuddy-ai'?'workbuddy':provider;try{await requestJSON(`/api/local-agent/providers/${pool}/refresh`,post({force:true}),300000);}finally{await Promise.all([reloadLocal(),logins[provider]?.refresh(true)]);}};
 const clientSwitch=target?.id==='qoder'?<SwitchTabs className="tfClientPair" label="Qoder 客户端" value={qoderClient} options={[["qoder","Qoder"],["qoder-ide","Qoder IDE"]]} onChange={next=>{setQoderClient(next);try{localStorage.setItem('token-flow.qoder.client',next);}catch{}}}/>:target?.id==='workbuddy'?<SwitchTabs className="tfClientPair" label="WorkBuddy 客户端" value={workbuddyClient} options={[['workbuddy','WorkBuddy'],['workbuddy-ai','WorkBuddyAI']]} onChange={next=>{setWorkbuddyClient(next);try{localStorage.setItem('token-flow.workbuddy.client',next);}catch{}}}/>:target?.id==='claude'?<SwitchTabs className="tfClientPair" label="Claude 客户端" value={claudeClient} options={[['terminal','Claude CLI'],['desktop','Claude Desktop']]} onChange={next=>{setClaudeClient(next);try{localStorage.setItem('token-flow.claude.client',next);}catch{}}}/>:undefined;
 return <div className="tfPage tfAgentsPage">
  <ScrollRail className="tfTiles" role="tablist" aria-label="本地 Agent">
   {targets?.filter(item=>item.id!=='workbuddy-ai').map(item=>{
    const source=item.id==='workbuddy'&&workbuddyClient==='workbuddy-ai'?targets.find(entry=>entry.id==='workbuddy-ai')??item:item;
    const client=item.id==='workbuddy'?workbuddyClient:item.id==='qoder'?qoderClient:item.id;
    const desktopView=item.id==='claude'&&claudeClient==='desktop';
    const connection=client!=='qoder-ide'&&!desktopView?source.connection:undefined;
    const labelPending=!desktopView&&(connection?sourceSelectionState(local,connection,available)==='loading'&&!local.models.some(m=>m.id===connection.model):!!logins[client]&&(!logins[client].status&&!logins[client].error||!!local.accountsLoading));
    const native=desktopView?undefined:logins[client]?.nativeLabel;
    const problem=desktopView?!!desktop.error:client!=='qoder-ide'&&!!problemOf(source,calls,available,local);
    const active=desktopView?!!desktop.status?.connected:!!(connection||native);
    return <button key={item.id} role="tab" aria-selected={target?.id===item.id} tabIndex={target?.id===item.id?0:-1} className="tfTile" onClick={()=>choose(item.id)}>
     <ProviderIcon provider={item.id} size={30}/>
     <span className="tfTileText"><strong>{client==='workbuddy-ai'?'WorkBuddyAI':client==='qoder-ide'?'Qoder IDE':item.name}</strong><small>{labelPending?<AgentFieldSkeleton/>:desktopView?'Claude Desktop':`${item.id==='claude'?'Claude CLI · ':''}${connection?modelLabel(local,connection.model):native?`本机 · ${native}`:client==='qoder-ide'?'本机用量':source.connection?'模型不可用':'未接入'}`}</small></span>
     <i className={`dot ${problem?'bad':active?'ok':''}`} aria-label={problem?'有问题':active?'使用中':desktopView&&!desktop.status?'正在读取':'未接入'}/>
    </button>;
   })}
  </ScrollRail>
  {(loadError||localError)&&<LoadError message="暂时无法读取本机 Agent，请检查连接后重试。" retry={()=>Promise.allSettled([reloadLocal(),refresh()])}/>}
  {!targets&&!loadError&&!localError&&<LoadingSkeleton label="正在读取本机 Agent" variant="cards"/>}
  {(()=>{const panel=target?.id==='workbuddy'&&workbuddyClient==='workbuddy-ai'?targets?.find(item=>item.id==='workbuddy-ai')??target:target;return target?.id==='qoder'&&qoderClient==='qoder-ide'?<QoderIdePanel clientSwitch={clientSwitch} local={local} usage={usage}/>:target?.id==='claude'&&claudeClient==='desktop'?<ClaudeDesktopPanel desktop={desktop} clientSwitch={clientSwitch} local={local} usage={usage} notify={notify} key="claude-desktop"/>:panel&&<AgentPanel onRefreshAccounts={()=>refreshOfficialAccounts(panel.id)} clientSwitch={clientSwitch} key={panel.id} target={panel} update={updates[panel.id]} login={logins[panel.id]} local={local} usage={usage} problem={problemOf(panel,calls,available,local)} notify={notify} onRepair={onRepair} onChanged={refresh} onProgramChanged={refreshUpdates}/>;})()}
 </div>;
}

function AgentPanel({onRefreshAccounts,clientSwitch,target,update,login,local,usage,problem,notify,onRepair,onChanged,onProgramChanged}:{onRefreshAccounts:()=>Promise<void>;clientSwitch?:ReactNode;target:AgentTarget;update?:AgentUpdate;login?:Login;local:LocalAgentSnapshot;usage:UsageData;problem:string;notify:Notify;onRepair:(chain:MaintenanceChain,intent?:'codex-history')=>void;onChanged:()=>Promise<void>;onProgramChanged:()=>Promise<void>}){
 const [modelOrder,,modelRanks,moveModel]=useModelOrder();
 const [gatewayPending,setGatewayPending]=useState<boolean>();
 const [gatewayConfirm,setGatewayConfirm]=useState<{selections:Choice[];preferred?:Choice;coexist?:boolean}>();
 const [programError,setProgramError]=useState('');
 const [programOpen,setProgramOpen]=useState(!target.installation.installed&&target.id!=='claude');const [programAction,setProgramAction]=useState<'install'|'update'>('install');
 const pendingSelection=useRef<{selections:Choice[];preferred?:Choice}|undefined>(undefined);
 const programCompleted=useRef(false);
 const askProgram=(action:'install'|'update')=>{setProgramError('');programCompleted.current=false;setProgramAction(action);setProgramOpen(true);};
 const updateAvailable=update?.status==='available'&&update.currentVersion===target.installation.version;
 const [restartOpen,setRestartOpen]=useState(false);const [restartError,setRestartError]=useState('');
 const [restartPending,setRestartPending]=useState(false);
 const [modelApplication,setModelApplication]=useState<{phase:'applying'|'saved'|'error'|'restarting';message?:string;code?:string;retry?:'models'|'restart'}>();
 const retryApplication=useRef<()=>unknown>(()=>{});
 const [historyOffer,setHistoryOffer]=useState('');
 const switching=useRef(false);
 const [restoreOpen,setRestoreOpen]=useState(false);
 const [restorePreview,setRestorePreview]=useState<Awaited<ReturnType<AgentConnections['restorePreview']>>>();
 const [restoreLoading,setRestoreLoading]=useState(false);
 const [restoreError,setRestoreError]=useState<{message:string;code?:string}>();
 const restoreBlocked=restorePreview?.canRestore===false||restoreError?.code==='configuration_conflict';
 const restoreRead=useRef(0);
 const [exitMessage,setExitMessage]=useState('');const retryMigration=useRef<()=>unknown>(()=>{});
 const [migrationProgress,setMigrationProgress]=useState(target.threadMigration);

 const insertedGateway=['workbuddy','workbuddy-ai','qoder','deepseek','pi'].includes(target.id);
 const desktopRestart=!!target.restartSupported&&['codex','qoder','workbuddy','workbuddy-ai','deepseek'].includes(target.id);
 const configurationSaved=(restarted=false,inApplication=false)=>{setRestartPending(desktopRestart&&!restarted);setRestartError('');setRestartOpen(desktopRestart&&!restarted&&!inApplication);};
 const [busy,setBusy]=useState(false);const lock=useRef(false);const [picking,setPicking]=useState(false);const [open,setOpen]=useState('');
 useEffect(()=>{if(target.id!=='codex'||!busy)return;let active=true;const timer=setInterval(()=>{void requestJSON<NonNullable<AgentTarget['threadMigration']>>('/api/a2a/codex-migration').then(value=>{if(active)setMigrationProgress(value);}).catch(()=>{});},1500);return ()=>{active=false;clearInterval(timer);};},[target.id,busy]);
 const rememberDetail=useListReturn(!!open);

 const [hidden,setHidden]=useState<string[]>(()=>{try{return JSON.parse(localStorage.getItem(hiddenKey(target.id))??'[]');}catch{return [];}});
 const hide=(next:string[])=>{setHidden(next);try{localStorage.setItem(hiddenKey(target.id),JSON.stringify(next));}catch{/* Hiding is cosmetic. */}};
 const available=sourceOptions(local);const running=local.state==='running';
 const connection=target.connection;
 const configurationChanged=!!connection&&!target.error&&['changed','missing'].includes(target.configurationState);
 const [roles,setRoles]=useState<{selections:Choice[];preferred?:Choice;confirmedTarget?:AgentTarget;defaultId:string;fastId:string}>();
 const [draftModels,setDraftModels]=useState<Choice[]>(()=>{try{const saved=JSON.parse(localStorage.getItem(`token-flow.agent.models.${target.id}`)??'[]');return Array.isArray(saved)?saved.filter(v=>typeof v?.model==='string'&&typeof v?.sourceId==='string'):[];}catch{return [];}});
 const [draftDirty,setDraftDirty]=useState(()=>{try{return localStorage.getItem(`token-flow.agent.models.pending.${target.id}`)==='true';}catch{return false;}});
 const saveDraft=(choices:Choice[],dirty=true)=>{setDraftModels(choices);setDraftDirty(dirty);try{localStorage.setItem(`token-flow.agent.models.${target.id}`,JSON.stringify(choices));localStorage.setItem(`token-flow.agent.models.pending.${target.id}`,String(dirty));}catch{}};

 const current=connection?{sourceId:connection.sourceId,model:connection.model}:undefined;
 const isCurrent=(choice:Choice)=>!!current&&current.sourceId===choice.sourceId&&current.model===choice.model;
 const models:Choice[]=draftDirty?draftModels:connection?.selections??(connection?[{sourceId:connection.sourceId,model:connection.model}]:draftModels.length?draftModels:target.backups.find(record=>record.selections)?.selections??[]);
 const unavailableModels=models.filter(choice=>sourceSelectionState(local,choice,available)==='unavailable');

 const visibleProblem=problem===unavailableSelectionMessage&&!unavailableModels.length?'':problem;
 const shownModels=orderModels(models,choice=>modelLabel(local,choice.model),modelOrder==='manual'?'manual':'name',modelRanks);const modelIds=shownModels.map(item=>item.model);
 const moveAgentModel=(from:string,to:string,items:readonly string[],after=false)=>{if(from===to||!items.includes(from)||!items.includes(to))return;moveModel(from,to,items,after);const ids=items.filter(id=>id!==from);ids.splice(ids.indexOf(to)+(after?1:0),0,from);saveDraft(ids.flatMap(id=>models.filter(choice=>choice.model===id)));};
 const accounts=(login?.accounts??[]).filter(account=>account.local||!hidden.includes(`account:${account.id}`));
 const hiddenCount=(login?.accounts.length??0)-accounts.length;
 const accountsPending=!!login&&((!login.status&&!login.error)||(!!local.accountsLoading||local.state==='starting')&&!!login.nativeLabel&&!login.nativeCurrent);
 const showAccounts=!!login&&(hasNativeLogin(login)||accountsPending);
 const accountRowsPending=accountsPending;
 // Statistics follow the Agent itself, even after its connection Key was replaced by a model switch.
 const rows=usage.combinedRows.filter(row=>row.target===target.id);
 const allAgentRows=usage.allRows.filter(row=>row.day===localDay(new Date())).filter(row=>row.target===target.id);

 const run=async(work:()=>Promise<string>,feedback?:'models'|'restart'|'program')=>{
  if(lock.current)return;lock.current=true;setBusy(true);
  if(feedback&&feedback!=='program')setModelApplication({phase:feedback==='models'?'applying':'restarting'});
  try{const text=await work();setExitMessage('');if(feedback&&feedback!=='program')setModelApplication({phase:'saved',message:text});else notify({kind:'ok',text});}
  catch(error){const code=(error as {code?:string}).code;const text=error instanceof Error?error.message:'操作失败';if(feedback==='program')setProgramError(text);else if(feedback){setExitMessage('');setModelApplication({phase:'error',message:text,code,retry:feedback});}else if(restoreOpen){setRestoreError({message:text,code});setExitMessage('');if(code!=='codex_migration_failed')setRestorePreview(undefined);}else if(code==='codex_exit_required')setExitMessage(text);else {setExitMessage('');notify({kind:'error',text});if(target.id==='codex'&&switching.current&&code==='codex_migration_failed')setHistoryOffer(text);}}
  finally{switching.current=false;try{await onChanged().catch(()=>{});await login?.refresh();}finally{lock.current=false;setBusy(false);}}
 };
 // The revision guard rejects the write if the config changed since it was read.
 const latest=async()=>{
  const next=(await requestJSON<{targets:AgentTarget[]}>('/api/a2a')).targets.find(item=>item.id===target.id);
  if(!next)throw new Error('找不到这个 Agent，请刷新。');
  return next;
 };
 const applySelected=(selections:Choice[],preferred?:Choice)=>{
  if(!(target.installation.configurationSupported??(target.id==='claude'||target.installation.installed))){pendingSelection.current={selections,preferred};askProgram('install');return;}
  if(target.id==='codex'){setGatewayConfirm({selections,preferred,coexist:connection?.codexDirectHybrid||connection?.codexCoexist||!connection});return;}
  return connectSelected(selections,preferred);
 };
 const changeCodex=(work:(restartCodex:boolean)=>Promise<string>,approved=false,configurationOnly=false,inApplication=false):Promise<void>|void=>{
  const automatic=target.id==='codex'&&desktopRestart;
  retryMigration.current=()=>changeCodex(work,true,configurationOnly,inApplication);
  if(automatic&&!approved){setExitMessage(configurationOnly?'将自动退出 Codex，恢复账号或接口配置后重新打开。保留对话内容，并同步旧对话的模型来源。':'将自动退出 Codex 并应用更改，完成后重新打开。已有备份会保留，仅在需要处理新对话时追加备份。');return;}
  setHistoryOffer('');setMigrationProgress(undefined);switching.current=true;
  return run(()=>work(automatic&&approved),inApplication?'models':undefined);
 };
 const connectSelected=(selections:Choice[],preferred?:Choice,confirmedTarget?:AgentTarget,fast?:Choice,coexist=false)=>{
  if(target.id==='claude'&&selections.length>1&&!fast){
   const fallback=preferred??selections.find(item=>isCurrent(item))??selections[0];
   if(!fallback)return;
   const known=selections.find(item=>item.model===connection?.fastModel)??fallback;
   setRoles({selections,preferred,confirmedTarget,defaultId:choiceId(fallback),fastId:choiceId(known)});return;
  }
  saveDraft(selections,true);
  retryApplication.current=()=>connectSelected(selections,preferred,confirmedTarget,fast,coexist);
  return changeCodex(async restartCodex=>{
  const choice=preferred??selections.find(item=>isCurrent(item))??selections[0];
  if(!choice)throw new Error('请至少选择一个模型。');
  saveDraft(selections,true);
  // Starting explicitly replaces current routing; still reject edits made during this write.
  const next=await latest();
  const result=await requestJSON<{recovery?:{message:string}}>('/api/a2a/connect',post({allowRunning:true,restartCodex,target:target.id,...(target.id==='codex'?{codexCoexist:coexist,codexDirectHybrid:false}:{}),selections,sourceId:choice.sourceId,model:choice.model,...(fast?{fastSourceId:fast.sourceId,fastModel:fast.model}:{}),revision:next.revision,...(next.connection?{replaceId:next.connection.id}:{}),...(next.connection?{rewrite:true}:{}),tokenLimit:null}),600000);
  saveDraft(selections,false);configurationSaved(restartCodex,true);
  if(hidden.includes(choiceId(choice)))hide(hidden.filter(id=>id!==choiceId(choice)));
  const label=modelLabel(local,choice.model);
  const menu=target.id==='qoder'||target.id==='workbuddy'||target.id==='workbuddy-ai'?`，在它的模型菜单里选 ${label}`:'';
  if(target.id==='claude')return `${target.name} 已导入 ${selections.length} 个模型，默认 ${label}${fast&&fast.model!==choice.model?`，快速模型 ${modelLabel(local,fast.model)}`:''}。下次启动时加载配置，可用 /model 选择模型。子代理跟随当前会话。`;
  if(target.id==='pi')return `${target.name} 已导入 ${selections.length} 个模型，下次启动时加载配置，可用 /model 选择模型。`;
  if(target.id==='deepseek')return `DeepSeek Harness 桌面版已导入 ${selections.length} 个模型，默认 ${label}；重新打开应用后生效。`;
  if(target.id==='codex'&&coexist)return '统一网关已配置。官方登录保留，官方使用原生压缩；网关模型标有 TokenFlow 并排列在官方模型之后。所有模型使用时请保持 TokenFlow 运行。';
  if(result.recovery)return `${target.name} 已配置 ${selections.length} 个模型，默认 ${label}。${result.recovery.message}${restartCodex?'已重新打开 Codex。':''}`;
  if(restartCodex)return `Codex 已切为网关模式，默认 ${label}。官方登录保留，对话来源已同步并重新打开。`;
  return `${target.name} 已配置 ${selections.length} 个模型，默认 ${label}。重启后可在 Agent 内切换${menu}。`;
 },target.id==='codex'||!!confirmedTarget,false,true);};
 const loadRestorePreview=async()=>{
  const version=++restoreRead.current;setRestoreLoading(true);setRestorePreview(undefined);setRestoreError(undefined);
  try{
   if(!connection)throw new Error('接入记录已变化，请刷新后重试。');
   const preview=await requestJSON<Awaited<ReturnType<AgentConnections['restorePreview']>>>(`/api/a2a/restore-preview/${connection.id}`);
   if(version===restoreRead.current)setRestorePreview(preview);
  }catch(error){if(version===restoreRead.current)setRestoreError({message:error instanceof Error?error.message:'无法读取恢复目标，请重试。'});}
  finally{if(version===restoreRead.current)setRestoreLoading(false);}
 };
 const openRestore=()=>{setHistoryOffer('');setRestoreOpen(true);void loadRestorePreview();};
 const closeRestore=()=>{restoreRead.current++;setRestoreOpen(false);setRestoreLoading(false);};
 const restore=(promptRestart=true,history=false,approved=false)=>changeCodex(async restartCodex=>{
  setRestoreError(undefined);
  const preview=target.id==='codex'?restorePreview:undefined;
  if(target.id==='codex'&&!preview?.canRestore)throw new Error('请先重新检查恢复目标。');
  const next=preview?undefined:await latest();
  const id=preview?.id??next?.connection?.id;
  if(!id)throw new Error('接入记录已变化，请刷新后重试。');
  await requestJSON('/api/a2a/restore',post({id,revision:preview?.revision??next!.revision,allowRunning:true,restartCodex,restoreHistory:history}),600000);
  setRestoreOpen(false);saveDraft(models,false);if(promptRestart||restartCodex)configurationSaved(restartCodex);else setRestartPending(desktopRestart);
  return restartCodex?'Codex 已切为官方直连并重新打开。官方对话不再依赖 TokenFlow，网关模型选择和备份保留。':insertedGateway?`${target.name} 已移除 TokenFlow 网关模型，其他 API 配置保留，${desktopRestart?'重启':'下次启动'}后生效。`:`${target.name} 已切回官方服务，${desktopRestart?'重启':'下次启动'}后生效。`;
 },approved,!history);
 const repairHistory=()=>onRepair({target:'codex',...(connection?{sourceId:connection.sourceId,model:connection.model,connectionId:connection.id}:{})},'codex-history');
 const restart=(inApplication=false)=>run(async()=>{
  setRestartError('');
  const result=await requestJSON<{message:string}>('/api/a2a/restart',post({target:target.id}),60000).catch(error=>{setRestartError(error instanceof Error?error.message:'重启失败');throw error;});
  setRestartPending(false);setRestartOpen(false);
  return result.message;
 },inApplication?'restart':undefined);
 const applying=modelApplication?.phase==='applying';
 const applicationWorking=applying||modelApplication?.phase==='restarting';
 const applicationStage=modelApplication?.phase==='restarting'?`正在重新打开 ${target.name}…`:target.id!=='codex'?`正在为 ${target.name} 应用模型配置…`:codexMigrationStage(migrationProgress);
 const officialConfirm=useOfficialLoginConfirm();
 const desktopOfficial=target.id==='workbuddy'||target.id==='workbuddy-ai'||target.id==='qoder';
 const restoreOfficial=async()=>{if(!await officialConfirm.confirm(target.id==='claude'?'Claude Code 终端':target.name,true))return;return run(async()=>{await login!.restore();setRestartPending(false);return `${target.name} 已恢复切换前登录并重新打开，请确认登录状态。`;});};
 const switchAccount=async(id:string,label:string)=>{const chosen=login?.accounts.find(account=>account.id===id);if(chosen&&officialLoginHeld(target.id,chosen.local,chosen.current))return;if(desktopOfficial||target.id==='claude'){if(!await officialConfirm.confirm(target.id==='claude'?'Claude Code 终端':target.name))return;return run(async()=>{const note=await login!.switchTo(id);setRestartPending(false);return `${target.name} 已保存账号 ${label}。${note}`;});}return changeCodex(async restartCodex=>{const note=await login!.switchTo(id,restartCodex);configurationSaved(restartCodex);return `${target.name} 已切换到账号 ${label}。${restartCodex?'Codex 已自动重新打开。':`${desktopRestart?'重启':'下次启动'}后生效。`}${note}`;},false,false);};
 const repair=()=>onRepair({target:target.id,...(connection?{sourceId:connection.sourceId,model:connection.model,connectionId:connection.id}:{})});
 const toggleDetail=(id:string)=>{if(open!==id)rememberDetail();setOpen(open===id?'':id);};


 const manageProgram=(action=programAction)=>run(async()=>{
  setProgramError('');
  const result=await requestJSON<{message:string;installation:AgentInstallation}>('/api/a2a/program',post({target:target.id,action}),195000);
  programCompleted.current=true;setProgramOpen(false);
  await onProgramChanged();
  return result.message;
 },'program');
 useEffect(()=>{if(!busy&&target.installation.installed&&pendingSelection.current){const pending=pendingSelection.current;pendingSelection.current=undefined;void applySelected(pending.selections,pending.preferred);}},[busy,target.installation.installed]);
 return <section className={`tfPanel${target.id==='workbuddy'||target.id==='workbuddy-ai'?' tfWorkBuddyPanel':''}`} aria-label={target.name}>
  <header className="tfPanelHead">
   <ProviderIcon provider={target.id} size={40}/>
   <div><div className="tfAgentTitle"><h2>{target.name}</h2>{clientSwitch}<button className="tfAgentUpdate" disabled={busy} aria-label={`${target.installation.installed?'更新':'安装'} ${target.name}`} title={updateAvailable?`有新版本 ${update.latestVersion}，点击更新`:target.installation.installed?'下载最新版':'安装官方客户端'} onClick={()=>askProgram(target.installation.installed?'update':'install')}><Icon name="download" size={15}/>{updateAvailable&&<span className="tfUpdateDot" role="img" aria-label="有可用更新"/>}</button>{target.installation.installed&&<span className="tfAgentVersion">已安装{target.installation.version?` · ${target.installation.version}`:''}{target.installation.channel==='npm'?' · npm':target.installation.channel==='application'?' · 桌面应用':''}</span>}</div><UsageFold loaded={usage.loaded} error={usage.error} onRetry={usage.reload} title={`${target.name} 用量`} rows={allAgentRows} range="today"/></div>
   <div className="tfRow">
    {!models.length&&!(login&&hasNativeLogin(login))&&<button type="button" className="iconButton" aria-label="选择模型" title="选择模型" disabled={busy||!running||!!target.error||!available.length} onClick={()=>setPicking(true)}><Icon name="plus" size={16}/></button>}
    {desktopRestart&&<button type="button" className="textButton" disabled={busy||!target.installation.installed} onClick={()=>{setRestartError('');setRestartOpen(true);}}>{restartPending?'重启生效':'重启…'}</button>}
    {connection&&!insertedGateway&&target.id!=='codex'&&<button type="button" disabled={busy} onClick={()=>void restore()}>切回官方</button>}
    {!!problem&&<button type="button" className="primary" disabled={busy} onClick={repair}>维修</button>}
   </div>
  </header>
  {target.id==='codex'&&<CodexRoutingMode busy={busy} canRestore={!!connection} onOfficial={openRestore}/>}
  <FlowDialog className="tfRestartDialog tfRestoreConfigDialog" open={!!gatewayConfirm} title="应用网关模型" busy={busy} showBusyIndicator={false} onClose={()=>setGatewayConfirm(undefined)}>
   <p>已选 {gatewayConfirm?.selections.length??0} 个网关模型。</p>
   <label className="toggle"><input type="checkbox" checked={!!gatewayConfirm?.coexist} disabled={busy} onChange={event=>setGatewayConfirm(value=>value?{...value,coexist:event.target.checked}:value)}/> 同时使用官方账号模型</label>
   <p className="tfHint">{gatewayConfirm?.coexist?'官方模型保留在列表上方，TokenFlow 模型排在后面。':'模型列表仅显示所选网关模型，官方登录保留。'} 使用时需保持 TokenFlow 运行。</p>
   <p className="tfHint">{desktopRestart?'应用后将备份配置并重启 Codex，请先结束正在进行的任务。':'请完全退出 Codex 后应用，完成后重新打开。'}</p>
   <footer><button disabled={busy} onClick={()=>setGatewayConfirm(undefined)}>取消</button><button className="primary" disabled={busy||!gatewayConfirm?.selections.length} onClick={()=>{const selected=gatewayConfirm;if(!selected)return;setGatewayConfirm(undefined);void connectSelected(selected.selections,selected.preferred,undefined,undefined,!!selected.coexist);}}>{desktopRestart?'应用并重启 Codex':'已退出，应用配置'}</button></footer>
  </FlowDialog>
  <FlowDialog className="tfRestartDialog tfRestoreConfigDialog" open={restoreOpen} title="切换为官方直连" busy={busy} showBusyIndicator={false} onClose={closeRestore}>
   <p className="tfDialogLead">{restoreBlocked?'暂时无法切回官方服务，请检查下方原因。':'停用 TokenFlow 网关，直接使用 Codex 官方接口和默认模型。'}</p>
   {restoreLoading&&<p className="tfHint" role="status">正在检查当前配置和恢复目标…</p>}

   {restorePreview?.canRestore&&!restoreError&&<p className="tfHint">{restorePreview.recovery?restorePreview.recovery.message:'保留官方登录与备份，将网关上下文转换为官方可读的历史。之后由官方原生压缩，TokenFlow 只统计用量。'}</p>}
   {restorePreview&&!restorePreview.canRestore&&<p className="tfError" role="alert">{restorePreview.reason} 当前配置尚未修改。</p>}
   {restoreError&&<p className="tfError" role="alert">{restoreError.message}</p>}
   {restoreError?.code==='codex_migration_failed'&&<button type="button" className="textButton" disabled={busy} onClick={()=>{closeRestore();repairHistory();}}>检查对话来源</button>}
   {busy?<p className="tfHint" role="status">{migrationProgress?.lifecyclePhase==='stopping'?'正在退出 Codex…':migrationProgress?.lifecyclePhase==='opening'?'已切回官方，正在重新打开 Codex…':migrationProgress?.phase==='backup'?'正在备份受影响的对话…':migrationProgress?.phase==='restoring'?`正在同步对话来源 ${migrationProgress.done} / ${migrationProgress.total}…`:'正在准备切回官方服务，请稍候…'}</p>:desktopRestart&&restorePreview?.canRestore&&!restoreError&&<p className="tfHint">确认后会退出并重新打开 Codex，请先保存正在进行的工作。</p>}
   {restoreBlocked&&desktopRestart&&<p className="tfHint">如需让 Codex 重新加载当前已保存的配置，可以单独重启。重启不会恢复备份、修改登录账号或处理对话，也不会解决配置冲突。</p>}
   <footer><button disabled={busy} onClick={closeRestore}>取消</button>{(restoreError||restorePreview&&!restorePreview.canRestore)&&<button disabled={busy||restoreLoading} onClick={()=>void loadRestorePreview()}>重新检查</button>}{!restoreBlocked&&<button className="primary" disabled={busy||restoreLoading||!restorePreview?.canRestore} onClick={()=>void restore(true,true,true)}>{busy?'正在切换…':desktopRestart?'切为官方直连并重启':'切为官方直连'}</button>}{restoreBlocked&&desktopRestart&&<button className="primary" disabled={busy||restoreLoading||!target.installation.installed} onClick={()=>{closeRestore();setRestartError('');setRestartOpen(true);}}>使用当前配置重启…</button>}</footer>
  </FlowDialog>
  <FlowDialog className="tfRestartDialog" open={!modelApplication&&(!!exitMessage||busy&&switching.current&&target.id==='codex'&&!restoreOpen)} title={desktopRestart?'重启 Codex 并应用更改':'先退出 Codex，保留旧对话'} onClose={()=>setExitMessage('')} busy={busy} showBusyIndicator={false}>
   {busy?<div className="tfMigrationProgress" aria-busy="true">
    <Thinking label="正在应用 Codex 更改"/>
    <p className="tfMigrationStage" role="status">{codexMigrationStage(migrationProgress)}</p>
    {!!migrationProgress?.total&&migrationProgress.lifecyclePhase!=='stopping'&&migrationProgress.lifecyclePhase!=='opening'&&migrationProgress.phase!=='idle'&&<progress max={migrationProgress.total} value={migrationProgress.done} aria-label="旧对话处理进度"/>}

   </div>:<>
    <p className="tfDialogLead">{exitMessage}</p>
    <p className="tfHint">{desktopRestart?'请先保存工作。确认后会尝试退出 Codex，确认退出后才应用更改并重新打开。若无法退出，请按提示手动处理。':'请完全退出 Codex 后继续。'}</p>
    <footer><button onClick={()=>setExitMessage('')}>稍后再说</button><button className="primary" onClick={()=>void retryMigration.current()}>{desktopRestart?'确认并自动重启':'已退出，继续'}</button></footer>
   </>}
  </FlowDialog>
  {!target.installation.installed&&<p className="tfHint" role="status">{target.installation.supported===false?target.installation.reason:target.id==='claude'?'未检测到独立 Claude CLI；仍可为本机 VS Code 扩展应用共享配置。':'未检测到程序，选择模型时会提示安装。'}</p>}
  <FlowDialog className="tfRestartDialog tfProgramDialog" open={programOpen} title={`${programAction==='install'?'安装':'更新'} ${target.name}`} busy={busy} onClose={()=>{setProgramOpen(false);if(!programCompleted.current)pendingSelection.current=undefined;}}>
   <p className="tfDialogLead">{target.installation.supported===false?target.installation.reason:target.installation.automatic?`将通过 npm 官方包${programAction==='install'?'下载并安装':'更新'} ${target.name}。配置和接入备份会保留。`:`将打开 ${target.name} 的官方下载页面，安装完成后会自动识别。`}</p>
   {programAction==='update'&&<p className="tfHint">请先保存工作并退出此 Agent。</p>}
   {busy&&<p className="tfHint" role="status">正在执行安装并检查程序，请稍候…</p>}
   {programError&&<p className="tfError" role="alert">{programError}</p>}
   <footer><button disabled={busy} onClick={()=>{setProgramOpen(false);pendingSelection.current=undefined;}}>稍后再说</button><button className="primary" disabled={busy} onClick={()=>void manageProgram()}>{busy?'正在处理…':target.installation.automatic?programAction==='install'?'下载安装':'更新到最新版本':'打开官方下载页面'}</button></footer>
  </FlowDialog>
  {visibleProblem&&<p className="tfProblem" role="status">{visibleProblem}{configurationChanged&&<button type="button" className="textButton" disabled={busy||!running||!models.length} onClick={()=>void applySelected(shownModels)}>重新应用</button>}{problem===unavailableSelectionMessage&&<button type="button" className="textButton" disabled={busy} onClick={()=>{saveDraft(models.filter(choice=>sourceSelectionState(local,choice,available)!=='unavailable'));setOpen('');}}>移除不可用模型（{unavailableModels.length}）</button>}</p>}
  <FlowDialog className="tfRestartDialog" open={!!historyOffer} title="对话来源处理未完成" busy={busy} onClose={()=>setHistoryOffer('')}>
   <p className="tfDialogLead">{historyOffer}</p>
   <p className="tfHint">切换在检查或同步对话来源时停止。请先检查受影响的对话，再决定是否需要修复。</p>
   <footer><button disabled={busy} onClick={()=>setHistoryOffer('')}>暂不处理</button><button className="primary" disabled={busy} onClick={()=>{setHistoryOffer('');repairHistory();}}>检查旧对话</button></footer>
  </FlowDialog>
  <FlowDialog className="tfRestartDialog" open={!!roles} title="应用 Claude Code 模型" busy={busy} onClose={()=>setRoles(undefined)}>
   <p className="tfDialogLead">默认模型用于会话和子代理，快速模型用于审批和快速请求。</p>
   <label>默认模型<select aria-label="默认模型" value={roles?.defaultId??''} onChange={event=>setRoles(current=>current&&{...current,defaultId:event.target.value})}>{roles?.selections.map(item=><option key={choiceId(item)} value={choiceId(item)}>{modelLabel(local,item.model)}</option>)}</select></label>
   <label>快速模型<select aria-label="快速模型" value={roles?.fastId??''} onChange={event=>setRoles(current=>current&&{...current,fastId:event.target.value})}>{roles?.selections.map(item=><option key={choiceId(item)} value={choiceId(item)}>{modelLabel(local,item.model)}</option>)}</select></label>
   <footer><button disabled={busy} onClick={()=>setRoles(undefined)}>取消</button><button className="primary" disabled={busy||!roles} onClick={()=>{if(!roles?.selections[0])return;const fallback=roles.selections[0];const defaultChoice=roles.selections.find(item=>choiceId(item)===roles.defaultId)??fallback;const fastChoice=roles.selections.find(item=>choiceId(item)===roles.fastId)??defaultChoice;const ordered=[defaultChoice,...roles.selections.filter(item=>choiceId(item)!==choiceId(defaultChoice))];const confirmed=roles.confirmedTarget;setRoles(undefined);void connectSelected(ordered,defaultChoice,confirmed,fastChoice);}}>应用</button></footer>
  </FlowDialog>
  <FlowDialog className="tfRestartDialog tfModelApplyDialog" open={!!modelApplication} title={applicationWorking?`应用 ${target.name} 模型`:modelApplication?.phase==='error'?'操作未完成':restartPending?'配置已保存，现在生效？':'模型已应用'} busy={busy} showBusyIndicator={false} onClose={()=>setModelApplication(undefined)}>
   <div className="tfModelApplyBody">
    {applicationWorking?<div className="tfMigrationProgress" aria-busy="true">
     <Thinking label={applicationStage}/><p className="tfMigrationStage" role="status">{applicationStage}</p>
     {applying&&target.id==='codex'&&!!migrationProgress?.total&&migrationProgress.lifecyclePhase!=='stopping'&&migrationProgress.lifecyclePhase!=='opening'&&migrationProgress.phase!=='idle'&&<progress max={migrationProgress.total} value={migrationProgress.done} aria-label="旧对话处理进度"/>}
    </div>:<>
     <p className={modelApplication?.phase==='error'?'tfError':'tfDialogLead'} role={modelApplication?.phase==='error'?'alert':'status'}>{modelApplication?.message}</p>
     {modelApplication?.phase==='saved'&&restartPending&&<p className="tfHint">请先保存工作并结束生成。你也可以稍后从 Agent 标题旁重启。</p>}
    </>}
   </div>
   <footer>
    {!applicationWorking&&<button disabled={busy} onClick={()=>setModelApplication(undefined)}>{restartPending?'稍后再说':'关闭'}</button>}
    {modelApplication?.phase==='saved'&&restartPending&&<button className="primary" disabled={busy||!target.installation.installed} onClick={()=>void restart(true)}>立即重启</button>}
    {modelApplication?.phase==='error'&&(modelApplication.code==='codex_migration_failed'?<button className="primary" disabled={busy} onClick={()=>{setModelApplication(undefined);repairHistory();}}>检查旧对话</button>:<button className="primary" disabled={busy} onClick={()=>void (modelApplication.retry==='restart'?restart(true):modelApplication.code==='codex_exit_required'?retryMigration.current():retryApplication.current())}>{modelApplication.retry==='restart'?'重试重启':modelApplication.code==='codex_exit_required'?'已退出，继续':'重新应用'}</button>)}
   </footer>
  </FlowDialog>
  <FlowDialog className="tfRestartDialog" open={desktopRestart&&restartOpen} title={restartPending?'配置已保存，现在生效？':`重启 ${target.name}`} onClose={()=>setRestartOpen(false)} busy={busy}>
   <p className="tfDialogLead">{restartPending?`重新打开 ${target.name} 后，会加载新的模型与账号配置。`:`重新打开 ${target.name}，加载已保存的配置。`}</p>
   <p className="tfHint">{target.id==='codex'?'请先保存工作。确认后会尝试退出 Codex，再重新打开。若仍有运行中的任务或退出提示，请按提示手动处理。':'请先保存工作并结束生成。你也可以稍后从 Agent 标题旁重启。'}</p>
   {target.id==='codex'&&<p className="tfHint">此次重启只加载当前已保存的配置，不会恢复备份、修改登录账号或处理对话。</p>}
   {restartError&&<p className="tfError" role="alert">{restartError}</p>}
   <footer><button disabled={busy} onClick={()=>setRestartOpen(false)}>稍后再说</button><button className="primary" disabled={busy||!target.installation.installed} onClick={()=>void restart()}>{busy?'正在处理…':'立即重启'}</button></footer>
  </FlowDialog>
  {!running&&!local.accountsLoading&&<p className="tfHint">网关未运行，暂时不能切换模型。</p>}
  {officialConfirm.dialog}

  <div className={`tfAgentColumns${showAccounts&&models.length?' hasLogin':''}`}>
  {login&&showAccounts&&<section className="tfAgentSection tfOfficialAccounts" aria-label="官方登录账号">
   <header className="tfAgentSectionHead"><div className="tfGatewayTitle"><h3>官方登录账号</h3>{!models.length&&<button type="button" className="iconButton" aria-label="添加模型" title="添加模型" disabled={busy||!running||!!target.error||!available.length} onClick={()=>setPicking(true)}><Icon name="plus" size={16}/></button>}</div><NativeLoginStatus name={target.name} login={login} onRefresh={onRefreshAccounts}>{(desktopOfficial||target.id==='claude')&&login.status?.backup&&<button className="textButton" disabled={busy} onClick={()=>void restoreOfficial()}>恢复原登录</button>}</NativeLoginStatus></header>
  <ul className="tfLines" aria-label={`${target.name} 官方登录账号`}>
   {accountRowsPending?Array.from({length:Math.max(1,accounts.length)},(_,index)=><AgentAccountSkeleton key={index} provider={target.id}/>):<UnpooledNativeAccount provider={target.id} login={login}/>}
   {!accountRowsPending&&accounts.map(account=>{
    const id=`account:${account.id}`;const quota=local.quotas[account.id];
    return <li key={id} className={account.current?'on':''}>
     <div className="tfLine">
      <button className="tfLineMain" aria-pressed={account.current} disabled={busy||officialLoginHeld(target.id,account.local,account.current)||!account.switchable} title={account.switchable?undefined:account.reason} onClick={()=>void switchAccount(account.id,account.label)}>
       <OfficialAccountIdentity provider={target.id} account={account} codexCoexist={login.status?.codexCoexist}/>
      </button>
      <span className="tfActions">
       <button className="textButton" aria-expanded={open===id} aria-controls={`quota-${target.id}-${account.id}`} onClick={()=>toggleDetail(id)}>{open===id?'收起':'详情'}</button>
       <button className="textButton danger" disabled={account.local} title={account.local?'正在使用，不能删除':'从这里移除，账号本身保留'} onClick={()=>hide([...hidden,id])}>删除</button>
      </span>
     </div>
     {open===id&&<div id={`quota-${target.id}-${account.id}`} className="tfAccountQuotaExpanded">{quota?<QuotaDetails quota={quota} label={account.label} compact concise/>:<span>额度暂未提供</span>}</div>}
    </li>;
   })}
  </ul>
  {hiddenCount>0&&<button className="textButton" onClick={()=>hide([])}>恢复已删除的 {hiddenCount} 项</button>}
  </section>}
  {showAccounts&&models.length>0&&<ColumnDivider storageKey="token-flow.layout.agent-split" label="调整账号与网关模型宽度"/>}
  {models.length>0&&<section className="tfAgentSection tfGatewaySection" aria-label="网关模型">
   <header className="tfAgentSectionHead"><div className="tfGatewayTitle"><h3>网关模型</h3><button className="iconButton" aria-label={models.length?'管理所选模型':'选择模型'} title={models.length?'管理所选模型':'选择模型'} disabled={busy||!running||!!target.error||(!available.length&&!models.length)} onClick={()=>setPicking(true)}><Icon name="plus" size={16}/></button>{draftDirty&&<small className="tfPendingModels">待应用</small>}</div>{target.id!=='codex'&&<label className="toggle"><input type="checkbox" role="switch" aria-label="启用网关模型" checked={gatewayPending??(!!connection&&target.configurationState==='configured'&&!draftDirty)} disabled={busy||!running||(!connection&&!models.length)} onChange={event=>{const enabled=event.target.checked;if(!enabled)saveDraft(models);setGatewayPending(enabled);void Promise.resolve(enabled?applySelected(shownModels):restore(false)).finally(()=>setGatewayPending(undefined));}}/><span>启动</span></label>}</header>
   {target.id==='claude'&&<p className="tfHint">自定义模型菜单需要 Claude Code 2.1.242 或更新版本；旧版可用 /model 模型ID 切换。接入多个模型时选择默认模型和快速模型。子代理跟随当前会话；审批和快速请求使用快速模型。IDE 与终端共享此登录配置。</p>}
  <ul className="tfLines" aria-label={`${target.name} 网关模型`}>
   {shownModels.map(choice=>{
    const pending=sourceSelectionState(local,choice,available)==='loading';
    const namePending=pending&&!local.models.some(model=>model.id===choice.model)&&!choice.model.startsWith('api-');
    const sourcePending=pending&&!sourceLabel(local,choice.sourceId);
    const id=choiceId(choice);const on=isCurrent(choice);const fastOn=target.id==='claude'&&!!connection?.fastModel&&connection.fastModel!==connection.model&&choice.model===connection.fastModel&&target.configurationState==='configured'&&!draftDirty;
    const used=totalsOf(rows.filter(row=>row.model===choice.model&&(!row.sourceId||row.sourceId===choice.sourceId)));
    return <li key={id} className={`tfDragRow ${on?'on':''}`} {...dropOrder('models',choice.model,modelIds,moveAgentModel)}>
     <div className="tfLine">
      <DragHandle kind="models" id={choice.model} label={modelLabel(local,choice.model)} items={modelIds} move={moveAgentModel}/>
      <div className="tfLineMain tfModelCardMain">
       <ProviderIcon provider={modelManufacturer(choice.model,local)} size={28}/>
       <span className="tfRowText"><strong title={namePending?undefined:modelLabel(local,choice.model)}>{namePending?<AgentFieldSkeleton/>:modelLabel(local,choice.model)}</strong><small>{sourcePending?<AgentFieldSkeleton short/>:<>{sourceLabel(local,choice.sourceId)}{used.requests?` · ${compactTokens(used.totalTokens)} tokens`:''}</>}</small></span>
       {on&&target.configurationState==='configured'&&<b className="tfUsing">{target.id==='pi'?'已导入':'默认模型'}</b>}{fastOn&&<b className="tfUsing">快速模型</b>}
      </div>
      <span className="tfActions">
       <button className="textButton" onClick={()=>toggleDetail(id)}>{open===id?'收起':'详情'}</button>
       <button className="textButton danger" disabled={busy||models.length===1} title={models.length===1?'至少保留一个模型，或停用网关':'从 Agent 的模型菜单移除'} onClick={()=>{const next=models.filter(item=>choiceId(item)!==id);saveDraft(next);if(open===id)setOpen('');}}>移除</button>
      </span>
     </div>
     {open===id&&<div className="tfUsage">
      <strong>Token 使用（{rangeLabel(usage.range)}）</strong>
      <span>{used.requests?`${formatTokens(used.requests)} 次请求${used.failed?`（${formatTokens(used.failed)} 次失败）`:''} · ${formatTokens(used.totalTokens)} tokens`:'这段时间还没有请求'}</span>
      {used.requests>0&&<span>未缓存输入 {formatTokens(used.uncachedTokens)} · 缓存读取 {formatTokens(used.cachedTokens)}（命中 {percentText(used.hitRate)}） · 输出 {formatTokens(used.outputTokens)}{used.last?` · 最近 ${new Date(used.last).toLocaleString()}`:''}</span>}
      <small>{modelLabel(local,choice.model)} · {sourceLabel(local,choice.sourceId)}</small>
     </div>}
    </li>;
   })}
  </ul>

  </section>}
  </div>
  <AgentUsageDetails target={target.id} local={local} usage={usage}/>
  <AgentModelPicker open={picking} title={`${target.name} 使用的模型`} local={local} current={current} selected={models} onConfirm={choices=>{saveDraft(choices);void applySelected(choices);}} onClose={()=>setPicking(false)}/>
 </section>;
}
