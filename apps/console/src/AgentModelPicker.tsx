import {useLayoutEffect,useRef,useState,useId,type ReactNode} from 'react';
import type {LocalAgentSnapshot} from '../../../packages/core/src/cliproxy';
import {modelGroups,type Choice} from './flow-model';
import {qualifiedModelLabel as modelLabel} from './model-label';
import {compareNames,DragHandle,dropOrder,orderModels,useModelOrder} from './display-order';
import {modelManufacturer} from './UsagePanel';
import {ProviderIcon,providerIconKey} from './ProviderIcon';
import {QuotaRing} from './QuotaRing';
import {QuotaDetails,quotaPresentation} from './QuotaDetails';
import {FlowDialog} from './FlowDialog';
import {Icon} from './Icons';
import {sourceSelectionState,sourceSelectionNotice} from './source-options';

const same=(a:Choice,b:Choice)=>a.sourceId===b.sourceId&&a.model===b.model;
export function AgentModelPicker({open,title,local,current,selected,onConfirm,onClose,embedded=false,busy=false,onSelectionChange,compact=false,applicationOptions}:{applicationOptions?:ReactNode;compact?:boolean;embedded?:boolean;busy?:boolean;onSelectionChange?:(choices:Choice[])=>void;open:boolean;title:string;local:LocalAgentSnapshot;current?:Choice;selected:Choice[];onConfirm:(choices:Choice[])=>void;onClose:()=>void}){
 const catalogId=useId();
 const [query,setQuery]=useState(''),[draft,setDraft]=useState<Choice[]>([]),[source,setSource]=useState(''),[provider,setProvider]=useState(''),[quotaOpen,setQuotaOpen]=useState(false);
 const [order,,ranks,moveModel]=useModelOrder();const displayOrder=order==='manual'?'manual':'name';
 const search=useRef<HTMLInputElement>(null),list=useRef<HTMLDivElement>(null);
 const positions=useRef(new Map<string,number>());
 const all=modelGroups(local).sort((a,b)=>Number(b.provider==='api')-Number(a.provider==='api')||compareNames(a.label,b.label));
 useLayoutEffect(()=>{setQuotaOpen(false);if(!open)return;setQuery('');setProvider('');setDraft(selected);setSource(compact?'':current?.sourceId??selected[0]?.sourceId??all[0]?.id??'');positions.current.clear();},[open]);
 const releaseSearch=()=>{if(document.activeElement===search.current)search.current?.blur();};
 const updateDraft=(next:Choice[]|((items:Choice[])=>Choice[]))=>{const value=typeof next==='function'?next(draft):next;setDraft(value);onSelectionChange?.(value);};
 const q=query.trim().toLowerCase();
 const groups=all.map(group=>({...group,models:orderModels(group.models.filter(model=>!q||`${group.label} ${group.providerLabel} ${model.id} ${model.label}`.toLowerCase().includes(q)),model=>model.label,displayOrder,ranks)})).filter(group=>group.models.length);
 const active=groups.find(group=>group.id===source)??(!compact?groups[0]:undefined);
 const quotaOverview=active?.quota?quotaPresentation(active.quota).overview:[];
 const quotaLabel=(label:string)=>active?.provider==='antigravity'?label.replace(/^Gemini Models/i,'Gemini').replace(/^Claude and GPT models/i,'Claude / GPT').replace(/Weekly Limit Remaining/i,'周额度').replace(/Five Hour Limit Remaining/i,'5 小时'):label;
 const providers=[...new Map(groups.map(group=>[providerIconKey(group.provider),group])).entries()];
 const activeProvider=active?providerIconKey(active.provider):provider;
 const accounts=groups.filter(group=>providerIconKey(group.provider)===activeProvider);
 const key=`${active?.id??''}\n${q}`;
 useLayoutEffect(()=>{if(list.current)list.current.scrollTop=positions.current.get(key)??0;},[key]);
 const chooseSource=(id:string)=>{if(list.current)positions.current.set(key,list.current.scrollTop);setSource(id);};
 const unavailable=(choice:Choice)=>sourceSelectionState(local,choice)==='unavailable';
 const unavailableCount=draft.filter(unavailable).length;
 const removeUnavailable=()=>updateDraft(items=>items.filter(choice=>!unavailable(choice)));
 const notice=sourceSelectionNotice(local,draft);
 const toggle=(choice:Choice)=>updateDraft(items=>items.some(item=>same(item,choice))?items.filter(item=>!same(item,choice)):[...items,choice]);
 const chosen=orderModels(draft,item=>modelLabel(local,item.model),displayOrder,ranks);
 const chosenIds=chosen.map(item=>item.model),visibleIds=active?.models.map(model=>model.id)??[];
 const move=(from:string,to:string,items:readonly string[],after=false)=>{moveModel(from,to,items,after);};
 const count=(id:string)=>draft.filter(item=>item.sourceId===id).length;
 const sourceChoices=active?.models.map(model=>({sourceId:active.id,model:model.id})).filter(choice=>!draft.some(item=>item.model===choice.model&&!same(item,choice)))??[];
 const sourceSelected=sourceChoices.length>0&&sourceChoices.every(choice=>draft.some(item=>same(item,choice)));
 const content=<>
  <div className="tfPickerToolbar">{compact&&<h3>{title}</h3>}<label className="tfSearch tfAgentPickerSearch"><Icon name="search" size={16}/><input ref={search} type="search" placeholder="搜索模型、来源或账号" aria-label="搜索厂商、账号或模型" value={query} onChange={event=>{if(list.current)positions.current.set(key,list.current.scrollTop);setQuery(event.target.value);}}/></label></div>
  {(!compact||draft.length>0)&&<section className="tfAgentPicked" aria-label="已选模型">
   <header><span>已选模型 <b aria-live="polite">{draft.length}</b></span><div className="tfRow">{embedded&&unavailableCount>0&&<button type="button" className="textButton" onClick={removeUnavailable}>移除不可用模型（{unavailableCount}）</button>}<button type="button" className="textButton" disabled={!draft.length} onClick={()=>updateDraft([])}>清空选择</button></div></header>
   <ul>{chosen.map(choice=>{const group=all.find(group=>group.id===choice.sourceId);const label=modelLabel(local,choice.model);const invalid=unavailable(choice);return <li className={`tfAgentPickedTag tfDragRow ${invalid?'unavailable':''}`} key={`${choice.sourceId}/${choice.model}`} {...dropOrder('models',choice.model,chosenIds,move)} title={`${label} · ${group?.accountLabel??(invalid?'当前来源未提供此模型':'来源信息待加载')}`}>
    <DragHandle kind="models" id={choice.model} label={label} items={chosenIds} move={move}/><ProviderIcon provider={modelManufacturer(choice.model,local)} size={24}/><strong>{label}</strong><button type="button" className="iconButton" aria-label={`移除 ${label}`} onClick={()=>toggle(choice)}><Icon name="close" size={12}/></button>
   </li>;})}</ul>{!chosen.length&&<p>从下方选择模型</p>}
  </section>}
  {notice&&<p className="tfHint" role="status">{notice}</p>}
  <div className={`tfAgentPickerBrowser ${compact?'tfCompactBrowser':''}`} onWheel={releaseSearch}>
   {compact?<>
    <div className="tfAgentPickerSources" role="tablist" aria-label="模型厂商">
     {providers.map(([id,group],index)=><button type="button" role="tab" key={id} aria-selected={activeProvider===id} aria-controls={`${catalogId}-accounts`} tabIndex={(providers.some(([key])=>key===activeProvider)?activeProvider:providers[0]?.[0])===id?0:-1} title={group.providerLabel} aria-label={group.providerLabel} onClick={()=>{setProvider(id);chooseSource('');}} onKeyDown={event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?providers.length-1:(index+(event.key==='ArrowRight'?1:-1)+providers.length)%providers.length;
      setProvider(providers[next][0]);chooseSource('');event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus({preventScroll:true});
     }}><ProviderIcon provider={id} size={22}/></button>)}
     {!groups.length&&<p className="tfHint">没有匹配的来源</p>}
    </div>
    {accounts.length>0&&<fieldset className="tfPickerAccounts" id={`${catalogId}-accounts`}><legend>{activeProvider==='api'?'选择 API 接口':'选择账号'}</legend><div className="tfAccessChoices">
     {accounts.map(group=><label key={group.id}><input type="radio" name={`${catalogId}-account`} value={group.id} checked={active?.id===group.id} onChange={()=>chooseSource(group.id)}/><span title={group.accountLabel}>{group.accountLabel}{count(group.id)>0&&<b className="tfPickerAccountCount">{count(group.id)}</b>}</span></label>)}
    </div></fieldset>}
   </>:<>
   <div className="tfAgentPickerSources" role="tablist" aria-label="模型来源" aria-orientation={compact?'horizontal':'vertical'}>
    <span className="tfAgentPickerCaption">来源与账号</span>
    {groups.map(group=><button type="button" role="tab" aria-selected={active?.id===group.id} aria-controls={(!compact||active||q)?catalogId:undefined} tabIndex={(active?.id??groups[0]?.id)===group.id?0:-1} onKeyDown={event=>{if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=groups.findIndex(item=>item.id===group.id),next=event.key==='Home'?0:event.key==='End'?groups.length-1:(index+(event.key==='ArrowDown'||event.key==='ArrowRight'?1:-1)+groups.length)%groups.length;chooseSource(groups[next].id);event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus({preventScroll:true});}} title={group.label} aria-label={group.label} key={group.id} onClick={()=>chooseSource(group.id)}>
     <ProviderIcon provider={group.provider} size={20}/><span><strong>{group.provider==='api'?group.accountLabel:group.providerLabel}</strong><small title={group.accountLabel}>{group.provider==='api'?'API 接口':group.accountLabel}</small></span>{count(group.id)>0&&<b className="chosen">{count(group.id)}</b>}
    </button>)}
    {!groups.length&&<p className="tfHint">没有匹配的来源</p>}
   </div>
   </>}
   {(!compact||!!active||!groups.length)&&<section className="tfAgentPickerCatalog tfPickSource" id={catalogId} role="tabpanel" aria-label={active?.label??'模型列表'}>
    {active?<>
     <header><div className="tfAgentCatalogIdentity"><strong>{active.provider==='api'?active.accountLabel:active.providerLabel}</strong><small title={active.accountLabel}>{compact||active.provider==='api'?`${active.models.length} 个模型`:`${active.accountLabel} · ${active.models.length} 个模型`}</small></div>
      {!!quotaOverview.length&&<div className="tfAgentPickerRings" aria-label={`${active.accountLabel} 额度`}>{quotaOverview.map(window=><span className="tfAgentPickerQuotaWindow" key={window.id} title={window.label}>
       <QuotaRing compact remaining={window.usedPercent===null?null:100-window.usedPercent} label={window.label}/><span>{quotaLabel(window.label)}{window.displayValue&&<small>{window.displayValue}</small>}</span>
      </span>)}</div>}
      {active.quota&&<button type="button" className="textButton tfModelQuotaButton" onClick={()=>setQuotaOpen(true)}>{active.quota.status==='error'?(active.quota.windows.length?'上次额度 · 更新失败':'额度查询失败'):'额度详情'}</button>}
      <button type="button" className="textButton" disabled={!sourceChoices.length} onClick={()=>updateDraft(items=>sourceSelected?items.filter(item=>!sourceChoices.some(choice=>same(item,choice))):[...items,...sourceChoices.filter(choice=>!items.some(item=>same(item,choice)))])}>{sourceSelected?'取消全选':'全选'}</button>
     </header>
     <div ref={list} className="tfPickBody tfAgentPickerModelList" onScroll={event=>positions.current.set(key,event.currentTarget.scrollTop)}><div className="tfPickOptions">
      {active.models.map(model=>{const choice={sourceId:active.id,model:model.id};const on=draft.some(item=>same(item,choice));const duplicate=draft.some(item=>item.model===model.id&&!same(item,choice));return <div key={model.id} className="tfPickDraggableRow tfDragRow" {...dropOrder('models',model.id,visibleIds,move)}>
       <DragHandle kind="models" id={model.id} label={model.label} items={visibleIds} move={move}/>
       <button type="button" className={`tfPickModel ${on?'on':''}`} aria-label={model.label} aria-pressed={on} disabled={duplicate} title={duplicate?'已从其他账号选择此模型，请先移除原选择':model.id} onClick={()=>toggle(choice)}>
        <ProviderIcon provider={modelManufacturer(model.id,local)} size={28}/><span><strong>{model.label}</strong><small className="tfModelIdentity">{model.id}</small>{duplicate&&<small>已从其他账号选择</small>}</span><span className={`tfAgentPickCheck ${on?'on':''}`} aria-hidden="true">{on?'✓':<Icon name="plus" size={12}/>}</span>
       </button>
      </div>;})}
     </div></div>
    </>:<div className="tfAgentPickerEmpty"><Icon name={compact&&!q?'plus':'search'} size={24}/><strong>{compact&&!q&&groups.length?'选择来源查看模型':q?'没有匹配的模型':'还没有可用模型'}</strong>{(!compact||q||!groups.length)&&<p>{q?'试试其他模型名或账号':'在账号授权或 API 接口添加来源'}</p>}</div>}
   </section>}
  </div>
  {open&&quotaOpen&&active?.quota&&<FlowDialog open title={`${active.providerLabel} 账号额度`} className="tfModelQuotaDialog" onClose={()=>setQuotaOpen(false)}><p className="tfHint">{active.accountLabel}</p><QuotaDetails quota={active.quota} label={active.accountLabel} compact concise/></FlowDialog>}
  {applicationOptions&&<div className="tfAgentPicked">{applicationOptions}</div>}
  {!embedded&&<footer><span aria-live="polite">已选择 {draft.length} 个模型{unavailableCount>0&&<button type="button" className="textButton tfRemoveUnavailable" onClick={removeUnavailable}>移除不可用模型（{unavailableCount}）</button>}</span><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" disabled={busy||!draft.length} onClick={()=>{onConfirm(draft);onClose();}}>应用所选模型</button></footer>}
 </>;
 if(embedded)return open?<section className={`tfAgentPicker tfInlineAgentPicker ${compact?'tfCompactPicker':''}`} aria-label={title} inert={busy} aria-busy={busy}>{content}</section>:null;
 return <FlowDialog open={open} title={title} className="tfAgentPicker" onClose={onClose}>{content}</FlowDialog>;
}
