import {hasNativeLogin} from './native-login-visibility';
import {UsageFold} from './UsagePanel';
import type {UsageData} from './usage-data';
import {localDay} from './usage-model';
import type {ReactNode} from 'react';
import {OfficialAccountIdentity,UnpooledNativeAccount} from './OfficialAccountIdentity';
import {useState} from 'react';
import {NativeLoginStatus} from './NativeLoginStatus';
import {useOfficialLoginConfirm} from './OfficialLoginConfirm';
import {officialLoginHeld} from '../../shared/native-login-identity';
import {loginNames,type LoginProvider,type useNativeLogin} from './native-login';
import type {Notify} from './notify';
import {requestJSON} from './request';
import {ProviderIcon} from './ProviderIcon';
import {Icon} from './Icons';
import {QuotaDetails} from './QuotaDetails';
import type {LocalAgentSnapshot} from '../../../packages/core/src/cliproxy';
import type {CSSProperties} from 'react';

export function DesktopOfficialPanel({local,onRefresh,clientSwitch,provider,login,notify,usage}:{local:LocalAgentSnapshot;onRefresh?:()=>Promise<void>;usage:UsageData;clientSwitch?:ReactNode;provider:LoginProvider;login:ReturnType<typeof useNativeLogin>;notify:Notify}){
 const [open,setOpen]=useState('');
 const [split]=useState(()=>{try{const value=Number(localStorage.getItem('token-flow.layout.agent-split')??36);return Number.isFinite(value)?Math.max(24,Math.min(68,value)):36;}catch{return 36;}});
 const installation=login.status?.installation;
 const [busy,setBusy]=useState(false),confirm=useOfficialLoginConfirm(),name=loginNames[provider];
 const change=async(id?:string)=>{const chosen=id?login.accounts.find(account=>account.id===id):undefined;if(chosen&&officialLoginHeld(provider,chosen.local,chosen.current))return;if(!await confirm.confirm(name,!id))return;setBusy(true);try{if(id)await login.switchTo(id);else await login.restore();notify({kind:'ok',text:`${name} 已${id?'切换账号':'恢复原登录'}并重新打开。`});}catch(error){notify({kind:'error',text:error instanceof Error?error.message:'切换失败'});}finally{await login.refresh();setBusy(false);}};
 const restart=async()=>{setBusy(true);try{await requestJSON('/api/a2a/restart',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target:provider})},600000);notify({kind:'ok',text:`${name} 已重新打开。`});}catch(error){notify({kind:'error',text:error instanceof Error?error.message:'重启失败'});}finally{setBusy(false);}};
 return <section className="tfPanel tfWorkBuddyPanel">{confirm.dialog}
  <header className="tfPanelHead"><ProviderIcon provider="workbuddy" size={30}/><div><div className="tfAgentTitle"><h2>{name}</h2>{clientSwitch}{installation&&<a className="tfAgentUpdate" href={installation.download} target="_blank" rel="noreferrer" title="打开官方下载页" aria-label={`打开 ${name} 官方下载页`}><Icon name="download" size={15}/></a>}<span className="tfAgentVersion">{!installation?'正在读取版本…':installation.installed?`已安装${installation.version?` · ${installation.version}`:' · 版本未提供'}`:'未检测到安装'}</span></div><UsageFold loaded={usage.loaded} error={usage.error} onRetry={usage.reload} title={`${name} 用量`} rows={usage.allRows.filter(row=>row.target===provider&&row.day===localDay(new Date()))} range="today"/></div><div className="tfRow"><button className="textButton" disabled={busy} onClick={()=>void restart()}>重启…</button></div></header>
  {hasNativeLogin(login)&&<div className="tfAgentColumns tfDesktopOfficialColumns" style={{'--split':`${split}%`} as CSSProperties}><section className="tfAgentSection tfOfficialAccounts" aria-label="官方登录账号">
   <header className="tfAgentSectionHead"><h3>官方登录账号</h3><NativeLoginStatus name={name} login={login} onRefresh={onRefresh}>{login.status?.backup&&<button className="textButton" disabled={busy} onClick={()=>void change()}>恢复原登录</button>}</NativeLoginStatus></header>
   {login.accounts.length||login.nativeLabel?<ul className="tfLines"><UnpooledNativeAccount provider={provider} login={login}/>{login.accounts.map(account=><li key={account.id} className={account.current?'on':''}><div className="tfLine">
    <button className="tfLineMain" aria-pressed={account.current} disabled={busy||officialLoginHeld(provider,account.local,account.current)||!account.switchable} title={account.reason||undefined} onClick={()=>void change(account.id)}>
     <OfficialAccountIdentity provider={provider} account={account}/>
    </button>
    <span className="tfActions"><button className="textButton" aria-expanded={open===account.id} aria-controls={`quota-${provider}-${account.id}`} onClick={()=>setOpen(open===account.id?'':account.id)}>{open===account.id?'收起':'详情'}</button></span>
   </div>{open===account.id&&<div id={`quota-${provider}-${account.id}`} className="tfAccountQuotaExpanded">{local.quotas[account.id]?<QuotaDetails quota={local.quotas[account.id]} label={account.label} compact concise/>:<span>额度暂未提供</span>}</div>}</li>)}</ul>:<p className="tfHint">还没有 WorkBuddyAI 账号</p>}
  </section></div>}
 </section>;
}
