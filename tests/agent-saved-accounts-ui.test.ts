import {AgentApiDirectPanel} from '../apps/console/src/AgentApiDirectPanel';
import {afterEach,expect,it,vi} from 'vitest';
import {createElement,type ComponentProps} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AgentPanel} from '../apps/console/src/AgentsPage';
import {uninspectedNativeStatus} from '../packages/core/src/native-credential-access';

// Dialog portals are unrelated to account discovery; keep the actual Agent panel and account rows.
vi.mock('../apps/console/src/FlowDialog',()=>({FlowDialog:()=>null}));
afterEach(()=>vi.unstubAllGlobals());
type Props=ComponentProps<typeof AgentPanel>;
function fixture(provider:'codex'|'qoder'|'workbuddy'|'workbuddy-ai'):Props{
 const id='saved-account',label=`Saved ${provider} account`;
 const account={id,label,remaining:null,models:[`${provider}/fixture-model`],switchable:true,reason:'',current:false,local:false};
 return {
  target:{id:provider,name:provider,path:'/isolated/config',exists:true,revision:'fixture',pids:[],error:'',connection:null,drift:false,configurationState:'unmanaged',backups:[],installation:{installed:true,channel:'application',automatic:false,download:'https://example.test/download'}},
  login:{status:{...uninspectedNativeStatus([{id}]),accounts:[{id,switchable:true,reason:''}]},error:'',accounts:[account],current:undefined,nativeCurrent:undefined,nativeLabel:'',refresh:vi.fn(async()=>{}),switchTo:vi.fn(async()=>''),restore:vi.fn(async()=>{})},
  local:{state:'running',loginState:'idle',port:8317,logs:[],accountError:undefined,lastError:undefined,login:undefined,accounts:[{id,label,provider:provider==='workbuddy-ai'?'workbuddy':provider,status:'active',disabled:false,unavailable:false,models:account.models}],models:[],quotas:{},quotaBusy:false,providers:[]},
  usage:{range:'today',setRange:vi.fn(),reload:vi.fn(async()=>{}),rows:[],nativeRows:[],combinedRows:[],allRows:[],coverage:[],scanning:false,loaded:true,error:'',warning:''},
  problem:'',notify:vi.fn(),onRepair:vi.fn(),onChanged:vi.fn(async()=>{}),onProgramChanged:vi.fn(async()=>{}),onRefreshAccounts:vi.fn(async()=>{}),
 };
}
it.each(['codex','qoder','workbuddy','workbuddy-ai'] as const)('shows saved %s accounts without inspecting the external client',provider=>{
 const props=fixture(provider),html=renderToStaticMarkup(createElement(AgentPanel,props));
 expect(html).toContain('aria-label="直连"');
 expect(html).toContain(`Saved ${provider} account`);
 expect(html).toContain('aria-pressed="false"');
 expect(html).not.toContain('tfLineMain" aria-pressed="false" disabled');
 expect(html).not.toContain('>使用中<');expect(html).not.toContain('>本机<');
 expect(html).not.toContain('点击“从本机导入”');
 expect(html).not.toContain('已加载 TokenFlow 保存的账号');
 expect(props.login!.refresh).not.toHaveBeenCalled();expect(props.login!.switchTo).not.toHaveBeenCalled();
});
it('keeps saved accounts visible when local-client inspection fails or is still pending',()=>{
 for(const state of ['failed','pending'] as const){
  const props=fixture('codex');props.login!.status=undefined;props.login!.error=state==='failed'?'本机登录暂不可读取':'';
  expect(renderToStaticMarkup(createElement(AgentPanel,props))).toContain('Saved codex account');
 }
});
it('keeps API direct available without a saved official account',()=>{
 const props=fixture('codex');props.login!.accounts=[];props.local.accounts=[];props.login!.status={...uninspectedNativeStatus(),accounts:[]};
 const html=renderToStaticMarkup(createElement(AgentPanel,props));
 expect(html).toContain('aria-label="直连"');expect(html).toContain('aria-label="添加 API 直连"');
 expect(html).not.toContain('Saved codex account');
});
it('allows hidden saved accounts to be restored even when the local login was not inspected',()=>{
 vi.stubGlobal('localStorage',{getItem:(key:string)=>key==='token-flow.agent.codex.hidden'?'["account:saved-account"]':null});
 const html=renderToStaticMarkup(createElement(AgentPanel,fixture('codex')));
 expect(html).toContain('恢复已删除的 1 项');expect(html).not.toContain('Saved codex account');
});

it('labels API restoration as account direct access instead of an ambiguous previous connection',()=>{
 const html=renderToStaticMarkup(createElement(AgentApiDirectPanel,{target:'codex',active:{sourceId:'fixture',model:'fixture',baseURL:'https://example.test',name:'Fixture',state:'applied',configured:true,revision:'fixture'},busy:false,restartSupported:false,onChanged:async()=>{}}));
 expect(html).toContain('恢复原账号直连');expect(html).not.toContain('恢复原接入');
});
