import {AgentApiDirectPanel} from '../../../../apps/console/src/AgentApiDirectPanel';
import {AgentSwitchProgress} from '../../../../apps/console/src/AgentSwitchProgress';
// Browser-only regression fixture. All requests are intercepted; no service, credentials or clients are touched.
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {useNativeLogin} from '../../../../apps/console/src/native-login';
import {AgentPanel,AgentsPage} from '../../../../apps/console/src/AgentsPage';
import {Thinking,ThinkingFeedback} from '../../../../apps/console/src/LoadingState';
import {ClaudeDesktopPanel} from '../../../../apps/console/src/ClaudeDesktopPanel';
import {FlowDialog} from '../../../../apps/console/src/FlowDialog';
import {invalidateSessionReads} from '../../../../apps/console/src/session-read';
import '../../../../apps/console/src/style.css';
import '../../../../apps/console/src/flow.css';
import '../../../../apps/console/src/kapian.css';
import '../../../../apps/console/src/graphite.css';
import '../../../../apps/console/src/refinement.css';
import '../../../../apps/console/src/page-layout.css';
import '../../../../apps/console/src/dialogs.css';
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
const calls:string[]=[],notices:any[]=[],results:string[]=[];
const status={loginState:'not-inspected',revision:'fixture',email:null,accountId:null,pids:[],backup:null,gatewayConnected:false,accounts:[{id:'saved',switchable:true,reason:''}]};
const local:any={state:'running',loginState:'idle',port:8317,accountsLoading:false,accounts:[{id:'saved',provider:'qoder',label:'Saved Qoder',status:'active',models:['qoder/example']}],models:[{id:'qoder/example',owned_by:'qoder'}],providers:[],quotas:{},logs:[],quotaBusy:false};
const usage:any={range:'today',setRange:()=>{},reload:async()=>{},rows:[],nativeRows:[],combinedRows:[],allRows:[],coverage:[],loaded:true,error:'',warning:''};
const target:any={id:'workbuddy-ai',name:'WorkBuddyAI',path:'/fixture/settings.json',revision:'fixture',exists:true,pids:[],error:'',connection:null,configurationState:'unmanaged',backups:[],restartSupported:true,installation:{installed:true,channel:'application',automatic:false},};
let failRestart=false;let finishApi:(()=>void)|undefined;
window.fetch=async(input,init)=>{
 const url=String(input);calls.push(`${init?.method??'GET'} ${url}`);
 let body:unknown=status;
 if(url==='/api/a2a')body={targets:[target]};
 else if(url==='/api/a2a/codex-api')body={revision:'fixture',choices:[{sourceId:'api',name:'Fixture API',models:['deepseek'],available:true}]};
 else if(url==='/api/a2a/codex-migration')body={phase:'idle',lifecyclePhase:'changing',operation:{stage:'history',label:'正在检查对话上下文',done:12,total:30,startedAt:Date.now()}};
 else if(url==='/api/a2a/codex-api/apply'){await new Promise<void>(resolve=>{finishApi=resolve;});body={};}
 else if(url.includes('program-updates'))body={updates:{}};
 else if(url==='/api/a2a/connect')body={};
 else if(url.endsWith('/restart')){if(failRestart)return new Response(JSON.stringify({error:'Fixture restart failed'}),{status:500});body={message:'客户端已重新打开'};}
 return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
};
let root=createRoot(document.getElementById('fixture')!);
const flush=async()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
const mount=async(element:any)=>{await act(async()=>{root.render(element);});await flush();};
const clear=async()=>{await act(async()=>root.unmount());root=createRoot(document.getElementById('fixture')!);invalidateSessionReads('');calls.length=0;notices.length=0;failRestart=false;};
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const test=async(name:string,work:()=>Promise<void>)=>{try{await clear();await work();results.push(`PASS ${name}`);}catch(error){results.push(`FAIL ${name}: ${String(error)}`);}document.getElementById('results')!.textContent=results.join('\n');};
function Login(){const login=useNativeLogin('qoder',local);return <div>{login.accounts.map(a=><span key={a.id}>{a.label}</span>)}</div>;}
await test('Saved credentials never trigger external inspection on mount/remount',async()=>{
 await mount(<Login/>);await mount(<Login/>);
 assert(document.getElementById('fixture')!.textContent?.includes('Saved Qoder'),'saved account missing');
 assert(!calls.some(c=>c.includes('/inspect')),'external /inspect called on mount');
 await mount(null);await mount(<Login/>);
 assert(calls.filter(c=>c.includes('/native-accounts/qoder')).length===1,'credential status fetched again on remount');
});
await test('Initial account loading keeps the entire Agent panel as skeleton',async()=>{
 const props:any={local:{...local,accountsLoading:true},calls:[],usage,notify:()=>{},onRepair:()=>{},onAgent:()=>{},localError:'',reloadLocal:async()=>{}};
 await mount(<AgentsPage {...props}/>);
 assert(document.querySelector('.tfLoadingSkeleton'),'missing full skeleton');
 assert(!document.querySelector('.tfPanelHead'),'partially loaded Agent panel is visible');
 await mount(<AgentsPage {...props} local={local}/>);
 assert(document.querySelector('.tfPanelHead'),'loaded panel did not appear');
 await mount(<AgentsPage {...props}/>);
 assert(document.querySelector('.tfPanelHead'),'background refresh replaced usable content with skeleton');
});
await test('Apply retains restart choice; successful restart becomes a notification',async()=>{
 localStorage.setItem('token-flow.agent.models.workbuddy-ai',JSON.stringify([{sourceId:'saved',model:'qoder/example'}]));
 const props:any={target,local,usage,problem:'',notify:(n:any)=>notices.push(n),onRepair:()=>{},onChanged:async()=>{},onProgramChanged:async()=>{},onRefreshAccounts:async()=>{}};
 await mount(<AgentPanel {...props}/>);
 await act(async()=>{document.querySelector<HTMLInputElement>('[aria-label="启用网关模型"]')!.click();});await flush();
 const dialog=document.querySelector<HTMLDialogElement>('dialog[open]');
 assert(dialog?.textContent?.includes('配置已保存，现在生效'),'restart decision was lost: '+dialog?.textContent+' '+JSON.stringify(notices)+' '+calls.join(','));
 const button=[...dialog!.querySelectorAll('button')].find(b=>b.textContent==='立即重启');
 await act(async()=>button!.click());await flush();
 assert(!document.querySelector('dialog[open]'),'completion still blocks with a dialog');
 assert(notices.some(n=>n.kind==='ok'&&n.text.includes('已重新打开')),'completion notification missing');
 localStorage.removeItem('token-flow.agent.models.workbuddy-ai');
});
await test('Claude Desktop completion notifies; restart failure retains recovery',async()=>{
 const desktop:any={status:{revision:'fixture',selections:[],automaticRestart:true,installation:{installed:true},pids:[],connected:false},refresh:async()=>({revision:'fixture'})};
 await mount(<ClaudeDesktopPanel desktop={desktop} local={local} usage={usage} notify={n=>notices.push(n)}/>);
 const restart=async()=>{
  await act(async()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='重启…')!.click();});
  await act(async()=>{[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='立即重启')!.click();});await flush();
 };
 await restart();assert(!document.querySelector('dialog[open]'),'Claude completion still uses a modal');
 assert(notices.some(n=>n.kind==='ok'),'Claude success notification missing');
 failRestart=true;await restart();
 assert(document.querySelector('dialog[open]')?.textContent?.includes('Fixture restart failed'),'restart failure feedback missing');
 assert([...document.querySelectorAll('dialog[open] button')].some(b=>b.textContent==='重试重启'),'restart retry missing');
});
await test('Standalone waiting blurs backdrop; detailed dialog hides the global wait',async()=>{
 await mount(<><ThinkingFeedback/><Thinking label="正在加载测试"/></>);
 const node=document.querySelector('.tfThinkingFeedback')!;
 assert(getComputedStyle(node,'::backdrop').backdropFilter.includes('blur'),'standalone backdrop has no blur');
 await mount(<><ThinkingFeedback busy/><FlowDialog open title="详细进度" onClose={()=>{}}><Thinking/><p>已完成 2 / 3</p></FlowDialog></>);
 assert(getComputedStyle(document.querySelector('.tfThinkingFeedback')!).display==='none','global wait obscures dialog');
});

await test('The last gateway model restores configuration and stays removed after remount',async()=>{
 for(const id of ['deepseek','pi']){
  localStorage.setItem(`token-flow.agent.models.${id}`,JSON.stringify([{sourceId:'saved',model:'qoder/example'}]));
  const props:any={target:{...target,id,name:id,connection:{id:'connection',sourceId:'saved',model:'qoder/example',selections:[{sourceId:'saved',model:'qoder/example'}]},backups:[{selections:[{sourceId:'saved',model:'qoder/example'}]}]},local,usage,problem:'',notify:(n:any)=>notices.push(n),onRepair:()=>{},onChanged:async()=>{},onProgramChanged:async()=>{},onRefreshAccounts:async()=>{}};
  const previous={...target};Object.assign(target,props.target);await mount(<AgentPanel {...props}/>);
  const remove=[...document.querySelectorAll('button')].find(b=>b.textContent==='移除')!;assert(!remove.disabled,'last model is disabled');
  await act(async()=>remove.click());await flush();assert(calls.some(c=>c==='POST /api/a2a/restore'),'configuration was not restored');
  assert(localStorage.getItem(`token-flow.agent.models.${id}`)==='[]','empty selection was not saved');
  await mount(null);await mount(<AgentPanel {...props} target={{...props.target,connection:null}}/>);
  assert(![...document.querySelectorAll('button')].some(b=>b.textContent==='移除'),'removed model reappeared from backup');
  Object.assign(target,previous);localStorage.removeItem(`token-flow.agent.models.${id}`);await mount(null);
 }
});
await test('API apply shares compact progress, real counts and releases busy state',async()=>{
 const busy:boolean[]=[];await mount(<AgentApiDirectPanel target="codex" busy={false} restartSupported onBusyChange={v=>busy.push(v)} onChanged={async()=>{}}/>);
 await act(async()=>{[...document.querySelectorAll('button')].find(b=>b.textContent?.includes('添加 API'))!.click();});await flush();
 const select=document.querySelector('select')!;await act(async()=>{select.value='api';select.dispatchEvent(new Event('change',{bubbles:true}));});
 await act(async()=>{[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='应用')!.click();});await flush();
 const dialog=document.querySelector<HTMLDialogElement>('dialog[open]')!;
 assert(dialog.classList.contains('tfModelApplyDialog'),'API uses a different progress dialog');assert(dialog.querySelector('progress')?.value===12,'real progress is missing');
 assert(dialog.getBoundingClientRect().height<=300,'progress dialog is oversized');assert(getComputedStyle(dialog,'::backdrop').backdropFilter.includes('blur'),'progress backdrop does not blur');
 await act(async()=>finishApi?.());await flush();assert(!document.querySelector('dialog[open]'),'completion dialog still visible');assert(busy.at(-1)===false,'busy state was not released');
});
await clear();document.getElementById('results')!.textContent=results.join('\n')+'\nDONE';

await mount(<FlowDialog open title="切换为官方直连" className="tfRestartDialog tfModelApplyDialog" busy showBusyIndicator={false} onClose={()=>{}}><div className="tfModelApplyBody"><AgentSwitchProgress progress={{phase:'idle',done:0,total:0,backups:1,remaining:0,restorable:0,lifecyclePhase:'changing',operation:{stage:'history',label:'正在检查对话上下文',done:12,total:30,startedAt:Date.now()}}}/></div></FlowDialog>);
