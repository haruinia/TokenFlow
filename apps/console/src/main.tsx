import type {MaintenanceContext} from '../../../packages/core/src/maintenance-conversations';
import {Thinking,LoadingSkeleton,LoadError} from './LoadingState';
import {SidebarDivider} from './SidebarDivider';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';
import type { MaintenanceChain } from '../../../packages/core/src/gateway-maintenance';
import { requestJSON } from './request';
import { notifyNativeLoginChanged } from './native-login';
import { visibleLocalAgent } from './provider-visibility';
import { Icon, type IconName } from './Icons';
import { ApiInflow } from './ApiInflow';
import { AgentsPage, savedAgentTab } from './AgentsPage';
import { AccountsPage, type AccountActions } from './AccountsPage';
import { KeyOutflow } from './KeyOutflow';
import { ActivityPane } from './ActivityPane';
import {UsageOverview} from './UsageOverview';
import { SettingsPane } from './SettingsPane';
import { FileCleanupPane } from './FileCleanupPane';
import { ConversationContinue, ToolboxTools, type ToolboxTool } from './ConversationHandoff';
import { RepairChat, type RepairSession } from './RepairChat';
import type { RepairPage } from './repair-context';
import { useGatewayOverview } from './gateway-overview';
import { useUsage } from './usage-data';
import type { Notice } from './notify';
import {Notifications} from './Notifications';
import './style.css';
import './flow.css';
import './kapian.css';
import './graphite.css';
import './refinement.css';
import './page-layout.css';

type View='accounts'|'apis'|'agents'|'proxy'|'activity'|'usage'|'toolbox'|'settings';
const empty:LocalAgentSnapshot={state:'stopped',loginState:'idle',port:8317,logs:[],accounts:[],models:[],accountError:undefined,lastError:undefined,quotas:{},quotaBusy:false,providers:[],login:undefined};
const post=(body:unknown={})=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const gatewayText:Record<string,string>={stopped:'网关已停止',starting:'网关启动中…',stopping:'网关停止中…',failed:'网关启动失败'};
const saved:[View,string,IconName][]=[['accounts','账号授权','user'],['apis','API 接口','plug']];
const used:[View,string,IconName][]=[['agents','本地 Agent','model'],['proxy','API 代理','key']];
const secondary:[View,string,IconName][]=[['usage','用量总览','tokens'],['activity','活动','history'],['toolbox','工具箱','briefcase'],['settings','设置','sliders']];

function App(){
 const [view,setView]=useState<View>('agents');
 const [tool,setTool]=useState<ToolboxTool>('cleanup');
 const [repairPage,setRepairPage]=useState<RepairPage>('agents');
 const repairAside=useRef<RepairPage>('agents');
 const [pageSelections,setPageSelections]=useState<Partial<Record<RepairPage,MaintenanceContext>>>({});
 const setPageContext=useCallback((context:MaintenanceContext)=>setPageSelections(current=>({...current,[context.page]:context})),[]);
 const [theme,setTheme]=useState<'dark'|'light'>(()=>{try{return localStorage.getItem('token-flow.appearance')==='light'?'light':'dark';}catch{return 'dark';}});
 useEffect(()=>{document.documentElement.dataset.theme=theme;document.querySelector('meta[name=theme-color]')?.setAttribute('content',theme==='dark'?'#161719':'#f7f9fc');try{localStorage.setItem('token-flow.appearance',theme);}catch{}
  const desktop=(window as Window&{desktop?:{platform:string;setTheme?:(theme:'dark'|'light')=>Promise<void>}}).desktop;
  document.documentElement.dataset.platform=desktop?.platform??'browser';void desktop?.setTheme?.(theme).catch(()=>{});
 },[theme]);
 const [local,setLocal]=useState<LocalAgentSnapshot>(empty);
 const [localLoaded,setLocalLoaded]=useState(false),[localError,setLocalError]=useState('');
 const [notice,setNotice]=useState<Notice>();
 const [busy,setBusy]=useState(false);const lock=useRef(false);
 const [repair,setRepair]=useState<RepairSession>();const [repairOpen,setRepairOpen]=useState(false);
 const [selectedAgent,setSelectedAgent]=useState(savedAgentTab);
 const [accountContext,setAccountContext]=useState<{provider?:string;sourceId?:string}>({});
 const [warnings,setWarnings]=useState<string[]>([]);
 const overview=useGatewayOverview();
 const usage=useUsage(view!=='settings'&&view!=='toolbox');
 const firstLoad=useRef(true);

 const refresh=useCallback(async()=>{
  let next:LocalAgentSnapshot;
  try{next=visibleLocalAgent(await requestJSON<LocalAgentSnapshot>('/api/local-agent'));setLocal(next);setLocalLoaded(true);setLocalError('');}
  catch(error){setLocalError('暂时无法获取账号与模型信息，请检查连接后重新加载。');throw error;}
  // Nothing to use yet: start where models are added.
  if(firstLoad.current&&next.state==='running'&&!next.accountsLoading){firstLoad.current=false;if(!next.models.length)setView('accounts');}
 },[]);
 useEffect(()=>{
  void refresh().catch(()=>{});
  void requestJSON<{credentialWarnings?:string[]}>('/api/settings').then(s=>setWarnings(s.credentialWarnings??[])).catch(()=>{});
 },[refresh]);
 // Only follow an in-progress operation; stop on completion or a read failure.
 useEffect(()=>{
  const pending=local.login&&['starting','waiting_for_browser','verifying'].includes(local.login.status);
  if(localError||!pending&&!local.accountsLoading&&!local.quotaBusy&&!['starting','stopping'].includes(local.state))return;
  const timer=setTimeout(()=>void refresh().catch(()=>{}),1500);return()=>clearTimeout(timer);
 },[local,localError,refresh]);
 const previousLoginStatus=useRef<string|undefined>(undefined);
 const previousAccountsLoading=useRef(false);
 const accountIDs=local.accounts.map(account=>account.id).sort().join(',');
 const previousAccountIDs=useRef('');
 useEffect(()=>{
  if(!local.accountsLoading&&local.state==='running'){
   if(previousAccountsLoading.current||previousAccountIDs.current!==accountIDs)notifyNativeLoginChanged();
   previousAccountIDs.current=accountIDs;
  }
  previousAccountsLoading.current=!!local.accountsLoading;
 },[accountIDs,local.accountsLoading,local.state]);
 useEffect(()=>{const previous=previousLoginStatus.current;previousLoginStatus.current=local.login?.status;if(previous&&['starting','waiting_for_browser','verifying'].includes(previous)&&local.login?.status==='completed')notifyNativeLoginChanged();},[local.login?.status]);
 const dismissNotice=useCallback(()=>setNotice(undefined),[]);
 useEffect(()=>{
  if(view!=='toolbox'){repairAside.current=view;setRepairPage(view);return;}
  setRepairPage(tool==='cleanup'?'cleanup':repairAside.current);
 },[view,tool]);
 useEffect(()=>{document.querySelector('main')?.scrollTo(0,0);},[view,tool]);
 const openRepair=useCallback((chain:MaintenanceChain,intent?:'codex-history')=>{setRepair({id:Date.now(),chain,intent});setRepairOpen(true);},[]);
 useEffect(()=>{const open=()=>setRepairOpen(true);window.addEventListener('token-flow:open-repair',open);return()=>window.removeEventListener('token-flow:open-repair',open);},[]);

 // One request at a time: gateway changes must not overlap.
 const act=async(work:()=>Promise<LocalAgentSnapshot|void>,success?:string)=>{
  if(lock.current)return;lock.current=true;setBusy(true);
  try{const next=await work();if(next)setLocal(visibleLocalAgent(next));if(success)setNotice({kind:'ok',text:success});await refresh();notifyNativeLoginChanged();}
  catch(error){setNotice({kind:'error',text:error instanceof Error?error.message:String(error)});}
  finally{lock.current=false;setBusy(false);}
 };
 const command=(action:string)=>act(()=>requestJSON<LocalAgentSnapshot>(`/api/local-agent/${action}`,post()));
 const accounts:AccountActions={
  refresh:(provider,force=true)=>force
   ?act(()=>requestJSON<LocalAgentSnapshot>(`/api/local-agent/providers/${provider}/refresh`,post(),300000),`${local.providers.find(item=>item.id===provider)?.label??provider} 账号、模型和额度已刷新。`)
   :requestJSON<LocalAgentSnapshot>(`/api/local-agent/providers/${provider}/refresh`,post({force:false}),300000).then(()=>refresh()).catch(()=>{}),
  connect:provider=>command(provider),
  importLocal:provider=>act(()=>requestJSON<LocalAgentSnapshot>(`/api/local-agent/import-local/${provider}`,post()),'已导入本机账号。'),
  login:(action,data)=>act(()=>requestJSON<LocalAgentSnapshot>(`/api/local-agent/login/${action}`,post(data))),
  toggle:(id,enabled)=>act(()=>requestJSON<LocalAgentSnapshot>(`/api/local-agent/accounts/${id}`,post({enabled}))),
  remove:id=>act(()=>requestJSON<LocalAgentSnapshot>(`/api/local-agent/accounts/${id}`,{method:'DELETE'}),'账号已删除。'),
 };
 const gatewayDown=local.state!=='running';
 const calls=overview.activity?.recent??[];
 // Keys bound to a source are the ones TokenFlow writes into Agent configs itself.
 const exported=overview.keys.filter(key=>key.exported||(!key.sourceId&&!key.modelSources));
 const platform=(window as Window&{desktop?:{platform:string}}).desktop?.platform;
 const navButton=([id,label,icon]:[View,string,IconName])=><button key={id} className={view===id?'on':''} aria-current={view===id?'page':undefined} onClick={()=>setView(id)}><Icon name={icon} size={icon==='key'?18:16}/>{label}</button>;

 return <div className={`tf ${platform==='darwin'?'nativeMac':platform==='win32'?'nativeWindows':''}`}>
  {(platform==='darwin'||platform==='win32')&&<div className="tfTitlebar" aria-hidden="true"/>}
  <aside className="tfSide">
   <div className="tfBrand"><img src="/logo.svg" alt="" width="24" height="24"/>TokenFlow<i className={`dot ${local.state==='running'?'ok':local.state==='failed'?'bad':''}`} title={gatewayText[local.state]??'网关运行中'}/></div>
   <nav aria-label="主导航">
    <small className="tfNavGroup">已保存</small>{saved.map(navButton)}
    <small className="tfNavGroup">使用</small>{used.map(navButton)}
   </nav>
   <nav aria-label="更多" className="tfSideFoot">{secondary.map(navButton)}</nav>
  </aside>
  <SidebarDivider/>
  <main className="tfMain">
   {busy&&<div className="tfOperationFeedback"><Thinking label="正在处理操作"/></div>}
   <div className="tfRequestStatus">{view!=='agents'&&localError&&<LoadError message={localError} retry={()=>refresh().catch(()=>{})}/>}</div>
   {view==='agents'&&<AgentsPage local={local} calls={calls} usage={usage} notify={setNotice} onRepair={openRepair} onAgent={setSelectedAgent} localError={localError} reloadLocal={refresh}/>}
   {!localLoaded?(!localError&&view!=='agents'&&<div className="tfPage"><LoadingSkeleton label="正在加载账号与模型" variant={view==='usage'?'overview':'cards'}/></div>):<>

   {view==='accounts'&&<AccountsPage local={local} usage={usage} disabled={busy} actions={accounts} notify={setNotice} onContext={setAccountContext}/>}
   {view==='apis'&&<div className="tfPage tfApiPage"><ApiInflow onContext={setPageContext} local={local} usage={usage} onChange={refresh} notify={setNotice}/></div>}
   {view==='proxy'&&<div className="tfPage tfProxyPage">{overview.error&&<LoadError message={overview.error} retry={overview.reload}/>} {!overview.loaded?(!overview.error&&<LoadingSkeleton label="正在加载 API 代理" variant="cards"/>):<KeyOutflow onContext={setPageContext} local={local} keys={exported} usage={usage} reload={overview.reload} notify={setNotice}/>}</div>}
   {view==='activity'&&<ActivityPane onContext={setPageContext} local={local} overview={overview} usage={usage}/>}
   {view==='usage'&&<div className="tfPage tfSettingsPage"><UsageOverview onContext={setPageContext} usage={usage} local={local}/></div>}
   {view==='toolbox'&&tool==='cleanup'&&<FileCleanupPane tools={<ToolboxTools tool={tool} onTool={setTool}/>} onRepair={prompt=>{setRepair({id:Date.now(),context:{page:'cleanup',intent:'file-cleanup'},prompt});setRepairOpen(true);}}/>}
   {view==='toolbox'&&tool==='handoff'&&<ConversationContinue tools={<ToolboxTools tool={tool} onTool={setTool}/>} notify={setNotice}/>}
   {view==='settings'&&<SettingsPane local={local} disabled={busy} onAction={command} theme={theme} onTheme={setTheme}/>}
   </>}
  </main>
  <Notifications notice={notice} onDismiss={dismissNotice} warnings={warnings} onDismissWarning={text=>setWarnings(value=>value.filter(item=>item!==text))} gateway={localLoaded&&gatewayDown?{text:`${gatewayText[local.state]??'网关未运行'}${local.state==='failed'&&local.lastError?`：${local.lastError}`:''}`,canStart:['stopped','failed'].includes(local.state),busy,onStart:()=>void command('start')}:undefined}/>
  <RepairChat selectionContext={pageSelections[repairPage]} range={usage.range} page={repairPage} accountContext={accountContext} local={local} session={repair} selectedAgent={selectedAgent} open={repairOpen} onToggle={setRepairOpen} onNew={()=>setRepair({id:Date.now()})}/>
 </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
