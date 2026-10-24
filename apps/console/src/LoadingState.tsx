import {createContext,useContext,useLayoutEffect,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
/** Dialog feedback stays beside its progress; page operations share one indicator. */
const ThinkingVisible=createContext(true);
const ThinkingInline=createContext(false);
const requests=new Map<symbol,string>();
const listeners=new Set<()=>void>();
let currentLabel:string|undefined;
const publish=()=>{currentLabel=[...requests.values()].at(-1);for(const listener of listeners)listener();};
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export function ThinkingScope({active,children}:{active:boolean;children:ReactNode}){
 return <ThinkingVisible value={active}><ThinkingInline value={true}>{children}</ThinkingInline></ThinkingVisible>;
}
export function Thinking({label='正在获取信息'}:{label?:string}){
 const visible=useContext(ThinkingVisible),inline=useContext(ThinkingInline);const id=useRef(Symbol());
 useLayoutEffect(()=>{if(!visible||inline)return;requests.set(id.current,label);publish();return()=>{requests.delete(id.current);publish();};},[visible,inline,label]);
 return visible&&inline?<span className="tfThinking" role="status" aria-label={label}><span className="tfThinkingDots" aria-hidden="true"><i/><i/><i/></span><span>处理中</span></span>:null;
}
export function ThinkingFeedback({busy=false}:{busy?:boolean}){
 const label=useSyncExternalStore(subscribe,()=>currentLabel,()=>undefined);
 const container=useRef<HTMLDivElement>(null);const active=!!label||busy;
 useLayoutEffect(()=>{
  const node=container.current;if(!node)return;
  const raise=()=>{
   if(node.matches(':popover-open'))node.hidePopover();
   if(active)node.showPopover();
  };
  raise();
  // A newly opened native dialog enters above an existing popover even when
  // the loading label stays the same. Raise the shared layer after that change.
  const dialogs=new MutationObserver(changes=>{if(changes.some(change=>change.target instanceof HTMLDialogElement))raise();});
  dialogs.observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
  return()=>dialogs.disconnect();
 },[active,label]);
 return createPortal(<div ref={container} popover="manual" className="tfThinkingFeedback" data-fallback={!label}>
  <span className="tfThinking" role="status"><span className="tfThinkingDots" aria-hidden="true"><i/><i/><i/></span><span>{label??'正在处理操作'}</span></span>
 </div>,document.body);
}
export function LoadingSkeleton({label='正在加载',variant='panel'}:{label?:string;variant?:'panel'|'overview'|'cards'}){
 return <div className={`tfLoadingSkeleton ${variant}`} role="status" aria-label={label} aria-busy="true"><div aria-hidden="true"><div className="tfSkeletonLine heading"/>{variant==='overview'?<><div className="tfSkeletonMetrics">{Array.from({length:5},(_,i)=><div className="tfSkeletonBlock" key={i}/>)}</div><div className="tfSkeletonBlock chart"/></>:variant==='cards'?<div className="tfSkeletonCards">{Array.from({length:3},(_,i)=><div className="tfSkeletonBlock card" key={i}/>)}</div>:null}<div className="tfSkeletonRows">{Array.from({length:4},(_,i)=><div className="tfSkeletonLine" key={i}/>)}</div></div><span className="srOnly">{label}</span></div>;
}
export function LoadError({message,retry}:{message:string;retry:()=>unknown}){
 const [loading,setLoading]=useState(false);
 const reload=async()=>{if(loading)return;setLoading(true);try{await retry();}finally{setLoading(false);}};
 return <div className="tfLoadError" role="alert"><span>{message}</span><button type="button" className="textButton" disabled={loading} onClick={()=>void reload().catch(()=>{})}>{loading&&<Thinking label="正在重新加载"/>}{loading?'正在重新加载…':'重新加载'}</button></div>;
}
