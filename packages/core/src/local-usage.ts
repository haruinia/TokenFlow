import {createHash} from 'node:crypto';
import type {UsageRow} from './usage-ledger.js';
import {dayOf} from './usage-ledger.js';

export type UsageChannel='official'|'api'|'unknown';
export type LocalUsageRow=UsageRow&{origin:'native';channel:UsageChannel;provider:string;nativeAccountId?:string;nativeOrganizationId?:string;nativeAccountLabel?:string;nativeEmailHash?:string;nativeAccountEvidence?:'otel'|'conflict'|'login-snapshot'|'billing';nativeThreadId?:string;nativeModelUnconfirmed?:boolean;sampleId?:string;responseHash?:string};
export type UsageCoverage={target:string;files:number;indexed:number;skipped:number;status:'ready'|'scanning'|'unavailable'|'unsupported';note?:string};
export type LocalUsageSnapshot={rows:LocalUsageRow[];recent?:LocalUsageRow[];coverage:UsageCoverage[];scanning:boolean;updatedAt?:string;warning?:string;cursorConversations?:import('./cursor-conversations.js').CursorConversation[]};
export const nativeIdentity=(provider:string,id:string)=>createHash('sha256').update(`${provider}:${id}`).digest('hex');
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?Math.min(Number.MAX_SAFE_INTEGER,Math.round(v)):0;
const gatewayModel=(v:unknown)=>typeof v==='string'&&/^(?:token-flow[/: ·]|(?:custom-local:)?(?:api-[a-f0-9]{24}\/|(?:codex|claude|antigravity|workbuddy|qoder|zcode|kimi|trae|cursor)\/))/i.test(v);
type Sample={id:string;timestamp:string;model:string;provider:string;channel:UsageChannel;account?:string;input:number;read:number;write:number;output:number;reasoning:number;cacheKnown:boolean;responseId?:string;threadId?:string;modelUnconfirmed?:boolean;client?:string;unmeasured?:boolean};

export function authChannel(meta:any):UsageChannel{
 const mode=String(meta?.authType??meta?.auth_mode??meta?.authMode??meta?.authentication?.type??'').toLowerCase().replace(/[_-]/g,'');
 if(['oauth','chatgpt','subscription','official'].includes(mode)||meta?.requires_openai_auth===true)return 'official';
 if(['apikey','key'].includes(mode)||meta?.requires_openai_auth===false||typeof meta?.apiKey==='string'&&!!meta.apiKey||typeof meta?.apiKeyEnv==='string'&&!!meta.apiKeyEnv)return 'api';
 return 'unknown';
}
export type LocalUsageEvidence={matchesResponse?:(id:string)=>boolean;channelFor?:(threadId:string,time:string)=>UsageChannel|'gateway';claudeDesktopGateway?:boolean};
/** Reads usage metadata only. Message content, arguments and credentials never enter the output. */
export class LocalUsageParser{
 private samples=new Map<string,Sample>();private provider='';private model='';private account='';private explicit:UsageChannel='unknown';private cumulative=0;private previousUsage:any;private legacy:Sample[]=[];private hasCodexRecords=false;private threadId='';
 constructor(private target:string,private fileId:string,private evidence:LocalUsageEvidence={}){}
 accept(record:any){
  if(!record||typeof record!=='object')return;
  const p=record.payload??{},m=record.message??{},data=record.data??{};
  if(this.target==='codex'){
   // Creator identity is session ownership, not proof of which account paid each response.
   if(record.type==='session_meta'){this.provider=p.model_provider??'';this.account=p.billing_account_id??p.account_id??'';this.threadId=p.id??p.thread_id??p.session_id??this.threadId;this.explicit=authChannel(p);if(this.explicit==='unknown'&&p.creator_account_id)this.explicit='official';}
   if(record.type==='turn_context'){this.model=p.model??this.model;if(p.model_provider&&p.model_provider!==this.provider)this.explicit='unknown';this.provider=p.model_provider??this.provider;const channel=authChannel(p);if(channel!=='unknown')this.explicit=channel;}
   if(record.type==='token_usage_record'&&p.usage){this.hasCodexRecords=true;this.codex(p.usage,record.timestamp,String(p.response_id??record.ordinal??this.samples.size),p.response_id,typeof p.thread_id==='string'&&p.thread_id?p.thread_id:this.threadId);}
   if(record.type==='event_msg'&&p.type==='token_count'&&p.info?.total_token_usage){
    const current=p.info.total_token_usage,total=number(current.total_tokens),last=p.info.last_token_usage;
    if(total!==this.cumulative&&last){
     const reset=!this.previousUsage||number(current.input_tokens)<number(this.previousUsage.input_tokens)||number(current.output_tokens)<number(this.previousUsage.output_tokens);
     const usage=reset?last:Object.fromEntries(['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens'].map(k=>[k,current[k]===undefined?(number(current.input_tokens)>number(this.previousUsage.input_tokens)?last[k]:0):Math.max(0,number(current[k])-number(this.previousUsage[k]))]));
     if(number(usage.input_tokens)>0||!this.legacy.length||reset){const before=this.samples;this.samples=new Map();this.codex(usage,record.timestamp,`${this.fileId}:legacy:${record.ordinal??total}`);this.legacy.push(...this.samples.values());this.samples=before;}
     else{const previous=this.legacy.at(-1);if(previous){previous.output+=number(usage.output_tokens);previous.reasoning+=number(usage.reasoning_output_tokens);previous.timestamp=record.timestamp;}}
    }this.cumulative=total;this.previousUsage=current;
   }
   return;
  }
  if(record.type==='model_change'||record.type==='model/selection'){this.provider=record.provider??data.provider??this.provider;this.model=record.modelId??data.model??this.model;}
  if(record.type==='session'||record.type==='session-meta'){const meta=record.meta??{};this.account=meta.accountId??meta.userId??this.account;}
  const recordChannel=authChannel(record);if(record.type==='session'||record.type==='session-meta'||record.type==='model_change'||record.type==='model/selection')this.explicit=recordChannel;
  const time=record.timestamp??record.time??m.timestamp;const timestamp=typeof time==='number'?new Date(time).toISOString():time;
  if(this.target==='deepseek'){
   const route=record.type==='request/header'?data.header?.config:record.type==='session/title-llm-request'?data.route:undefined;
   if(route){this.provider=route.provider??this.provider;this.model=route.model??this.model;const auth=authChannel(route);this.explicit=auth;}
   if((record.type==='assistant/message'||record.type==='session/title-llm-request'||record.type==='compaction/summary')&&data.usage){const u=data.usage,provider=data.provider??this.provider;this.add({id:String(data.requestId??data.id??data.compactionId??record.seq),timestamp,model:data.model??this.model,provider,channel:recordChannel!=='unknown'?recordChannel:this.explicit!=='unknown'?this.explicit:['openai-codex','deepseek-account'].includes(provider)?'official':provider==='deepseek'?'api':'unknown',responseId:data.responseId,input:number(u.inputTokens)+number(u.cacheReadTokens)+number(u.cacheWriteTokens),read:number(u.cacheReadTokens),write:number(u.cacheWriteTokens),output:number(u.outputTokens),reasoning:number(u.reasoningTokens),cacheKnown:u.cacheReadTokens!==undefined},gatewayModel(data.model??this.model)||provider==='token-flow');}
   return;
  }
  const u=m.usage??record.usage;if(!u)return;
  const source=record.providerData??{};
  const model=record.requestedModel??source.requestModelId??m.model??this.model;
  const provider=m.provider??record.provider??this.provider;
  const routed=gatewayModel(model)||gatewayModel(m.model)||gatewayModel(source.requestModelName)||record.customProviderId==='token-flow'||provider==='token-flow'||/token.?flow/i.test(this.provider);
  const workbuddy=this.target==='workbuddy'||this.target==='workbuddy-ai';
  const id=workbuddy?`${source.messageId??u.request_id??record.id??''}:${source.stepSeq??''}`:String(u.request_id??m.id??record.id??record.uuid??'');if(!id||id===':')return;
  if(this.target==='pi'){
   const platform=provider==='openai-codex'||provider==='openai'?'codex':provider==='anthropic'?'claude':provider;
   this.add({id,responseId:m.id??record.responseId,timestamp,model,provider:platform,channel:recordChannel!=='unknown'?recordChannel:this.explicit!=='unknown'?this.explicit:provider==='openai-codex'?'official':['openai','deepseek','mistral','groq','xai','cerebras','openrouter'].includes(provider)?'api':'unknown',account:this.account,input:number(u.input)+number(u.cacheRead)+number(u.cacheWrite),read:number(u.cacheRead),write:number(u.cacheWrite),output:number(u.output),reasoning:number(u.reasoning),cacheKnown:u.cacheRead!==undefined},routed);return;
  }
  if(workbuddy){
   const raw=source.rawUsage??u;const inclusive=raw.prompt_tokens!==undefined||raw.total_tokens!==undefined&&raw.cache_read_input_tokens===undefined;
   const read=number(raw.prompt_tokens_details?.cached_tokens??raw.cache_read_input_tokens),write=number(raw.cache_creation_input_tokens);
   this.add({id,timestamp,model,provider:this.target,channel:record.modelSource==='custom'||String(model).startsWith('custom-local:')?'api':'official',account:this.account,input:number(raw.prompt_tokens??raw.input_tokens)+(inclusive?0:read+write),read,write,output:number(raw.completion_tokens??raw.output_tokens),reasoning:number(raw.completion_tokens_details?.reasoning_tokens),cacheKnown:raw.prompt_tokens_details?.cached_tokens!==undefined||raw.cache_read_input_tokens!==undefined},routed);return;
  }
  const read=number(u.cache_read_input_tokens),write=number(u.cache_creation_input_tokens);
  // Claude Desktop shares the CLI log folder. Its third-party mode never spends the Claude account.
  const desktop=this.target==='claude'&&typeof record.entrypoint==='string'&&record.entrypoint.startsWith('claude-desktop'),thirdParty=desktop&&record.entrypoint.endsWith('-3p');
  const sampleChannel:UsageChannel=thirdParty?'api':recordChannel!=='unknown'?recordChannel:this.explicit!=='unknown'?this.explicit:desktop?'official':this.target==='qoder'?(record.modelSource==='custom'?'api':record.modelSource==='builtin'||record.modelSource==='official'?'official':'unknown'):record.authType==='oauth'?'official':record.authType==='api-key'?'api':'unknown';
  this.add({id,timestamp,model,provider:this.target,channel:sampleChannel,responseId:m.id??record.responseId,account:thirdParty?undefined:record.accountId??this.account,input:number(u.input_tokens)+read+write,read,write,output:number(u.output_tokens),reasoning:number(u.output_tokens_details?.thinking_tokens),cacheKnown:u.cache_read_input_tokens!==undefined,...(desktop?{client:'claude-desktop'}:{}),
   // Qoder's built-in models bill credits and leave every token counter at zero.
   ...(this.target==='qoder'&&!number(u.input_tokens)&&!number(u.output_tokens)&&(number(u.credits)>0||u.billable===true)?{unmeasured:true}:{})},routed||thirdParty&&!!this.evidence.claudeDesktopGateway);
 }
 /** Parent session context is not request-level model, account or route evidence for a child thread. */
 private codex(u:any,timestamp:string,id:string,responseId?:string,threadId=this.threadId){
  const child=threadId!==this.threadId,inferred=this.evidence.channelFor?.(threadId,timestamp)??'unknown';if(inferred==='gateway')return;
  this.add({id,responseId,threadId,modelUnconfirmed:child,timestamp,model:child?'未标注模型':this.model,provider:'codex',channel:inferred!=='unknown'?inferred:!child?this.explicit:'unknown',account:u.account_id??(!child?this.account:undefined),input:number(u.input_tokens),read:number(u.cached_input_tokens),write:number(u.cache_write_input_tokens),output:number(u.output_tokens),reasoning:number(u.reasoning_output_tokens),cacheKnown:u.cached_input_tokens!==undefined},!child&&(/token.?flow/i.test(this.provider)||gatewayModel(this.model)));
 }
 private add(sample:Sample,routed:boolean){
  if(routed||sample.responseId&&this.evidence.matchesResponse?.(sample.responseId)||typeof sample.timestamp!=='string'||!Number.isFinite(Date.parse(sample.timestamp))||!sample.input&&!sample.output&&!sample.unmeasured)return;
  sample.model=typeof sample.model==='string'?sample.model.slice(0,300):'未标注模型';sample.read=Math.min(sample.read,sample.input);sample.write=Math.min(sample.write,Math.max(0,sample.input-sample.read));sample.reasoning=Math.min(sample.reasoning,sample.output);
  // Streaming assistant fragments share one provider response ID. Keep the final/largest sample.
  const previous=this.samples.get(sample.id);if(!previous||sample.input+sample.output>=previous.input+previous.output)this.samples.set(sample.id,sample);
 }
 rows():LocalUsageRow[]{
  const samples=this.target==='codex'&&!this.hasCodexRecords?this.legacy:[...this.samples.values()];const rows=new Map<string,LocalUsageRow>();
  for(const s of samples){const identity=s.account?nativeIdentity(s.provider,s.account):'';const day=dayOf(s.timestamp);const sampleId=nativeIdentity(this.target,`${s.responseId??s.id}${s.responseId?'':':'+s.timestamp}`);const key=sampleId;const row=rows.get(key)??{day,target:s.client??this.target,keyId:`native:${identity||s.client||this.target}`,keyName:s.channel==='official'?'官方登录':s.channel==='api'?'API Key':'本机记录 · 渠道未标注',sourceId:'',model:s.model,requests:0,failed:0,unmeasured:0,inputTokens:0,cachedTokens:0,cacheBaseTokens:0,outputTokens:0,durationMs:0,last:s.timestamp,origin:'native',channel:s.channel,provider:s.provider,sampleId,...(this.target==='codex'&&s.threadId?{nativeThreadId:nativeIdentity('thread',s.threadId)}:{}),...(s.modelUnconfirmed?{nativeModelUnconfirmed:true}:{}),...(s.responseId?{responseHash:nativeIdentity('response',s.responseId)}:{}),...(identity?{nativeAccountId:identity}:{})};
   row.requests++;if(s.unmeasured)row.unmeasured++;row.inputTokens+=s.input;row.outputTokens+=s.output;row.cachedTokens+=s.read;if(s.cacheKnown)row.cacheBaseTokens+=s.input;row.cacheWriteTokens=(row.cacheWriteTokens??0)+s.write;row.reasoningTokens=(row.reasoningTokens??0)+s.reasoning;if(s.timestamp>row.last)row.last=s.timestamp;rows.set(key,row);
  }return [...rows.values()];
 }
}
/** Forks and exported copies may retain response IDs: count each billed response once across files. */
function uniqueSamples(input:LocalUsageRow[]){
 const blocked=new Set<string>();const samples=new Map<string,LocalUsageRow>(),identities=new Map<string,Map<string,LocalUsageRow>>();
 for(const r of input){
  const id=r.sampleId??JSON.stringify(r),old=samples.get(id);if(r.nativeAccountEvidence==='conflict')blocked.add(id);if(!old||r.inputTokens+r.outputTokens>=old.inputTokens+old.outputTokens)samples.set(id,r);
  if(r.nativeAccountId){const known=identities.get(id)??new Map<string,LocalUsageRow>(),key=`${r.nativeAccountId}:${r.nativeEmailHash??''}:${r.nativeOrganizationId??''}`,previous=known.get(key);if(!previous||previous.nativeAccountEvidence==='login-snapshot'||r.nativeAccountEvidence!=='login-snapshot')known.set(key,r);identities.set(id,known);}
 }
 for(const[id,known]of identities){const row=samples.get(id)!;const verified=[...known.values()].filter(r=>r.nativeAccountEvidence!=='login-snapshot'),proofs=verified.length?verified:[...known.values()];if(proofs.length===1&&!blocked.has(id)){const account=proofs[0];samples.set(id,{...row,...(row.nativeModelUnconfirmed&&!account.nativeModelUnconfirmed?{model:account.model,nativeModelUnconfirmed:undefined}:{}),nativeAccountId:account.nativeAccountId,channel:account.channel,keyName:account.keyName,nativeAccountEvidence:account.nativeAccountEvidence,nativeEmailHash:account.nativeEmailHash,nativeOrganizationId:account.nativeOrganizationId});}else{const {nativeAccountId,nativeEmailHash,nativeOrganizationId,nativeAccountLabel,nativeAccountEvidence,...unconfirmed}=row;samples.set(id,{...unconfirmed,nativeAccountEvidence:'conflict',sourceId:'',keyId:`native:${row.target}`});}}
 return samples;
}
export function mergeLocalUsageRows(input:LocalUsageRow[]):LocalUsageRow[]{
 const samples=uniqueSamples(input);
 const groups=new Map<string,LocalUsageRow>();for(const r of samples.values()){const key=[r.day,r.target,r.model,r.provider,r.channel,r.nativeAccountId??'',r.nativeEmailHash??'',r.nativeOrganizationId??'',r.nativeAccountEvidence??''].join('|');const old=groups.get(key);if(!old){const {sampleId,responseHash,...copy}=r;groups.set(key,{...copy});continue;}for(const k of ['requests','failed','unmeasured','inputTokens','cachedTokens','cacheBaseTokens','outputTokens','durationMs','cacheWriteTokens','reasoningTokens'] as const)old[k]=(old[k]??0)+(r[k]??0);if(r.last>old.last)old.last=r.last;}return [...groups.values()];
}

/** Only distinct usage samples become activity records; daily aggregates are not requests. */
export function recentLocalUsageRows(input:LocalUsageRow[],limit=1000):LocalUsageRow[]{
 const samples=uniqueSamples(input.filter(row=>!!row.sampleId));
 return [...samples.values()].sort((a,b)=>b.last.localeCompare(a.last)).slice(0,limit);
}
