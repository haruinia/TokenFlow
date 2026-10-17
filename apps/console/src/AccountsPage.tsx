import {UnpooledNativeAccount} from './OfficialAccountIdentity';
import {NativeLoginStatus} from './NativeLoginStatus';
import {SwitchTabs} from './SwitchTabs';
import {useOfficialLoginConfirm} from './OfficialLoginConfirm';
import {Thinking,LoadingSkeleton} from './LoadingState';
import {FlowDialog} from './FlowDialog';
import {ColumnDivider} from './ColumnDivider';
import {copyText} from './clipboard';
import {localDay,spentByPlatform} from './usage-model';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';
import { QuotaDetails } from './QuotaDetails';
import { qualifiedModelLabel as modelLabel } from './model-label';
import { formatTokens, percentText, rangeLabel, totalsOf } from './usage-model';
import type { UsageData } from './usage-data';
import {officialLoginHeld} from '../../shared/native-login-identity';
import { clientOptions, loginNames, useNativeLogin, type LoginProvider } from './native-login';
import { Icon } from './Icons';
import {UsageFold,modelManufacturer} from './UsagePanel';
import {DragHandle,dropOrder,orderModels,useModelOrder} from './display-order';
import { ProviderIcon } from './ProviderIcon';
import type { Notify } from './notify';

const importable=new Set(['trae','workbuddy','zcode','cursor']);
const pendingStates=['starting','waiting_for_browser','verifying'];
const tabKey='token-flow.accounts.provider';

function navigateTabs(event:KeyboardEvent<HTMLDivElement>){
 const tabs=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]'));
 const index=tabs.indexOf(event.target as HTMLButtonElement);
 if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
 event.preventDefault();
 const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
 tabs[next]?.focus();tabs[next]?.click();
}

export type AccountActions={
 refresh:(provider:string,force?:boolean)=>Promise<void>;
 connect:(provider:string)=>Promise<void>;
 importLocal:(provider:string)=>Promise<void>;
 login:(action:'open'|'cancel'|'callback',data:{id:string;redirectURL?:string})=>Promise<void>;
 toggle:(id:string,enabled:boolean)=>Promise<void>;
 remove:(id:string)=>Promise<void>;
};

function LoginProgress({local,disabled,actions}:{local:LocalAgentSnapshot;disabled:boolean;actions:AccountActions}){
 const login=local.login;const [callback,setCallback]=useState('');const [copiedURL,setCopiedURL]=useState(false);const [copyFailure,setCopyFailure]=useState(false);const [dismissed,setDismissed]=useState(()=>{try{return localStorage.getItem('token-flow.login.dismissed')??'';}catch{return '';}});
 useEffect(()=>{setCallback('');setCopiedURL(false);setCopyFailure(false);},[login?.id]);
 if(!login||login.status==='idle'||dismissed===login.id)return null;
 const dismiss=()=>{setDismissed(login.id);try{localStorage.setItem('token-flow.login.dismissed',login.id);}catch{}};
 const pending=pendingStates.includes(login.status);
 const label=local.providers.find(p=>p.id===login.provider)?.label??(login.provider==='workbuddy-overseas'?'WorkBuddy 国际版':login.provider==='zcode-bigmodel'?'ZCode（智谱 BigModel）':login.provider==='claude-manual'?'Claude（授权码）':login.provider);
 return <FlowDialog open title={login.status==='completed'?`${label} 已连接`:`连接 ${label}`} className="tfLoginDialog" onClose={()=>{if(pending)void actions.login('cancel',{id:login.id});dismiss();}}><div className="tfLogin">
  <div className="tfLoginHead"><ProviderIcon provider={login.provider} size={32}/><div><strong>{login.status==='completed'?'账号与模型已保存':login.status==='starting'?'正在准备授权':login.status==='verifying'?'正在验证账号':pending?'请在浏览器完成授权':'授权未完成'}</strong>{pending&&<Thinking label={login.status==='verifying'?'正在验证账号':'正在等待授权'}/>}</div></div>
  <p className="tfLoginMessage" role={pending?'status':login.status==='completed'?'status':'alert'}>{login.status==='waiting_for_browser'?login.flow==='code'?'登录官方页面并确认授权，然后把页面显示的授权码粘贴到下方。':'登录官方页面并确认授权，完成后会自动保存账号并刷新模型。':login.message}</p>
  {pending&&login.flow==='device'&&login.userCode&&<p className="tfCode">设备码 <b className="mono">{login.userCode}</b></p>}
  {pending&&<div className="tfRow tfLoginActions">
   <button className="primary" disabled={disabled||!login.url||login.status==='verifying'} onClick={()=>void actions.login('open',{id:login.id})}>打开授权页</button>
   <button className="textButton" disabled={disabled} onClick={()=>void actions.login('cancel',{id:login.id})}>取消</button>
  </div>}
  {pending&&login.url&&<details key={login.id} className="tfAuthorizationDetails"><summary>查看授权链接</summary><label className="tfAuthorizationURL"><span className="srOnly">授权链接</span><div className="inputAction"><input readOnly aria-label="授权链接" value={login.url} onFocus={event=>event.target.select()}/><button type="button" onClick={()=>void copyText(login.url??'').then(()=>{setCopiedURL(true);setCopyFailure(false);}).catch(()=>setCopyFailure(true))}>{copiedURL?'已复制':'复制'}</button></div></label>{copyFailure&&<p className="tfError" role="alert">复制失败，请选中链接手动复制。</p>}</details>}
  {pending&&login.flow==='code'&&<form className="tfInline" onSubmit={event=>{event.preventDefault();const value=callback;setCallback('');void actions.login('callback',{id:login.id,redirectURL:value});}}>
   <input required autoComplete="off" spellCheck={false} aria-label="授权码" placeholder="粘贴官方页面显示的授权码" value={callback} onChange={event=>setCallback(event.target.value)}/>
   <button disabled={disabled||!callback.trim()||login.status==='verifying'}>提交</button>
  </form>}
  {pending&&login.flow==='callback'&&<details><summary>浏览器无法打开回调地址？</summary>
   <form className="tfInline" onSubmit={event=>{event.preventDefault();const value=callback;setCallback('');void actions.login('callback',{id:login.id,redirectURL:value});}}>
    <input type="url" required autoComplete="off" spellCheck={false} aria-label="完整回调地址" placeholder="粘贴授权后地址栏里的完整 localhost 地址" value={callback} onChange={event=>setCallback(event.target.value)}/>
    <button disabled={disabled||!callback.trim()||login.status==='verifying'}>提交</button>
   </form>
  </details>}
  {login.status==='completed'?<button className="primary" onClick={dismiss}>完成</button>:!pending&&<button disabled={disabled} onClick={()=>void actions.connect(login.provider)}>重新连接</button>}
 </div></FlowDialog>;
}

/** Authorized accounts with their quota up front, plus switching the client's own login where it has one. */
export function AccountsPage({local,usage,disabled,actions,notify,onContext}:{local:LocalAgentSnapshot;usage:UsageData;disabled:boolean;actions:AccountActions;notify:Notify;onContext?:(context:{provider?:string;sourceId?:string})=>void}){
 const [modelOrder,,modelRanks,moveModel]=useModelOrder();
 const [tab,setTab]=useState(()=>{try{return localStorage.getItem(tabKey)??'codex';}catch{return 'codex';}});
 const logins:Record<LoginProvider,ReturnType<typeof useNativeLogin>>={codex:useNativeLogin('codex',local),claude:useNativeLogin('claude',local),antigravity:useNativeLogin('antigravity',local),workbuddy:useNativeLogin('workbuddy',local),'workbuddy-ai':useNativeLogin('workbuddy-ai',local),qoder:useNativeLogin('qoder',local),'qoder-ide':useNativeLogin('qoder-ide',local),cursor:useNativeLogin('cursor',local,tab==='cursor')};
 const [clients,setClients]=useState<Record<string,LoginProvider>>({workbuddy:'workbuddy',qoder:'qoder'});
 const [selectedAccounts,setSelectedAccounts]=useState<Record<string,string>>({});
 const [refreshing,setRefreshing]=useState('');
 const [switching,setSwitching]=useState(false);const lock=useRef(false);
 const loginPending=!!local.login&&pendingStates.includes(local.login.status);
 const accountsLoading=!!local.accountsLoading||local.state==='starting';
 const locked=disabled||switching||!!refreshing||loginPending||['starting','stopping'].includes(local.state);
 const providers=local.providers.map(provider=>({...provider,accounts:local.accounts.filter(a=>a.provider===provider.id&&!a.isDuplicate&&(!a.unavailable||a.retryable||provider.id==='cursor'))}));
 const provider=providers.find(p=>p.id===tab)??providers[0];
 const variants=provider?.id==='workbuddy'?clientOptions.workbuddy:provider?.id==='qoder'?clientOptions.qoder:undefined;
 const client=provider?(clients[provider.id]??(provider.id in loginNames?provider.id as LoginProvider:undefined)):undefined;
 const login=client?logins[client]:undefined;
 const accounts=provider?.accounts.filter(a=>!variants||!!client&&(a.nativeClients?.includes(client)??login?.status?.accounts.some(c=>c.id===a.id)))??[];
 const accountKey=client??provider?.id??'';
 const account=accounts.find(a=>a.id===selectedAccounts[accountKey])??accounts.find(a=>a.id===login?.nativeCurrent?.id)??accounts[0];
 const selected=login?.accounts.find(a=>a.id===account?.id);
 useEffect(()=>{onContext?.({provider:provider?.id,sourceId:account?.id});},[provider?.id,account?.id,onContext]);
 const chooseProvider=(id:string)=>{setTab(id);try{localStorage.setItem(tabKey,id);}catch{/* Only remembers the open platform. */}};
 // Follow a newly started authorization once; manual platform browsing stays available afterwards.
 useEffect(()=>{if(local.login&&pendingStates.includes(local.login.status)){const id=local.login.provider;chooseProvider(id==='workbuddy-overseas'?'workbuddy':id==='zcode-bigmodel'?'zcode':id==='claude-manual'?'claude':id);if(id==='workbuddy'||id==='workbuddy-overseas')setClients(previous=>({...previous,workbuddy:id==='workbuddy-overseas'?'workbuddy-ai':'workbuddy'}));}},[local.login?.id]);
 const officialConfirm=useOfficialLoginConfirm();
 const switchLogin=async(provider:LoginProvider,id:string,label:string)=>{
  if((provider==='workbuddy'||provider==='workbuddy-ai'||provider==='qoder'||provider==='qoder-ide'||provider==='claude')&&!await officialConfirm.confirm(provider==='claude'?'Claude Code 终端':loginNames[provider]))return;
  if(lock.current)return;lock.current=true;setSwitching(true);
  try{const note=await logins[provider].switchTo(id);notify({kind:'ok',text:`${loginNames[provider]} 本机登录已切换到 ${label}，${provider==='workbuddy'||provider==='workbuddy-ai'||provider==='qoder'||provider==='qoder-ide'||provider==='claude'?'客户端已重新打开，请确认登录状态':`重新打开 ${loginNames[provider]} 生效`}。${note}`});}
  catch(error){notify({kind:'error',text:error instanceof Error?error.message:'切换失败'});}
  finally{await logins[provider].refresh();lock.current=false;setSwitching(false);}
 };

 const nativeLogin=login&&client&&<NativeLoginStatus name={loginNames[client]} login={login} showRefresh={false}>
    {selected&&client&&!officialLoginHeld(client,selected.local,selected.current)&&!login.status?.readOnly&&<button className="textButton" disabled={locked||!selected.switchable} title={selected.reason||undefined} onClick={()=>void switchLogin(client,selected.id,selected.label)}>切换到此账号</button>}
    {login.status?.backup&&<button className="textButton" disabled={locked} onClick={()=>void (async()=>{if(lock.current)return;if(!await officialConfirm.confirm(loginNames[client],true))return;lock.current=true;setSwitching(true);try{await login.restore();notify({kind:'ok',text:`${loginNames[client]} 已恢复原登录。`});}catch(error){notify({kind:'error',text:error instanceof Error?error.message:'恢复失败'});}finally{await login.refresh();lock.current=false;setSwitching(false);}})()}>恢复原登录</button>}
   </NativeLoginStatus>;

 return <div className="tfPage tfAccountsPage">{officialConfirm.dialog}
  <div className="tfProviderTabs" role="tablist" aria-label="授权平台" onKeyDown={navigateTabs}>
   {providers.map(item=><button key={item.id} id={`provider-tab-${item.id}`} role="tab" aria-selected={provider?.id===item.id} aria-controls={`provider-panel-${item.id}`} tabIndex={provider?.id===item.id?0:-1} onClick={()=>chooseProvider(item.id)}>
    <ProviderIcon provider={item.id} size={28}/><span>{item.label}</span>
   </button>)}
  </div>
  <LoginProgress local={local} disabled={disabled||switching} actions={actions}/>
  {!provider&&<p className="tfHint">正在读取授权平台…</p>}
  {provider&&<section id={`provider-panel-${provider.id}`} role="tabpanel" aria-labelledby={`provider-tab-${provider.id}`} className="tfProviderPanel">
   <header className="tfProviderHead">
    <div className="tfProviderTitle"><UsageFold loaded={usage.loaded} error={usage.error} onRetry={usage.reload} title={`${provider.label} 用量`} rows={usage.allRows.filter(row=>row.day===localDay(new Date())).filter(r=>spentByPlatform(r,provider))} range="today"/><button className="textButton tfProviderRefresh" aria-label={`刷新 ${provider.label} 账号、模型和额度`} title="点击刷新此平台的账号、模型和额度" disabled={locked||local.state!=='running'} onClick={()=>void (async()=>{if(lock.current)return;lock.current=true;setRefreshing(provider.id);try{await actions.refresh(provider.id);await login?.refresh(true);}catch(error){notify({kind:'error',text:error instanceof Error?error.message:'刷新失败，请重试'});}finally{lock.current=false;setRefreshing('');}})()}><Icon name="refresh" size={14}/>刷新</button></div>
    <div className="tfRow">
     {importable.has(provider.id)&&<button disabled={locked} onClick={()=>void actions.importLocal(client==='workbuddy-ai'?'workbuddy-ai':provider.id).then(()=>login?.refresh(true))}>{provider.id==='cursor'&&login?.nativeCurrent?'复用本机账号':'从本机导入'}</button>}
     <button className="primary" aria-label={`添加 ${client?loginNames[client]:provider.label} 账号`} disabled={locked} onClick={()=>void actions.connect(client==='workbuddy-ai'?'workbuddy-overseas':provider.id)}><Icon name="plus" size={14}/>{provider.id==='zcode'?'添加 Z.ai 账号':'添加账号'}</button>
     {provider.id==='claude'&&<button title="不使用本机回调端口：在官方页面复制授权码后粘贴回来" disabled={locked} onClick={()=>void actions.connect('claude-manual')}>授权码登录</button>}
     {provider.id==='zcode'&&<button aria-label="添加智谱 BigModel 账号" disabled={locked} onClick={()=>void actions.connect('zcode-bigmodel')}><Icon name="plus" size={14}/>添加 BigModel 账号</button>}
    </div>
   </header>
   {(()=>{const coverage=usage.coverage.find(item=>item.target===(client==='workbuddy-ai'?client:provider.id));return coverage&&coverage.status!=='ready'?<p className="tfHint">{coverage.status==='unsupported'?'此客户端直连用量尚未采集；上方用量仅包含已记录的 TokenFlow 请求。':coverage.status==='scanning'?'正在读取本机直连用量…':'未找到可读取的客户端直连记录；上方用量仅包含已采集的请求。'}</p>:null;})()}
   {variants&&client&&<SwitchTabs label="账号客户端" value={client} options={variants} disabled={locked} onChange={id=>setClients(previous=>({...previous,[provider.id]:id}))}/>}
   {!account&&!accountsLoading&&login&&client&&<div className="tfAccountTabs"><UnpooledNativeAccount provider={client} login={login} compact/></div>}
   {!account&&!accountsLoading&&nativeLogin}
   {!account&&accountsLoading?<LoadingSkeleton label="正在加载已保存的账号" variant="cards"/>:!account?<div className="tfAccountEmpty">
    <Icon name="user" size={28}/><h3>{local.accountError?'账号信息暂未加载':`还没有 ${client?loginNames[client]:provider.label} 账号`}</h3>
    <p>{local.accountError??(local.state==='running'?'点击上方添加账号，完成授权后即可查看模型和额度。':'网关启动后显示已授权的账号，也可以点击上方添加账号。')}</p>
   </div>:<>
    <div className="tfAccountTabs" role="tablist" aria-label={`${provider.label} 已授权账号`} onKeyDown={navigateTabs}>
     {accounts.map(item=><button key={item.id} id={`account-tab-${item.id}`} role="tab" aria-selected={account.id===item.id} aria-controls={`account-panel-${item.id}`} tabIndex={account.id===item.id?0:-1} onClick={()=>{setSelectedAccounts(previous=>({...previous,[accountKey]:item.id}));}}>
      <Icon name="user" size={14}/><span title={item.label}>{item.label}</span>
      {login?.nativeCurrent?.id===item.id?<b className="tfUsing">本机</b>:item.disabled?<small>已停用</small>:null}
     </button>)}
     {login&&client&&<UnpooledNativeAccount provider={client} login={login} compact/>}
    </div>
    {(()=>{
     const quota=local.quotas[account.id];
     const shownModels=orderModels(account.models??[],id=>modelLabel(local,id),modelOrder==='manual'?'manual':'name',modelRanks);
     return <div id={`account-panel-${account.id}`} role="tabpanel" aria-labelledby={`account-tab-${account.id}`} className={`tfAccountDetail ${account.disabled?'off':''}`}>
      <div className="tfAccountTop">
       {nativeLogin}
       <div className="tfAccountManage"><label className="toggle" title={account.disabled?'启用':'停用'}><input type="checkbox" checked={!account.disabled} disabled={locked||local.state!=='running'} onChange={()=>void actions.toggle(account.id,account.disabled)}/><span>启用</span></label>
       <button className="textButton danger" disabled={locked||local.state!=='running'} onClick={()=>{if(window.confirm(`删除账号 ${account.label} 的登录凭据？`))void actions.remove(account.id);}}>删除</button></div>
      </div>
      {(account.credentialCount??0)>1&&<small className="tfHint">已保存 {account.credentialCount} 份授权，优先使用最新可用授权。</small>}
      {refreshing!==provider.id&&account.modelError&&<small className="tfWarn">{account.modelError}</small>}
      {account.retryable&&<small className="tfHint">上次请求暂时失败，可稍后重试。</small>}
      <div className="tfAccountColumns">
       <section className="tfQuotaSide" aria-label="账号额度"><h3>额度</h3>{refreshing===provider.id||local.quotaBusy?<LoadingSkeleton label="正在加载账号额度"/>:quota&&!account.disabled?<QuotaDetails quota={quota} label={account.label} compact/>:<small className="tfHint">{account.disabled?'已停用，不参与调用':'额度暂未提供'}</small>}</section>
       <ColumnDivider storageKey="token-flow.layout.account-split" label="调整额度与模型宽度"/>
       <section className="tfModelsSide" aria-label="账号模型"><div className="tfAccountModels" id={`models-${account.id}`}>
       <header className="tfAccountModelsHead"><h3>模型</h3><small className="tfAccountModelCount">{account.models?.length??0} 个模型</small></header>
       {refreshing===provider.id?<LoadingSkeleton label="正在加载账号模型"/>:account.models?.length?<ul aria-label={`${account.label} 支持的模型`}>{shownModels.map(id=><li key={id} className="tfDragRow" {...dropOrder('models',id,shownModels,moveModel)}><DragHandle kind="models" id={id} label={modelLabel(local,id)} items={shownModels} move={moveModel}/><ProviderIcon provider={modelManufacturer(id,local)} size={28}/><span className="tfCatalogModelName"><strong title={modelLabel(local,id)}>{modelLabel(local,id)}</strong></span><button className="textButton" aria-label={`复制模型 ${modelLabel(local,id)}`} title={id} onClick={()=>void copyText(id).then(()=>notify({kind:'ok',text:'模型 ID 已复制'})).catch(()=>notify({kind:'error',text:'复制失败'}))}>复制</button></li>)}</ul>:<p className="tfHint">尚未获取到模型，请启用账号后刷新。</p>}
      </div></section></div>
     </div>;
    })()}
   </>}


  </section>}
 </div>;
}
