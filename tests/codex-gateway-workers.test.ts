import {afterEach,expect,it} from 'vitest';
import {CodexGatewayWorkers} from '../packages/core/src/codex-gateway-workers';
import {CodexProviderBridge} from '../packages/core/src/codex-provider-bridge';
const cleanup:Array<()=>void>=[];afterEach(()=>cleanup.splice(0).forEach(f=>f()));
function fixture({mismatch=false,fail=false}:{mismatch?:boolean;fail?:boolean}={}){
 const parent:any={provider:'openai',model:'official',resume:{cwd:'/tmp',approvalPolicy:'never',runtimeWorkspaceRoots:['/tmp']},settings:{disabledPluginIds:['disabled']},sandbox:{type:'workspaceWrite',writableRoots:['/tmp'],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}};
 const calls:any[]=[];let count=0;const children=new Map<string,any>();
 const workers=new CodexGatewayWorkers(async(method,params)=>{calls.push({method,params});
  if(method==='thread/start'){const id='child-'+(++count);const child={thread:{id},model:params.model,modelProvider:params.modelProvider,approvalPolicy:params.approvalPolicy,sandbox:mismatch?{type:'dangerFullAccess'}:parent.sandbox};children.set(id,child);return child;}
  if(method==='thread/resume'){const c=structuredClone(children.get(params.threadId));if(mismatch)c.sandbox={type:'dangerFullAccess'};return c;}
  if(method==='turn/start'){if(fail)throw Error('private upstream credential detail');return {turn:{id:'turn-'+count}};}
  return {};
 },id=>['parent','other'].includes(id)?parent:undefined,()=>['gateway']);cleanup.push(()=>workers.close());return {workers,parent,calls};
}
const spawn={task_name:'child',model:'gateway',message:'Explicit task only',fork_turns:'none'};
it('creates only gateway work sessions, verifies effective permissions before inference, and returns the result',async()=>{
 const f=fixture();const t:any=await f.workers.handle('parent','spawn_agent',spawn);
 expect(t.status).toBe('running');expect(f.calls.map(c=>c.method)).toEqual(['thread/start','thread/settings/update','turn/start']);
 expect(f.calls[0].params).toMatchObject({modelProvider:'token_flow',approvalPolicy:'never',sandbox:'workspace-write',runtimeWorkspaceRoots:['/tmp']});expect(f.calls[1].params).toMatchObject({disabledPluginIds:['disabled']});expect(f.calls[2].params.input).toEqual([{type:'text',text:spawn.message}]);expect(JSON.stringify(f.calls)).not.toContain('history');
 f.workers.receive({method:'item/completed',params:{threadId:t.thread_id,item:{type:'agentMessage',text:'RESULT'}}});f.workers.receive({method:'turn/completed',params:{threadId:t.thread_id,turn:{status:'completed'}}});
 expect(await f.workers.handle('parent','wait_agent',{target:t.task_id,timeout_ms:0})).toMatchObject({status:'completed',result:'RESULT\n'});
 const continued:any=await f.workers.handle('parent','followup_task',{target:t.task_id,message:'continue'});expect(continued.status).toBe('running');expect(f.calls.filter(c=>c.method==='thread/start')).toHaveLength(1);
});
it('does not start inference when permission verification fails',async()=>{
 const f=fixture({mismatch:true});expect(await f.workers.handle('parent','spawn_agent',spawn)).toMatchObject({status:'failed'});expect(f.calls.some(c=>c.method==='turn/start')).toBe(false);expect(f.calls.at(-1).method).toBe('thread/unsubscribe');
});
it('rejects official targets, encrypted/full-history inputs and gateway parents without creating sessions',async()=>{
 const f=fixture();for(const input of [{...spawn,model:'official'},{...spawn,fork_turns:'all'},{...spawn,encrypted_message:true}])await expect(f.workers.handle('parent','spawn_agent',input)).rejects.toThrow();f.parent.provider='token_flow';await expect(f.workers.handle('parent','spawn_agent',spawn)).rejects.toThrow('仅供官方');expect(f.calls).toHaveLength(0);
});
it('scopes management to the parent and forwards cancellation to the real worker turn',async()=>{
 const f=fixture();const t:any=await f.workers.handle('parent','spawn_agent',spawn);await expect(f.workers.handle('other','interrupt_agent',{target:t.task_id})).rejects.toThrow('不属于');await f.workers.cancelParent('parent');expect(f.calls.at(-1)).toEqual({method:'turn/interrupt',params:{threadId:t.thread_id,turnId:'turn-1'}});expect(await f.workers.handle('parent','wait_agent',{target:t.task_id,timeout_ms:0})).toMatchObject({status:'cancelled'});
});
it('reports failures without leaking transport errors, bounds concurrency, and blocks followup after permission change',async()=>{
 const f=fixture({fail:true});const t:any=await f.workers.handle('parent','spawn_agent',spawn);expect(t.status).toBe('failed');expect(JSON.stringify(t)).not.toContain('private');f.parent.sandbox.networkAccess=true;await expect(f.workers.handle('parent','followup_task',{target:t.task_id,message:'continue'})).rejects.toThrow('权限已变化');
 const g=fixture();for(let i=0;i<4;i++)await g.workers.handle('parent','spawn_agent',spawn);await expect(g.workers.handle('parent','spawn_agent',spawn)).rejects.toThrow('上限');
});
it('adds an extension only for new official sessions and forwards native tools unchanged',()=>{
 const engine:any[]=[],client:any[]=[];const bridge=new CodexProviderBridge(()=>({officialModels:['official'],gatewayModels:['gateway']}),m=>engine.push(m),m=>client.push(m),()=>{},true);cleanup.push(()=>bridge.close());
 const official={id:1,method:'thread/start',params:{model:'official',dynamicTools:[{type:'function',name:'existing',description:'existing',inputSchema:{type:'object'}}]}};bridge.receiveClient(official);expect(engine[0].params.dynamicTools[0]).toEqual(official.params.dynamicTools[0]);expect(engine[0].params.dynamicTools[1].name).toBe('tokenflow_gateway');
 const gateway={id:2,method:'thread/start',params:{model:'gateway',modelProvider:'token_flow'}};bridge.receiveClient(gateway);expect(engine[1]).toEqual(gateway);
 for(const m of [{id:10,method:'item/tool/call',params:{threadId:'parent',namespace:'collaboration',tool:'spawn_agent',arguments:{model:'official',message:'unchanged'}}},{method:'item/completed',params:{threadId:'parent',item:{type:'collabAgentToolCall'}}}]){bridge.receiveEngine(m);expect(client.at(-1)).toEqual(m);}
 expect(JSON.stringify(engine)).not.toContain('multi_agent_v2');
});

it('falls back to original thread creation if an official version rejects the optional extension',()=>{
 const engine:any[]=[],client:any[]=[];const bridge=new CodexProviderBridge(()=>({officialModels:['official'],gatewayModels:['gateway']}),m=>engine.push(m),m=>client.push(m),()=>{},true);cleanup.push(()=>bridge.close());
 const original={id:1,method:'thread/start',params:{model:'official',modelProvider:'openai'}};bridge.receiveClient(original);expect(engine[0].params.dynamicTools).toHaveLength(1);
 bridge.receiveEngine({id:1,error:{code:-32602,message:'dynamicTools requires experimental API support'}});expect(engine[1]).toEqual(original);expect(client).toHaveLength(0);
 bridge.receiveEngine({id:1,result:{thread:{id:'original'},model:'official',modelProvider:'openai'}});expect(client).toHaveLength(1);
});
