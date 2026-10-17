import {describe,it,expect} from 'vitest';
import {LocalUsageParser,mergeLocalUsageRows} from '../packages/core/src/local-usage.js';
const timestamp='2026-10-12T08:00:00.000Z';
describe('local program token accounting',()=>{
 it('collects WorkBuddyAI separately and still excludes its imported gateway models',()=>{
  const p=new LocalUsageParser('workbuddy-ai','intl');for(const model of ['builtin','custom-local:antigravity/Gemini'])p.accept({id:model,timestamp,message:{usage:{input_tokens:20,output_tokens:5}},providerData:{messageId:model,requestModelId:model,rawUsage:{prompt_tokens:20,completion_tokens:5,prompt_tokens_details:{cached_tokens:10}}}});
  expect(p.rows()).toHaveLength(1);expect(p.rows()[0]).toMatchObject({target:'workbuddy-ai',provider:'workbuddy-ai',channel:'official',inputTokens:20,cachedTokens:10,outputTokens:5});
 });
 it('prefers Codex per-response records over repeated cumulative notifications and dedupes copied sessions',()=>{
  const p=new LocalUsageParser('codex','one');p.accept({type:'session_meta',payload:{model_provider:'openai',creator_account_id:'owner-not-billing'}});p.accept({type:'turn_context',payload:{model:'gpt-test'}});
  const usage={input_tokens:100,cached_input_tokens:60,output_tokens:20,reasoning_output_tokens:10};
  p.accept({type:'event_msg',timestamp,payload:{type:'token_count',info:{total_token_usage:{total_tokens:120},last_token_usage:usage}}});
  p.accept({type:'token_usage_record',timestamp,payload:{response_id:'resp-one',usage}});p.accept({type:'token_usage_record',timestamp,payload:{response_id:'resp-one',usage}});
  const rows=mergeLocalUsageRows([...p.rows(),...p.rows()]);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({requests:1,inputTokens:100,cachedTokens:60,outputTokens:20,reasoningTokens:10,channel:'official'});expect(rows[0].nativeAccountId).toBeUndefined();expect(JSON.stringify(rows)).not.toContain('owner-not-billing');
 });
 it('excludes Codex gateway routes and permits genuine independent custom API routes',()=>{
  const p=new LocalUsageParser('codex','two');p.accept({type:'session_meta',payload:{model_provider:'token_flow'}});p.accept({type:'turn_context',payload:{model:'custom-test'}});p.accept({type:'token_usage_record',timestamp,payload:{response_id:'one',usage:{input_tokens:100,output_tokens:10}}});expect(p.rows()).toEqual([]);
  p.accept({type:'turn_context',payload:{model_provider:'company-api',model:'custom-test',auth_mode:'api_key'}});p.accept({type:'token_usage_record',timestamp,payload:{response_id:'two',usage:{input_tokens:100,output_tokens:10}}});expect(p.rows()[0].channel).toBe('api');p.accept({type:'turn_context',payload:{model_provider:'cc-switch-official',model:'custom-test'}});p.accept({type:'token_usage_record',timestamp,payload:{response_id:'three',usage:{input_tokens:10,output_tokens:5}}});expect(p.rows()[1].channel).toBe('unknown');
 });
 it('counts legacy Codex cumulative updates only when the total advances',()=>{
  const p=new LocalUsageParser('codex','legacy');p.accept({type:'session_meta',payload:{model_provider:'openai'}});for(const total of [120,120,240])p.accept({type:'event_msg',timestamp,payload:{type:'token_count',info:{total_token_usage:{total_tokens:total,input_tokens:total/120*100,output_tokens:total/120*20},last_token_usage:{input_tokens:100,output_tokens:20}}}});expect(p.rows().reduce((n,r)=>n+r.requests,0)).toBe(2);
  const stream=new LocalUsageParser('codex','legacy-stream');stream.accept({type:'session_meta',payload:{model_provider:'openai'}});for(const [input,output]of [[100,1],[100,3],[200,8]])stream.accept({type:'event_msg',timestamp,payload:{type:'token_count',info:{total_token_usage:{total_tokens:input+output,input_tokens:input,output_tokens:output},last_token_usage:{input_tokens:100,output_tokens:output}}}});const rows=stream.rows();expect(rows.reduce((n,r)=>n+r.inputTokens+r.outputTokens,0)).toBe(208);expect(rows.reduce((n,r)=>n+r.requests,0)).toBe(2);
 });
 it('counts Anthropic cache buckets once and keeps the last assistant usage sample without content',()=>{
  const p=new LocalUsageParser('claude','claude');const message={id:'msg-one',model:'claude-test',content:[{text:'PRIVATE_BODY',type:'text'}],usage:{input_tokens:10,cache_read_input_tokens:50,cache_creation_input_tokens:5,output_tokens:10}};
  p.accept({type:'assistant',timestamp,message});p.accept({type:'assistant',timestamp,message:{...message,usage:{...message.usage,output_tokens:20}}});expect(p.rows()[0]).toMatchObject({requests:1,inputTokens:65,cachedTokens:50,cacheWriteTokens:5,outputTokens:20,channel:'unknown'});expect(JSON.stringify(p.rows())).not.toContain('PRIVATE_BODY');
  p.accept({type:'assistant',timestamp,requestedModel:'opus',message:{...message,id:'gateway-alias',model:'api-'+ 'a'.repeat(24)+'/model'}});expect(p.rows()).toHaveLength(1);
 });
 it('identifies Qoder and WorkBuddy routing without treating every custom provider as token-flow',()=>{
  const q=new LocalUsageParser('qoder','q');const message={id:'q1',model:'plain-api-model',usage:{input_tokens:100,output_tokens:10}};q.accept({type:'assistant',timestamp,modelSource:'custom',customProviderId:'company',message});expect(q.rows()[0].channel).toBe('api');q.accept({type:'assistant',timestamp,modelSource:'custom',customProviderId:'token-flow',message:{...message,id:'q2'}});expect(q.rows()).toHaveLength(1);
  const credits=new LocalUsageParser('qoder','credits');credits.accept({type:'assistant',timestamp,modelSource:'builtin',message:{id:'q3',model:'auto',usage:{input_tokens:0,output_tokens:0,credits:0.16,billable:true}}});credits.accept({type:'assistant',timestamp,modelSource:'builtin',message:{id:'q4',model:'auto',usage:{input_tokens:0,output_tokens:0,credits:0,billable:false}}});
  expect(credits.rows()).toEqual([expect.objectContaining({requests:1,unmeasured:1,inputTokens:0,outputTokens:0,channel:'official'})]);
  const w=new LocalUsageParser('workbuddy','w');w.accept({type:'message',id:'w1',timestamp,message:{usage:{input_tokens:100,output_tokens:10}},providerData:{requestModelId:'custom-local:qoder/one',rawUsage:{prompt_tokens:100,completion_tokens:10}}});expect(w.rows()).toEqual([]);
  for(const stepSeq of [1,2])w.accept({type:'message',id:`w-${stepSeq}`,timestamp,message:{usage:{input_tokens:10,output_tokens:10}},providerData:{conversationRequestId:'same-turn',messageId:`step-${stepSeq}`,stepSeq,requestModelId:'builtin',rawUsage:{prompt_tokens:10,completion_tokens:10}}});expect(w.rows()).toHaveLength(2);
 });
 it('normalizes Pi and DeepSeek disjoint cache inputs, excludes reasoning from the total',()=>{
  const pi=new LocalUsageParser('pi','pi');pi.accept({type:'message',id:'pi1',timestamp,message:{provider:'openai-codex',model:'gpt-test',usage:{input:10,cacheRead:50,cacheWrite:5,output:20,reasoning:8}}});expect(pi.rows()[0]).toMatchObject({inputTokens:65,outputTokens:20,reasoningTokens:8,channel:'official'});
  const d=new LocalUsageParser('deepseek','dsh');d.accept({type:'model/selection',data:{provider:'company',model:'plain-model'}});d.accept({type:'assistant/message',seq:5,time:Date.parse(timestamp),data:{usage:{inputTokens:10,cacheReadTokens:50,outputTokens:20},stream:[{usage:{inputTokens:10,cacheReadTokens:50,outputTokens:20}}]}});expect(d.rows()[0]).toMatchObject({inputTokens:60,outputTokens:20,requests:1});
  const compact=new LocalUsageParser('deepseek','compact');compact.accept({type:'compaction/summary',seq:7,time:Date.parse(timestamp),data:{compactionId:'c1',provider:'deepseek',model:'deepseek-chat',summary:{text:'PRIVATE'},usage:{inputTokens:25329,cacheReadTokens:8213,outputTokens:1378,totalTokens:34920}}});expect(compact.rows()[0]).toMatchObject({inputTokens:33542,cachedTokens:8213,outputTokens:1378,channel:'api',model:'deepseek-chat'});expect(JSON.stringify(compact.rows())).not.toContain('PRIVATE');
  const routedCompact=new LocalUsageParser('deepseek','routed');routedCompact.accept({type:'compaction/summary',seq:8,time:Date.parse(timestamp),data:{compactionId:'c2',provider:'token-flow',model:'plain-model',usage:{inputTokens:10,outputTokens:1}}});expect(routedCompact.rows()).toEqual([]);
  const gateway=new LocalUsageParser('deepseek','gateway');gateway.accept({type:'request/header',data:{header:{config:{provider:'token-flow',model:'workbuddy/test'},tools:[{text:'PRIVATE'}]}}});gateway.accept({type:'assistant/message',seq:6,time:Date.parse(timestamp),data:{usage:{inputTokens:100,outputTokens:10}}});expect(gateway.rows()).toEqual([]);
 });
 it('uses recorded authentication, scopes endpoint evidence to each response, and removes matched gateway aliases',()=>{
  const p=new LocalUsageParser('codex','evidence',{channelFor:(_thread,time)=>time===timestamp?'official':'unknown',matchesResponse:id=>id==='proxied'});
  p.accept({type:'session_meta',payload:{id:'thread',model_provider:'openai'}});p.accept({type:'turn_context',payload:{model:'same-model'}});
  for(const [id,time]of [['direct',timestamp],['no-evidence','2026-10-11T08:00:00Z'],['proxied',timestamp]])p.accept({type:'token_usage_record',timestamp:time,payload:{response_id:id,usage:{input_tokens:100,output_tokens:10}}});
  expect(p.rows().map(r=>r.channel)).toEqual(['official','unknown']);expect(p.rows().reduce((n,r)=>n+r.requests,0)).toBe(2);
  const claude=new LocalUsageParser('claude','c',{matchesResponse:id=>id==='msg-proxy'});
  for(const [id,authType]of [['msg-api','api_key'],['msg-oauth','oauth'],['msg-unknown',undefined],['msg-proxy',undefined]])claude.accept({type:'assistant',timestamp,authType,message:{id,model:'claude-original-name',usage:{input_tokens:10,output_tokens:5}}});
  expect(claude.rows().map(r=>r.channel)).toEqual(['api','official','unknown']);
 });
 it('deduplicates copied Pi sessions while keeping separate native responses',()=>{
  const make=(file:string)=>{const p=new LocalUsageParser('pi',file);p.accept({type:'message',id:'entry-copy',timestamp,message:{provider:'openai',model:'gpt-test',usage:{input:10,output:5}}});return p.rows();};
  const rows=mergeLocalUsageRows([...make('one'),...make('copy')]);expect(rows[0]).toMatchObject({requests:1,inputTokens:10,outputTokens:5,channel:'api'});
 });

});

it('separates Claude Desktop from Claude CLI and never charges its third-party mode to the Claude account',()=>{
 const parse=(claudeDesktopGateway:boolean)=>{const p=new LocalUsageParser('claude','shared',{claudeDesktopGateway});
  for(const [id,entrypoint]of [['cli','cli'],['desktop-official','claude-desktop'],['desktop-3p','claude-desktop-3p']])p.accept({type:'assistant',timestamp,entrypoint,accountId:'logged-in',requestedModel:'claude-sonnet-4-6[1m]',message:{id,model:'claude-opus-4-6-thinking',usage:{input_tokens:10,output_tokens:5}}});
  return p.rows().map(r=>[r.target,r.provider,r.channel,!!r.nativeAccountId]);};
 expect(parse(true)).toEqual([['claude','claude','unknown',true],['claude-desktop','claude','official',true]]);
 expect(parse(false)).toEqual([['claude','claude','unknown',true],['claude-desktop','claude','official',true],['claude-desktop','claude','api',false]]);
});

it('uses the response thread for route exclusion and keeps sibling responses independent',()=>{
 const seen:string[]=[];const p=new LocalUsageParser('codex','parent',{channelFor:thread=>{seen.push(thread);return thread==='gateway-child'?'gateway':thread==='official-child'?'official':'unknown';}});
 p.accept({type:'session_meta',payload:{id:'parent',model_provider:'openai'}});p.accept({type:'turn_context',payload:{model:'gpt-test'}});
 for(const thread of ['gateway-child','official-child'])p.accept({type:'token_usage_record',timestamp,payload:{thread_id:thread,response_id:thread,usage:{input_tokens:100,output_tokens:20}}});
 expect(seen).toEqual(['gateway-child','official-child']);expect(p.rows()).toHaveLength(1);expect(p.rows()[0]).toMatchObject({channel:'official',inputTokens:100,outputTokens:20});
});

it('does not inherit parent gateway configuration or billing identity into another thread',()=>{
 const p=new LocalUsageParser('codex','parent',{channelFor:thread=>thread==='direct-child'?'official':'unknown'});
 p.accept({type:'session_meta',payload:{id:'parent',model_provider:'token-flow',billing_account_id:'parent-payer'}});p.accept({type:'turn_context',payload:{model:'workbuddy/parent-model'}});
 for(const thread of ['direct-child','unconfirmed-child'])p.accept({type:'token_usage_record',timestamp,payload:{thread_id:thread,response_id:thread,usage:{input_tokens:100,output_tokens:20}}});
 expect(p.rows()).toHaveLength(2);expect(p.rows().map(r=>r.channel)).toEqual(['official','unknown']);expect(p.rows().every(r=>!r.nativeAccountId&&r.model==='未标注模型')).toBe(true);
});
