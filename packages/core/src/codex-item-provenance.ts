import {randomUUID} from 'node:crypto';
type Item=Record<string,any>;
/** Gateway provenance is independent of task encryption and message phases. */
export const isGatewayCodexItem=(item:Record<string,unknown>)=>typeof item.id==='string'&&item.id.startsWith('tfitem_');
export class CodexItemProvenance{
 private bySource=new Map<string,string>();
 private byIndex=new Map<number,string>();
 id(source:unknown,index?:number){
  let id=typeof source==='string'?this.bySource.get(source):undefined;
  if(!id&&Number.isInteger(index))id=this.byIndex.get(index!);
  id??='tfitem_'+randomUUID().replaceAll('-','');
  if(typeof source==='string')this.bySource.set(source,id);
  if(Number.isInteger(index))this.byIndex.set(index!,id);
  return id;
 }
 item(item:Item,index?:number):Item{return {...item,id:this.id(item.id,index)};}
 response(response:Item):Item{return Array.isArray(response.output)?{...response,output:response.output.map((item:Item,i:number)=>this.item(item,i))}:response;}
}
