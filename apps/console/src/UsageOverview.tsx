import type {MaintenanceContext} from '../../../packages/core/src/maintenance-conversations';
import {LoadingSkeleton,LoadError} from './LoadingState';
import {useEffect,useMemo,useState,useId,useRef,useLayoutEffect,type MouseEvent,type FocusEvent,type CSSProperties} from 'react';
import {createPortal} from 'react-dom';
import type {UsageData} from './usage-data';
import {compactTokens,formatTokens,groupUsage,localDay,totalsOf,type UsageRow} from './usage-model';
import type {LocalAgentSnapshot} from '../../../packages/core/src/cliproxy';
import {ModelUsage,SourceUsage,UsageBreakdown} from './UsagePanel';
import {ProviderIcon} from './ProviderIcon';
import {Icon} from './Icons';
import {NativeUsageCoverage,usageClientNames} from './NativeUsageCoverage';
const names:Record<string,string>={...usageClientNames,key:'API 代理',internal:'TokenFlow 内部',workspace:'工作台调试'};
const methodSub=(key:string,rows:readonly UsageRow[])=>{
 if(key==='key')return '导出的 Key';
 if(key==='internal')return '维修检查与内部辅助调用';
 if(key==='workspace')return '工作台直接调试';
 const gateway=totalsOf(rows.filter(r=>r.origin!=='native')).totalTokens,native=totalsOf(rows.filter(r=>r.origin==='native')).totalTokens;
 return `本地 Agent · 经 TokenFlow ${formatTokens(gateway)} · 本机直连 ${formatTokens(native)}`;
};
export function activityStats(rows:readonly UsageRow[],today=new Date()){
 const days=new Map<string,number>();for(const row of rows)if(row.day<=localDay(today))days.set(row.day,(days.get(row.day)??0)+row.inputTokens+row.outputTokens);
 let current=0,longest=0,run=0,previous='';for(const day of [...days.keys()].sort()){if(!days.get(day))continue;const date=new Date(`${day}T12:00:00`);date.setDate(date.getDate()-1);run=localDay(date)===previous?run+1:1;longest=Math.max(longest,run);previous=day;}
 const date=new Date(today);if(!days.get(localDay(date)))date.setDate(date.getDate()-1);while(days.get(localDay(date))){current++;date.setDate(date.getDate()-1);}return {days,activeDays:[...days.values()].filter(n=>n>0).length,peak:Math.max(0,...days.values()),longest,current};
}
export function UsageOverview({usage,local,onContext}:{onContext?:(context:MaintenanceContext)=>void;usage:UsageData;local:LocalAgentSnapshot}){
 const tooltipId=useId();const [hover,setHover]=useState<{day:string;value:number;total:number;left:number;top:number;below:boolean}>();
 const showDay=(event:MouseEvent<HTMLButtonElement>|FocusEvent<HTMLButtonElement>,day:{day:string;value:number;total:number})=>{const box=event.currentTarget.getBoundingClientRect();const grid=event.currentTarget.closest('.tfHeatmap')!.getBoundingClientRect();setHover({...day,left:Math.max(8,Math.min(box.left-60,window.innerWidth-216)),top:grid.top<72?box.bottom+8:grid.top-8,below:grid.top<72});};
 const [animation,setAnimation]=useState(0);
 const chooseMode=(next:'day'|'week'|'cumulative')=>{setMode(next);setHover(undefined);setAnimation(value=>value+1);};
 const heatmapScroll=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{const node=heatmapScroll.current;if(!node)return;const revealLatest=()=>{const weeks=Number(node.style.getPropertyValue('--heatmap-weeks'))||53;const gap=window.innerWidth<=700?3:4;node.style.setProperty('--heatmap-cell',`${Math.max(10,(node.clientWidth-4-(weeks-1)*gap)/weeks)}px`);node.scrollLeft=Math.max(0,node.scrollWidth-node.clientWidth);};const resize=new ResizeObserver(revealLatest);resize.observe(node);revealLatest();return()=>resize.disconnect();},[usage.loaded]);
 const [mode,setMode]=useState<'day'|'week'|'cumulative'>('cumulative'),[selected,setSelected]=useState(localDay(new Date()));const [breakdown,setBreakdown]=useState(()=>{try{const saved=localStorage.getItem('token-flow.overview.breakdown');return saved==='agent'||saved==='model'?saved:'method';}catch{return 'method';}});const chooseBreakdown=(id:string)=>{setBreakdown(id);try{localStorage.setItem('token-flow.overview.breakdown',id);}catch{}};const allRows=usage.allRows;const weekStart=new Date(`${selected}T12:00:00`);weekStart.setDate(weekStart.getDate()-weekStart.getDay());const weekEnd=new Date(weekStart);weekEnd.setDate(weekEnd.getDate()+6);const rows=mode==='day'?allRows.filter(r=>r.day===selected):mode==='week'?allRows.filter(r=>r.day>=localDay(weekStart)&&r.day<=localDay(weekEnd)&&r.day<=localDay(new Date())):allRows.filter(r=>r.day<=selected);const total=totalsOf(allRows);const stats=useMemo(()=>activityStats(allRows),[allRows]);
 useEffect(()=>onContext?.({page:'usage',mode,day:selected,breakdown:breakdown as MaintenanceContext['breakdown']}),[mode,selected,breakdown,onContext]);
 const calendar=useMemo(()=>{const end=new Date(),start=new Date(end);start.setDate(start.getDate()-364);start.setDate(start.getDate()-start.getDay());const result:{day:string;value:number;total:number;future:boolean}[]=[];let running=[...stats.days].filter(([day])=>day<localDay(start)).reduce((sum,[,n])=>sum+n,0);for(let d=new Date(start);d<=end||result.length%7!==0;d.setDate(d.getDate()+1)){const day=localDay(d),amount=stats.days.get(day)??0;running+=amount;let value=amount;if(mode==='cumulative')value=running;if(mode==='week'){value=0;const first=new Date(d);first.setDate(first.getDate()-first.getDay());for(let i=0;i<7;i++){value+=stats.days.get(localDay(first))??0;first.setDate(first.getDate()+1);}}result.push({day,value,total:amount,future:day>localDay(end)});}return result;},[stats,mode]);
 const weekOf=(day:string)=>{const date=new Date(`${day}T12:00:00`);date.setDate(date.getDate()-date.getDay());return localDay(date);};
 const max=Math.max(1,...calendar.map(d=>d.value));const level=(n:number)=>n===0?0:Math.max(1,Math.min(4,Math.ceil(n/max*4)));
 const native=rows.filter(r=>r.origin==='native'),gateway=rows.filter(r=>r.origin!=='native');

 const scopeLabel=mode==='day'?selected:mode==='week'?`${localDay(weekStart)} 至 ${localDay(weekEnd)>localDay(new Date())?localDay(new Date()):localDay(weekEnd)}`:`累计至 ${selected}`;
 const paths=<div className="tfOverviewPaths"><span className="tfOverviewScope">{scopeLabel}</span><span>本机直连 <b>{formatTokens(totalsOf(native).totalTokens)} Token</b></span><span>经 TokenFlow <b>{formatTokens(totalsOf(gateway).totalTokens)} Token</b></span></div>;
 if(!usage.loaded)return <section className="tfUsageOverview"><header className="tfPageHead"><h2>用量总览</h2></header>{usage.error?<LoadError message={usage.error} retry={usage.reload}/>:<LoadingSkeleton label="正在加载用量总览" variant="overview"/>}</section>;
 return <section className="tfUsageOverview" aria-label="用量总览">
  <header className="tfPageHead"><h2>用量总览</h2></header>
  {usage.error&&<LoadError message={usage.error} retry={usage.reload}/>}
  <dl className="tfOverviewMetrics">{[[formatTokens(total.totalTokens),'累计 Token'],[compactTokens(stats.peak),'每日使用峰值'],[`${stats.activeDays} 天`,'活跃天数'],[`${stats.longest} 天`,'最长连续天数'],[`${stats.current} 天`,'当前连续天数']].map(([value,label])=><div key={label}><dd>{value}</dd><dt>{label}</dt></div>)}</dl>
  <section className="tfTokenActivity" aria-label="Token 活动"><header><h3>Token 活动</h3><div className="tfRange" role="group" aria-label="总览统计范围"><button aria-pressed={mode==='day'} onClick={()=>chooseMode('day')}>每天</button><button aria-pressed={mode==='week'} onClick={()=>chooseMode('week')}>七天</button><button aria-pressed={mode==='cumulative'} onClick={()=>chooseMode('cumulative')}>累计总量</button></div></header><div ref={heatmapScroll} className="tfHeatmapScroll" style={{'--heatmap-weeks':Math.ceil(calendar.length/7)} as CSSProperties}><div key={animation} className="tfHeatmap" data-animation={animation} role="group" aria-label="近一年每日 Token">{calendar.map((d,index)=><button key={d.day} style={{'--cell-delay':`${Math.floor(index/7)*9+index%7*13}ms`} as CSSProperties} disabled={d.future} className={`level${level(d.value)}${mode==='week'&&hover&&weekOf(d.day)===weekOf(hover.day)?' hoverWeek':''}`} aria-pressed={mode==='day'?selected===d.day:mode==='week'?weekOf(d.day)===weekOf(selected):undefined} aria-label={`${d.day} · ${formatTokens(d.value)} tokens`} aria-describedby={hover?.day===d.day?tooltipId:undefined} onMouseEnter={event=>showDay(event,d)} onMouseLeave={()=>setHover(undefined)} onFocus={event=>showDay(event,d)} onBlur={()=>setHover(undefined)} onClick={()=>{setSelected(d.day);}}/>)}</div><div className="tfHeatmapMonths">{Array.from({length:12},(_,i)=>{const d=new Date();d.setMonth(d.getMonth()-11+i);return <span key={i}>{d.getMonth()+1}月</span>;})}</div></div></section>
  {hover&&createPortal(<div id={tooltipId} role="tooltip" className="tfHeatmapTooltip" style={{left:hover.left,top:hover.top,transform:hover.below?'none':undefined}}><span>{mode==='week'?`${weekOf(hover.day).replace('-', '年').replace('-', '月')}日起的一周`:`${Number(hover.day.slice(5,7))}月${Number(hover.day.slice(8))}日${mode==='cumulative'?' · 累计':''}`}</span><strong>{formatTokens(hover.value)} 个 Token</strong></div>,document.body)}
  <div className="tfBreakTabs tfSwitchTabs" role="tablist" aria-label="用量分类">{[['method','使用方式'],['agent','来源'],['model','模型']].map(([id,label])=><button key={id} role="tab" id={`overview-tab-${id}`} aria-controls="overview-breakdown-panel" aria-selected={breakdown===id} onClick={()=>chooseBreakdown(id)}>{label}</button>)}</div>
  <div id="overview-breakdown-panel" role="tabpanel" aria-labelledby={`overview-tab-${breakdown}`}>
   {breakdown==='method'&&<UsageBreakdown headerExtra={paths} title="使用方式" empty="暂无记录" items={groupUsage(rows,r=>r.target).map(g=>({key:g.key,label:names[g.key]??g.key,sub:methodSub(g.key,g.rows),icon:g.key==='key'?<Icon name="key" size={22}/>:<ProviderIcon provider={g.key} size={22}/>,totals:g.totals}))}/>}
   {breakdown==='agent'&&<SourceUsage headerExtra={paths} local={local} rows={rows} title="来源" empty="暂无用量" showQuota={false}/>}
   {breakdown==='model'&&<ModelUsage headerExtra={paths} local={local} rows={rows} title="模型"/>}
  </div>
  <NativeUsageCoverage coverage={usage.coverage} scanning={usage.scanning}/>
  {usage.warning&&<p className="tfHint">{usage.warning}</p>}
 </section>;
}
