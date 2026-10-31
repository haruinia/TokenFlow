/** Read-only response-ID audit; prints counters only, never messages, raw IDs or credentials. */
import {createReadStream} from 'node:fs';
import {readFile,readdir,stat} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash,createHmac} from 'node:crypto';
if(!process.argv.includes('--check'))throw Error('Usage: node scripts/codex-subagent-usage-audit.mjs --check [--since YYYY-MM-DD]');
const sinceIndex=process.argv.indexOf('--since'),since=sinceIndex>=0?process.argv[sinceIndex+1]:'2026-10-27';
if(!/^\d{4}-\d{2}-\d{2}$/.test(since))throw Error('Invalid date');
const root=join(homedir(),'Library/Application Support/desktop-browser-agent'),home=join(homedir(),'.codex');
const hash=(kind,id)=>createHash('sha256').update(kind+':'+id).digest('hex');
const day=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
const traces=JSON.parse(await readFile(join(root,'gateway-traces.json'),'utf8'));
const ledger=JSON.parse(await readFile(join(root,'usage-ledger.json'),'utf8')).rows;
const index=JSON.parse(await readFile(join(root,'local-usage-index.json'),'utf8'));
const native=new Map(Object.values(index.files).flatMap(f=>f.rows??[]).filter(r=>r.responseHash).map(r=>[r.responseHash,r]));
const evidence=new Set(),refs=[];for(const line of (await readFile(join(root,'gateway-response-evidence.jsonl'),'utf8')).split('\n'))try{const v=JSON.parse(line);if(typeof v==='string')evidence.add(v);else refs.push(v);}catch{}
const samples=new Map();let files=0,children=0,changing=0,withoutResponseUsage=0,childLegacyEvents=0;const kinds={};
for(const dir of ['sessions','archived_sessions'])for(const rel of (await readdir(join(home,dir),{recursive:true})).filter(p=>p.endsWith('.jsonl'))){
 const path=join(home,dir,rel),before=await stat(path),stream=createReadStream(path),lines=createInterface({input:stream,crlfDelay:Infinity});let child=false,first=true,thread='',provider='',model='',count=0;
 try{for await(const line of lines){let r;try{r=JSON.parse(line);}catch{continue;}const p=r.payload??{};
 if(first){first=false;files++;child=!!p.source?.subagent;if(!child)break;children++;thread=p.id;provider=p.model_provider;kinds[JSON.stringify(Object.keys(p.source.subagent??{}))]=(kinds[JSON.stringify(Object.keys(p.source.subagent??{}))]??0)+1;}
 if(r.type==='turn_context')model=p.model??model;
 if(r.type==='event_msg'&&p.type==='token_count'&&r.timestamp&&day(r.timestamp)>=since)childLegacyEvents++;
 if(r.type!=='token_usage_record'||!p.response_id||!p.usage)continue;count++;if(p.thread_id!==thread)continue;
 if(!r.timestamp||day(r.timestamp)<since)continue;
 const h=hash('response',p.response_id),u=p.usage;
 const trace=traces.records.find(t=>t.responseHash===h||t.responseRef===createHmac('sha256',traces.salt).update(`${t.keyId}\n${p.response_id}`).digest('hex'));
 const matched=evidence.has(h)||refs.some(e=>e.responseRef===createHmac('sha256',e.salt).update(`${e.keyId}\n${p.response_id}`).digest('hex'));
 const row=trace&&ledger.find(l=>l.day===day(trace.startedAt)&&l.target===trace.target&&l.keyId===trace.keyId&&l.sourceId===trace.sourceId&&l.model===trace.model);
 const item={day:day(r.timestamp),provider,model,input:u.input_tokens??0,output:u.output_tokens??0,cached:u.cached_input_tokens??0,gatewayEvidence:matched||!!trace,trace:!!trace,native:!!native.get(h),ledger:!!row,traceInput:trace?.inputTokens,traceOutput:trace?.outputTokens,ledgerCoversTrace:!!row&&row.inputTokens>=trace.inputTokens&&row.outputTokens>=trace.outputTokens,thread:hash('thread',thread).slice(0,12)};
 const old=samples.get(h);if(!old||item.input+item.output>=old.input+old.output)samples.set(h,item);
 }}finally{lines.close();stream.destroy();}if(child&&!count)withoutResponseUsage++;const after=await stat(path);if(before.size!==after.size)changing++;
}
const groups={};for(const s of samples.values()){const key=[s.day,s.provider,s.model].join(' | ');const g=groups[key]??={requests:0,input:0,output:0,cachedIncludedInInput:0,gatewayEvidence:0,recentTraces:0,nativeIndex:0,ledgerGroups:0,ledgerCoversTrace:0,traceTokenMismatch:0,unmatched:0};g.requests++;g.input+=s.input;g.output+=s.output;g.cachedIncludedInInput+=s.cached;g.gatewayEvidence+=+s.gatewayEvidence;g.recentTraces+=+s.trace;g.nativeIndex+=+s.native;g.ledgerGroups+=+s.ledger;g.ledgerCoversTrace+=+s.ledgerCoversTrace;if(s.trace&&(s.traceInput!==s.input||s.traceOutput!==s.output))g.traceTokenMismatch++;if(!s.gatewayEvidence&&!s.native)g.unmatched++;}
console.log(JSON.stringify({capturedAt:new Date().toISOString(),timezone:'America/Los_Angeles',since,files,children,changing,withoutResponseUsage,childLegacyEvents,kinds,uniqueResponses:samples.size,groups},null,2));
