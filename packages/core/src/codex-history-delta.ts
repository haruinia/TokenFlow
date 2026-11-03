import {createHash} from 'node:crypto';

export type HistoryPiece={offset?:number;length:number};
const limit=100000;
function records(value:Buffer){
 const ranges:{offset:number;length:number}[]=[];
 for(let offset=0;offset<value.length;){const newline=value.indexOf(10,offset),end=newline<0?value.length:newline+1;ranges.push({offset,length:end-offset});offset=end;if(ranges.length>limit)return null;}
 return ranges;
}
/** JSONL records are stable across routing changes even when metadata grows.
 * Copy unchanged records from the immutable parent; store only new bytes. */
export function historyRecordDelta(before:Buffer,after:Buffer){
 const old=records(before),next=records(after);if(!old||!next)return null;
 const key=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
 const index=new Map<string,{offset:number;length:number}>();
 for(const range of old){const id=key(before.subarray(range.offset,range.offset+range.length));if(!index.has(id))index.set(id,range);}
 const pieces:HistoryPiece[]=[],literals:Buffer[]=[];let bytes=0;
 for(const range of next){
  const value=after.subarray(range.offset,range.offset+range.length),match=index.get(key(value));
  const copy=match&&value.equals(before.subarray(match.offset,match.offset+match.length))?match:undefined;
  const last=pieces.at(-1);
  if(copy){if(last?.offset!==undefined&&last.offset+last.length===copy.offset)last.length+=copy.length;else pieces.push({...copy});}
  else {literals.push(value);bytes+=value.length;if(last&&last.offset===undefined)last.length+=value.length;else pieces.push({length:value.length});}
 }
 return {pieces,bytes,payload:()=>Buffer.concat(literals,bytes)};
}
export function applyHistoryPieces(before:Buffer,literals:Buffer,pieces:HistoryPiece[],size:number){
 if(!Array.isArray(pieces)||pieces.length>limit||!Number.isSafeInteger(size)||size<0)throw Error('Invalid history backup pieces');
 const buffers:Buffer[]=[];let consumed=0,total=0;
 for(const part of pieces){
  if(!part||!Number.isSafeInteger(part.length)||part.length<=0||total+part.length>size)throw Error('Invalid history backup piece');
  if(part.offset===undefined){if(consumed+part.length>literals.length)throw Error('Incomplete history backup literals');buffers.push(literals.subarray(consumed,consumed+part.length));consumed+=part.length;}
  else {if(!Number.isSafeInteger(part.offset)||part.offset<0||part.offset+part.length>before.length)throw Error('Invalid history backup copy');buffers.push(before.subarray(part.offset,part.offset+part.length));}
  total+=part.length;
 }
 if(consumed!==literals.length||total!==size)throw Error('Incomplete history backup pieces');
 return Buffer.concat(buffers,total);
}
