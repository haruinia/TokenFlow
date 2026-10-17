import {useEffect,useLayoutEffect,useRef,useState,type KeyboardEvent,type ReactNode} from 'react';
import {cleanupBytes,cleanupCategoryLabels,cleanupRiskLabels,cleanupPresets,type CleanupMethod,type CleanupCategory,type CleanupEntry,type CleanupRisk,type CleanupSnapshot,type CleanupScanScope} from '../../shared/file-cleanup';
import {Icon} from './Icons';
import {requestJSON} from './request';
import {cleanupCheckTools} from '../../shared/file-cleanup-tools';
import './file-cleanup.css';

const post=(body:unknown={})=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const selectable=(entry:CleanupEntry)=>entry.complete&&entry.state==='ready';
const risks:CleanupRisk[]=['rebuildable','review','protected'];
const scopeGroups:{category:CleanupCategory;summary:string}[]=[{category:'package',summary:'npm、npx、pip、uv、pnpm'},{category:'agent',summary:'Agent 运行时、会话与配置'},{category:'application',summary:'Claude、Qoder、Cursor、VS Code、Chromium 等'},{category:'build',summary:'Gradle、Go 构建缓存与安装下载'},{category:'artifact',summary:'疑似应用副本、打包版本与安装包'}];

function ScanScope({data,disabled,onAdd,onRemove,onScope}:{data:CleanupSnapshot;disabled:boolean;onAdd:()=>void;onRemove:(index:number)=>void;onScope:(scope:CleanupScanScope)=>void}){
 return <div className="tfCleanupScopeContent"><header className="tfCleanupSectionHead"><h2>本次扫描范围</h2><span>{({darwin:'macOS',win32:'Windows',linux:'Linux'} as Record<string,string>)[data.platform]??data.platform} · {data.scanScope==='all'?'所有可访问磁盘':'常见位置'}</span></header><div className="tfCleanupLocations">{scopeGroups.map(({category,summary})=>{
  const locations=data.locations?.filter(location=>location.category===category)??[];
  if(!locations.length)return null;
  return <details className="tfCleanupLocationGroup" key={category}><summary><strong>{cleanupCategoryLabels[category]}</strong><span>{summary}</span><small>{locations.length} 个位置</small><Icon name="chevron" size={14}/></summary><ul>{locations.map((location,index)=><li key={`${location.path}-${index}`}><span>{location.name}{location.risk==='protected'&&<small>受保护数据</small>}</span><span className="tfCleanupPath">{location.path}</span></li>)}</ul></details>;
 })}</div><div className="tfCleanupProjects"><header className="tfCleanupSectionHead tfCleanupProjectsHead"><div><h2>扫描位置</h2><span>查找缓存、依赖与打包文件</span></div><div className="tfCleanupScopeActions"><label><input type="checkbox" checked={data.scanScope==='all'} disabled={disabled} onChange={event=>onScope(event.target.checked?'all':'common')}/>扫描所有磁盘</label><button type="button" className="textButton" disabled={!data.capabilities.pickDirectory||disabled} onClick={onAdd}><Icon name="plus" size={14}/>添加位置</button></div></header>{data.scanScope==='all'&&<ul>{data.diskRoots.map(root=><li key={root}><Icon name="briefcase" size={15}/><span>{root}</span></li>)}</ul>}{!!data.projectRoots.length&&<ul>{data.projectRoots.map((root,index)=><li key={root}><Icon name="briefcase" size={15}/><span>{root}</span><button type="button" className="textButton" disabled={disabled} aria-label={`移除扫描位置 ${root}`} onClick={()=>onRemove(index)}>移除</button></li>)}</ul>}</div><p className="tfCleanupScopeNote">只读取文件信息；跳过符号链接、系统运行目录和无权访问的位置。</p></div>;
}

export function FileCleanupPane({onRepair,tools}:{onRepair?:(prompt:string)=>void;tools?:ReactNode}){
 const [tab,setTab]=useState<'scan'|'scope'|'help'>('scan');
 const tabItems=[['scan','扫描清理'],['scope','扫描范围'],['help','清理帮助']] as const;
 const tabButtons=useRef<Partial<Record<typeof tab,HTMLButtonElement|null>>>({});
 const heading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{heading.current?.focus({preventScroll:true});},[]);
 const tabKey=(event:KeyboardEvent<HTMLButtonElement>,id:typeof tab)=>{const enabled=tabItems.filter(([key])=>!tabButtons.current[key]?.disabled),index=enabled.findIndex(item=>item[0]===id),length=enabled.length;const next=event.key==='ArrowRight'?(index+1)%length:event.key==='ArrowLeft'?(index+length-1)%length:event.key==='Home'?0:event.key==='End'?length-1:undefined;if(next===undefined||!length)return;event.preventDefault();setTab(enabled[next][0]);tabButtons.current[enabled[next][0]]?.focus();};
 const [data,setData]=useState<CleanupSnapshot>();
 const [error,setError]=useState(''),[connectionError,setConnectionError]=useState(''),[working,setWorking]=useState(false);
 const [risk,setRisk]=useState<CleanupRisk|'all'>('all'),[category,setCategory]=useState<CleanupCategory|'all'>('all'),[query,setQuery]=useState('');
 const [selected,setSelected]=useState<Set<string>>(new Set());
 const [method,setMethod]=useState<CleanupMethod>('trash'),[permanentText,setPermanentText]=useState('');
 const [confirm,setConfirm]=useState(false),[closedApps,setClosedApps]=useState(false),[reviewed,setReviewed]=useState(false);
 const actionLock=useRef(false),scanId=useRef<string|undefined>(undefined),alive=useRef(true);
 const confirmation=useRef<HTMLDivElement>(null),body=useRef<HTMLDivElement>(null),resultsScroll=useRef(0);
 useLayoutEffect(()=>{if(confirm){body.current?.scrollTo(0,0);confirmation.current?.querySelector('h3')?.focus({preventScroll:true});}else body.current?.scrollTo(0,resultsScroll.current);},[confirm]);
 useEffect(()=>{body.current?.scrollTo(0,0);},[tab]);
 useEffect(()=>{
  alive.current=true;let timer:ReturnType<typeof setTimeout>;
  const refresh=async()=>{
   try{const next=await requestJSON<CleanupSnapshot>('/api/file-cleanup');if(alive.current&&!actionLock.current){setData(next);setConnectionError('');}}
   catch(e){if(alive.current&&!actionLock.current)setConnectionError(e instanceof Error?e.message:'无法读取扫描状态。');}
   finally{if(alive.current)timer=setTimeout(()=>void refresh(),1500);}
  };
  void refresh();return()=>{alive.current=false;clearTimeout(timer);};
 },[]);
 useEffect(()=>{
  if(data?.scanId!==scanId.current){scanId.current=data?.scanId;setSelected(new Set());setConfirm(false);}
 },[data?.scanId]);
 const act=async(path:string,init:RequestInit=post())=>{
  if(actionLock.current)return;actionLock.current=true;setWorking(true);setError('');
  try{const next=await requestJSON<CleanupSnapshot>(`/api/file-cleanup${path}`,init);if(alive.current)setData(next);return true;}
  catch(e){if(alive.current)setError(e instanceof Error?e.message:'操作失败，请重新扫描后重试。');return false;}
  finally{actionLock.current=false;if(alive.current)setWorking(false);}
 };
 const reveal=async(id:string)=>{
  try{await requestJSON('/api/file-cleanup/reveal',post({id}));}catch(e){setError(e instanceof Error?e.message:'无法打开文件位置。');}
 };
 const entries=data?.entries??[],scanning=data?.status==='scanning',active=scanning||data?.status==='cleaning',disabled=working||active||confirm;
 useEffect(()=>{if(active)setTab('scan');},[active]);
 const trashName=data?.platform==='win32'?'回收站':'废纸篓';
 const canClean=method==='delete'?data?.capabilities.delete:data?.capabilities.trash;
 const chosen=entries.filter(e=>selected.has(e.id)&&selectable(e)),bytes=chosen.reduce((sum,e)=>sum+e.bytes,0),hasReview=chosen.some(e=>e.risk==='review'),hasProtected=chosen.some(e=>e.risk==='protected');
 const remaining=entries.filter(e=>e.state!=='trashed'&&e.state!=='deleted');
 const visible=remaining.filter(e=>(risk==='all'||e.risk===risk)&&(category==='all'||e.category===category)&&`${e.name} ${e.path}`.toLowerCase().includes(query.toLowerCase()));
 const totals=Object.fromEntries(risks.map(value=>[value,remaining.filter(e=>e.risk===value).reduce((sum,e)=>sum+e.bytes,0)])) as Record<CleanupRisk,number>;
 const toggle=(id:string)=>{if(!selected.has(id)&&selected.size>=200){setError('每次最多清理 200 项，请分批处理。');return;}setSelected(current=>{const next=new Set(current);next.has(id)?next.delete(id):next.add(id);return next;});};
 const scope=data&&<ScanScope data={data} disabled={disabled} onAdd={()=>void act('/project-roots')} onRemove={index=>void act(`/project-roots/${index}`,{method:'DELETE'})} onScope={scope=>void act('/scope',post({scope}))}/>;
 return <div className="tfPage tfCleanup tfCleanupPage">
  {tools}
  <div className="tfCleanupWork" id={tools?'toolbox-panel-cleanup':undefined} role={tools?'tabpanel':undefined} aria-labelledby={tools?'toolbox-tab-cleanup':undefined}>
  <header className="tfPageHead tfCleanupPageHead"><h1 ref={heading} tabIndex={-1}>文件清理</h1><button type="button" className={scanning?'':'primary'} disabled={!data||working||confirm||data.status==='cleaning'} onClick={()=>{setTab('scan');if(scanning){void act('/cancel');return;}setRisk('all');setCategory('all');setQuery('');void act('/scan');}}><Icon name={scanning?'close':data?.scanId?'refresh':'search'} size={15}/>{scanning?'停止扫描':data?.status==='cleaning'?'正在清理…':data?.scanId?'重新扫描':'开始扫描'}</button></header>
  <div className="tfCleanupTabs" role="tablist" aria-label="文件清理功能">{tabItems.map(([id,label])=><button type="button" key={id} id={`cleanup-tab-${id}`} ref={node=>{tabButtons.current[id]=node;}} role="tab" aria-selected={tab===id} aria-controls={`cleanup-panel-${id}`} tabIndex={tab===id?0:-1} disabled={confirm||active&&id==='scope'} onKeyDown={event=>tabKey(event,id)} onClick={()=>setTab(id)}>{label}{id==='scope'&&!!data?.projectRoots.length&&<span>{data.projectRoots.length}</span>}</button>)}</div>
  <div className="tfCleanupBody" ref={body}>
  {error&&<p className="tfError" role="alert">{error}</p>}
  {connectionError&&<p className="tfError" role="alert">{connectionError}</p>}
  {data&&!data.capabilities.trash&&!data.capabilities.delete&&<p className="tfHint">当前为只读扫描，清理请使用桌面版。</p>}
  {!data&&!connectionError&&<p className="tfHint" role="status">正在读取清理状态…</p>}
  <section id="cleanup-panel-scan" role="tabpanel" aria-labelledby="cleanup-tab-scan" hidden={tab!=='scan'} className="tfCleanupScan">
  {data?.status==='idle'&&<><h2 className="tfCleanupSlogan">理清缓存占用，<br/>把空间留给正在做的事。</h2>{scope}</>}
  {active&&<div className="tfCleanupProgress" role="status"><Icon name="refresh" size={22}/><div><h2>{scanning?data?.scanScope==='all'?'正在全盘扫描':'正在扫描文件':data?.result?.method==='delete'?'正在校验并永久删除':`正在校验并移入${trashName}`}</h2><p>{scanning?`${data?.walkedDirectories?`已检查 ${data.walkedDirectories.toLocaleString()} 个文件夹`:data?.planned?`正在检查 ${data.checked} / ${data.planned} 个位置`:'正在发现扫描项目'} · 已发现 ${entries.length} 项，${cleanupBytes(entries.reduce((sum,entry)=>sum+entry.bytes,0))}`:'正在检查所选文件是否发生变化'}</p><span className="tfCleanupPath">{data?.current}</span></div></div>}
  {data?.scanId&&!active&&<>
   <div hidden={confirm}>
   <div className="tfCleanupRiskTabs" role="group" aria-label="按清理风险筛选">{risks.map(value=><button type="button" key={value} aria-pressed={risk===value} onClick={()=>setRisk(risk===value?'all':value)}><span>{cleanupRiskLabels[value]}{risk===value&&<Icon name="checkCircle" size={13}/>}</span><strong>{remaining.some(entry=>entry.risk===value&&!entry.complete)&&'≥ '}{cleanupBytes(totals[value])}</strong></button>)}</div>
   <div className="tfCleanupListHead"><div><h2>扫描结果</h2><span>{visible.length} 项{risk!=='all'&&` · ${cleanupRiskLabels[risk]}`}</span></div><div>{risk!=='all'&&<button type="button" className="textButton" onClick={()=>setRisk('all')}>查看全部</button>}<button type="button" className="textButton" disabled={disabled||!canClean||data.status!=='complete'} onClick={()=>setSelected(new Set(entries.filter(e=>e.risk==='rebuildable'&&selectable(e)).map(e=>e.id)))}>选择可重建缓存</button></div></div>
   <div className="tfCleanupFilters"><label><Icon name="search" size={15}/><input aria-label="搜索清理项" placeholder="搜索名称或路径" value={query} onChange={e=>setQuery(e.target.value)}/></label><div className="tfCleanupMethod"><select aria-label="按文件类别筛选" value={category} onChange={e=>setCategory(e.target.value as CleanupCategory|'all')}><option value="all">所有类别</option>{Object.entries(cleanupCategoryLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><Icon name="chevron" size={12}/></div></div>
   <div className="tfCleanupList" aria-label="扫描结果" aria-busy={active}>
    {visible.map(entry=><article key={entry.id} className={`tfCleanupItem ${entry.state==='trashed'||entry.state==='deleted'?'isTrashed':''}`}>
     <input type="checkbox" aria-label={`选择 ${entry.name}`} checked={selected.has(entry.id)&&selectable(entry)} disabled={disabled||!canClean||!selectable(entry)||data.status!=='complete'} onChange={()=>toggle(entry.id)}/>
     <details className="tfCleanupFile"><summary aria-label={`查看 ${entry.name} 的用途与清理影响`}><span><span className="tfCleanupFileName"><strong>{entry.name}</strong><small className={`tfCleanupRisk ${entry.risk}`}>{entry.state==='deleted'?'已永久删除':entry.state==='trashed'?`已移入${trashName}`:entry.state==='failed'?'处理失败':cleanupRiskLabels[entry.risk]}</small></span><span className="tfCleanupItemPath">{entry.path}</span></span><b>{!entry.complete?'≥ ':''}{cleanupBytes(entry.bytes)}</b><Icon name="chevron" size={14}/></summary><div className="tfCleanupFileDetails"><p>{entry.description}</p><p>{entry.impact}</p><span>{entry.files.toLocaleString()} 个文件{entry.modifiedAt&&` · 最近修改 ${new Date(entry.modifiedAt).toLocaleDateString('zh-CN')}`}</span>{data.capabilities.reveal&&entry.state!=='trashed'&&entry.state!=='deleted'&&<button type="button" className="textButton" onClick={()=>void reveal(entry.id)}>在文件管理器中查看 ↗</button>}</div></details>{entry.issue&&<p className="tfCleanupIssue">{entry.issue}</p>}

    </article>)}
    {!visible.length&&!active&&<p className="tfCleanupNoResults">{entries.length?'无匹配项':'未发现文件'}</p>}
   </div>
   {(data.status==='cancelled'||data.status==='failed')&&<p className="tfHint">{data.status==='cancelled'?'扫描已停止':'扫描未完成'}，当前结果仅供查看，请重新扫描后清理。</p>}
   {!!data.warnings.length&&<details className="tfCleanupWarnings"><summary>扫描提示 · {data.warnings.length} 项</summary><ul>{data.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></details>}
   {data.result&&!active&&<p className="tfCleanupResult" role="status">{data.result.method==='delete'?`已永久删除 ${data.result.deleted} 项`:`已移入${trashName} ${data.result.moved} 项`}（{cleanupBytes(data.result.bytes)}）{data.result.failed>0&&`，${data.result.failed} 项未完成，请查看原因并重新扫描`}{data.result.method==='delete'?'。此为文件逻辑大小，实际释放空间以系统为准。':`。清空系统${trashName}后才会释放空间。`}</p>}
   </div>
   {confirm&&<div ref={confirmation} className="tfCleanupConfirm" role="region" aria-label="确认清理文件"><h3 tabIndex={-1}>{method==='delete'?`永久删除这 ${chosen.length} 项？`:`将这 ${chosen.length} 项移入${trashName}？`}</h3><p>合计 {cleanupBytes(bytes)}。{method==='delete'?`文件将直接删除，不经过${trashName}。请逐项核对，删除后不能从回收站恢复。`:`请核对以下文件与影响，系统${trashName}由你自行清空。`}</p>{hasProtected&&<p className="tfCleanupProtectedWarning" role="alert">所选项包含受保护数据。清理可能丢失会话、登录配置或记忆，也可能影响其他项目的共享依赖。请核对备份与用途后再确认。</p>}<ul>{chosen.map(entry=><li key={entry.id}><strong>{entry.name} <span>{cleanupBytes(entry.bytes)}</span></strong><span className="tfCleanupPath">{entry.path}</span><span>{entry.impact}</span></li>)}</ul><label><input type="checkbox" checked={closedApps} disabled={working} onChange={e=>setClosedApps(e.target.checked)}/>我已关闭相关应用、Agent 和安装 / 构建任务</label>{hasReview&&<label><input type="checkbox" checked={reviewed} disabled={working} onChange={e=>setReviewed(e.target.checked)}/>我已核对「需要确认」的项目，了解备份或依赖被移走后的影响</label>}{method==='delete'&&<label className="tfCleanupPermanent">输入“永久删除”确认<input aria-label="输入永久删除确认" value={permanentText} disabled={working} autoComplete="off" onChange={e=>setPermanentText(e.target.value)}/></label>}</div>}

  </>}
  </section>
  <section id="cleanup-panel-scope" role="tabpanel" aria-labelledby="cleanup-tab-scope" hidden={tab!=='scope'} className="tfCleanupScope">
   {!active&&scope}
  </section>
  <section id="cleanup-panel-help" role="tabpanel" aria-labelledby="cleanup-tab-help" hidden={tab!=='help'} className="tfCleanupHelp">
   <div className="tfCleanupPresets">{cleanupPresets.map(preset=><button type="button" key={preset.label} disabled={!onRepair||active||working} onClick={()=>onRepair?.(preset.prompt)}>{preset.label}<Icon name="arrow" size={14}/></button>)}</div>
   <details className="tfCleanupTools"><summary><span>常用工具</span><Icon name="chevron" size={14}/></summary><ul>{cleanupCheckTools.map(tool=><li key={tool.name}><strong>{tool.name}</strong><code>{data?.platform==='win32'&&tool.name==='pip'?'py -m pip cache info':tool.check}</code><span>{tool.detail}</span><details><summary>清理命令 · 需确认</summary><code>{tool.cleanup}</code><p>{tool.impact}</p></details></li>)}</ul></details>
  </section>
  </div>
  {data?.scanId&&!active&&tab==='scan'&&<footer className="tfCleanupFoot"><strong>已选 {chosen.length} 项<span> · {cleanupBytes(bytes)}</span></strong><div className="tfCleanupFootActions">{confirm?<><button type="button" className="textButton" disabled={working} onClick={()=>setConfirm(false)}>返回选择</button><button type="button" className="primary" disabled={working||!chosen.length||!canClean||data.status!=='complete'||!closedApps||(hasReview&&!reviewed)||(method==='delete'&&permanentText!=='永久删除')} onClick={()=>void act('/clean',post({scanId:data.scanId,ids:chosen.map(e=>e.id),method,confirmReview:reviewed,confirmProtected:hasProtected,confirmPermanent:method==='delete'&&permanentText==='永久删除'})).then(ok=>{if(ok){setConfirm(false);setSelected(new Set());}})}>{method==='delete'?'确认永久删除':`确认移入${trashName}`}</button></>:<><div className="tfCleanupMethod"><select aria-label="清理方式" value={method} disabled={disabled} onChange={e=>setMethod(e.target.value as CleanupMethod)}><option value="trash" disabled={!data.capabilities.trash}>移入{trashName}</option><option value="delete" disabled={!data.capabilities.delete}>永久删除</option></select><Icon name="chevron" size={12}/></div><button type="button" className="primary" disabled={disabled||!canClean||data.status!=='complete'||!chosen.length} onClick={()=>{resultsScroll.current=body.current?.scrollTop??0;setConfirm(true);setClosedApps(false);setReviewed(false);setPermanentText('');}}>清理所选</button></>}</div></footer>}
  </div>
 </div>;
}
