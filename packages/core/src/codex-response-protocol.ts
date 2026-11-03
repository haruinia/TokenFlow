import {CodexItemProvenance} from './codex-item-provenance.js';
import {CodexMessagePhases,isAssistantMessage,needsClientToolResult} from './codex-message-phases.js';
import {responsesStream} from './responses-stream.js';
type Item=Record<string,any>;
const object=(v:unknown):v is Item=>!!v&&typeof v==='object'&&!Array.isArray(v);
export {isGatewayCodexItem} from './codex-item-provenance.js';
/** The managed Codex boundary owns item provenance and message completion.
 * Never apply this to the official route or arbitrary API clients. Native
 * phases are authoritative; translated Chat responses need phases derived
 * from actual tool/terminal events, not the model's prose or model name.
 */
export function codexGatewayResponse(response:Response):Response{
 if(!response.ok||!response.body)return response;
 const provenance=new CodexItemProvenance(),phases=new CodexMessagePhases();
 const output=(value:Item)=>phases.output(provenance.response(value));
 const headers=new Headers(response.headers);headers.delete('content-length');
 if(!(headers.get('content-type')??'').includes('text/event-stream')){
  // Transform cancellation propagates to the original body; no detached json() read.
  const chunks:Uint8Array[]=[];
  const body=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
   transform(chunk){chunks.push(chunk);},
   flush(controller){const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));controller.enqueue(new TextEncoder().encode(JSON.stringify(object(value)?output(value):value)));}
  }));
  return new Response(body,{status:response.status,headers});
 }
 let terminal=false,sequence=0,sawTool=false;
 const pending:Item[]=[];
 const emit=(event:Item)=>'event: '+event.type+'\ndata: '+JSON.stringify({...event,sequence_number:sequence++})+'\n\n';
 const flush=(final=false,terminalOutput?:Item[])=>pending.splice(0).map((event,i,all)=>{
  const completed=terminalOutput?.find(item=>item.id===event.item.id);
  return emit({...event,item:phases.annotate(completed??event.item,final&&i===all.length-1?'final_answer':'commentary')});
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
    if(needsClientToolResult(event.item))sawTool=true;
    // Another item establishes that the preceding message was intermediate.
    if(event.type==='response.output_item.added'||needsClientToolResult(event.item))prefix=flush();
    event={...event,item:phases.annotate(provenance.item(event.item,event.output_index))};
    if(event.type==='response.output_item.done'&&isAssistantMessage(event.item)&&event.item.phase==null){pending.push(event);return prefix;}
   }
   if(typeof event.item_id==='string')event={...event,item_id:provenance.id(event.item_id,event.output_index)};
   if(object(event.response)){
    if(Array.isArray(event.response.output))sawTool ||=event.response.output.some(needsClientToolResult);
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
