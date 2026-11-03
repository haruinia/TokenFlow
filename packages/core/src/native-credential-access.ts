/** Per-process intent, separate from access to credentials already saved in TokenFlow. */
export class NativeCredentialAccess {
 private requested=new Set<string>();
 constructor(private onDemand:boolean,private onRequest?:(provider:string)=>void){}
 allows(provider:string){return !this.onDemand||this.requested.has(provider);}
 request(provider:string){this.onRequest?.(provider);this.requested.add(provider);}
}
export const uninspectedNativeStatus=(accounts:unknown[]=[])=>({loginState:'not-inspected' as const,message:accounts.length?'已加载 TokenFlow 保存的账号，本机当前登录尚未检查。':'点击“从本机导入”后读取此客户端的登录。',revision:'',email:null,accountId:null,pids:[],backup:null,gatewayConnected:false,accounts});
