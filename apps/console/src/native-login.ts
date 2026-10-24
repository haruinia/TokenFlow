import type {AgentInstallation} from '../../../packages/core/src/agent-installation';
import {hasNativeLogin} from './native-login-visibility';
import {desktopIdentityMatches,officialLoginCoexists,officialLoginHeld,officialLoginSelected} from '../../shared/native-login-identity';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';
import type { AgentConnections } from '../../../packages/core/src/agent-connections';
import { requestJSON } from './request';
import { readForSession,invalidateSessionReads } from './session-read';
import { sourceOptions } from './source-options';

export type LoginProvider='codex'|'claude'|'antigravity'|'workbuddy'|'workbuddy-ai'|'qoder'|'qoder-ide'|'cursor'|'trae'|'zcode';
export const loginNames:Record<LoginProvider,string>={codex:'Codex',claude:'Claude Code',antigravity:'Antigravity',workbuddy:'WorkBuddy','workbuddy-ai':'WorkBuddyAI',qoder:'Qoder','qoder-ide':'Qoder IDE',cursor:'Cursor',trae:'Trae',zcode:'ZCode'};
export const clientOptions={workbuddy:[['workbuddy','WorkBuddy'],['workbuddy-ai','WorkBuddyAI']],qoder:[['qoder','Qoder'],['qoder-ide','Qoder IDE']]} as const;
type Status={installation?:AgentInstallation;readOnly?:boolean;displayName?:string;loginState?:'signed-in'|'signed-out'|'unreadable';readError?:string;unavailableReason?:string;message?:string;organizationId?:string|null;domain?:string;enterpriseId?:string;revision:string;email?:string|null;accountId?:string|null;model?:string|null;pids:number[];backup:{state:string}|null;gatewayConnected:boolean;codexCoexist?:boolean;
 accounts:{organizationId?:string|null;domain?:string;enterpriseId?:string;id:string;email?:string|null;accountId?:string|null;switchable:boolean;reason:string}[]};
export type LoginAccount={id:string;label:string;remaining:number|null;models:string[];switchable:boolean;reason:string;current:boolean;local:boolean};

const post=(body:unknown)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const base=(provider:LoginProvider)=>provider==='codex'?'/api/codex-accounts':`/api/native-accounts/${provider}`;
const usable=(provider:LoginProvider,models:string[])=>provider==='codex'?models.filter(m=>!/(?:gpt-image-|codex-auto-review)/.test(m)):models;

// Mutations invalidate cached snapshots even when their page is not mounted.
export function notifyNativeLoginChanged(){
 invalidateSessionReads('/api/native-accounts/');invalidateSessionReads('/api/codex-accounts');invalidateSessionReads('agent-targets');
 window.dispatchEvent(new Event('tokenflow:native-login-changed'));
}

/** The client's own login (not token-flow): which pooled account it is signed in as, and switching between them. */
export function useNativeLogin(provider:LoginProvider,local:LocalAgentSnapshot,enabled=true){
 const desktop=provider==='workbuddy'||provider==='workbuddy-ai'||provider==='qoder'||provider==='qoder-ide';
 const [status,setStatus]=useState<Status>();const [error,setError]=useState('');const requestVersion=useRef(0);
 const refresh=useCallback(async(force=false,reload=true)=>{const version=++requestVersion.current;try{const next=await readForSession(base(provider),()=>requestJSON<Status>(base(provider)+(force&&(desktop||provider==='cursor')?'?refresh=1':'')),reload);if(version!==requestVersion.current)return;setStatus(next);setError('');}catch(e){if(version!==requestVersion.current)return;setStatus(undefined);setError(e instanceof Error&&/invalid_enum_value|Invalid enum value/.test(e.message)?'请重新打开新版 TokenFlow':'暂时无法读取本机登录');}},[provider,desktop]);
 const sourceAccounts=sourceOptions(local);
 const pool=provider==='workbuddy-ai'?'workbuddy':provider==='qoder-ide'?'qoder':provider;
 const pooled=local.accounts.filter(a=>a.provider===pool&&!a.isDuplicate&&(!a.disabled||provider==='cursor')).map(a=>({...a,models:a.models??[],remaining:sourceAccounts.find(s=>s.id===a.id)?.remaining??null}));
 useEffect(()=>{setStatus(undefined);if(!enabled)return;void refresh(false,false);const reload=()=>void refresh();window.addEventListener('tokenflow:native-login-changed',reload);return()=>{requestVersion.current++;window.removeEventListener('tokenflow:native-login-changed',reload);};},[refresh,enabled]);
 const matches=(credential:Status['accounts'][number]|undefined)=>hasNativeLogin({status,error})&&!!status&&!!credential&&(desktop?desktopIdentityMatches(provider,status,credential):provider==='trae'||provider==='zcode'?!!status.accountId&&status.accountId===credential.accountId:provider==='claude'?!!status.accountId&&status.accountId===credential.accountId&&status.organizationId===credential.organizationId:provider==='codex'?!!status.accountId&&credential.accountId===status.accountId&&(!credential.email||!status.email||credential.email===status.email):!!status.email&&(provider==='cursor'?credential.email?.toLowerCase()===status.email.toLowerCase():credential.email===status.email));

 const accounts:LoginAccount[]=pooled.filter(a=>!desktop||status?.accounts.some(c=>c.id===a.id)).map(a=>{
  const credential=status?.accounts.find(item=>item.id===a.id);
  const current=officialLoginSelected(provider,matches(credential),!!status?.gatewayConnected,!!status?.codexCoexist);
  return {id:a.id,label:a.label,remaining:a.remaining,models:usable(provider,a.models),switchable:!!credential?.switchable,reason:credential?.reason??'',current,local:matches(credential)};
 });
 const current=accounts.find(a=>a.current);
 const nativeCurrent=pooled.find(a=>matches(status?.accounts.find(c=>c.id===a.id)));
 const nativeLabel=hasNativeLogin({status,error})?((provider==='qoder'||provider==='qoder-ide')?status?.email||status?.displayName:'')||nativeCurrent?.label||status?.email||status?.displayName||(status?.accountId?`${loginNames[provider]} 账号 ${status.accountId.slice(0,8)}`:''):'';

 // Only clients with an exclusive gateway mode must release it when returning to official login.
 const releaseGateway=async()=>{
  if(provider==='antigravity')return;
  const targets=(await requestJSON<{targets:Awaited<ReturnType<AgentConnections['status']>>}>('/api/a2a')).targets;
  const target=targets.find(t=>t.id===provider);
  if(target?.connection)await requestJSON('/api/a2a/restore',post({id:target.connection.id,revision:target.revision,allowRunning:true}),600000);
 };
 const switchTo=async(id:string,restartCodex=false)=>{
  if(status?.readOnly)throw new Error('请在官方客户端切换本机登录。');
  const account=accounts.find(a=>a.id===id);if(!account)throw new Error('账号已不可用，请刷新。');if(officialLoginHeld(provider,account.local,account.current,!!status?.codexCoexist))return '';

  let latest=await requestJSON<Status>(base(provider));
  const preferred=`${provider}/${latest.model}`;
  const model=account.models.includes(preferred)?preferred:account.models[0];
  // Codex, desktop clients and Claude use server-side lifecycle checks before releasing the gateway.
  if(!desktop&&provider!=='codex'&&provider!=='claude'&&latest.pids.length)throw new Error(`请先完全退出 ${loginNames[provider]}，再切换本机登录。`);
  if(provider==='codex'&&!model)throw new Error('这个账号还没有可用模型，请先刷新账号。');
  const released=latest.gatewayConnected&&!officialLoginCoexists(provider,!!latest.codexCoexist);
  if(released&&!desktop&&provider!=='codex'&&provider!=='claude'){await releaseGateway();latest=await requestJSON<Status>(base(provider));}
  const body=provider==='codex'?{revision:latest.revision,allowRunning:true,restartCodex,sourceId:id,model}:provider==='claude'?{revision:latest.revision,sourceId:id,restart:true}:{revision:latest.revision,sourceId:id};
  const saved=await requestJSON<Status>(`${base(provider)}/switch`,post(body),provider==='codex'||provider==='claude'||desktop?600000:20000);setStatus(saved);
  notifyNativeLoginChanged();
  return saved.message??(latest.gatewayConnected&&!saved.gatewayConnected?`已先断开 TokenFlow 接入，${loginNames[provider]} 现在直接使用自己的登录。`:'');
 };
 const restore=async()=>{
  const latest=await requestJSON<Status>(base(provider));
  setStatus(await requestJSON<Status>(`${base(provider)}/restore`,post(provider==='codex'?{revision:latest.revision,allowRunning:true}:provider==='claude'?{revision:latest.revision,restart:true}:{revision:latest.revision}),provider==='codex'||provider==='claude'||desktop?600000:20000));
  notifyNativeLoginChanged();
 };
 return {status,error,accounts,current,nativeCurrent,nativeLabel,refresh,switchTo,restore};
}
