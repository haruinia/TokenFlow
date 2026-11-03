import {expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CodexHistoryEditor} from '../packages/core/src/codex-history-editor.js';
import {captureAgentProtocol,rewriteAgentProtocol} from '../packages/core/src/codex-agent-protocol-migration.js';
it('rebases frozen branch byte boundaries for protocol-only edits without touching child protocols or opaque content',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'protocol-history-editor-')),home=join(root,'codex'),dir=join(home,'sessions');await mkdir(dir,{recursive:true});
 try{
  const id=randomUUID(),parent=join(dir,`rollout-2026-10-29-${id}.jsonl`),child=join(dir,`rollout-2026-10-29-${randomUUID()}.jsonl`);
  const rows=[{ordinal:0,type:'session_meta',payload:{id}},{ordinal:1,type:'response_item',payload:{type:'agent_message',content:[{type:'encrypted_content',encrypted_content:'opaque task'}]}}];
  const original=rows.map(r=>JSON.stringify(r)+'\n').join('');await writeFile(parent,original);
  const branch=JSON.stringify({ordinal:2,type:'session_meta',payload:{id:'child',multi_agent_version:'v2',history_base:{thread_id:id,end_ordinal_exclusive:2,end_byte_offset:Buffer.byteLength(original)}}})+'\n';await writeFile(child,branch);
  const baseline=captureAgentProtocol(original),editor=new CodexHistoryEditor(root,join(home,'config.toml'));
  await editor.rewrite((path,text)=>path===parent?rewriteAgentProtocol(text,baseline,'gateway'):text,async()=>[]);
  const current=await readFile(parent,'utf8'),afterChild=JSON.parse((await readFile(child,'utf8')).trim());
  expect(afterChild.payload.history_base.end_byte_offset).toBe(Buffer.byteLength(current));expect(afterChild.payload.multi_agent_version).toBe('v2');expect(current.split('\n')[1]).toBe(original.split('\n')[1]);
  await editor.rewrite((path,text)=>path===parent?rewriteAgentProtocol(text,baseline,'native'):text,async()=>[]);
  expect(await readFile(parent,'utf8')).toBe(original);expect(await readFile(child,'utf8')).toBe(branch);
 }finally{await rm(root,{recursive:true,force:true});}
});
