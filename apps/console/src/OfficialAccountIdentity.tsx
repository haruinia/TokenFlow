import {Icon} from './Icons';
import {ProviderIcon} from './ProviderIcon';
import {officialLoginCoexists,officialLoginHeld,officialLoginSelected} from '../../shared/native-login-identity';
import type {LoginAccount,useNativeLogin} from './native-login';

/** Codex's existing account row, shared by every official client. */
export function OfficialAccountIdentity({provider,account,codexCoexist=false}:{provider:string;codexCoexist?:boolean;account:Pick<LoginAccount,'label'|'remaining'|'current'|'local'|'switchable'|'reason'>}){
 return <><span className={`tfLoginRadio ${account.current?'on':''}`} aria-hidden="true"/>
  <ProviderIcon provider={provider==='workbuddy-ai'?'workbuddy':provider} size={22}/><span className="tfKind">账号</span>
  <span className="tfRowText"><strong title={account.label}>{account.label}</strong><small>官方登录{account.remaining===null?'':` · 剩余 ${Math.round(account.remaining)}%`}{!account.switchable&&account.reason?` · ${account.reason}`:''}</small></span>
  {officialLoginHeld(provider,account.local,account.current,codexCoexist)?<b className="tfUsing">{account.current&&officialLoginCoexists(provider,codexCoexist)?'已登录':account.current?'使用中':'本机'}</b>:<>{account.local&&<b className="tfUsing">本机</b>}<span className="tfSwitch">切换</span></>}
 </>;
}
export function UnpooledNativeAccount({provider,login,compact=false}:{provider:string;login:ReturnType<typeof useNativeLogin>;compact?:boolean}){
 if(!login.nativeLabel||login.nativeCurrent||login.error||login.status?.readError)return null;
 if(compact)return <span className="tfNativeAccountChip"><Icon name="user" size={14}/><span title={login.nativeLabel}>{login.nativeLabel}</span><b className="tfUsing">本机</b></span>;
 const current=officialLoginSelected(provider,true,!!login.status?.gatewayConnected,!!login.status?.codexCoexist);
 return <li className={current?'on':''}><div className="tfLine"><div className="tfLineMain"><OfficialAccountIdentity provider={provider} codexCoexist={login.status?.codexCoexist} account={{label:login.nativeLabel,remaining:null,current,local:true,switchable:false,reason:''}}/></div></div></li>;
}
