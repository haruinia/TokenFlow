/** Read-only native-checkpoint diagnosis. Exact selected lineage only; no credentials or model calls.
 * Derived caches are temporary and deleted. Output contains no history content or ciphertext. */
import {CodexContext} from '../../../packages/core/src/codex-context.ts';
import {GatewayContext} from '../../../packages/core/src/gateway-context.ts';
import {codexRolloutFiles,rolloutId} from '../../../packages/core/src/codex-history-editor.ts';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
const home=process.argv[2],immutableId=process.argv[3];if(!home||!immutableId)throw Error('Usage: <codex-home> <rollout-immutable-id>');
const files=await codexRolloutFiles(home),start=files.find(f=>rolloutId(f.path)===immutableId);if(!start)throw Error('Selected rollout not found');
const relevant=[];let item:any=start;const seen=new Set();let checkpoint:any;
while(item&&!seen.has(item.path)){seen.add(item.path);relevant.push(item);const raw=await readFile(item.path,'utf8'),rows=raw.split('\n').flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}});if(item===start)checkpoint=rows.filter(r=>r.type==='compacted').at(-1)?.payload.replacement_history?.find((x:any)=>x.type==='compaction');const base=rows[0]?.payload?.history_base;item=files.find(f=>rolloutId(f.path)===base?.thread_id);}
if(!checkpoint)throw Error('No selected checkpoint');const root=await mkdtemp(join(tmpdir(),'tf98-readonly-'));
try{const context=await GatewayContext.open(root),migration=new CodexContext(root,join(home,'config.toml'),context);Object.defineProperty(migration,'files',{value:async()=>relevant});try{await migration.recover(checkpoint,[]);console.log(JSON.stringify({lineageFiles:relevant.length,reproduced:false}));}catch(e:any){console.log(JSON.stringify({lineageFiles:relevant.length,reproduced:e.code==='codex_encrypted_agent_message',code:e.code,status:e.statusCode}));}}finally{await rm(root,{recursive:true,force:true});}
