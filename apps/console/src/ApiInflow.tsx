import {orderApiSources} from './api-source-order';
import { apiModelRoute, normalizeApiBaseURL, protocolFromURL } from '../../shared/api-endpoint';
import type {MaintenanceContext} from '../../../packages/core/src/maintenance-conversations';
import {Thinking} from './LoadingState';
import {orderModels,useModelOrder} from './display-order';
import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import {FlowDialog} from './FlowDialog';
import {SupplierImport} from './SupplierImport';
import type { ApiSource } from '../../../packages/core/src/api-sources';
import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';
import { requestJSON } from './request';
import { Icon } from './Icons';
import { parseModels, protocolNames, sourceProtocolLabel, validateDraft, type DraftErrors } from './api-source-draft';
import type { Notify } from './notify';
import type { UsageData } from './usage-data';
import {UsageFold} from './UsagePanel';
import {tokenTotalText,localDay,totalsOf} from './usage-model';
import {useListReturn} from './list-return';


import {copyText} from './clipboard';

const json=(method:string,body:unknown)=>({method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});

/** Short, in-row wording for a connectivity check. The long service message stays off the card. */
export function connectivityResult(passed:boolean,message:string){
 const state=passed?'ok':message.includes('有响应')?'weak':'fail';
 const phrase=state==='ok'?'已连通':state==='weak'?'有响应':'未连通';
 const hint=state==='ok'?'接口可用':state==='weak'?'接口已响应，返回尚不完整':/密钥|API Key|权限/.test(message)?'检查密钥或模型权限':/限流|429/.test(message)?'请求较多，稍后再试':/超时|无法连接/.test(message)?'检查网络或接口地址':message?'检查接口地址和模型设置':'这次没有连通';
 return {state,phrase,hint} as const;
}

function ModelActions({name,probing,copied,disabled,onProbe,onCopy}:{name:string;probing:boolean;copied:boolean;disabled:boolean;onProbe:()=>void;onCopy:()=>void}){
 const id=useId(),panel=useRef<HTMLDivElement>(null);
 const place=(event:MouseEvent<HTMLButtonElement>)=>{const box=event.currentTarget.getBoundingClientRect();if(!panel.current)return;panel.current.style.left=`${Math.max(12,Math.min(window.innerWidth-188,box.right-176))}px`;panel.current.style.top=`${Math.min(window.innerHeight-96,box.bottom+6)}px`;};
 const close=()=>panel.current?.hidePopover();
 return <span className="tfProbeActions"><button type="button" className="textButton" aria-label={`${name} 的模型操作`} popoverTarget={id} onClick={place}><Icon name="menu" size={14}/>操作</button><div ref={panel} id={id} popover="auto" className="tfKeyActionMenu" aria-label={`${name} 的模型操作`}><button type="button" disabled={disabled||probing} onClick={()=>{close();onProbe();}}>{probing?'测试中…':'测试连通性'}</button><button type="button" disabled={disabled} onClick={()=>{close();onCopy();}}>{copied?'已复制':'复制全部模型'}</button></div></span>;
}

function ApiSourceCard({local,source,usage,disabled,editing,notify,onEdit,onToggle,onRemove,onSelect}:{onSelect:()=>void;usage:UsageData;local:LocalAgentSnapshot;source:ApiSource;disabled:boolean;editing:boolean;notify:Notify;onEdit:()=>void;onToggle:()=>void;onRemove:()=>void}){
 const [modelOrder,,modelRanks]=useModelOrder();
 const identity=(model:string)=>`api-${source.id}/${model}`;const sortedModels=orderModels(source.models,model=>model,modelOrder,modelRanks,identity);
 const sourceRows=usage.allRows.filter(row=>row.sourceId===source.id&&row.origin!=='native');
 const today=totalsOf(sourceRows.filter(row=>row.day===localDay(new Date())));
 const ready=local.state==='running'&&source.models.length>0&&source.models.every(model=>local.models.some(route=>route.id===identity(model)));
 const status=!source.enabled?'已停用':!source.hasKey?'密钥不可读':local.state!=='running'?'网关未启动':!source.models.length?'未配置模型':ready?'已就绪':local.apiRoutesSyncing?'路由同步中':'路由未就绪';
 const [copied,setCopied]=useState('');
 const [flipped,setFlipped]=useState(false),[secret,setSecret]=useState(''),[revealing,setRevealing]=useState(false);
 const [probes,setProbes]=useState<Record<string,{state:'running'|'ok'|'weak'|'fail';phrase?:string;hint?:string}>>(()=>Object.fromEntries(Object.entries(source.checks??{}).map(([model,check])=>[model,connectivityResult(check.status==='passed',check.message)])));
 const [probing,setProbing]=useState(false);const probeVersion=useRef(0);
 const modelsSection=useRef<HTMLElement>(null),jumpToModels=useRef(false);
 const revealVersion=useRef(0);const flipButton=useRef<HTMLButtonElement>(null),returnButton=useRef<HTMLButtonElement>(null),didFlip=useRef(false);
 useLayoutEffect(()=>{if(didFlip.current)(flipped?returnButton:flipButton).current?.focus({preventScroll:true});if(flipped&&jumpToModels.current){jumpToModels.current=false;modelsSection.current?.focus({preventScroll:true});const section=modelsSection.current;const face=section?.closest<HTMLElement>('.tfCredentialBack');if(section&&face)face.scrollTop=section.offsetTop-8;}},[flipped]);
 useEffect(()=>()=>{revealVersion.current++;probeVersion.current++;},[]);
 const probeModels=async()=>{if(probing||!sortedModels.length)return;const version=++probeVersion.current;setProbing(true);setProbes({});try{for(const model of sortedModels){if(version!==probeVersion.current)return;setProbes(current=>({...current,[model]:{state:'running'}}));try{const result=await requestJSON<{passed:boolean;message:string}>(`/api/sources/${source.id}/check`,json('POST',{model}),95000);if(version!==probeVersion.current)return;const next=connectivityResult(result.passed,result.message);setProbes(current=>({...current,[model]:next}));}catch{if(version!==probeVersion.current)return;setProbes(current=>({...current,[model]:connectivityResult(false,'')}));}}}finally{if(version===probeVersion.current)setProbing(false);void usage.reload();}};
 const probeSummary=(()=>{const states=sortedModels.map(model=>probes[model]?.state).filter(Boolean);if(!states.length)return '';const running=states.filter(state=>state==='running').length;if(running)return `正在测试 ${states.length-running}/${sortedModels.length}`;const count=(state:string)=>states.filter(item=>item===state).length;return [count('ok')&&`${count('ok')} 个已连通`,count('weak')&&`${count('weak')} 个有响应`,count('fail')&&`${count('fail')} 个未连通`].filter(Boolean).join('，');})();
 const flip=()=>{didFlip.current=true;revealVersion.current++;setSecret('');setRevealing(false);setFlipped(value=>!value);};
 const reveal=async()=>{if(secret){revealVersion.current++;setSecret('');return;}const version=++revealVersion.current;setRevealing(true);try{const result=await requestJSON<{apiKey:string}>(`/api/sources/${source.id}/reveal-key`,json('POST',{}));if(version===revealVersion.current)setSecret(result.apiKey);}catch(error){if(version===revealVersion.current)notify({kind:'error',text:error instanceof Error?error.message:'读取凭证失败，请重试。'});}finally{if(version===revealVersion.current)setRevealing(false);}};
 const copy=async(value:string,id:string)=>{try{await copyText(value);setCopied(id);setTimeout(()=>setCopied(''),1500);}catch{notify({kind:'error',text:'复制失败，请选中后手动复制。'});}};

 return <article onPointerDown={onSelect} onFocusCapture={onSelect} className={`tfApiSourceCard ${source.enabled?'':'off'} ${flipped?'isFlipped':''}`} aria-label={source.name}>
  <div className={`tfCredential ${flipped?'flipped':''}`}><div className="tfCredentialInner">
   <div className="tfApiSourceBody tfCredentialFace" aria-hidden={flipped} inert={flipped}>
    <button ref={flipButton} className="tfCardFlipSurface" aria-label={`翻面查看 ${source.name} 凭证`} onClick={flip}/>
    <div className="tfApiCardTools"><span className="tfApiProtocol">{sourceProtocolLabel(source)}</span><div className="tfApiCardManage"><button className="textButton" disabled={disabled} onClick={onEdit}>{editing?'编辑中':'编辑'}</button><button className="textButton" disabled={disabled} onClick={onToggle}>{source.enabled?'停用':'启用'}</button><button className="textButton danger" disabled={disabled} onClick={onRemove}>删除</button></div></div>
    <header className="tfApiSourceHead"><div><h3>{source.name}</h3></div><span className={`tfKeyStatus ${source.enabled&&source.hasKey&&ready?'on':source.enabled?'warn':''}`}>{status}</span></header>

    <ul className="tfApiModelPreview" aria-label={`${source.name} 模型预览`}>{sortedModels.slice(0,3).map(model=><li key={model}><code title={model}>{model}</code></li>)}</ul>
    {!source.models.length&&<p className="tfHint">尚未添加模型，编辑接口后即可接入。</p>}
    {source.models.length>3&&<button type="button" className="textButton tfApiMoreModels" aria-label={`查看 ${source.name} 的全部 ${source.models.length} 个模型`} onClick={()=>{jumpToModels.current=true;flip();}}>另有 {source.models.length-3} 个模型<Icon name="arrow" size={12}/></button>}
    <div className="tfKeyTotal tfApiToday tfApiUsageCounts" title="TokenFlow 已记录的当日用量，包含保存验证和连通性测试。"><span>当日用量</span><b>{usage.loaded?tokenTotalText(today,true):'—'}<small>Token</small></b></div>
   </div>
   <div className="tfCredentialFace tfCredentialBack" aria-hidden={!flipped} inert={!flipped}>
    <button ref={returnButton} className="tfCardFlipSurface" aria-label={`返回 ${source.name} 卡片正面`} onClick={flip}/>
    <h3>{source.name}</h3>
    <dl className="tfCredentialMeta"><div><dt>协议</dt><dd>{sourceProtocolLabel(source)}</dd></div><div><dt>模型权限</dt><dd>{source.models.length} 个模型</dd></div></dl>
    <label>接口地址<div className="inputAction"><input aria-label={`${source.name} 接口地址`} readOnly value={source.baseURL} onFocus={event=>event.target.select()}/><button type="button" onClick={()=>void copy(source.baseURL,'url')}>{copied==='url'?'已复制':'复制'}</button></div></label>
    <label>API Key<div className="inputAction"><input aria-label={`${source.name} API Key`} type={secret?'text':'password'} readOnly value={secret||'****************'} onFocus={event=>event.target.select()}/><button type="button" disabled={revealing||!source.hasKey} onClick={()=>void reveal()}>{revealing?'读取中…':secret?'隐藏':'显示'}</button>{secret&&<button type="button" onClick={()=>void copy(secret,'key')}>{copied==='key'?'已复制':'复制'}</button>}</div></label>
    <section ref={modelsSection} tabIndex={-1} className="tfCredentialModels" aria-label={`${source.name} 完整模型列表`}><header><strong>模型 · {source.models.length}</strong>{probeSummary&&<span className="tfProbeSummary" aria-live="polite">{probeSummary}</span>}<ModelActions name={source.name} probing={probing} copied={copied==='models'} disabled={!sortedModels.length} onProbe={()=>void probeModels()} onCopy={()=>void copy(sortedModels.join('\n'),'models')}/></header><ul>{sortedModels.map(model=>{const probe=probes[model];return <li key={model}><code>{model}</code><span className="tfHint" title={apiModelRoute(source,model).baseURL}>{protocolNames[apiModelRoute(source,model).protocol]}</span>{probe&&<em className={`tfProbe ${probe.state}`} title={probe.hint}>{probe.state==='running'?'测试中':probe.phrase}</em>}<button className="iconButton" aria-label={`复制模型 ${model}`} onClick={()=>void copy(model,model)}><Icon name={copied===model?'checkCircle':'copy'} size={13}/></button></li>;})}</ul></section>

   </div>
  </div></div>

 </article>;
}

export function ApiInflow({local,usage,onChange,notify,onContext}:{onContext?:(context:MaintenanceContext)=>void;local:LocalAgentSnapshot;usage:UsageData;onChange:()=>Promise<void>;notify:Notify}){
 const sources=orderApiSources(local.apiSources??[],usage.allRows);
 const pendingSaved=useRef<ApiSource|null>(null);
 useEffect(()=>{
  const source=pendingSaved.current;
  if(source&&local.state==='running'&&source.models.length&&source.models.every(model=>local.models.some(route=>route.id===`api-${source.id}/${model}`))){
   pendingSaved.current=null;notify({kind:'ok',title:'模型路由已就绪',text:`${source.name} 的模型路由已同步，可以使用。`});
  }
 },[local,notify]);
 const [selectedSource,setSelectedSource]=useState<string>();
 useEffect(()=>onContext?.({page:'apis',sourceId:sources.some(source=>source.id===selectedSource)?selectedSource:undefined,range:usage.range}),[selectedSource,usage.range,onContext]);

 // undefined: closed, null: adding, source: editing
 const [form,setForm]=useState<ApiSource|null>();
 const rememberEditor=useListReturn(form!==undefined);
 const [name,setName]=useState('');const [baseURL,setBaseURL]=useState('');const [apiKey,setApiKey]=useState('');const nextModelId=useRef(1);const [modelRows,setModelRows]=useState([{id:0,value:''}]);
 const model=modelRows.map(row=>row.value).join('\n');const modelCount=parseModels(model).length;
 const [keyEditing,setKeyEditing]=useState(false);const [visible,setVisible]=useState(false);const [revealed,setRevealed]=useState('');const [revealing,setRevealing]=useState(false);const revealVersion=useRef(0);
 const [errors,setErrors]=useState<DraftErrors>({});const [failure,setFailure]=useState('');
 const [protocolChosen,setProtocolChosen]=useState(false);const [choosingProtocol,setChoosingProtocol]=useState(false);const [verificationOpen,setVerificationOpen]=useState(false);const [protocol,setProtocol]=useState<ApiSource['protocol']>('chat');
 const [busy,setBusy]=useState(false);const controller=useRef<AbortController|null>(null);
 const nameOnly=!!form&&!apiKey.trim()&&baseURL.trim()===form.baseURL&&JSON.stringify(parseModels(model))===JSON.stringify(form.models);

 const open=(source:ApiSource|null)=>{if(form===undefined)rememberEditor();revealVersion.current++;setKeyEditing(!source?.hasKey);setVisible(false);setRevealed('');setRevealing(false);setVerificationOpen(false);setProtocol(source?.protocol??'chat');setForm(source);setName(source?.name??'');setBaseURL(source?.baseURL??'');setApiKey('');setModelRows((source?.models.length?source.models:['']).map(value=>({id:nextModelId.current++,value})));setErrors({});setFailure('');};
 const close=()=>{setVerificationOpen(false);revealVersion.current++;setVisible(false);setRevealed('');controller.current?.abort();setForm(undefined);setApiKey('');setFailure('');};

 // A source that Agents or Keys use asks once before it changes, instead of blocking up front.
 async function guarded<T>(run:(acknowledge:boolean)=>Promise<T>,usedText:string):Promise<T|undefined>{
  try{return await run(false);}
  catch(error){
   if((error as {code?:string}).code==='api_source_in_use'&&window.confirm(`${usedText}\n仍要继续吗？`))return run(true);
   throw error;
  }
 }

 async function submit(event:React.SyntheticEvent,forceVerify=false){
  event.preventDefault();if(busy)return;
  const found=validateDraft({name,baseURL,apiKey,model},!!form);setErrors(found);setFailure('');
  if(Object.keys(found).length)return;
  if(nameOnly&&!forceVerify){void save(false);return;}
  setProtocolChosen(false);setChoosingProtocol(false);setVerificationOpen(true);
 }

 async function save(verify:boolean,selectedProtocol=protocol){
  if(busy)return;
  const abort=new AbortController();controller.current=abort;setBusy(true);
  try{
   const saved=await guarded(acknowledge=>requestJSON<ApiSource&{routingError?:string;routingPending?:boolean}>(verify?'/api/sources/quick':form?`/api/sources/${form.id}`:'/api/sources',{...json(verify||!form?'POST':'PUT',verify?{id:form?.id,name:name.trim(),baseURL:baseURL.trim(),apiKey:apiKey.trim()||undefined,model,acknowledge:acknowledge||undefined}:{name:name.trim(),baseURL:normalizeApiBaseURL(baseURL),apiKey:apiKey.trim()||undefined,protocol:selectedProtocol,models:parseModels(model),enabled:form?.enabled??true,acknowledge:acknowledge||undefined}),signal:abort.signal},90000),'此来源正被 Agent 或本地 Key 使用，修改会影响它们。');
   if(!saved)return;
   pendingSaved.current=saved.routingPending?saved:null;
   setVerificationOpen(false);revealVersion.current++;setRevealed('');setVisible(false);setForm(undefined);setApiKey('');
   notify({kind:saved.routingError?'warning':'ok',title:saved.routingError?'来源已保存':undefined,text:saved.routingError??(nameOnly?`名称备注已保存：${saved.name}`:`${form?'已更新':'已添加'}：${saved.name}，${saved.models.length} 个模型（${sourceProtocolLabel(saved)}）`)});
   await Promise.all([onChange(),usage.reload()]);
  }catch(error){setVerificationOpen(false);setFailure(error instanceof Error?error.message:'保存失败，请检查填写内容。');}
  finally{controller.current=null;setBusy(false);}
 }

 async function toggle(source:ApiSource){
  try{
   const saved=await guarded(acknowledge=>requestJSON<ApiSource&{routingError?:string;routingPending?:boolean}>(`/api/sources/${source.id}`,json('PUT',{name:source.name,baseURL:source.baseURL,protocol:source.protocol,models:source.models,enabled:!source.enabled,acknowledge})),`此来源正被使用，${source.enabled?'停用':'启用'}会影响它们。`);
   if(saved?.routingError){pendingSaved.current=saved.routingPending?saved:null;notify({kind:'warning',title:'来源已保存',text:saved.routingError});}
   await onChange();
  }catch(error){notify({kind:'error',text:error instanceof Error?error.message:'操作失败'});}
 }
 async function remove(source:ApiSource){
  if(!window.confirm(`删除 ${source.name} 及其保存的 API Key？`))return;
  try{await requestJSON(`/api/sources/${source.id}`,json('DELETE',{}));await onChange();}
  catch(error){notify({kind:'error',text:error instanceof Error?error.message:'删除失败'});}
 }

 return <section className="tfApis" aria-label="API 接口">
  <header className="tfCollectionHead"><UsageFold loaded={usage.loaded} error={usage.error} onRetry={usage.reload} title="API 接口用量" subtitle="今日 API 用量与缓存命中" rows={usage.allRows.filter(row=>row.day===localDay(new Date())&&row.origin!=='native'&&sources.some(source=>source.id===row.sourceId))} range="today"/><SupplierImport disabled={busy||form!==undefined} onChange={onChange} notify={notify}/><button className="iconButton tfCollectionAdd" aria-label="添加 API" title="添加 API" disabled={busy||form!==undefined} onClick={()=>open(null)}><Icon name="plus" size={18}/></button></header>
  {form!==undefined&&<FlowDialog open title={form?`编辑 API · ${form.name}`:'添加 API'} className="tfApiEditorDialog" onClose={close}><form className="tfForm tfApiEditor" onSubmit={event=>void submit(event)} noValidate aria-label={form?'编辑 API':'添加 API'}>
   <div className="tfKeyFields">
   <label>名称备注<input name="name" autoComplete="off" aria-invalid={!!errors.name} value={name} disabled={busy} onChange={event=>{setName(event.target.value);setErrors(e=>({...e,name:undefined}));}} placeholder="例如：公司中转 · Kimi" autoFocus/>{errors.name&&<span className="tfError">{errors.name}</span>}</label>
   <label>URL<input name="baseURL" inputMode="url" autoComplete="off" spellCheck={false} aria-invalid={!!errors.baseURL} value={baseURL} disabled={busy} onChange={event=>{setBaseURL(event.target.value);setErrors(e=>({...e,baseURL:undefined}));}} placeholder="https://api.example.com/v1"/>{errors.baseURL&&<span className="tfError">{errors.baseURL}</span>}</label>
   </div>
   <label>API Key<div className="inputAction"><input name="apiKey" aria-label="API Key" type={visible?'text':'password'} autoComplete="off" spellCheck={false} aria-invalid={!!errors.apiKey} readOnly={!keyEditing} value={keyEditing?apiKey:(visible?revealed:'********')} disabled={busy||revealing} onFocus={event=>event.target.select()} onChange={event=>{setApiKey(event.target.value);setRevealed('');setErrors(e=>({...e,apiKey:undefined}));}} placeholder="sk-…"/>
    <button type="button" disabled={busy||revealing} onClick={()=>void (async()=>{
     if(visible){setVisible(false);setRevealed('');return;}
     if(keyEditing||!form?.hasKey){setVisible(true);return;}
     const version=++revealVersion.current;setRevealing(true);
     try{const result=await requestJSON<{apiKey:string}>(`/api/sources/${form.id}/reveal-key`,json('POST',{}));if(version===revealVersion.current){setRevealed(result.apiKey);setVisible(true);}}
     catch(error){if(version===revealVersion.current)setFailure(error instanceof Error?error.message:'读取密钥失败');}
     finally{if(version===revealVersion.current)setRevealing(false);}
    })()}>{revealing?'读取中…':visible?'隐藏密钥':'显示完整密钥'}</button>{form?.hasKey&&<button type="button" disabled={busy||revealing} onClick={()=>{revealVersion.current++;setKeyEditing(!keyEditing);setApiKey('');setRevealed('');setVisible(false);}}>{keyEditing?'保留原密钥':'更换密钥'}</button>}</div>{errors.apiKey&&<span className="tfError">{errors.apiKey}</span>}</label>
   <fieldset className="tfApiModels" disabled={busy} aria-describedby="api-models-help">
    <legend>可用模型 · {modelCount} 个</legend>
    <p id="api-models-help" className="tfHint">这些模型共用基础 URL，可分别使用不同协议。</p>
    {modelRows.map((row,index)=><div className="tfApiModelRow" key={row.id}>
     <label>{index===0?'模型名称':`模型名称 ${index+1}`}<input name="model" autoComplete="off" spellCheck={false} aria-invalid={!!errors.model} value={row.value} onChange={event=>{setModelRows(rows=>rows.map(item=>item.id===row.id?{...item,value:event.target.value}:item));setErrors(e=>({...e,model:undefined}));}} placeholder="填写完整模型 ID，例如 gpt-5"/></label>
     <button type="button" className="textButton" aria-label={`移除模型 ${index+1}`} disabled={modelRows.length===1} onClick={()=>{setModelRows(rows=>rows.filter(item=>item.id!==row.id));setErrors(e=>({...e,model:undefined}));}}>移除</button>
    </div>)}
    {errors.model&&<span className="tfError" role="alert">{errors.model}</span>}
    <button type="button" className="tfAddButton" disabled={modelRows.length>=50} onClick={()=>setModelRows(rows=>[...rows,{id:nextModelId.current++,value:''}])}><Icon name="plus" size={15}/>添加模型</button>
    <p className="tfHint">上限 50 个，验证会尝试协议并保存路由。</p>
   </fieldset>
   {failure&&<p className="tfError" role="alert">{failure}</p>}
   {busy&&<Thinking label="正在保存接口信息"/>}
   <footer className="tfApiFormFoot"><p/><div className="tfRow">
    <button className="primary" disabled={busy||!name.trim()||!baseURL.trim()||(!form&&!apiKey.trim())||!parseModels(model).length}>{busy?'保存中…':form?'保存':'添加'}</button>
    {form&&<button type="button" disabled={busy} onClick={event=>void submit(event,true)}>重新验证模型协议</button>}
    <button type="button" onClick={close}>取消</button>
   </div></footer>
  </form></FlowDialog>}
  <FlowDialog open={verificationOpen} title="验证接口？" className="tfVerifyDialog" busy={busy} onClose={()=>setVerificationOpen(false)}>
   <p>是否需要验证可用性并自动识别接口协议？</p>
   <p className="tfHint">每个模型优先按 URL 后缀发送一次探针，成功即停止；失败后才尝试其他协议。验证会产生少量用量。</p>
   {choosingProtocol?<>
    <p className="tfHint">URL 后缀无法确定协议，请选择服务文档注明的协议。仅以 /v1 结尾也需要选择。</p>
    <label>接口协议<select aria-label="接口协议" disabled={busy} value={protocolChosen?protocol:''} onChange={event=>{setProtocol(event.target.value as ApiSource['protocol']);setProtocolChosen(true);}}><option value="" disabled>请选择接口协议</option>{Object.entries(protocolNames).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
    <footer><button disabled={busy} onClick={()=>setChoosingProtocol(false)}>返回</button><button className="primary" disabled={busy||!protocolChosen} onClick={()=>void save(false)}>{busy?'保存中…':'按所选协议保存'}</button></footer>
   </>:<footer><button disabled={busy} onClick={()=>{const inferred=protocolFromURL(baseURL);if(inferred)void save(false,inferred);else setChoosingProtocol(true);}}>{busy?'保存中…':'跳过验证，直接保存'}</button><button className="primary" disabled={busy} onClick={()=>void save(true)}>{busy?'处理中…':'验证并保存'}</button></footer>}
  </FlowDialog>
  {sources.length>0?<div className="tfApiSourceGrid">{sources.map(source=><ApiSourceCard onSelect={()=>setSelectedSource(source.id)} key={source.id} local={local} usage={usage} source={source} disabled={busy||form!==undefined} editing={form?.id===source.id} notify={notify} onEdit={()=>open(source)} onToggle={()=>void toggle(source)} onRemove={()=>void remove(source)}/>)}</div>:form===undefined&&<div className="tfKeyEmpty"><h3>添加第一个 API 接口</h3><p>支持 Responses、Chat Completions 和 Anthropic Messages。<br/>填写已有接口的地址、Key 和模型，即可接入。</p></div>}

 </section>;
}
