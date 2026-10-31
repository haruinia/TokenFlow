import {AgentSwitchProgress,useSwitchProgress} from './AgentSwitchProgress';
import {useRef,useState} from 'react';
import {FlowDialog} from './FlowDialog';
import {Icon} from './Icons';
import {requestJSON} from './request';
import type {ApiDirectConfig} from '../../../packages/core/src/api-direct-config';

type Active=Awaited<ReturnType<ApiDirectConfig['status']>>;
type Choice={sourceId:string;name:string;models:string[];available:boolean};
const post=(body:unknown)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const choiceId=(choice:Pick<Choice,'sourceId'>)=>choice.sourceId;
export function AgentApiDirectPanel({target,active,busy,restartSupported,onChanged,onBusyChange,onNotice}:{target:'codex'|'claude';active?:Active;busy:boolean;restartSupported:boolean;onChanged:()=>Promise<void>;onBusyChange?:(busy:boolean)=>void;onNotice?:(text:string)=>void}){
 const [open,setOpen]=useState(false),[choices,setChoices]=useState<Choice[]>([]),[selected,setSelected]=useState(''),[stage,setStage]=useState(''),[error,setError]=useState('');
 const [applying,setApplying]=useState(false),[restoring,setRestoring]=useState(false);
 const progress=useSwitchProgress(applying&&target==='codex');
 const lock=useRef(false),base=`/api/a2a/${target}-api`;
 const show=async()=>{if(lock.current)return;setOpen(true);setError('');setStage('正在读取 API…');lock.current=true;
  try{const result=await requestJSON<{choices:Choice[]}>(base);setChoices(result.choices);setSelected(active?choiceId(active):'');}
  catch(e){setError(e instanceof Error?e.message:'API 模型暂不可读取。');}finally{setStage('');setApplying(false);onBusyChange?.(false);lock.current=false;}
 };
 const choice=choices.find(c=>choiceId(c)===selected);
 const apply=async(restore=false)=>{
  if(lock.current||!restore&&!choice?.available)return;lock.current=true;setError('');setStage('正在应用配置…');setApplying(true);setRestoring(restore);onBusyChange?.(true);
  try{
   const {revision}=await requestJSON<{revision:string}>(base);
   if(!revision)throw new Error('配置暂不可读取，请刷新后重试。');
   await requestJSON(`${base}/${restore?'restore':'apply'}`,post({revision,...(target==='codex'?{restartCodex:restartSupported}:{}),...(!restore?{sourceId:choice!.sourceId}:{})}),600000);
   await onChanged();setOpen(false);onNotice?.(restore?'已恢复原账号直连。':'API 直连已应用。');
  }catch(e){setError(e instanceof Error?e.message:'接入切换未完成。');await onChanged().catch(()=>{});}finally{setStage('');setApplying(false);onBusyChange?.(false);lock.current=false;}
 };
 return <>
  {active&&<ul className="tfLines" aria-label="API 直连"><li className={active.configured?'on':''}><div className="tfLine">
   <button className="tfLineMain" disabled={busy||!!stage} onClick={()=>void show()}><Icon name="key" size={22}/><span className="tfKind">API</span><span className="tfRowText"><strong>{active.name}</strong></span><b className="tfUsing">{active.configured?'已配置':'配置有变化'}</b></button>
   <span className="tfActions"><button className="textButton" disabled={busy||!!stage} onClick={()=>{setOpen(true);void apply(true);}}>恢复原账号直连</button></span>
  </div></li></ul>}
  <button className="textButton" aria-label="添加 API 直连" disabled={busy||!!stage} onClick={()=>void show()}><Icon name="plus" size={16}/>添加 API</button>
  <FlowDialog className={`tfRestartDialog tfSwitchDialog ${applying?'tfModelApplyDialog':''}`} open={open} title={applying?(restoring?'恢复原账号直连':'应用 API 直连'):'添加 API 直连'} busy={!!stage} showBusyIndicator={false} onClose={()=>setOpen(false)}>
   {applying?<div className="tfModelApplyBody"><AgentSwitchProgress progress={progress} label={target==='claude'?stage:undefined}/></div>:<>
   <label>API 来源<select value={selected} disabled={!!stage} onChange={e=>{setSelected(e.target.value);setError('');}}><option value="">选择已保存的 API</option>{choices.map(c=><option key={choiceId(c)} value={choiceId(c)} disabled={!c.available}>{c.name}{!c.available?'（需通过网关）':''}</option>)}</select></label>
   {!choices.length&&!stage&&!error&&<p className="tfHint">请先在“API 接口”添加来源。</p>}
   {stage&&<p role="status">{stage}</p>}{error&&<p role="alert" className="tfError">{error}</p>}
   <footer><button disabled={!!stage} onClick={()=>setOpen(false)}>取消</button><button className="primary" disabled={!!stage||!choice?.available} onClick={()=>void apply()}>应用</button></footer>
   </>}
  </FlowDialog>
 </>;
}
