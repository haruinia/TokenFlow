/** Read-only context replay for foreign checkpoints. Mirrors the rollback rules
 * in Codex 5425d3e6 context_manager/history.rs and session/rollout_reconstruction.rs:
 * select a surviving replacement first, then replay its suffix and rollbacks.
 * This never changes the user's rollout or invokes a summarizer. */
type Item=Record<string,any>;
export const CODEX_SUMMARY_PREFIX='Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';
const texts=(item:Item):string[]=>typeof item.content==='string'?[item.content]:Array.isArray(item.content)?item.content.filter((part:Item)=>(item.role==='user'?part.type==='input_text':['input_text','output_text'].includes(part.type))&&typeof part.text==='string').map((part:Item)=>part.text):[];
const contextual=(text:string)=>{
 const value=text.trim(),lower=value.replace(/[A-Z]/g,char=>char.toLowerCase());
 for(const tag of ['environment_context','turn_aborted','user_shell_command','subagent_notification','agent_message_board_notification','recommended_plugins','skill'])if(lower.startsWith('<'+tag+'>')&&lower.endsWith('</'+tag+'>'))return true;
 const external=/^<(external_[^>]+)>/.exec(value);
 if(external&&value.endsWith('</'+external[1]+'>'))return true;
 if(value.startsWith('<goal_context>')&&value.endsWith('</goal_context>')||/^<codex_internal_context source="[a-z][a-z0-9_]*">/.test(value)&&value.endsWith('</codex_internal_context>'))return true;
 if(/^<hook_prompt\s+hook_run_id="[^"<>]+">(?:[^<&]|&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)*<\/hook_prompt>$/.test(value))return true;
 return lower.startsWith('# agents.md instructions')&&lower.endsWith('</instructions>')
  ||value.startsWith('Warning: The maximum number of unified exec processes you can keep open is')
  ||value.startsWith('Warning: Your account was flagged for potentially high-risk cyber activity')
  ||value.startsWith('Warning: apply_patch was requested via ')&&value.endsWith('Use the apply_patch tool instead of exec_command.');
};
export function codexUserTurnBoundary(item:Item){
 if(item.type==='agent_message')return true;
 if(item.type!=='message'&&item.type!==undefined)return false;
 const content=texts(item);
 if(item.role==='user')return !content.some(text=>text.startsWith(CODEX_SUMMARY_PREFIX+'\n')||contextual(text));
 if(item.role==='assistant'&&content.length===1){try{const value=JSON.parse(content[0]!);return typeof value.author==='string'&&typeof value.recipient==='string'&&typeof value.content==='string'&&typeof value.trigger_turn==='boolean';}catch{}}
 return false;
}
const count=(value:unknown)=>{if(!Number.isSafeInteger(value)||Number(value)<0)throw Error('Invalid Codex rollback count');return Number(value);};
export function replayCodexHistory(rows:Item[],replacement:(row:Item)=>Item[]|undefined):Item[]{return replayCodexHistoryWindow(rows,replacement).history;}
/** Track missing coverage separately from messages so a later user turn cannot
 * disguise an unreadable earlier window. Rollbacks remove only gaps in removed
 * turns; a complete readable checkpoint can replace the entire earlier base. */
export function replayCodexHistoryWindow(rows:Item[],replacement:(row:Item)=>Item[]|undefined,completeBase=true):{history:Item[];complete:boolean}{
 // TurnStarted is serialized as task_started. Older rollouts may omit it;
 // those use the real user-message boundary instead of a synthetic summary.
 const hasStarts=rows.some(row=>row.type==='event_msg'&&['task_started','turn_started'].includes(row.payload?.type));
 const survivingLegacy=new Set<number>(),survivingCheckpoints=new Set<number>();
 let pending=0,selected=-1,boundedByLegacy=false,segment:{user:boolean;checkpoints:number[];legacy:number[];turnId?:string}|undefined;
 const finish=()=>{
  if(!segment)return;
  if(pending){if(segment.user)pending--;}
  else {
   for(const index of segment.legacy)survivingLegacy.add(index);
   for(const index of segment.checkpoints)survivingCheckpoints.add(index);
   // Decode only after rollback has decided this segment survives. An earlier
   // unreadable checkpoint cannot invalidate a newer complete readable summary.
   if(selected<0&&!boundedByLegacy)for(const index of segment.checkpoints){
    if(survivingLegacy.has(index)){boundedByLegacy=true;break;}
    if(replacement(rows[index]!)!==undefined){selected=index;break;}
   }
  }
  segment=undefined;
 };
 for(let index=rows.length-1;index>=0;index--){
  const row=rows[index]!,payload=row.payload;
  if(!payload)continue;
  if(row.type==='event_msg'&&payload.type==='thread_rolled_back'){pending+=count(payload.num_turns);continue;}
  if(row.type==='compacted'||row.type==='response_item'&&payload.type==='compaction'){
   segment??={user:false,checkpoints:[],legacy:[]};segment.checkpoints.push(index);
   if(row.type==='compacted'&&payload.replacement_history==null&&typeof payload.message==='string'&&payload.message.trim())segment.legacy.push(index);
  }
  if(row.type==='turn_context'){segment??={user:false,checkpoints:[],legacy:[]};segment.turnId??=payload.turn_id;}
  const user=row.type==='response_item'&&codexUserTurnBoundary(payload)||row.type==='event_msg'&&payload.type==='user_message'||row.type==='inter_agent_communication';
  if(user){segment??={user:false,checkpoints:[],legacy:[]};segment.user=true;if(!hasStarts)finish();}
  if(row.type==='event_msg'&&['task_started','turn_started'].includes(payload.type)&&(!segment?.turnId||!payload.turn_id||segment.turnId===payload.turn_id))finish();
  if(selected>=0)break;
 }
 finish();
 type Entry={item:Item}|{missing:true};
 let history:Entry[]=selected>=0?replacement(rows[selected]!)!.map(item=>({item})):completeBase?[]:[{missing:true}];
 for(const [offset,row] of rows.slice(selected+1).entries()){
  const payload=row.payload;if(!payload)continue;
  if(row.type==='response_item'&&payload.type!=='compaction')history.push({item:payload});
  else if(row.type==='inter_agent_communication')history.push({item:{type:'agent_message',content:[{type:'input_text',text:payload.content}],author:payload.author,recipient:payload.recipient}});
  else if(row.type==='compacted'&&payload.replacement_history==null&&typeof payload.message==='string'&&payload.message.trim()){
   // Legacy Codex local compaction stores its readable summary in `message`.
   // Like native replay, retain user requests and replace earlier work with
   // that summary. Do this chronologically so later rollbacks still apply.
   // A non-null replacement_history is authoritative, even if it is opaque.
   history=[...history.filter(entry=>'item' in entry?entry.item.role==='user'&&codexUserTurnBoundary(entry.item):!survivingLegacy.has(selected+1+offset)),{item:{type:'message',role:'user',content:[{type:'input_text',text:payload.message}]}}];
  }
  else if((row.type==='compacted'||row.type==='response_item'&&payload.type==='compaction')&&survivingCheckpoints.has(selected+1+offset)){
   // Opaque compaction is recoverable only if the preceding model-visible
   // history is present. Missing coverage stays missing across subsequent turns.
   if(!history.some(entry=>'item' in entry&&(entry.item.role==='user'||entry.item.type==='agent_message')))history.push({missing:true});
  }
  else if(row.type==='event_msg'&&payload.type==='thread_rolled_back'){
   const amount=count(payload.num_turns);if(!amount)continue;
   const positions=history.flatMap((entry,index)=>'item' in entry&&codexUserTurnBoundary(entry.item)?[index]:[]);
   if(positions.length)history=history.slice(0,positions[Math.max(0,positions.length-amount)]);
  }
 }
 return {history:history.flatMap(entry=>'item' in entry?[entry.item]:[]),complete:history.every(entry=>'item' in entry)};
}
