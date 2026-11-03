import type {ModelCapabilities} from '../../../packages/core/src/model-capabilities';
const label=(size:number)=>size>=1000000?`${size/1000000}M`:`${size/1000}K`;
export function ModelContextSelect({modelLabel,capability,value,disabled,onChange}:{modelLabel:string;capability?:ModelCapabilities;value?:number;disabled:boolean;onChange:(value:number|undefined)=>void}){
 if(!capability?.contextWindows?.length)return null;
 return <label className="tfQoderContextChoice">上下文<select aria-label={`${modelLabel} 上下文`} disabled={disabled} value={value??''} onChange={event=>onChange(event.target.value?Number(event.target.value):undefined)}>
  <option value="">默认{capability.contextWindow?` · ${label(capability.contextWindow)}`:''}</option>
  {capability.contextWindows.map(size=><option key={size} value={size}>{label(size)}</option>)}
 </select></label>;
}
