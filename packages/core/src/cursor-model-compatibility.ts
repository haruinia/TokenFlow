import type {SDKModel,ModelParameterValue} from '@cursor/sdk';
const ordered=(params:ModelParameterValue[])=>params.map(p=>[p.id,p.value]).sort(([a],[b])=>a.localeCompare(b));
const key=(model:SDKModel,params:ModelParameterValue[])=>JSON.stringify([model.id,model.parameters,model.variants,ordered(params)]);

/** One proven local-runtime incompatibility. Never invent model IDs or alter
 * effort/speed: both the parameter and exact alternate variant must be advertised. */
export function cursorLocalAlternative(model:SDKModel,params:ModelParameterValue[]){
 if(model.id!=='grok-4.7'||!params.some(p=>p.id==='context'&&p.value==='500k')||!model.parameters?.some(p=>p.id==='context'&&p.values.some(v=>v.value==='256k')))return;
 const alternate=params.map(p=>({...p,...(p.id==='context'?{value:'256k'}:{})}));
 if(!model.variants?.some(v=>JSON.stringify(ordered(v.params))===JSON.stringify(ordered(alternate))))return;
 return alternate;
}
export function cursorRetryableModelRejection(error:unknown){
 const value=(typeof error==='string'?{message:error}:error??{}) as {status?:number;code?:string;message?:string};
 if(value.status!==undefined&&![400,404].includes(value.status))return false;
 if(value.code)return value.code.toLowerCase()==='model_not_found';
 return /\bmodel (?:was |is )?not found\b/i.test(value.message??'');
}
export function cursorGeneratedUsage(usage:{outputTokens?:number;reasoningTokens?:number}|undefined){return (usage?.outputTokens??0)>0||(usage?.reasoningTokens??0)>0;}

/** Scoped to one CursorAccount instance and one exact grant, catalog and request
 * parameter set. Retry the official default again after five minutes. */
export class CursorLocalModelCompatibility {
 private owner?:object;private choices=new Map<string,{params:ModelParameterValue[];until:number}>();
 private scope(owner:object){if(this.owner!==owner){this.owner=owner;this.choices.clear();}for(const[k,v]of this.choices)if(v.until<=Date.now())this.choices.delete(k);}
 select(owner:object,model:SDKModel,params:ModelParameterValue[]){this.scope(owner);return this.choices.get(key(model,params))?.params.map(p=>({...p}));}
 remember(owner:object,model:SDKModel,params:ModelParameterValue[],selected:ModelParameterValue[]){this.scope(owner);if(!cursorLocalAlternative(model,params))return;if(this.choices.size>=32)this.choices.clear();this.choices.set(key(model,params),{params:selected.map(p=>({...p})),until:Date.now()+5*60000});}
 forget(owner:object,model:SDKModel,params:ModelParameterValue[]){this.scope(owner);this.choices.delete(key(model,params));}
}
