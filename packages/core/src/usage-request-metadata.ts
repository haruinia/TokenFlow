import {createHash} from 'node:crypto';
export const usageHash=(kind:string,value:string)=>createHash('sha256').update(`${kind}:${value}`).digest('hex');
/** Only explicit routing metadata is used. Conversation text is never inspected for attribution. */
export function usageRequestMetadata(headers:Record<string,string|string[]|undefined>,path:string,body:unknown,official=false){
 const thread=headers.session_id??headers['session-id'];
 const account=official?headers['chatgpt-account-id']:undefined;
 const input=(body as {input?:unknown})?.input;
 const compact=path==='responses/compact'||Array.isArray(input)&&input.some(item=>item?.type==='compaction_trigger');
 return {...(typeof thread==='string'&&thread.length>0&&thread.length<=256?{threadHash:usageHash('thread',thread)}:{}),
  ...(typeof account==='string'&&account.length>0&&account.length<=300?{billingAccountHash:usageHash('codex',account)}:{}),
  taskKind:compact?'compaction' as const:'unknown' as const};
}
