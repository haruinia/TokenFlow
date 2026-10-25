import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';

// Only locally authored validation messages may be returned to the model.
export class GatewayWorkerError extends Error {}
export function gatewayWorkerErrorText(error:unknown){
 const detail=error instanceof GatewayWorkerError?error.message:error instanceof z.ZodError?'参数格式无效，请按此工具的参数定义重新调用。':'内部操作失败，请检查会话桥与 TokenFlow 的连接后重试。';
 return '网关任务操作未完成：'+detail;
}
type Parent={provider:string;model:string;resume:any;settings:any;sandbox:any};
type Task={id:string;parent:string;name:string;model:string;threadId?:string;turnId?:string;status:'starting'|'running'|'completed'|'failed'|'cancelled';output:string;error?:string;permissions:any;timer?:ReturnType<typeof setTimeout>};
const taskInput=z.object({model:z.string(),task_name:z.string().regex(/^[a-z0-9_]{1,64}$/),message:z.string().min(1).max(64000),reasoning_effort:z.enum(['low','medium','high','xhigh']).optional(),fork_turns:z.literal('none').optional()}).strict();
const targetInput=z.object({target:z.string().uuid()}).strict();
const followupInput=targetInput.extend({message:z.string().min(1).max(64000)});
const waitInput=targetInput.extend({timeout_ms:z.number().int().min(0).max(30000).optional()});
const namespace='tokenflow_gateway';
const schema=(properties:any,required:string[])=>({type:'object',properties,required,additionalProperties:false});
const target={target:{type:'string',description:'The task ID returned by this gateway tool, not a native agent path.'}};
/** Client-side independent work sessions on the installed official app-server.
 * Never intercept native collaboration tools or change the parent's provider. */
export class CodexGatewayWorkers {
 private tasks=new Map<string,Task>();private closed=false;
 constructor(private rpc:(method:string,params:any)=>Promise<any>,private parent:(id:string)=>Parent|undefined,private models:()=>string[]){}
 tools(){return {type:'namespace',name:namespace,description:'Only for an official OpenAI parent delegating to a configured gateway model. Creates independent Codex work sessions, not native collaboration children. Use native collaboration for official→official and gateway→gateway. Only explicit task text is shared; full-history fork is unsupported. Use this namespace to list, wait, cancel or follow up these tasks.',tools:[
  {type:'function',name:'spawn_agent',description:'Start an independent gateway work session with the parent’s current sandbox and approval policy. Returns a task ID; use wait_agent for the result.',inputSchema:schema({model:{type:'string',enum:this.models()},task_name:{type:'string'},message:{type:'string',maxLength:64000},reasoning_effort:{type:'string',enum:['low','medium','high','xhigh']},fork_turns:{type:'string',enum:['none']}},['model','task_name','message'])},
  {type:'function',name:'list_agents',description:'List only the independent gateway tasks owned by this conversation.',inputSchema:schema({},[])},
  {type:'function',name:'wait_agent',description:'Wait up to 30 seconds and return status and the completed result. Call again if still running.',inputSchema:schema({...target,timeout_ms:{type:'integer',minimum:0,maximum:30000}},['target'])},
  {type:'function',name:'interrupt_agent',description:'Cancel a gateway task. Does not cancel or modify the parent conversation.',inputSchema:schema(target,['target'])},
  {type:'function',name:'followup_task',description:'Send a new task to a completed independent gateway work session. Parent permissions must still match.',inputSchema:schema({...target,message:{type:'string',maxLength:64000}},['target','message'])}
 ]};}
 augment(params:any){const existing=params.dynamicTools??[];if(!Array.isArray(existing)||existing.some((t:any)=>t.name===namespace))return params;
 // Do not convert or reinterpret a client's legacy dynamic-tool schema.
 if(existing.some((t:any)=>!t.type))return params;
 return {...params,dynamicTools:[...existing,this.tools()]};}
 owns(message:any){return message.method==='item/tool/call'&&message.params?.namespace===namespace;}
 private snapshot(p:Parent){return {sandbox:structuredClone(p.sandbox),approvalPolicy:p.resume.approvalPolicy,approvalsReviewer:p.resume.approvalsReviewer,permissions:p.resume.permissions,cwd:p.resume.cwd,runtimeWorkspaceRoots:p.resume.runtimeWorkspaceRoots,disabledPluginIds:p.settings.disabledPluginIds};}
 private view(t:Task){return {task_id:t.id,task_name:t.name,model:t.model,thread_id:t.threadId,status:t.status,...(t.status==='completed'?{result:t.output}:{}),...(t.error?{error:t.error}:{})};}
 private owned(parent:string,id:string){const t=this.tasks.get(id);if(!t||t.parent!==parent)throw new GatewayWorkerError('此任务不属于当前对话，或会话桥已重启。');return t;}
 private async stop(t:Task){if(['starting','running'].includes(t.status)){t.status='cancelled';clearTimeout(t.timer);if(t.threadId&&t.turnId)await this.rpc('turn/interrupt',{threadId:t.threadId,turnId:t.turnId});}}
 async cancelParent(id:string){await Promise.allSettled([...this.tasks.values()].filter(t=>t.parent===id).map(t=>this.stop(t)));}
 private async run(t:Task,message:string,effort?:string){
  t.status='running';t.output='';delete t.error;delete t.turnId;
  t.timer=setTimeout(()=>{t.error='任务超过 30 分钟，已请求取消。';void this.stop(t).catch(()=>{});},1800000);t.timer.unref?.();
  try{const r=await this.rpc('turn/start',{threadId:t.threadId,model:t.model,...(effort?{effort}:{}),input:[{type:'text',text:message}]});t.turnId=r.turn.id;if((t.status as string)==='cancelled')await this.rpc('turn/interrupt',{threadId:t.threadId,turnId:t.turnId});}
  catch{if((t.status as string)!=='cancelled'){t.status='failed';t.error='网关任务启动失败；请检查 TokenFlow 是否在线及该模型是否可用。';}clearTimeout(t.timer);}
 }
 async handle(parentId:string,tool:string,args:unknown){
  if(this.closed)throw new GatewayWorkerError('会话桥已关闭。');const p=this.parent(parentId);
  if(!p)throw new GatewayWorkerError('未找到父会话的有效设置，请重新打开本对话后重试。');
  if(p.provider!=='openai')throw new GatewayWorkerError('此入口仅供官方主代理派发网关任务；当前 provider 请使用原生派发。');
  if(tool==='list_agents'){z.object({}).strict().parse(args);return [...this.tasks.values()].filter(t=>t.parent===parentId).map(t=>this.view(t));}
  if(tool==='spawn_agent'){
   const a=taskInput.parse(args);if(!this.models().includes(a.model))throw new GatewayWorkerError('所选模型不在已配置的网关模型列表中。');
   const own=[...this.tasks.values()].filter(t=>t.parent===parentId);if(own.filter(t=>['starting','running'].includes(t.status)).length>=4||own.length>=64)throw new GatewayWorkerError('当前对话的网关任务数量已达上限。');
   const permissions=this.snapshot(p);if(!permissions.cwd||permissions.approvalPolicy==null||!p.sandbox||p.resume.unsupportedSandbox)throw new GatewayWorkerError('无法确认父会话的权限，未创建网关任务。');
   const sandbox=({readOnly:'read-only',workspaceWrite:'workspace-write',dangerFullAccess:'danger-full-access'} as Record<string,string>)[p.sandbox.type];if(!sandbox)throw new GatewayWorkerError('此沙箱类型暂不支持独立网关任务。');
   const t:Task={id:randomUUID(),parent:parentId,name:a.task_name,model:a.model,status:'starting',output:'',permissions};this.tasks.set(t.id,t);
   try{
    const child=await this.rpc('thread/start',{model:a.model,modelProvider:'token_flow',cwd:permissions.cwd,runtimeWorkspaceRoots:permissions.runtimeWorkspaceRoots,approvalPolicy:permissions.approvalPolicy,approvalsReviewer:permissions.approvalsReviewer,...(permissions.permissions?{permissions:permissions.permissions}:{sandbox})});t.threadId=child.thread.id;
    // A fresh thread has no rollout until its first turn; thread/resume cannot
    // verify it yet. Verify the authoritative thread/start response instead.
    if(child.modelProvider!=='token_flow'||child.model!==a.model||!isDeepStrictEqual(child.sandbox,permissions.sandbox)||!isDeepStrictEqual(child.approvalPolicy,permissions.approvalPolicy))throw new GatewayWorkerError('权限或 provider 校验失败。');
    if(permissions.disabledPluginIds!==undefined)await this.rpc('thread/settings/update',{threadId:t.threadId,disabledPluginIds:permissions.disabledPluginIds});
    if(!isDeepStrictEqual(this.snapshot(this.parent(parentId)!),permissions))throw new GatewayWorkerError('父会话权限已变化。');
    if(t.status==='cancelled'||this.closed){await this.rpc('thread/unsubscribe',{threadId:t.threadId});return this.view(t);}
    await this.run(t,a.message,a.reasoning_effort);
   }catch{if(t.status!=='cancelled'){t.status='failed';t.error='未能以父会话权限创建网关任务，未发送任务内容。';}if(t.threadId)await this.rpc('thread/unsubscribe',{threadId:t.threadId}).catch(()=>{});}
   return this.view(t);
  }
  const a=(tool==='followup_task'?followupInput:tool==='wait_agent'?waitInput:targetInput).parse(args);const t=this.owned(parentId,a.target);
  if(tool==='interrupt_agent'){await this.stop(t);return this.view(t);}
  if(tool==='followup_task'){
   if(['starting','running'].includes(t.status))throw new GatewayWorkerError('任务仍在运行，请先等待或取消。');
   if(!isDeepStrictEqual(t.permissions,this.snapshot(p)))throw new GatewayWorkerError('父会话权限已变化，请创建新任务。');
   if(!this.models().includes(t.model)||!t.threadId)throw new GatewayWorkerError('此网关任务已不可继续。');
   const previous=t.status;t.status='starting';
   try{
    const checked=await this.rpc('thread/resume',{threadId:t.threadId,excludeTurns:true});
    if(checked.modelProvider!=='token_flow'||checked.model!==t.model||!isDeepStrictEqual(checked.sandbox,t.permissions.sandbox)||!isDeepStrictEqual(checked.approvalPolicy,t.permissions.approvalPolicy))throw new GatewayWorkerError('工作会话的权限或 provider 已变化，请创建新任务。');
    if((t.status as string)==='cancelled'||this.closed)return this.view(t);
    await this.run(t,(a as z.infer<typeof followupInput>).message);return this.view(t);
   }catch(e){if(t.status==='starting')t.status=previous;throw e;}
  }
  if(tool==='wait_agent'){
   const until=Date.now()+((a as z.infer<typeof waitInput>).timeout_ms??30000);
   while(!this.closed&&['starting','running'].includes(t.status)&&Date.now()<until)await new Promise(r=>setTimeout(r,100));return this.view(t);
  }
  throw new GatewayWorkerError('未知网关任务操作。');
 }
 receive(message:any){const p=message.params??{},id=p.threadId??p.thread?.id;const t=[...this.tasks.values()].find(t=>t.threadId===id);if(!t)return;
  if(message.method==='turn/started'){t.turnId=p.turn?.id;if(t.status==='cancelled'&&t.turnId)void this.rpc('turn/interrupt',{threadId:id,turnId:t.turnId}).catch(()=>{});}
  if(message.method==='item/completed'&&p.item?.type==='agentMessage'&&t.status==='running')t.output=(t.output+p.item.text+'\n').slice(-64000);
  if(message.method==='turn/completed'){clearTimeout(t.timer);if(t.status!=='cancelled'){t.status=p.turn?.status==='completed'?'completed':p.turn?.status==='interrupted'?'cancelled':'failed';if(t.status==='failed')t.error='网关回复未完成。可查看独立工作会话中的错误，或在恢复服务后重试。';}}
 }
 close(){this.closed=true;for(const t of this.tasks.values()){clearTimeout(t.timer);if(['starting','running'].includes(t.status))t.status='cancelled';}}
}
