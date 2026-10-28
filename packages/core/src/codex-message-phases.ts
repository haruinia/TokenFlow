type Item=Record<string,any>;
export const isAssistantMessage=(item:Item)=>item.type==='message'&&item.role==='assistant';
/** A server tool's completed output is not a request for client execution. */
export const needsClientToolResult=(item:Item)=>['function_call','custom_tool_call','computer_call','local_shell_call','mcp_approval_request'].includes(item.type)||item.type==='tool_search_call'&&item.execution==='client';
/** One response's message stages. No routing, ciphertext or agent-task logic. */
export class CodexMessagePhases{
 private explicitPhases=new Map<string,string>();
 observe(item:Item){if(isAssistantMessage(item)&&typeof item.phase==='string')this.explicitPhases.set(item.id,item.phase);}
 annotate(item:Item,fallback?:string):Item{
  this.observe(item);
  if(!isAssistantMessage(item))return item;
  const phase=item.phase??this.explicitPhases.get(item.id)??fallback;
  if(phase==null)return item;
  return {...item,phase};
 }
 output(response:Item):Item{
  if(!Array.isArray(response.output))return response;
  response.output.forEach((item:Item)=>this.observe(item));
  const final=response.status==='completed'&&!response.output.some(needsClientToolResult);
  let last=-1;response.output.forEach((item:Item,i:number)=>{if(isAssistantMessage(item))last=i;});
  return {...response,output:response.output.map((item:Item,i:number)=>this.annotate(item,final&&i===last?'final_answer':'commentary'))};
 }
}
