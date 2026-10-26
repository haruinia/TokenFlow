import {ProviderIcon} from './ProviderIcon';

/** Inline placeholders keep the final row geometry while metadata arrives. */
export function AgentFieldSkeleton({short=false}:{short?:boolean}){
 return <span className={`tfSkeletonLine tfAgentFieldSkeleton${short?' short':''}`} aria-label="正在加载" aria-busy="true"/>;
}
export function AgentAccountSkeleton({provider}:{provider:string}){
 return <li aria-busy="true" aria-label="正在加载官方账号"><div className="tfLine">
  <div className="tfLineMain"><span className="tfLoginRadio" aria-hidden="true"/><ProviderIcon provider={provider} size={22}/><span className="tfKind">账号</span>
   <span className="tfRowText"><strong><AgentFieldSkeleton/></strong><small><AgentFieldSkeleton short/></small></span>
  </div>
  <span className="tfActions"><button className="textButton" disabled>详情</button><button className="textButton" disabled>删除</button></span>
 </div></li>;
}
