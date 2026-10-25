import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {CodexGatewayWorkers,gatewayWorkerErrorText} from './codex-gateway-workers.js';

type Message={id?:string|number;method?:string;params?:any;result?:any;error?:any};
type ThreadState={provider:string;model:string;resume:any;settings:any;busy:boolean;gatewayDirty:boolean;persistent:boolean;sandbox:any};
export type CodexBridgeRouting={officialModels:string[];gatewayModels:string[]};
const error=(message:string)=>Object.assign(new Error(message),{code:-32001});
const settingsKeys=['cwd','runtimeWorkspaceRoots','approvalPolicy','approvalsReviewer','serviceTier','permissions','sandbox','config','baseInstructions','developerInstructions'];
// Optional request nulls inherit effective settings; only serviceTier null clears.
const hasOverride=(params:any,key:string)=>params[key]!==undefined&&(params[key]!==null||key==='serviceTier');
/** A stdio protocol adapter, not an inference proxy. Native OpenAI never calls TokenFlow. */
export class CodexProviderBridge {
 private serial=0;private prefix=`tf_bridge_${randomUUID()}_`;
 private internal=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 private requests=new Map<string|number,Message>();private threads=new Map<string,ThreadState>();
 private queues=new Map<string,Promise<void>>();private compactions=new Map<string,{resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 private serverRequests=new Map<string|number,string>();
 private workers?:CodexGatewayWorkers;
 private workerToolRequests=new Map<string|number,Message>();
 constructor(private routing:()=>CodexBridgeRouting,private toEngine:(message:Message)=>void,private toClient:(message:Message)=>void,private report:(event:{stage:string;provider?:string})=>void=()=>{},gatewayWorkers=false){if(gatewayWorkers)this.workers=new CodexGatewayWorkers((m,p)=>this.rpc(m,p),id=>this.threads.get(id),()=>this.routing().gatewayModels);}
 private route(model:unknown){if(typeof model!=='string')return undefined;const r=this.routing();return r.gatewayModels.includes(model)?'token_flow':r.officialModels.includes(model)?'openai':undefined;}
 private rpc(method:string,params:any){return new Promise<any>((resolve,reject)=>{const id=this.prefix+(++this.serial),timer=setTimeout(()=>{this.internal.delete(id);reject(error('会话切换超时，请重试；原对话保留。'));},60000);this.internal.set(id,{resolve,reject,timer});this.toEngine({id,method,params});});}
 private remember(result:any,params:any={}){
  if(!result?.thread?.id||typeof result.modelProvider!=='string')return;
  const id=result.thread.id,previous=this.threads.get(id);
  const resume={...previous?.resume,...Object.fromEntries(settingsKeys.filter(k=>hasOverride(params,k)).map(k=>[k,params[k]]))};
  for(const k of ['cwd','runtimeWorkspaceRoots','approvalPolicy','approvalsReviewer','serviceTier'])if(result[k]!==undefined)resume[k]=result[k];
  if(result.activePermissionProfile?.id){resume.permissions=result.activePermissionProfile.id;delete resume.sandbox;}
  else if(result.sandbox){const type=result.sandbox.type;const modes:Record<string,string>={readOnly:'read-only',workspaceWrite:'workspace-write',dangerFullAccess:'danger-full-access'};if(modes[type]){resume.sandbox=modes[type];delete resume.permissions;}else resume.unsupportedSandbox=true;}
  const settings={...previous?.settings,model:result.model,effort:result.reasoningEffort,collaborationMode:result.collaborationMode,disabledPluginIds:result.disabledPluginIds};
  this.threads.set(id,{provider:result.modelProvider,model:result.model,resume,settings,sandbox:result.sandbox,persistent:result.thread.ephemeral===false,busy:result.thread.status?.type==='active',gatewayDirty:previous?.gatewayDirty??result.modelProvider==='token_flow'});
 }
 private forward(message:Message){if(message.id!==undefined&&message.method)this.requests.set(message.id,message);if(message.method==='turn/start'){const state=this.threads.get(message.params?.threadId);if(state)state.busy=true;}this.toEngine(message);}
 receiveClient(message:Message){
  if(message.method==='turn/interrupt')void this.workers?.cancelParent(message.params?.threadId);
  if(message.id!==undefined&&!message.method)this.serverRequests.delete(message.id);
  const params=message.params??{},id=params.threadId;
  const changes=['turn/start','thread/settings/update','thread/resume'].includes(message.method??'');
  if(changes&&typeof id==='string'){
   const previous=this.queues.get(id)??Promise.resolve();const next=previous.then(async()=>{
    try{
     let state=this.threads.get(id);
     if(!state){this.remember(await this.rpc('thread/resume',{threadId:id}));state=this.threads.get(id);}
     const selected=params.model??params.collaborationMode?.settings?.model??state?.model,route=this.route(selected);
     if(route&&state&&state.provider!==route)await this.switchProvider(id,route,selected);
     if(route&&message.method==='thread/resume')message={...message,params:{...params,modelProvider:route}};
     this.forward(message);
    }catch(e){if(message.id!==undefined)this.toClient({id:message.id,error:{code:-32001,message:e instanceof Error?e.message:'会话切换未完成，原对话保留。'}});}
   });this.queues.set(id,next);void next.finally(()=>{if(this.queues.get(id)===next)this.queues.delete(id);});return;
  }
  if(message.method==='thread/start'||message.method==='thread/fork'){
   const route=this.route(params.model);if(route)message={...message,params:{...params,modelProvider:route}};
   if(message.method==='thread/start'&&this.workers&&this.routing().gatewayModels.length&&(route==='openai'||(!params.model&&(!params.modelProvider||params.modelProvider==='openai')))){
    const augmented=this.workers.augment(message.params??{});
    if(augmented!==message.params&&message.id!==undefined){this.workerToolRequests.set(message.id,message);message={...message,params:augmented};}
   }
  }
  this.forward(message);
 }
 receiveEngine(message:Message){
  const params=message.params??{},id=params.threadId??params.thread?.id;
  this.workers?.receive(message);
  if(this.workers?.owns(message)&&message.id!==undefined){
   this.serverRequests.set(message.id,id);
   void this.workers.handle(id,params.tool,params.arguments).then(result=>this.toEngine({id:message.id,result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]}}),e=>this.toEngine({id:message.id,result:{success:false,contentItems:[{type:'inputText',text:gatewayWorkerErrorText(e)}]}})).finally(()=>this.serverRequests.delete(message.id!));return;
  }
  if(message.method==='thread/closed')this.threads.delete(id);
  if(message.method&&message.id!==undefined&&typeof id==='string')this.serverRequests.set(message.id,id);
  if(message.method==='turn/started'&&this.threads.has(id))this.threads.get(id)!.busy=true;
  if(message.method==='turn/completed'){
   if(params.turn?.status!=='completed')void this.workers?.cancelParent(id);
   const state=this.threads.get(id);if(state){state.busy=false;if(state.provider==='token_flow')state.gatewayDirty=true;}
   const waiting=this.compactions.get(id);if(waiting){clearTimeout(waiting.timer);this.compactions.delete(id);params.turn?.status==='completed'?waiting.resolve():waiting.reject(error('网关摘要未完成，尚未切到官方直连。'));}
  }
  if(message.method==='thread/settings/updated'){
   void this.workers?.cancelParent(id);
   const s=this.threads.get(id),v=params.threadSettings;if(s&&v){s.provider=v.modelProvider;s.model=v.model;s.sandbox=v.sandboxPolicy;s.settings={...s.settings,...v};for(const k of ['cwd','approvalPolicy','approvalsReviewer','serviceTier'])if(v[k]!==undefined)s.resume[k]=v[k];if(v.activePermissionProfile?.id){s.resume.permissions=v.activePermissionProfile.id;delete s.resume.sandbox;}}
  }
  if(message.id!==undefined&&!message.method){
   const withoutWorkerTools=this.workerToolRequests.get(message.id);this.workerToolRequests.delete(message.id);
   // An older official engine may not support the optional extension schema.
   // Fall back to its untouched thread creation; never substitute an engine.
   if(withoutWorkerTools&&[-32600,-32602].includes(message.error?.code)&&/dynamic.?tools|experimental|namespace/i.test(message.error?.message??'')){this.forward(withoutWorkerTools);return;}
   const internal=typeof message.id==='string'?this.internal.get(message.id):undefined;
   if(internal){clearTimeout(internal.timer);this.internal.delete(message.id as string);if(message.error)internal.reject(error('Codex 拒绝了会话重载，原对话保留。'));else internal.resolve(message.result);return;}
   const request=this.requests.get(message.id);this.requests.delete(message.id);
   if(request?.method==='turn/start'&&message.error){const state=this.threads.get(request.params?.threadId);if(state)state.busy=false;}
   if(request&&!message.error){
    if(request.method==='thread/unsubscribe')this.threads.delete(request.params?.threadId);
    if(['thread/start','thread/resume','thread/fork'].includes(request.method??''))this.remember(message.result,request.params);
    const state=this.threads.get(request.params?.threadId);
    if(state&&['turn/start','thread/settings/update'].includes(request.method??'')){
     for(const k of ['model','effort','summary','serviceTier','collaborationMode','disabledPluginIds'])if(hasOverride(request.params,k))state.settings[k]=request.params[k];
     for(const k of settingsKeys)if(hasOverride(request.params,k))state.resume[k]=request.params[k];
     if(request.method==='turn/start')state.busy=true;
    }
   }
  }
  this.toClient(message);
 }
 private async switchProvider(id:string,provider:string,model:string){
  const current=this.threads.get(id)!;
  if(current.busy||[...this.serverRequests.values()].includes(id))throw error('请等待当前回复、工具操作或审批结束，再切换模型。');
  if(!current.persistent)throw error('临时会话不能自动重载，请使用已保存的对话。');
  const terminals=await this.rpc('thread/backgroundTerminals/list',{threadId:id,limit:1});
  if(!Array.isArray(terminals?.data)||terminals.data.length||terminals.nextCursor)throw error('此对话仍有后台终端，请结束后台任务后再切换模型。');
  if(current.resume.unsupportedSandbox)throw error('此会话使用自定义外部沙箱，暂不支持自动切换 provider。');
  if(current.provider!=='openai'&&current.provider!=='token_flow')throw error('此会话由其他 provider 管理，未自动修改连接。');
  // A readable Codex-owned summary makes gateway history portable without editing
  // a rollout while its app-server is running, or forwarding official traffic.
  if(current.provider==='token_flow'&&current.gatewayDirty){
   this.report({stage:'summarizing',provider});
   const done=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{this.compactions.delete(id);reject(error('网关摘要超时，尚未切到官方直连。'));},180000);this.compactions.set(id,{resolve,reject,timer});});
   try{await Promise.all([this.rpc('thread/compact/start',{threadId:id}),done]);}catch(e){const c=this.compactions.get(id);if(c){clearTimeout(c.timer);this.compactions.delete(id);}throw e;}
  }
  this.report({stage:'reloading',provider});
  const old={provider:current.provider,model:current.model,resume:structuredClone(current.resume),settings:structuredClone(current.settings),sandbox:structuredClone(current.sandbox)};
  await this.rpc('thread/unsubscribe',{threadId:id});
  try{
   const loaded=await this.rpc('thread/resume',{...old.resume,threadId:id,model,modelProvider:provider});
   if(loaded.modelProvider!==provider)throw error('其他窗口仍订阅着此对话，暂时无法切换；请关闭该对话的其他视图后重试。');
   if(!isDeepStrictEqual(loaded.sandbox,old.sandbox)||!isDeepStrictEqual(loaded.approvalPolicy,old.resume.approvalPolicy))throw error('会话重载后的权限设置不一致，未发送新请求。');
   this.remember(loaded,old.resume);
   const overrides={threadId:id,...old.settings,model};
   for(const k of ['modelProvider','cwd','approvalPolicy','approvalsReviewer','sandboxPolicy','activePermissionProfile'])delete overrides[k];
   if(overrides.collaborationMode?.settings)overrides.collaborationMode={...overrides.collaborationMode,settings:{...overrides.collaborationMode.settings,model}};
   await this.rpc('thread/settings/update',overrides);
   this.threads.get(id)!.gatewayDirty=false;
   this.report({stage:'ready',provider});
  }catch(e){
   try{await this.rpc('thread/unsubscribe',{threadId:id});this.remember(await this.rpc('thread/resume',{...old.resume,threadId:id,model:old.model,modelProvider:old.provider}),old.resume);}catch{/* Never send the pending turn on an unverified route. */}
   this.report({stage:'failed',provider});throw e;
  }
 }
 close(){this.workers?.close();for(const p of this.internal.values()){clearTimeout(p.timer);p.reject(error('Codex 会话连接已关闭。'));}this.internal.clear();for(const p of this.compactions.values()){clearTimeout(p.timer);p.reject(error('Codex 会话连接已关闭。'));}this.compactions.clear();}
}
