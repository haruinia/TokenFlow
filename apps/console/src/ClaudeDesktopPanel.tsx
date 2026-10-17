import type {ReactNode} from 'react';
import {useEffect,useState} from 'react';
import {requestJSON} from './request';
import {ProviderIcon} from './ProviderIcon';
import {FlowDialog} from './FlowDialog';
import {isSourceSelectionAvailable,sourceLabel,sourceOptions} from './source-options';
import {qualifiedModelLabel as modelLabel} from './model-label';
import {AgentModelPicker} from './AgentModelPicker';
import {UsageFold,modelManufacturer} from './UsagePanel';
import {localDay} from './usage-model';
import {Icon} from './Icons';
import type {Choice} from './flow-model';
import type {UsageData} from './usage-data';
import {claudeDesktopModelLimit} from '../../shared/claude-desktop-models';
import type {LocalAgentSnapshot} from '../../../packages/core/src/cliproxy';
import type {Notify} from './notify';
type Selection={model:string;sourceId:string};
type Status={revision:string;connected:boolean;mode:string;backup:{state:string}|null;selections:Selection[];fastModel?:string;unavailableReason:string;pids:number[];automaticRestart:boolean;installation:{installed:boolean;version?:string;download?:string};message?:string};
type Action='connect'|'restore'|'restart';
const post=(body:unknown)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const same=(a:Selection,b:Selection)=>a.model===b.model&&a.sourceId===b.sourceId;
export function ClaudeDesktopPanel({clientSwitch,local,usage,notify}:{clientSwitch?:ReactNode;local:LocalAgentSnapshot;usage:UsageData;notify:Notify}){
 const [status,setStatus]=useState<Status>();const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [action,setAction]=useState<Action>();const [draft,setDraft]=useState<Choice[]|null>(null);const [picking,setPicking]=useState(false);const [roleDefault,setRoleDefault]=useState('');const [roleFast,setRoleFast]=useState('');
 const refresh=async()=>{try{const state=await requestJSON<Status>('/api/claude-desktop');setStatus(state);setError('');return state;}catch(e){setError(e instanceof Error?e.message:'无法读取 Claude Desktop 配置');throw e;}};
 useEffect(()=>{void refresh().catch(()=>{});const timer=setInterval(()=>void refresh().catch(()=>{}),5000);return()=>clearInterval(timer);},[]);
 const available=sourceOptions(local);
 const models=draft??status?.selections??[];
 const tooMany=models.length>claudeDesktopModelLimit;const blocked=busy||!status||!!status.unavailableReason;
 const rows=usage.allRows.filter(row=>row.day===localDay(new Date())&&row.target==='claude-desktop');
 const askConnect=(choices=models)=>{const fallback=choices[0];const fast=choices.find(item=>item.model===status?.fastModel)??fallback;setRoleDefault(fallback?.model??'');setRoleFast(fast?.model??'');setAction('connect');};
 const apply=async()=>{if(!action||busy)return;setBusy(true);try{
  const current=await refresh();
  const fallback=models[0];const defaultChoice=models.find(item=>item.model===roleDefault)??fallback;const fastChoice=models.find(item=>item.model===roleFast)??defaultChoice;
  const ordered=action==='connect'&&defaultChoice?[defaultChoice,...models.filter(item=>item.model!==defaultChoice.model)]:models;
  const body=action==='restart'?{}:{revision:current.revision,...(action==='connect'?{selections:ordered,fast:fastChoice?{sourceId:fastChoice.sourceId,model:fastChoice.model}:undefined}:{})};
  const result=await requestJSON<Status>(`/api/claude-desktop/${action}`,post(body),600000);setDraft(null);await refresh();setAction(undefined);notify({kind:'ok',text:result.message??'Claude Desktop 配置已处理。'});
 }catch(e){notify({kind:'error',text:e instanceof Error?e.message:'操作未完成'});}finally{setBusy(false);}};
 const download=status?.installation.download??'https://claude.ai/download';
 const restartNote=status?.automaticRestart?'请先保存工作。确认后会退出 Claude Desktop，再重新打开。':'请先退出 Claude Desktop，保存后再打开。';
 return <section className="tfPanel" aria-label="Claude Desktop">
  <header className="tfPanelHead"><ProviderIcon provider="claude" size={40}/><div><div className="tfAgentTitle"><h2>Claude Desktop</h2>{clientSwitch}<a className="tfAgentUpdate" href={download} target="_blank" rel="noreferrer" title="打开官方下载页" aria-label="打开 Claude Desktop 官方下载页"><Icon name="download" size={15}/></a><span className="tfAgentVersion">{!status?'正在读取版本…':status.installation.installed?`已安装${status.installation.version?` · ${status.installation.version}`:''}`:'未检测到安装'}</span></div><UsageFold loaded={usage.loaded} error={usage.error} onRetry={usage.reload} title="Claude Desktop 用量" rows={rows} range="today"/></div><div className="tfRow">
   {!models.length&&<button className="textButton" disabled={blocked} onClick={()=>setPicking(true)}><Icon name="plus" size={15}/>选择模型</button>}
   {status?.automaticRestart&&<button className="textButton" disabled={busy||!status.installation.installed&&!status.pids.length} onClick={()=>setAction('restart')}>重启…</button>}
   {status?.backup&&<button disabled={blocked} onClick={()=>setAction('restore')}>恢复原配置</button>}
  </div></header>
  {error&&<p className="tfError" role="alert">{error}<button onClick={()=>void refresh().catch(()=>{})}>重试</button></p>}
  {status?.unavailableReason&&<p className="tfHint">{status.unavailableReason}</p>}
  {!!models.length&&<div className="tfAgentSection"><header className="tfAgentSectionHead"><div className="tfGatewayTitle"><h3>模型</h3><button className="tfAddButton" disabled={blocked} onClick={()=>setPicking(true)}><Icon name="plus" size={15}/>管理所选模型</button><button className="tfAddButton" disabled={blocked||tooMany} onClick={()=>askConnect()}>默认模型</button></div><label className="toggle"><input type="checkbox" role="switch" aria-label="启用网关模型" checked={!!status?.connected&&!draft} disabled={blocked} onChange={event=>{if(event.target.checked)askConnect();else setAction('restore');}}/><span>启动</span></label></header>
   <p className="tfHint">最多 {claudeDesktopModelLimit} 个。默认模型用于会话和子代理，快速模型用于审批和快速请求。</p>
   {tooMany&&<p className="tfHint">最多 {claudeDesktopModelLimit} 个模型，请先移除多余项。</p>}
   <ul className="tfLines" aria-label="Claude Desktop 模型">
    {models.map((choice,index)=>{
     const on=index===0;const fastModel=models.some(item=>item.model===status?.fastModel)?status?.fastModel:models[0]?.model;const fast=choice.model===fastModel;const label=modelLabel(local,choice.model);
     return <li key={`${choice.sourceId}/${choice.model}`} className={on?'on':''}><div className="tfLine">
      <div className="tfLineMain tfModelCardMain"><ProviderIcon provider={modelManufacturer(choice.model,local)} size={28}/><span className="tfRowText"><strong title={label}>{label}</strong><small>{sourceLabel(local,choice.sourceId)??'来源暂不可用'}{on&&fast?' · 默认，审批和快速请求也使用它':on?' · 默认，会话和子代理':fast?' · 审批和快速请求':' · 菜单可选'}{!isSourceSelectionAvailable(available,choice)?' · 暂不可用':''}</small></span>{on&&<b className="tfUsing">默认模型</b>}{fast&&!on&&<b className="tfUsing">快速模型</b>}</div>
      <span className="tfActions"><button className="textButton danger" disabled={blocked} onClick={()=>{const next=models.filter(item=>!same(item,choice));setDraft(next);}}>移除</button></span>
     </div></li>;
    })}
   </ul>
  </div>}
  <AgentModelPicker open={picking} title="Claude Desktop 使用的模型" local={local} current={models[0]} selected={models} onConfirm={choices=>{if(choices.length>claudeDesktopModelLimit){notify({kind:'error',text:`Claude Desktop 最多接入 ${claudeDesktopModelLimit} 个模型。`});return;}const current=models[0];const preferred=choices.find(item=>current&&same(item,current))??choices[0];const next=preferred?[preferred,...choices.filter(item=>item!==preferred)]:choices;setDraft(next);askConnect(next);}} onClose={()=>setPicking(false)}/>
  <FlowDialog className="tfRestartDialog" open={!!action} title={action==='connect'?'应用模型':action==='restore'?'恢复原配置':'重启 Claude Desktop'} busy={busy} onClose={()=>setAction(undefined)}>
   {action==='connect'&&<><p className="tfDialogLead">{status?.connected?'用当前所选模型替换 Claude Desktop 的模型菜单。':'把所选模型接入 Claude Desktop。'}</p>{models.length>1&&<><label>默认模型<select aria-label="默认模型" value={roleDefault} onChange={event=>setRoleDefault(event.target.value)}>{models.map(item=><option key={item.model} value={item.model}>{modelLabel(local,item.model)}</option>)}</select></label><label>快速模型<select aria-label="快速模型" value={roleFast} onChange={event=>setRoleFast(event.target.value)}>{models.map(item=><option key={item.model} value={item.model}>{modelLabel(local,item.model)}</option>)}</select></label></>}<p className="tfHint">默认模型用于会话和子代理，快速模型用于审批和快速请求。</p>{status?.mode==='3p'&&<p className="tfHint">已有其他第三方配置，接入时会保留，可随时恢复。</p>}</>}
   {action==='restore'&&<><p className="tfDialogLead">恢复接入前的配置，并停用当前网关连接。</p><p className="tfHint">原官方登录数据保留。</p></>}
   {action==='restart'&&<p className="tfDialogLead">重新打开 Claude Desktop，加载已保存的配置。</p>}
   <p className="tfHint">{restartNote}</p>
   <footer><button disabled={busy} onClick={()=>setAction(undefined)}>{action==='restart'?'稍后再说':'取消'}</button><button className="primary" disabled={busy} onClick={()=>void apply()}>{busy?'正在处理…':action==='restart'?'立即重启':action==='restore'?'恢复配置':status?.automaticRestart?'应用并重启':'应用'}</button></footer>
  </FlowDialog>
 </section>;
}