/** Saved gateway accounts alone are not evidence of a local client login. */
export function hasNativeLogin(login:{
 error?:string;
 status?:{email?:string|null;accountId?:string|null;displayName?:string;loginState?:'signed-in'|'signed-out'|'unreadable'|'not-inspected';readError?:string};
}|undefined):boolean{
 if(!login?.status||login.error||login.status.readError)return false;
 if(login.status.loginState==='signed-out'||login.status.loginState==='unreadable'||login.status.loginState==='not-inspected')return false;
 return login.status.loginState==='signed-in'||!!(login.status.email?.trim()||login.status.accountId?.trim()||login.status.displayName?.trim());
}
