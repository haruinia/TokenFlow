import {it,expect} from 'vitest';
import {upstreamError} from '../packages/core/src/upstream-errors.js';
it('reports bounded Qoder capacity waiting without inventing a queue ETA',()=>{
 const result=upstreamError(429,JSON.stringify({error:{code:'qoder_capacity_wait_exhausted',message:'PRIVATE_UPSTREAM'}}));
 expect(result).toMatchObject({code:'qoder_capacity_wait_exhausted',type:'rate_limit_error'});
 expect(result.message).toContain('容量不足');expect(result.message).toContain('等待预算');
 expect(result.message).not.toMatch(/PRIVATE|60|预计|队列位置/);
});
it.each(['qoder_resource_limit','qoder_rate_limited','qoder_authentication_failed','qoder_access_denied','qoder_request_rejected','qoder_upstream_error'])('preserves Qoder envelope category %s without provider payloads',code=>{
 const result=upstreamError(code.includes('limit')?429:502,JSON.stringify({error:{code,message:'PRIVATE_PROMPT Bearer private-token'}}));
 expect(result.code).toBe(code);expect(result.message).not.toMatch(/PRIVATE_PROMPT|private-token/);
 if(code.includes('limit'))expect(result.type).toBe('rate_limit_error');
});
it('reports safe parameter errors separately from source cooldown without leaking payloads',()=>{
 const result=upstreamError(400,JSON.stringify({error:{code:'a2a_invalid_request',message:'private request contents'}}));
 expect(result).toMatchObject({code:'a2a_invalid_request',type:'invalid_request_error'});
 expect(result.message).not.toContain('private request');
 expect(upstreamError(503,JSON.stringify({error:{message:'auth_unavailable: no auth available'}})).code).toBe('source_cooldown');
});
it('keeps safe WorkBuddy field paths while discarding provider text and arbitrary fields',()=>{
 const result=upstreamError(400,JSON.stringify({error:{code:'workbuddy_invalid_request',fields:['tools.2.name','reasoning.summary','private-token','input.secret'],message:'private request contents'}}));
 expect(result.message).toContain('tools.2.name');expect(result.message).toContain('reasoning.summary');expect(result.message).not.toMatch(/private|secret/);
});
it('retains safe Cursor schema paths and failure categories through compaction error handling',()=>{
 const regional=upstreamError(403,JSON.stringify({error:{code:'cursor_region_unsupported',message:'PRIVATE'}}));
 expect(regional).toMatchObject({code:'cursor_region_unsupported',type:'permission_error'});expect(regional.message).toContain('地区');expect(regional.message).not.toContain('PRIVATE');
 const bad=upstreamError(400,JSON.stringify({error:{code:'cursor_invalid_request',fields:['messages.149.content','private-token','input.secret'],message:'private request'}}));
 expect(bad).toMatchObject({code:'cursor_invalid_request',type:'invalid_request_error'});expect(bad.message).toContain('messages.149.content');expect(bad.message).not.toMatch(/private|secret/);
 for(const code of ['cursor_model_not_found','cursor_network_error','cursor_timeout','cursor_rate_limited','cursor_permission_denied','cursor_plan_required','cursor_authentication_failed','cursor_backend_override','cursor_upstream_error','cursor_upstream_unavailable','cursor_upstream_internal','cursor_request_rejected','cursor_tls_error','cursor_dns_error']){
  const result=upstreamError(502,JSON.stringify({error:{code,message:'private upstream payload'}}));
  expect(result.code).toBe(code);expect(result.message).not.toContain('private');
 }
});
it('keeps structural upstream 400 parameters without exposing provider messages or arbitrary names',()=>{
 const result=upstreamError(400,JSON.stringify({error:{type:'invalid_request_error',param:'input[42].content',message:'PRIVATE_PROMPT'}}));
 expect(result).toMatchObject({code:'upstream_invalid_request'});expect(result.message).toContain('input[42].content');expect(result.message).not.toContain('PRIVATE');
 const bad=upstreamError(400,JSON.stringify({error:{type:'invalid_request_error',param:'input.PRIVATE_TOKEN',message:'PRIVATE_PROMPT'}}));
 expect(bad.message).not.toContain('PRIVATE');
 expect(upstreamError(400,JSON.stringify({error:{code:'context_length_exceeded',message:'PRIVATE_PROMPT'}})).code).toBe('upstream_context_length');
});

it.each(['workbuddy_sdk_failed','workbuddy_output_failed','workbuddy_timeout','a2a_parallel_tools_violated'])('retains safe category %s without upstream payload',code=>{
 expect(upstreamError(502,JSON.stringify({error:{code,message:'private payload'}}))).toMatchObject({code});
 expect(upstreamError(502,JSON.stringify({error:{code,message:'private payload'}})).message).not.toContain('private');
});

it.each(['workbuddy_text_mismatch','workbuddy_model_mismatch','workbuddy_missing_result','workbuddy_context_limit','workbuddy_output_limit','workbuddy_tool_schema','workbuddy_tool_protocol','workbuddy_turn_limit','workbuddy_sdk_startup','workbuddy_sdk_execution','workbuddy_sdk_transport'])('retains diagnostic category %s without arbitrary error text',code=>{
 const safe=upstreamError(502,JSON.stringify({error:{code,message:'PRIVATE_PROMPT Bearer private-token'}}));
 expect(safe.code).toBe(code);expect(safe.message).not.toMatch(/PRIVATE_PROMPT|private-token/);
});
it.each(['unknown_name','unfinished_block','invalid_json','invalid_args','truncated_turn','parallel_limit','orphan_delta'])('retains the fixed %s tool subtype through repeated error normalization',toolIssue=>{
 const first=upstreamError(502,JSON.stringify({error:{code:'workbuddy_tool_protocol',toolIssue,message:'PRIVATE_TOOL_ARGUMENT'}}));
 expect(first).toMatchObject({code:'workbuddy_tool_protocol',toolIssue});expect(first.message).toContain(toolIssue);expect(first.message).not.toContain('PRIVATE');
 const second=upstreamError(502,JSON.stringify({error:{code:first.code,message:first.message}}));expect(second).toMatchObject({code:first.code,toolIssue,message:first.message});
});
it('discards arbitrary WorkBuddy tool issue strings',()=>{
 const safe=upstreamError(502,JSON.stringify({error:{code:'workbuddy_tool_protocol',toolIssue:'PRIVATE_TOOL_ARGUMENT',message:'PRIVATE_TOOL_ARGUMENT'}}));expect(safe).not.toHaveProperty('toolIssue');expect(safe.message).not.toContain('PRIVATE');
});

it.each([
 ['tools.0.custom.name',"String should match pattern PRIVATE"],
 ['messages.1.content.0','Invalid `signature` in `thinking` block PRIVATE'],
 ['tools[2].input_schema.anyOf[0].type','Unsupported schema PRIVATE'],
])('extracts only a whitelisted structural path from nested Antigravity errors: %s',(param,detail)=>{
 const inner={type:'error',error:{type:'invalid_request_error',message:`${param}: ${detail}`}};
 const result=upstreamError(400,JSON.stringify({error:{type:'invalid_request_error',message:JSON.stringify(inner)}}));
 expect(result).toMatchObject({code:'upstream_invalid_request',param});
 expect(result.message).toContain(param);expect(result.message).not.toMatch(/PRIVATE|signature`|String should/);
});
it.each(['tools.0.custom.PRIVATE_TOKEN','messages.0.content.secret','tools.0.input_schema.properties.privateCustomerName','tools.0.custom.name\nPRIVATE','Bearer private-token','x'.repeat(300)])('rejects nonstructural provider parameter text: %s',param=>{
 const result=upstreamError(400,JSON.stringify({error:{type:'invalid_request_error',message:`${param}: PRIVATE`,param}}));
 expect(result.param).toBeUndefined();expect(result.message).not.toMatch(/PRIVATE|private-token|privateCustomerName/);
});
