type Item=Record<string,unknown>;
const object=(value:unknown):value is Item=>!!value&&typeof value==='object'&&!Array.isArray(value);
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
/** Message metadata/IDs do not change the retained conversation content. */
export function checkpointMessageIdentity(item:Item){
 const content=typeof item.content==='string'?[{type:item.role==='assistant'?'output_text':'input_text',text:item.content}]:item.content;
 return JSON.stringify(canonical({role:item.role,content}));
}
/** Replace a checkpoint's window, carrying only fresh client-prepended messages.
 * Coverage is supplied only after the caller authenticates the checkpoint. */
export function replayCheckpointWindow<T>(prefix:T[],replacement:T[],covered:(item:Item)=>boolean,getItem:(entry:T)=>Item):T[]{
 const retained=new Set(replacement.map(entry=>checkpointMessageIdentity(getItem(entry))));
 const fresh=prefix.filter(entry=>{
  const item=getItem(entry);
  return ['user','system','developer'].includes(String(item.role))&&!(item.role==='user'&&covered(item))&&!retained.has(checkpointMessageIdentity(item));
 });
 return [...replacement,...fresh];
}
