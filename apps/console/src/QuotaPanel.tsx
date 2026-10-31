import {useCallback,useEffect,useRef,useState} from 'react';
import type {AccountQuotaSnapshot} from '../../../packages/core/src/account-quota-snapshot';
import {requestJSON} from './request';
import {QuotaRing} from './QuotaRing';
import {resetLabel} from './QuotaDetails';
import {ProviderIcon} from './ProviderIcon';
import {Icon} from './Icons';
import {LoadingSkeleton} from './LoadingState';
import {panelQuotaGroups} from './quota-panel-model';
import './quota-panel.css';

type PanelDesktop={hideQuotaPanel:()=>Promise<void>;setQuotaAppearance:(theme:'dark'|'light')=>Promise<{glass:boolean}>};
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
  let active=true;
  const material=(glass:boolean)=>{if(active)document.documentElement.dataset.material=glass?'glass':'solid';};
  const appearance=()=>{
   const theme=localStorage.getItem('token-flow.appearance')==='light'?'light':'dark';
   document.documentElement.dataset.theme=theme;
   void desktop()?.setQuotaAppearance(theme).then(state=>material(state.glass)).catch(()=>material(false));
  };
  const materialChanged=(event:Event)=>material((event as CustomEvent<{glass:boolean}>).detail.glass);
  appearance();document.documentElement.dataset.panel='quota';
  const visibility=(event:Event)=>setVisible((event as CustomEvent<boolean>).detail);
  const browserVisibility=()=>setVisible(!document.hidden);
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')void desktop()?.hideQuotaPanel().catch(()=>{});};
  window.addEventListener('token-flow:quota-visibility',visibility);
  document.addEventListener('visibilitychange',browserVisibility);
  window.addEventListener('storage',appearance);window.addEventListener('keydown',escape);
  window.addEventListener('token-flow:quota-material',materialChanged);
  return()=>{active=false;window.removeEventListener('token-flow:quota-visibility',visibility);document.removeEventListener('visibilitychange',browserVisibility);window.removeEventListener('storage',appearance);window.removeEventListener('keydown',escape);window.removeEventListener('token-flow:quota-material',materialChanged);delete document.documentElement.dataset.panel;delete document.documentElement.dataset.material;};
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
 const groups=panelQuotaGroups(snapshot),accountCount=groups.reduce((count,group)=>count+group.accounts.length,0);
 const pending=refreshing||!!snapshot?.refreshing;
 return <div className="tfQuotaPopover">
  <header className="tfQuotaPopoverHeader">
   <div><img src="/logo.svg" width="17" height="17" alt=""/><h1>剩余额度</h1></div>
   <div><span className="tfQuotaPopoverStatus" role="status">{pending?'更新中…':snapshot&&!snapshot.loading?`${accountCount} 个账号`:''}</span><button className="tfQuotaRefresh" aria-label="刷新额度" title="刷新额度" disabled={pending||!snapshot||snapshot.loading} onClick={()=>void refresh()}><Icon name="refresh" size={13}/></button></div>
  </header>
  <main className="tfQuotaPopoverBody" aria-label="已授权账号的剩余额度">
   {error&&<div className="tfQuotaPopoverError" role="status"><span>{error}</span><button className="textButton" onClick={()=>void read()}>重试</button></div>}
   {!snapshot||snapshot.loading?(!error&&<LoadingSkeleton label="正在加载已授权账号" variant="cards"/>):!groups.length?<div className="tfQuotaPopoverEmpty"><h2>暂无可显示的额度</h2><p>有效账号的额度更新后会显示在这里。</p></div>:groups.map(group=><section className="tfQuotaPopoverGroup" key={group.id} aria-label={group.label}>
    <header className="tfQuotaGroupHeading"><ProviderIcon provider={group.id} size={20}/><h2>{group.label}</h2>{group.accounts.length>1&&<span className="tfQuotaGroupCount">{group.accounts.length} 个账号</span>}</header>
    {group.accounts.map(({account,quota,provider,windows})=>{
    const observed=quota.observedAt;
    return <article className="tfQuotaPopoverAccount" key={account.id} aria-label={`${provider} · ${account.label}`}>
     <header><div><h3 title={account.label}>{account.label}</h3>{quota.plan&&<span className="tfQuotaPlan" title={quota.plan}>{quota.plan}</span>}</div><time title={`更新于 ${new Date(observed).toLocaleString()}`} dateTime={observed}>{new Date(observed).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false})}</time></header>
      <div className="tfQuotaPopoverWindows">{windows.map(item=><div className={`tfQuotaPopoverWindow${item.balance?' hasBalance':''}`} key={item.id}>
       <QuotaRing remaining={item.remainingPercent} label={item.label}/>
       <div><strong title={item.label}>{item.label}</strong>{item.balance&&<b>{item.balance}</b>}{item.total&&<span>{item.total}</span>}{item.resetsAt&&<small title={new Date(item.resetsAt).toLocaleString()}>{item.credits?`${new Date(item.resetsAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})}重置`:resetLabel(item.resetsAt,true)}</small>}</div>
      </div>)}</div>
      {account.provider==='codex'&&quota.resetCredits!==undefined&&<div className="tfQuotaResetCards"><Icon name="copy" size={12}/><span>重置卡</span><b>{quota.resetCredits} 张</b><small>可用</small></div>}
    </article>;
   })}</section>)}
  </main>
 </div>;
}
