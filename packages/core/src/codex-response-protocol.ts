import {createHash,randomUUID} from 'node:crypto';
import {responsesStream} from './responses-stream.js';
type Item=Record<string,any>;
const object=(v:unknown):v is Item=>!!v&&typeof v==='object'&&!Array.isArray(v);
export const isGatewayCodexItem=(item:Item)=>typeof item.id==='string'&&item.id.startsWith('tfitem_');
const message=(item:Item)=>item.type==='message'&&item.role==='assistant';
const tool=(item:Item)=>typeof item.type==='string'&&item.type.endsWith('_call');
/** The managed Codex boundary owns item provenance and message completion.
 * Never apply this to the official route or arbitrary API clients. Native
 * phases are authoritative; translated Chat responses need phases derived
 * from actual tool/terminal events, not the model's prose or model name.
 */
export function codexGatewayResponse(response:Response):Response{
 if(!response.ok||!response.body)return response;
 const salt=randomUUID(),ids=new Map<string,string>();
 const id=(value:string)=>{let mapped=ids.get(value);if(!mapped){mapped='tfitem_'+createHash('sha256').update(salt+'\0'+value).digest('hex').slice(0,32);ids.set(value,mapped);}return mapped;};
 const item=(value:Item,phase?:string)=>({...value,...(typeof value.id==='string'?{id:id(value.id)}:{}),...(message(value)&&value.phase==null&&phase?{phase}:{})});
 const output=(value:Item)=>{
  if(!Array.isArray(value.output))return value;
  const final=value.status==='completed'&&!value.output.some(tool);
  let last=-1;value.output.forEach((v:Item,i:number)=>{if(message(v))last=i;});
  return {...value,output:value.output.map((v:Item,i:number)=>item(v,final&&i===last?'final_answer':'commentary'))};
 };
 const headers=new Headers(response.headers);headers.delete('content-length');
 if(!(headers.get('content-type')??'').includes('text/event-stream')){
  const body=new ReadableStream<Uint8Array>({async start(controller){try{const value=await response.json();controller.enqueue(new TextEncoder().encode(JSON.stringify(object(value)?output(value):value)));controller.close();}catch(e){controller.error(e);}}});
  return new Response(body,{status:response.status,headers});
 }
 let terminal=false,sequence=0,sawTool=false;
 const pending:Item[]=[];
 const emit=(event:Item)=>'event: '+event.type+'\ndata: '+JSON.stringify({...event,sequence_number:sequence++})+'\n\n';
 const flush=(final=false,terminalOutput?:Item[])=>pending.splice(0).map((event,i,all)=>{
  const completed=terminalOutput?.find(item=>item.id===event.item.id);
  return emit({...event,item:{...event.item,phase:completed?.phase??(final&&i===all.length-1?'final_answer':'commentary')}});
 }).join('');
 const body=responsesStream(response.body,{
  terminal:()=>terminal,
  rewrite:async(frame)=>{
   const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
   if(!data)return frame+'\n\n';
   if(data==='[DONE]')return frame+'\n\n';
   let event:Item;try{event=JSON.parse(data);}catch{return frame+'\n\n';}
   if(!object(event))return frame+'\n\n';
   let prefix='';
   if(object(event.item)){
    if(tool(event.item))sawTool=true;
    // Another item establishes that the preceding message was intermediate.
    if(event.type==='response.output_item.added'||tool(event.item))prefix=flush();
    event={...event,item:item(event.item)};
    if(event.type==='response.output_item.done'&&message(event.item)&&event.item.phase==null){pending.push(event);return prefix;}
   }
   if(typeof event.item_id==='string')event={...event,item_id:id(event.item_id)};
   if(object(event.response)){
    if(Array.isArray(event.response.output))sawTool ||=event.response.output.some(tool);
    event={...event,response:output(event.response)};
   }
   if(['response.completed','response.incomplete','response.failed','error'].includes(event.type)){
    prefix+=flush(event.type==='response.completed'&&event.response?.status==='completed'&&!sawTool,Array.isArray(event.response?.output)?event.response.output:undefined);terminal=true;
   }
   return prefix+emit(event);
  },
  failure:()=>{terminal=true;return flush()+emit({type:'error',code:'incomplete_stream',message:'Source stream ended before completion'});},
 });
 return new Response(body,{status:response.status,headers});
}
