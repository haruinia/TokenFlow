import {workbuddyLoginTarget} from '../../packages/core/src/workbuddy-region';

type Identity={accountId?:string|null;domain?:string;enterpriseId?:string};
/** These clients keep their official login alongside separately imported custom models. */
export function officialLoginCoexists(provider:string,codexCoexist=false){return provider==='workbuddy'||provider==='workbuddy-ai'||provider==='qoder'||provider==='codex'&&codexCoexist;}
/** A matching machine login stays locked only while it is the active official session, or on clients where that login coexists with gateway models. Exclusive Codex and Claude modes can be clicked again to leave the gateway. */
export function officialLoginHeld(provider:string,local:boolean,current:boolean,codexCoexist=false){return local&&(current||officialLoginCoexists(provider,codexCoexist));}
export function officialLoginSelected(provider:string,matches:boolean,gatewayConnected:boolean,codexCoexist=false){return matches&&(officialLoginCoexists(provider,codexCoexist)||!gatewayConnected);}
/** Compare identity only; permission to switch is validated separately by the server. */
export function desktopIdentityMatches(provider:string,native:Identity,account:Identity){
 if(!native.accountId||account.accountId!==native.accountId||(account.enterpriseId??'')!==(native.enterpriseId??''))return false;
 if(provider==='workbuddy'||provider==='workbuddy-ai')return workbuddyLoginTarget(account.domain)===provider&&workbuddyLoginTarget(native.domain)===provider;
 return (account.domain??'')===(native.domain??'');
}
