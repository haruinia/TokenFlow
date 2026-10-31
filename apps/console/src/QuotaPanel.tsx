import {useCallback,useEffect,useRef,useState} from 'react';
import type {AccountQuotaSnapshot} from '../../../packages/core/src/account-quota-snapshot';
import {requestJSON} from './request';
import {isProviderVisible} from './provider-visibility';
import {QuotaRing} from './QuotaRing';
import {quotaPresentation,quotaErrorMessage,resetLabel} from './QuotaDetails';
import {ProviderIcon} from './ProviderIcon';
import {Icon} from './Icons';
import {LoadingSkeleton} from './LoadingState';
import {quotaPanelLabel} from './quota-panel-label';
import './quota-panel.css';

type PanelDesktop={openWorkspace:(view?:'accounts')=>Promise<void>;hideQuotaPanel:()=>Promise<void>};
const desktop=()=> (window as Window&{desktop?:PanelDesktop}).desktop;

export function QuotaPanel(){
 const [snapshot,setSnapshot]=useState<AccountQuotaSnapshot>();
 const [error,setError]=useState(''),[refreshing,setRefreshing]=useState(false);
 const [visible,setVisible]=useState(!document.hidden);
 const reading=useRef(false),updating=useRef(false);
 const read=useCallback(async()=>{
  if(reading.current)return;reading.current=true;
  try{setSnapshot(await requestJSON<AccountQuotaSnapshot>('/api/account-quotas'));setError('');}
  catch{setError('暂时无法读取额度，请重试。');}
  finally{reading.current=false;}
 },[]);
 useEffect(()=>{
  const appearance=()=>{document.documentElement.dataset.theme=localStorage.getItem('token-flow.appearance')==='light'?'light':'dark';};
  appearance();document.documentElement.dataset.panel='quota';
  const visibility=(event:Event)=>setVisible((event as CustomEvent<boolean>).detail);
  const browserVisibility=()=>setVisible(!document.hidden);
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')void desktop()?.hideQuotaPanel().catch(()=>{});};
  window.addEventListener('token-flow:quota-visibility',visibility);
  document.addEventListener('visibilitychange',browserVisibility);
  window.addEventListener('storage',appearance);window.addEventListener('keydown',escape);
  return()=>{window.removeEventListener('token-flow:quota-visibility',visibility);document.removeEventListener('visibilitychange',browserVisibility);window.removeEventListener('storage',appearance);window.removeEventListener('keydown',escape);delete document.documentElement.dataset.panel;};
 },[]);
 useEffect(()=>{
  if(!visible)return;
  void read();
  // Poll the in-memory snapshot only. Opening the panel never imports credentials.
  const timer=setInterval(()=>void read(),snapshot?.loading||snapshot?.refreshing||refreshing?1500:15000);
  return()=>clearInterval(timer);
 },[visible,read,snapshot?.loading,snapshot?.refreshing,refreshing]);
 const refresh=async()=>{
  if(updating.current)return;updating.current=true;setRefreshing(true);setError('');
  try{setSnapshot(await requestJSON<AccountQuotaSnapshot>('/api/account-quotas/refresh',{method:'POST'},180000));}
  catch{setError('额度更新未完成，保留上次结果。');}
  finally{updating.current=false;setRefreshing(false);}
 };
 const open=(view?:'accounts')=>{
  if(desktop())void desktop()!.openWorkspace(view).catch(()=>setError('无法打开工作台，请点击 Dock 图标重试。'));
  else window.location.href=view==='accounts'?'/?view=accounts':'/';
 };
 const accounts=snapshot?.accounts.filter(account=>isProviderVisible(account.provider))??[];
 const pending=refreshing||!!snapshot?.refreshing;
 return <div className="tfQuotaPopover">
  <header className="tfQuotaPopoverHeader">
   <div><img src="/logo.svg" width="20" height="20" alt=""/><h1>账号额度</h1></div>
   <button className="iconButton" aria-label="刷新额度" title="刷新额度" disabled={pending||!snapshot||snapshot.loading} onClick={()=>void refresh()}><Icon name="refresh" size={17}/></button>
  </header>
  <main className="tfQuotaPopoverBody" aria-label="已授权账号的剩余额度">
   {error&&<div className="tfQuotaPopoverError" role="status"><span>{error}</span><button className="textButton" onClick={()=>void read()}>重试</button></div>}
   {!snapshot||snapshot.loading?(!error&&<LoadingSkeleton label="正在加载已授权账号" variant="cards"/>):!accounts.length?<div className="tfQuotaPopoverEmpty"><Icon name="user" size={28}/><h2>添加账号，随时查看额度</h2><p>已授权账号会显示在这里。</p><button onClick={()=>open('accounts')}>添加账号</button></div>:accounts.map(account=>{
    const quota=snapshot.quotas[account.id];
    const provider=snapshot.providers.find(item=>item.id===account.provider)?.label??account.provider;
    const windows=quota?quotaPresentation(quota).overview:[];
    const stale=quota?.status==='error';
    const observed=stale?quota.lastSuccessfulAt:quota?.observedAt;
    return <section className="tfQuotaPopoverAccount" key={account.id} aria-label={`${provider} · ${account.label}`}>
     <header><ProviderIcon provider={account.provider} size={26}/><div><div className="tfQuotaPopoverAccountTitle"><h2>{provider}</h2>{quota?.plan&&<span title={quota.plan}>{quota.plan}</span>}</div><p title={account.label}>{account.label}</p></div></header>
     {account.authenticationRequired?<p className="tfQuotaPopoverWarning">登录已失效，请在账号授权中重新登录。</p>:account.disabled?<p className="tfQuotaPopoverMeta">账号已停用</p>:<>
      {stale&&<p className="tfQuotaPopoverWarning">{quotaErrorMessage(quota.error)}{windows.length?' 当前为上次额度。':''}</p>}
      {!!windows.length&&<div className="tfQuotaPopoverWindows">{windows.map(item=><div className="tfQuotaPopoverWindow" key={item.id}>
       <QuotaRing remaining={item.usedPercent===null?null:100-item.usedPercent} label={item.label}/>
       <div><strong title={item.label}>{quotaPanelLabel(item.label)}</strong>{item.displayValue&&<span>{item.displayValue}</span>}{item.usedPercent===null&&!item.displayValue&&<span>{item.remaining!==undefined?`余额 ${item.unit==='USD'?'$':''}${item.remaining.toLocaleString()}${item.unit&&item.unit!=='USD'?item.unit:''}`:'额度未提供'}</span>}{item.resetsAt&&<small title={new Date(item.resetsAt).toLocaleString()}>{resetLabel(item.resetsAt,true)}</small>}{item.note&&<small>{item.note}</small>}</div>
      </div>)}</div>}
      {!windows.length&&!stale&&<p className="tfQuotaPopoverMeta">{quota?.note??'额度暂未提供'}</p>}
      {observed&&<p className="tfQuotaPopoverUpdated" title={new Date(observed).toLocaleString()}>{stale?'上次成功更新':'更新于'} {new Date(observed).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</p>}
     </>}
    </section>;
   })}
  </main>
  <footer><span role="status">{pending?'正在更新额度…':!snapshot||snapshot.loading?error?'暂不可用':'正在读取账号…':`${accounts.length} 个账号 · 圆环显示剩余`}</span><button className="textButton" onClick={()=>open('accounts')}>管理账号<Icon name="arrow" size={14}/></button><button className="iconButton" title="打开工作台" aria-label="打开工作台" onClick={()=>open()}><Icon name="workspace" size={16}/></button></footer>
 </div>;
}
