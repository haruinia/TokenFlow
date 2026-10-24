import {parse} from 'smol-toml';

export type CodexRoutingMode='official'|'gateway'|'coexist'|'external'|'unreadable';
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

/** Saved routing only: a running Codex process may still hold its previous config. */
export function codexRoutingMode(current:string|null):CodexRoutingMode {
 try{
  const doc=parse(current??'');
  const profiles=object(doc.profiles);
  if(doc.profile!==undefined&&(typeof doc.profile!=='string'||!profiles[doc.profile]))return 'unreadable';
  const profile=typeof doc.profile==='string'?object(profiles[doc.profile]):{};
  const config={...doc,...profile};
  const providerConfig=(id:string)=>({...object(object(doc.model_providers)[id]),...object(object(profile.model_providers)[id])});
  const provider=config.model_provider??'openai';
  if(provider==='openai')return config.openai_base_url||Object.keys(providerConfig('openai')).length?'external':'official';
  if(provider!=='token_flow')return 'external';
  const route=providerConfig('token_flow');
  if(typeof route.base_url!=='string')return 'external';
  const url=new URL(route.base_url);
  if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)return 'external';
  const path=url.pathname.replace(/\/$/,'');
  return path==='/codex/v1'?'coexist':path==='/v1'?'gateway':'external';
 }catch{return 'unreadable';}
}
