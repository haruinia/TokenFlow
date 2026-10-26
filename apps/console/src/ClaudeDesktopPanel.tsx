import type {ReactNode} from 'react';
import {useState} from 'react';
import type {useClaudeDesktopStatus} from './claude-desktop-status';
import {requestJSON} from './request';
import {ProviderIcon} from './ProviderIcon';
import {FlowDialog} from './FlowDialog';
import {isSourceSelectionAvailable,sourceLabel,sourceOptions} from './source-options';
import {qualifiedModelLabel as modelLabel} from './model-label';
import {AgentModelPicker} from './AgentModelPicker';
import {AgentUsageDetails} from './AgentUsageDetails';
import {UsageFold,modelManufacturer} from './UsagePanel';
import {localDay} from './usage-model';
import {Icon} from './Icons';
import {Thinking} from './LoadingState';
import type {Choice} from './flow-model';
import type {UsageData} from './usage-data';
import {claudeDesktopModelLimit} from '../../shared/claude-desktop-models';
import type {LocalAgentSnapshot} from '../../../packages/core/src/cliproxy';
import type {Notify} from './notify';
type Selection={model:string;sourceId:string};
type Action='connect'|'restore'|'restart';
const post=(body:unknown)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const same=(a:Selection,b:Selection)=>a.model===b.model&&a.sourceId===b.sourceId;
export function ClaudeDesktopPanel({desktop,clientSwitch,local,usage,notify}:{desktop:ReturnType<typeof useClaudeDesktopStatus>;clientSwitch?:ReactNode;local:LocalAgentSnapshot;usage:UsageData;notify:Notify}){
 const {status,error,refresh}=desktop;
 const [busy,setBusy]=useState(false);const [action,setAction]=useState<Action>();const [draft,setDraft]=useState<Choice[]|null>(null);const [picking,setPicking]=useState(false);const [roleDefault,setRoleDefault]=useState('');const [roleFast,setRoleFast]=useState('');
 const [phase,setPhase]=useState<'confirm'|'working'|'saved'|'error'>('confirm');const [message,setMessage]=useState('');
 const openAction=(next:Action)=>{setPhase('confirm');setMessage('');setAction(next);};
 const available=sourceOptions(local);
 const models=draft??status?.selections??[];
 const tooMany=models.length>claudeDesktopModelLimit;const blocked=busy||!status||!!status.unavailableReason;
 const rows=usage.allRows.filter(row=>row.day===localDay(new Date())&&row.target==='claude-desktop');
 const askConnect=(choices=models)=>{const fallback=choices[0];const fast=choices.find(item=>item.model===status?.fastModel)??fallback;setRoleDefault(fallback?.model??'');setRoleFast(fast?.model??'');openAction('connect');};
 const apply=async(nextAction=action)=>{if(!nextAction||busy)return;setAction(nextAction);setBusy(true);setPhase('working');setMessage('');try{
  const current=await refresh();
  const fallback=models[0];const defaultChoice=models.find(item=>item.model===roleDefault)??fallback;const fastChoice=models.find(item=>item.model===roleFast)??defaultChoice;
  const ordered=nextAction==='connect'&&defaultChoice?[defaultChoice,...models.filter(item=>item.model!==defaultChoice.model)]:models;
  const body=nextAction==='restart'?{}:{revision:current.revision,...(nextAction==='connect'?{selections:ordered,fast:fastChoice?{sourceId:fastChoice.sourceId,model:fastChoice.model}:undefined}:{})};
  const result=await requestJSON<{message?:string}>(`/api/claude-desktop/${nextAction}`,post(body),600000);if(nextAction==='connect')setDraft(null);
  setMessage(result.message??(nextAction==='restart'?'Claude Desktop 已重新打开。':'Claude Desktop 配置已处理。'));setPhase('saved');await refresh().catch(()=>{});
 }catch(e){setMessage(e instanceof Error?e.message:'操作未完成');setPhase('error');await refresh().catch(()=>{});}finally{setBusy(false);}};
 const download=status?.installation.download??'https://claude.ai/download';
 const restartNote=status?.automaticRestart?'请先保存工作。确认后会退出 Claude Desktop，再重新打开。':'请先退出 Claude Desktop，保存后再打开。';
 return <section className="tfPanel" aria-label="Claude Desktop">
  <header className="tfPanelHead"><ProviderIcon provider="claude" size={40}/><div><div className="tfAgentTitle"><h2>Claude Desktop</h2>{clientSwitch}<a className="tfAgentUpdate" href={download} target="_blank" rel="noreferrer" title="打开官方下载页" aria-label="打开 Claude Desktop 官方下载页"><Icon name="download" size={15}/></a><span className="tfAgentVersion">{!status?'正在读取版本…':status.installation.installed?`已安装${status.installation.version?` · ${status.installation.version}`:''}`:'未检测到安装'}</span></div><UsageFold loaded={usage.loaded} error={usage.error} onRetry={usage.reload} title="Claude Desktop 用量" rows={rows} range="today"/></div><div className="tfRow">
   {!models.length&&<button className="iconButton" aria-label="选择模型" title="选择模型" disabled={blocked} onClick={()=>setPicking(true)}><Icon name="plus" size={16}/></button>}
   {status?.automaticRestart&&<button className="textButton" disabled={busy||!status.installation.installed&&!status.pids.length} onClick={()=>openAction('restart')}>重启…</button>}
   {status?.backup&&<button disabled={blocked} onClick={()=>openAction('restore')}>切回官方</button>}
  </div></header>
  {error&&<p className="tfError" role="alert">{error}<button onClick={()=>void refresh().catch(()=>{})}>重试</button></p>}
  {status?.unavailableReason&&<p className="tfHint">{status.unavailableReason}</p>}
  {(status?.configurationChanged||status?.mappingUpdateRequired)&&<p className="tfProblem" role="status">{status.configurationChanged?'Claude Desktop 接入配置已被修改，当前未确认使用这里所选的模型。':'旧版菜单名称可能与子代理型号冲突。'}请重新应用模型，随后在旧对话中重新选择一次模型；对话内容保留。<button type="button" className="textButton" disabled={blocked||tooMany} onClick={()=>askConnect()}>重新应用</button></p>}
  {!!models.length&&<div className="tfAgentSection"><header className="tfAgentSectionHead"><div className="tfGatewayTitle"><h3>模型</h3><button className="iconButton" aria-label="管理所选模型" title="管理所选模型" disabled={blocked} onClick={()=>setPicking(true)}><Icon name="plus" size={16}/></button></div><label className="toggle"><input type="checkbox" role="switch" aria-label="启用网关模型" checked={!!status?.connected&&!draft} disabled={blocked} onChange={event=>{if(event.target.checked)askConnect();else openAction('restore');}}/><span>启动</span></label></header>
   <p className="tfHint">最多 {claudeDesktopModelLimit} 个。</p>
   {tooMany&&<p className="tfHint">最多 {claudeDesktopModelLimit} 个模型，请先移除多余项。</p>}
   <ul className="tfLines" aria-label="Claude Desktop 模型">
    {models.map(choice=>{
     const label=modelLabel(local,choice.model);
     return <li key={`${choice.sourceId}/${choice.model}`}><div className="tfLine">
      <div className="tfLineMain tfModelCardMain"><ProviderIcon provider={modelManufacturer(choice.model,local)} size={28}/><span className="tfRowText"><strong title={label}>{label}</strong><small>{sourceLabel(local,choice.sourceId)??'来源暂不可用'}{!isSourceSelectionAvailable(available,choice)?' · 暂不可用':''}</small></span></div>
      <span className="tfActions"><button className="textButton danger" disabled={blocked} onClick={()=>{const next=models.filter(item=>!same(item,choice));setDraft(next);}}>移除</button></span>
     </div></li>;
    })}
   </ul>
  </div>}
  <AgentUsageDetails target="claude-desktop" local={local} usage={usage}/>
  <AgentModelPicker open={picking} title="Claude Desktop 使用的模型" local={local} current={models[0]} selected={models} onConfirm={choices=>{if(choices.length>claudeDesktopModelLimit){notify({kind:'error',text:`Claude Desktop 最多接入 ${claudeDesktopModelLimit} 个模型。`});return;}const current=models[0];const preferred=choices.find(item=>current&&same(item,current))??choices[0];const next=preferred?[preferred,...choices.filter(item=>item!==preferred)]:choices;setDraft(next);askConnect(next);}} onClose={()=>setPicking(false)}/>
  <FlowDialog className="tfRestartDialog tfModelApplyDialog" open={!!action} title={phase==='error'?'操作未完成':phase==='saved'?'操作完成':action==='connect'?'应用模型':action==='restore'?'切回官方':'重启 Claude Desktop'} busy={busy} showBusyIndicator={false} onClose={()=>setAction(undefined)}>
   <div className="tfModelApplyBody">
   {phase==='working'?<div className="tfMigrationProgress" aria-busy="true"><Thinking label={action==='restart'?'正在重新打开 Claude Desktop':'正在应用 Claude Desktop 配置'}/><p className="tfMigrationStage" role="status">{action==='restart'?'正在重新打开 Claude Desktop':'正在应用 Claude Desktop 配置'}</p></div>:phase==='saved'||phase==='error'?<p className={phase==='error'?'tfError':'tfDialogLead'} role={phase==='error'?'alert':'status'}>{message}</p>:<>
   {action==='connect'&&<><p className="tfDialogLead">{status?.connected?'用当前所选模型替换 Claude Desktop 的模型菜单。':'把所选模型接入 Claude Desktop。'}</p>{models.length>1&&<><label>默认模型<select aria-label="默认模型" value={roleDefault} onChange={event=>setRoleDefault(event.target.value)}>{models.map(item=><option key={item.model} value={item.model}>{modelLabel(local,item.model)}</option>)}</select></label><label>快速模型<select aria-label="快速模型" value={roleFast} onChange={event=>setRoleFast(event.target.value)}>{models.map(item=><option key={item.model} value={item.model}>{modelLabel(local,item.model)}</option>)}</select></label></>}<p className="tfHint">默认模型用于会话和子代理，快速模型用于审批和快速请求。</p></>}
   {action==='restore'&&<><p className="tfDialogLead">停用当前网关，切回 Claude Desktop 官方服务；不恢复以前的第三方配置。</p><p className="tfHint">原官方登录数据保留。</p></>}
   {action==='restart'&&<p className="tfDialogLead">重新打开 Claude Desktop，加载已保存的配置。</p>}
   <p className="tfHint">{restartNote}</p>
   </>}
   </div>
   <footer>{!busy&&<><button onClick={()=>setAction(undefined)}>{phase==='confirm'?(action==='restart'?'稍后再说':'取消'):'关闭'}</button>{phase!=='saved'&&<button className="primary" onClick={()=>void apply()}>{phase==='error'?(action==='restart'?'重试重启':'重新应用'):action==='restart'?'立即重启':action==='restore'?'切回官方':status?.automaticRestart?'应用并重启':'应用'}</button>}{phase==='error'&&action!=='restart'&&status?.automaticRestart&&status.connected&&<button onClick={()=>void apply('restart')}>重启 Claude Desktop</button>}</>}</footer>
  </FlowDialog>
 </section>;
}
