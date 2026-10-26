import {afterEach,expect,it,vi} from 'vitest';
import {CodexProviderBridge} from '../packages/core/src/codex-provider-bridge';
const cleanup:CodexProviderBridge[]=[];afterEach(()=>cleanup.splice(0).forEach(b=>b.close()));
function fixture(options:{busy?:boolean;ephemeral?:boolean;terminals?:boolean;otherSubscriber?:boolean;changedPermission?:boolean;compactError?:boolean}={}){
 const engine:any[]=[],client:any[]=[],reports:any[]=[];let provider='openai',model='official';
 const sandbox={type:'readOnly',networkAccess:false};
 const result=()=>({thread:{id:'thread',ephemeral:!!options.ephemeral,status:{type:options.busy?'active':'idle'}},modelProvider:provider,model,sandbox,approvalPolicy:'never',cwd:'/tmp',reasoningEffort:'high',serviceTier:'priority'});
 let bridge:CodexProviderBridge;
 bridge=new CodexProviderBridge(()=>({officialModels:['official'],gatewayModels:['gateway']}),message=>{
  engine.push(message);
  if(typeof message.id!=='string'||!message.id.startsWith('tf_bridge_'))return;
  queueMicrotask(()=>{
   let response:any={};
   if(message.method==='thread/backgroundTerminals/list')response={data:options.terminals?[{processId:'active'}]:[],nextCursor:null};
   if(message.method==='thread/resume'){
    if(!options.otherSubscriber){provider=message.params.modelProvider??provider;model=message.params.model??model;}
    response=result();if(options.changedPermission&&provider==='token_flow'){response.sandbox={type:'dangerFullAccess'};bridge.receiveEngine({method:'thread/settings/updated',params:{threadId:'thread',threadSettings:{model,modelProvider:provider,sandboxPolicy:response.sandbox,approvalPolicy:'never'}}});}
   }
   if(message.method==='thread/compact/start'){
    if(options.compactError){bridge.receiveEngine({id:message.id,error:{message:'private upstream details'}});return;}
    bridge.receiveEngine({method:'turn/completed',params:{threadId:'thread',turn:{id:'compact',status:'completed'}}});
   }
   bridge.receiveEngine({id:message.id,result:response});
  });
 },m=>client.push(m),m=>reports.push(m));cleanup.push(bridge);
 bridge.receiveClient({id:1,method:'thread/start',params:{model:'official',approvalPolicy:'never',sandbox:'read-only'}});bridge.receiveEngine({id:1,result:result()});engine.length=0;client.length=0;
 return {bridge,engine,client,reports};
}
const wait=()=>new Promise(r=>setTimeout(r,10));
it('releases only its subscription, resumes the same thread, preserves permissions and forwards model/effort/fast tier unchanged',async()=>{
 const f=fixture();const request={id:2,method:'turn/start',params:{threadId:'thread',model:'gateway',effort:'xhigh',serviceTier:'priority',input:[{type:'text',text:'preserve'}]}};
 f.bridge.receiveClient(request);await wait();
 expect(f.engine.map(m=>m.method)).toEqual(['thread/backgroundTerminals/list','thread/unsubscribe','thread/resume','thread/settings/update','turn/start']);
 expect(f.engine[2].params).toMatchObject({threadId:'thread',modelProvider:'token_flow',model:'gateway',approvalPolicy:'never',sandbox:'read-only',serviceTier:'priority',cwd:'/tmp'});
 expect(f.engine.at(-1)).toEqual(request);expect(f.client.some(m=>String(m.id).startsWith('tf_bridge_'))).toBe(false);
});
it.each([{busy:true},{ephemeral:true},{terminals:true}])('does not detach a thread with nonportable or running state: %j',async options=>{
 const f=fixture(options);f.bridge.receiveClient({id:2,method:'turn/start',params:{threadId:'thread',model:'gateway'}});await wait();
 expect(f.client.at(-1)).toMatchObject({id:2,error:{code:-32001}});expect(f.engine.some(m=>m.method==='thread/unsubscribe'||m.method==='turn/start')).toBe(false);
});
it.each([{otherSubscriber:true},{changedPermission:true}])('fails closed and rolls back when reload cannot verify provider and permissions: %j',async options=>{
 const f=fixture(options);f.bridge.receiveClient({id:2,method:'turn/start',params:{threadId:'thread',model:'gateway'}});await wait();
 expect(f.client.at(-1)).toHaveProperty('error');expect(f.engine.some(m=>m.method==='turn/start')).toBe(false);expect(f.engine.filter(m=>m.method==='thread/resume').at(-1).params.modelProvider).toBe('openai');
});
it('forwards server tool calls, streamed output and approval responses without changing payloads; blocks switching while approval is pending',async()=>{
 const f=fixture(),tool={id:72,method:'item/tool/call',params:{threadId:'thread',callId:'tool-call',arguments:{text:'x'}}};
 f.bridge.receiveEngine(tool);expect(f.client.at(-1)).toEqual(tool);
 f.bridge.receiveClient({id:2,method:'thread/settings/update',params:{threadId:'thread',model:'gateway'}});await wait();expect(f.client.at(-1)).toHaveProperty('error');
 const answer={id:72,result:{contentItems:[{type:'inputText',text:'done'}],success:true}};f.bridge.receiveClient(answer);expect(f.engine.at(-1)).toEqual(answer);
 const delta={method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',delta:'unchanged'}};f.bridge.receiveEngine(delta);expect(f.client.at(-1)).toEqual(delta);
 f.bridge.receiveClient({id:3,method:'thread/settings/update',params:{threadId:'thread',model:'gateway'}});await wait();expect(f.engine.at(-1).id).toBe(3);
});
it('waits for the gateway summary before resuming native and keeps official-only requests untouched',async()=>{
 const f=fixture();f.bridge.receiveClient({id:2,method:'turn/start',params:{threadId:'thread',model:'gateway'}});await wait();
 f.bridge.receiveEngine({id:2,result:{turn:{id:'gateway-turn'}}});f.bridge.receiveEngine({method:'turn/completed',params:{threadId:'thread',turn:{id:'gateway-turn',status:'completed'}}});f.engine.length=0;
 f.bridge.receiveClient({id:3,method:'turn/start',params:{threadId:'thread',model:'official'}});await wait();
 expect(f.engine.map(m=>m.method)).toEqual(['thread/backgroundTerminals/list','thread/compact/start','thread/unsubscribe','thread/resume','thread/settings/update','turn/start']);
 expect(f.engine[3].params.modelProvider).toBe('openai');expect(f.reports.map(m=>m.stage)).toContain('summarizing');
 f.bridge.receiveEngine({id:3,result:{turn:{id:'official-turn'}}});f.bridge.receiveEngine({method:'turn/completed',params:{threadId:'thread',turn:{id:'official-turn',status:'completed'}}});f.engine.length=0;
 const compact={id:4,method:'thread/compact/start',params:{threadId:'thread'}};f.bridge.receiveClient(compact);expect(f.engine).toEqual([compact]);
});
it('does not detach or submit the official turn if the gateway summary fails',async()=>{
 const f=fixture({compactError:true});f.bridge.receiveClient({id:2,method:'turn/start',params:{threadId:'thread',model:'gateway'}});await wait();f.bridge.receiveEngine({method:'turn/completed',params:{threadId:'thread',turn:{status:'completed'}}});f.engine.length=0;
 f.bridge.receiveClient({id:3,method:'turn/start',params:{threadId:'thread',model:'official'}});await wait();expect(f.engine.some(m=>m.method==='thread/unsubscribe'||m.method==='turn/start')).toBe(false);expect(JSON.stringify(f.client)).not.toContain('private upstream details');
});
it('keeps inherited nullable settings while preserving an explicit service-tier clear on reload',async()=>{
 const f=fixture();const request={id:2,method:'turn/start',params:{threadId:'thread',model:'official',cwd:null,approvalPolicy:null,permissions:null,effort:null,disabledPluginIds:null,serviceTier:null}};
 f.bridge.receiveClient(request);await wait();expect(f.engine.at(-1)).toEqual(request);
 f.bridge.receiveEngine({id:2,result:{turn:{id:'official-turn'}}});f.bridge.receiveEngine({method:'turn/completed',params:{threadId:'thread',turn:{status:'completed'}}});f.engine.length=0;
 f.bridge.receiveClient({id:3,method:'turn/start',params:{threadId:'thread',model:'gateway'}});await wait();
 expect(f.engine.find(m=>m.method==='thread/resume').params).toMatchObject({cwd:'/tmp',approvalPolicy:'never',sandbox:'read-only',serviceTier:null});
 expect(f.engine.find(m=>m.method==='thread/settings/update').params).toMatchObject({effort:'high',serviceTier:null});
});
