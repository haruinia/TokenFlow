import {LoadError} from './LoadingState';
import {usageClientNames} from './NativeUsageCoverage';
import {useId,useState,useRef,useEffect,type ReactNode,type CSSProperties} from 'react';
import {createPortal} from 'react-dom';
import type { LocalAgentSnapshot } from '../../../packages/core/src/cliproxy';
import { Icon } from './Icons';
import { QuotaDetails } from './QuotaDetails';
import { ProviderIcon } from './ProviderIcon';
import { qualifiedModelLabel } from './model-label';
import { quotaRemaining } from './flow-model';
import {
  chartSpan, compactTokens, dailyTokens, durationText, formatTokens, groupUsage, percentText, rangeLabel, ranges, sourceKey, totalsOf,
  type RangeId, type UsageRow, type UsageTotals,
} from './usage-model';

/** Time window switch shared by every usage summary. */
export function RangeTabs({ range, onChange }: { range: RangeId; onChange: (range: RangeId) => void }) {
  return <div className="tfRange" role="group" aria-label="统计时间范围">
    {ranges.map(item => <button key={item.id} type="button" aria-pressed={range === item.id} onClick={() => onChange(item.id)}>{item.label}</button>)}
  </div>;
}

const share = (value: number, total: number) => total > 0 ? `${(value / total) * 100}%` : '0%';

/** Keep the usage popover against the control that opened it, above the control when the space below is shorter. */
export function usagePopoverPosition(box:{left:number;top:number;bottom:number},viewport:{width:number;height:number}){
 const gap=8,roomBelow=viewport.height-box.bottom-gap-12,roomAbove=box.top-gap-12,below=roomBelow>=180||roomBelow>=roomAbove,width=Math.min(360,viewport.width-24);
 return {left:Math.max(12,Math.min(box.left,viewport.width-width-12)),top:below?box.bottom+gap:Math.max(12,box.top-gap-Math.min(360,roomAbove)),maxHeight:Math.max(160,below?roomBelow:Math.min(360,roomAbove))};
}

/** Usage stays out of the way: one line of the headline numbers, details on demand. */
export function UsageFold({title='用量统计',subtitle,rows,range,loaded=true,error='',onRetry}:{title?:string;subtitle?:string;rows:readonly UsageRow[];range:RangeId;loaded?:boolean;error?:string;onRetry?:()=>unknown}){
 const [open,setOpen]=useState(false);const [position,setPosition]=useState({left:0,top:0,maxHeight:320});const id=useId();const button=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);const totals=totalsOf(rows);
 const place=()=>{const box=button.current?.getBoundingClientRect();if(!box)return;const next=usagePopoverPosition(box,{width:window.innerWidth,height:window.innerHeight});setPosition(current=>current.left===next.left&&current.top===next.top&&current.maxHeight===next.maxHeight?current:next);};
 useEffect(()=>{if(!open)return;panel.current?.focus();place();const close=()=>setOpen(false);const outside=(event:PointerEvent)=>{if(!panel.current?.contains(event.target as Node)&&!button.current?.contains(event.target as Node))setOpen(false);};const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);button.current?.focus();}};window.addEventListener('resize',close);document.addEventListener('scroll',place,true);document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);return()=>{window.removeEventListener('resize',close);document.removeEventListener('scroll',place,true);document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};},[open]);
 const toggle=()=>{place();setOpen(value=>!value);};
 if(!loaded)return <section className="tfUsageFold" aria-label={title}>{error?<LoadError message="用量暂不可用" retry={onRetry??(()=>{})}/>:<span className="tfSkeletonLine tfUsageFoldSkeleton" role="status" aria-label={`正在加载${title}`} aria-busy="true"/>}</section>;
 return <section className={`tfUsageFold${open?' open':''}`} aria-label={title}>
  <button ref={button} type="button" className="tfUsageFoldHead" title={subtitle??title} aria-label={title} aria-expanded={open} aria-controls={id} onClick={toggle}><Icon name="tokens" size={17}/>{range==='today'&&<span>今日用量</span>}<b>{compactTokens(totals.totalTokens)}</b><span>Token</span><i aria-hidden="true">·</i><span>缓存命中 {percentText(totals.hitRate)}</span></button>
  {open&&createPortal(<div ref={panel} tabIndex={-1} id={id} className="tfUsagePopover" role="dialog" aria-label={title} style={position}><header><strong>Token 用量</strong><b>{formatTokens(totals.totalTokens)} Token</b><button className="iconButton" aria-label="关闭用量" onClick={()=>setOpen(false)}><Icon name="close" size={14}/></button></header><dl><div><dt>缓存命中</dt><dd>{percentText(totals.hitRate)}</dd></div><div><dt>{totals.unknownCacheTokens?'未缓存／未拆分输入':'未缓存输入'}</dt><dd>{formatTokens(totals.uncachedTokens)} Token</dd></div><div><dt>缓存读取</dt><dd>{formatTokens(totals.cachedTokens)} Token</dd></div>{totals.cacheWriteTokens>0&&<div><dt>缓存写入</dt><dd>{formatTokens(totals.cacheWriteTokens)} Token</dd></div>}<div><dt>输出</dt><dd>{formatTokens(totals.outputTokens)} Token</dd></div><div><dt>请求</dt><dd>{formatTokens(totals.requests)} 次 · {rangeLabel(range)}</dd></div></dl></div>,document.body)}
 </section>;
}

/** Total, cache hit rate and the uncached / cached / output split, the way the official apps report usage. */
export function UsageSummary({ title = 'Token 用量', rows, range, onRange, loaded = true, hint }: { title?: string; rows: readonly UsageRow[]; range: RangeId; onRange: (range: RangeId) => void; loaded?: boolean; hint?: ReactNode }) {
  const totals = totalsOf(rows);
  const parts = totals.totalTokens;
  return <section className="tfUsageSummary" aria-label={title}>
    <header><div><h3>{title}</h3></div><RangeTabs range={range} onChange={onRange} /></header>
    <div className="tfUsageHero">
      <div className="tfUsageTotal"><strong title={`${formatTokens(totals.totalTokens)} tokens`}>{formatTokens(totals.totalTokens)}</strong><span>Token</span></div>
      <div className="tfUsageHit" title={totals.hitRate === null ? '上游没有返回缓存数据' : `缓存读取 ${formatTokens(totals.cachedTokens)} tokens`}>
        <span>缓存命中</span><strong>{percentText(totals.hitRate)}</strong>
      </div>
    </div>
    <div className="tfUsageBar" role="img" aria-label={`未缓存输入 ${formatTokens(totals.uncachedTokens)}，缓存读取 ${formatTokens(totals.cachedTokens)}，缓存写入 ${formatTokens(totals.cacheWriteTokens)}，输出 ${formatTokens(totals.outputTokens)}`}>
      {tokenParts(totals).map(part => <i key={part.key} style={{width:share(part.value,parts),background:part.color}} />)}
    </div>
    <dl className="tfUsageTokenParts">
      {tokenParts(totals).map(part => <div key={part.key}><dt><i style={{background:part.color}}/>{part.label}</dt><dd>{formatTokens(part.value)}</dd></div>)}
    </dl>
    <dl className="tfUsageMetrics">
      <div><dt>请求</dt><dd>{formatTokens(totals.requests)}{totals.failed > 0 && <small className="bad"> · {formatTokens(totals.failed)} 失败</small>}{totals.unmeasured > 0 && <small title="客户端只返回积分或次数，没有返回 Token"> · {formatTokens(totals.unmeasured)} 次未返回 Token</small>}</dd></div>
      <div><dt>平均耗时</dt><dd>{durationText(totals.avgMs)}</dd></div>
      <div><dt>工具调用／返回</dt><dd>{totals.toolsMeasured?`${formatTokens(totals.toolCalls)} / ${formatTokens(totals.toolResults)}`:'未记录'}</dd></div><div><dt>生成速率（流式）</dt><dd>{totals.tokensPerSecond===null?'—':`${totals.tokensPerSecond.toFixed(1)} Token/s`}</dd></div>
    </dl>
    {loaded && totals.requests === 0 && <p className="tfHint">这段时间没有用量记录。</p>}
    {hint && <p className="tfHint">{hint}</p>}
  </section>;
}

/** Tokens per day; quiet days stay visible as empty slots. */
export function DailyChart({ rows, range }: { rows: readonly UsageRow[]; range: RangeId }) {
  const [hover,setHover]=useState<{day:string;tokens:number;left:number;top:number}>();
  const tooltipId=useId();
  const days = dailyTokens(rows, chartSpan(range, rows));
  useEffect(()=>setHover(undefined),[rows,range]);
  if (days.length < 2 || days.every(item => item.tokens === 0)) return null;
  const peak = Math.max(...days.map(item => item.tokens), 1);
  const show=(element:HTMLButtonElement,item:typeof days[number])=>{
    const box=element.getBoundingClientRect();
    setHover({...item,left:Math.max(88,Math.min(window.innerWidth-88,box.left+box.width/2)),top:box.top-10});
  };
  return <figure className="tfDaily" aria-label="每日 Tokens">
    <div className="tfDailyBars" role="group" aria-label="每日 Token 用量">
      {days.map(item => <button type="button" key={item.day} aria-label={`${item.day} · ${formatTokens(item.tokens)} tokens`} aria-describedby={hover?.day===item.day?tooltipId:undefined}
        onMouseEnter={event=>show(event.currentTarget,item)} onMouseLeave={()=>setHover(undefined)}
        onFocus={event=>show(event.currentTarget,item)} onBlur={()=>setHover(undefined)} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setHover(undefined);}}}>
        <i className={item.tokens ? '' : 'quiet'} style={{height:`${Math.max(item.tokens ? 6 : 2,(item.tokens/peak)*100)}%`}}/>
      </button>)}
    </div>
    {hover&&<div id={tooltipId} role="tooltip" className="tfHeatmapTooltip tfDailyTooltip" style={{left:hover.left,top:hover.top}}><span>{hover.day}</span><strong>{formatTokens(hover.tokens)} 个 Token</strong></div>}
  </figure>;
}

export type BreakdownItem = { key: string; label: string; sub?: string; icon?: ReactNode; totals: UsageTotals; extra?: ReactNode };
const tokenSeries=[['uncached','输入','uncachedTokens','#2563eb'],['cached','缓存读取','cachedTokens','#2bb59c'],['write','缓存写入','cacheWriteTokens','#9480cc'],['output','输出','outputTokens','#d89b32']] as const;
const tokenParts=(totals:UsageTotals)=>tokenSeries.map(([key,label,field,color])=>({key,label:key==='uncached'?(totals.unknownCacheTokens?'输入／未拆分':'未缓存输入'):label,value:totals[field],color}));
export function TokenLegend(){return <div className="tfTokenLegend" aria-label="Token 图例">{tokenSeries.map(([key,label,,color])=><span key={key}><i style={{background:color}}/>{label}</span>)}</div>;}
/** Compare totals at rest; hover to inspect each row's full-width composition. */
export function UsageBreakdown({ title, items, empty, limit = 8, headerExtra }: { headerExtra?:ReactNode; title: string; items: BreakdownItem[]; empty: string; limit?: number }) {
  const [all, setAll] = useState(false);
  const peak = Math.max(...items.map(item => item.totals.totalTokens), 1);
  const total=items.reduce((sum,item)=>sum+item.totals.totalTokens,0);
  const shown = all ? items : items.slice(0, limit);
  return <section className="tfBreakdown" aria-label={title}>
    <header><h4>{title}</h4>{headerExtra}{items.length > 0 && <small>{items.length} 项</small>}</header>
    {items.length>0&&<TokenLegend/>}
    {!items.length && <p className="tfHint">{empty}</p>}
    <ul>
      {shown.map(item => <li key={item.key}>
        <div className="tfBreakHead">
          {item.icon}
          <span className="tfBreakName"><strong title={item.label}>{item.label}</strong>{item.sub && <small title={item.sub}>{item.sub}</small>}</span>
          <div className="tfBreakValue"><b>{compactTokens(item.totals.totalTokens)} <small>Token</small></b><span>{percentText(total?item.totals.totalTokens/total:null)} 的用量</span></div>
        </div>
        <svg className="tfStackedTokens" viewBox="0 0 1000 20" preserveAspectRatio="none" role="img" aria-label={`${item.label} Token 构成，总量 ${formatTokens(item.totals.totalTokens)}；${tokenParts(item.totals).map(p=>`${p.label} ${formatTokens(p.value)}`).join('，')}`}>
         <g className="tfTokenComposition" style={{'--token-scale':item.totals.totalTokens/peak} as CSSProperties}>
          {tokenParts(item.totals).map((part,index,parts)=><rect key={part.key} x={parts.slice(0,index).reduce((sum,p)=>sum+p.value,0)/Math.max(item.totals.totalTokens,1)*1000} y="2" width={part.value/Math.max(item.totals.totalTokens,1)*1000} height="16" fill={part.color}><title>{part.label} {formatTokens(part.value)} Token</title></rect>)}
         </g>
        </svg>
        <dl className="tfBreakParts">{tokenParts(item.totals).filter(p=>p.key!=='write'||p.value>0).map(part=><div key={part.key}><dt>{part.label}</dt><dd>{formatTokens(part.value)}</dd></div>)}</dl>
        <div className="tfBreakFacts"><span>缓存命中 <b>{percentText(item.totals.hitRate)}</b></span><span>{formatTokens(item.totals.requests)} 次请求</span>{item.totals.failed>0&&<span className="failed">{formatTokens(item.totals.failed)} 次失败</span>}{item.totals.unmeasured>0&&<span title="客户端只返回积分或次数，没有返回 Token">{formatTokens(item.totals.unmeasured)} 次未返回 Token</span>}</div>
        {item.extra}
      </li>)}
    </ul>
    {items.length>0&&<div className="tfBreakScale" aria-label="Token 数量刻度"><span>0</span><span>{formatTokens(peak/2)}</span><span>{formatTokens(peak)} Token</span></div>}
    {items.length > limit && <button type="button" className="textButton" onClick={() => setAll(!all)}>{all ? '收起' : `显示全部 ${items.length} 项`}</button>}
  </section>;
}

/** The account or API behind a source id, as shown to the user. */
export function describeSource(local: LocalAgentSnapshot, key: string, rows:readonly UsageRow[]=[]): { label: string; provider: string; sub: string } {
  const inferred=rows.some(row=>row.nativeAccountEvidence==='login-snapshot');
  const account = local.accounts.find(item => item.id === key);
  if (account) return { label: account.label, provider: account.provider, sub: `${local.providers.find(item => item.id === account.provider)?.label ?? account.provider} · 官方授权${inferred?' · 含本机登录识别的用量':''}` };
  const api = local.apiSources?.find(item => item.id === key);
  if (api) return { label: api.name, provider: 'api', sub: `API Key · ${api.baseURL}` };
  if(key.startsWith('native:')){const [,raw,channel,identity,email]=key.split(':');const provider=raw==='openai'||raw==='openai-codex'?'codex':raw;const label=local.providers.find(item=>item.id===provider)?.label??usageClientNames[provider]??provider;const names=[...new Set(rows.map(r=>r.nativeAccountLabel).filter(Boolean))];return {label:names.length===1?names[0]!: `${label} · ${channel==='official'?'官方登录':channel==='api'?'API Key':'渠道未确认'}`,provider,sub:inferred?`${label} · 按用量产生时的本机登录识别`:identity?`日志账号 ${(email||identity).slice(0,8)} · 未关联已保存账号`:'本机日志 · 未记录请求账号或接口'};}
  if (key.startsWith('provider:')) { const id = key.slice(9); const label = local.providers.find(item => item.id === id)?.label ?? id; return { label, provider: id, sub: '账号（未记录具体账号）' }; }
  return { label: '已移除的来源', provider: 'api', sub: '账号或接口已删除' };
}

/** Per account / API: tokens spent through the gateway, with the account's remaining quota beside them. */
export function SourceUsage({ local, rows, title = '按来源账号', empty = '还没有经过网关的请求。', showQuota = true, expandQuota = false, headerExtra }: { headerExtra?:ReactNode; local: LocalAgentSnapshot; rows: readonly UsageRow[]; title?: string; empty?: string; showQuota?: boolean;expandQuota?:boolean }) {
  const [open, setOpen] = useState('');
  const items: BreakdownItem[] = groupUsage(rows, sourceKey).map(group => {
    const info = describeSource(local, group.key, group.rows);
    const quota = showQuota ? local.quotas[group.key] : undefined;
    const remaining = quotaRemaining(quota);
    return {
      key: group.key, label: info.label, sub: info.sub, totals: group.totals,
      icon: <ProviderIcon provider={info.provider} size={28} />,
      extra: quota&&expandQuota?<div className="tfBreakQuota"><QuotaDetails quota={quota} label={info.label} compact/></div>:quota ? <div className="tfBreakQuota">
        <button type="button" className="textButton" aria-expanded={open === group.key} onClick={() => setOpen(open === group.key ? '' : group.key)}>
          {remaining === null ? '额度' : `官方额度剩余 ${Math.round(remaining)}%`}{open === group.key ? ' · 收起' : ' · 详情'}
        </button>
        {open === group.key && <QuotaDetails quota={quota} label={info.label} compact />}
      </div> : undefined,
    };
  });
  return <UsageBreakdown title={title} items={items} empty={empty} headerExtra={headerExtra} />;
}

export function modelManufacturer(model:string,local:LocalAgentSnapshot){
 const named=local.models.find(item=>item.id===model);
 const hint=`${named?.displayName??''} ${model.split('/').at(-1)??model}`.toLowerCase();
 if(/glm/.test(hint))return 'zai';
 if(/kimi|moonshot/.test(hint))return 'kimi';
 if(/minimax|\babab\b/.test(hint))return 'minimax';
 if(/qwen|qwq|qvq/.test(hint))return 'qwen';
 if(/grok/.test(hint))return 'xai';
 if(/deepseek/.test(hint))return 'deepseek';
 if(/doubao/.test(hint))return 'doubao';
 if(/gemini/.test(hint))return 'gemini';
 if(/claude|sonnet|opus|haiku/.test(hint))return 'claude';
 if(/gpt-|chatgpt|\bo[134](?:-|\b)/.test(hint))return 'codex';
 return named?.provider??(model.startsWith('api-')?'api':model.split('/')[0]);
}
export function ModelUsage({ local, rows, title = '按模型', empty = '还没有经过网关的请求。', headerExtra }: { headerExtra?:ReactNode; local: LocalAgentSnapshot; rows: readonly UsageRow[]; title?: string; empty?: string }) {
  const items: BreakdownItem[] = groupUsage(rows, row => row.model).map(group => ({ key: group.key, label: qualifiedModelLabel(local, group.key), icon:<ProviderIcon provider={modelManufacturer(group.key,local)} size={28}/>, totals: group.totals }));
  return <UsageBreakdown title={title} items={items} empty={empty} headerExtra={headerExtra} />;
}
