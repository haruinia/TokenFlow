import {afterEach,expect,it} from 'vitest';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {GatewayContext} from '../packages/core/src/gateway-context.js';import {CodexContext,codexContextScope,portableCodexItem} from '../packages/core/src/codex-context.js';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const summary=()=>Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'SAFE_SUMMARY'}]}]});
it('replays authenticated coverage identically on wire, persisted rollout and later opaque recovery',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'checkpoint-replay-'));roots.push(root);const home=join(root,'codex'),context=await GatewayContext.open(root),migration=new CodexContext(root,join(home,'config.toml'),context);
 const old={role:'user',content:'OLD_ALREADY_SUMMARIZED'},latest={role:'user',content:'LATEST_RETAINED'},fresh={role:'developer',content:'FRESH_INSTRUCTION'};
 const input=[old,{role:'assistant',content:'completed work '.repeat(5000)},latest,...Array.from({length:8},()=>({role:'assistant',content:'recent work'}))];
 const compact=await(await context.response('responses/compact',{model:'qoder/fixture',input},'key','source',async()=>summary(),{scope:codexContextScope,recover:async()=>[]})).json();
 // Equivalent input_text content has different key order and string/array form.
 const equivalent={type:'message',role:'user',content:[{text:'LATEST_RETAINED',type:'input_text'}]};
 const history=[old,equivalent,fresh,...compact.output];
 const expected=(await migration.forOfficial({input:history},[])).input.map((item:any)=>portableCodexItem(item)).flat();
 const texts=(items:any[])=>items.filter(item=>item.role==='user').map(item=>typeof item.content==='string'?item.content:item.content[0].text);
 expect(texts(expected)).toEqual(['LATEST_RETAINED']);expect(JSON.stringify(expected)).toContain('FRESH_INSTRUCTION');
 const file=join(home,'sessions/rollout-fixture.jsonl');await mkdir(join(home,'sessions'),{recursive:true});
 const original=[{type:'session_meta',payload:{id:'fixture',model_provider:'token_flow'}},{type:'compacted',payload:{replacement_history:history}},{type:'compacted',payload:{replacement_history:[{type:'compaction',encrypted_content:'later-native'}]}}].map(row=>JSON.stringify(row)+'\n').join('');await writeFile(file,original);
 expect(await migration.recover({type:'compaction',encrypted_content:'later-native'},[])).toEqual(expected);
 await migration.prepareOfficial([],async()=>[]);const after=await readFile(file,'utf8'),rows=after.trim().split('\n').map(line=>JSON.parse(line));
 expect(rows[1].payload.replacement_history).toEqual(expected);expect(await migration.prepareOfficial([],async()=>[])).toEqual({migrated:0});expect(await readFile(file,'utf8')).toBe(after);
 let forwarded:unknown;await context.response('responses',{model:'qoder/fixture',input:history,store:false},'key','source',async(_p,body)=>{forwarded=body.input;return Response.json({status:'completed',output:[]});},{scope:codexContextScope,recover:async()=>[],normalize:portableCodexItem});
 expect(forwarded).toEqual(expected);
 const replayed=await migration.forOfficial({input:[...expected,...compact.output]},[]);expect(replayed.input.flatMap(portableCodexItem)).toEqual(expected);
});
