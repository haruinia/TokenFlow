import {expect,it} from 'vitest';
import {captureAgentProtocol,rewriteAgentProtocol} from '../packages/core/src/codex-agent-protocol-migration.js';
const row=(type:string,payload:unknown)=>JSON.stringify({type,payload});
it.each(['v1','v2','disabled',undefined])('restores the original %s protocol while retaining new turns and opaque records',value=>{
 const original=row('session_meta',{id:'x',multi_agent_version:value})+'\n'+row('turn_context',{turn_id:'before',multi_agent_version:value})+'\n';
 const ordinary=[row('response_item',{type:'agent_message',encrypted_content:'opaque'}),row('response_item',{type:'reasoning',encrypted_content:'reasoning'}),row('compacted',{replacement_history:[{type:'compaction',encrypted_content:'native'}]})].join('\n')+'\n';
 const baseline=captureAgentProtocol(original);const gateway=rewriteAgentProtocol(original+ordinary,baseline,'gateway');expect(JSON.parse(gateway.split('\n')[0]!).payload.multi_agent_version).toBe('v1');
 const added=row('turn_context',{turn_id:'after',multi_agent_version:'v1'})+'\n';const restored=rewriteAgentProtocol(gateway+added,baseline,'native');
 expect(restored).toBe(original+ordinary+row('turn_context',{turn_id:'after',multi_agent_version:value})+'\n');
 expect(rewriteAgentProtocol(restored,baseline,'native')).toBe(restored);
});
it('lets the restored native config choose a gateway-born thread protocol',()=>{
 const text=row('session_meta',{multi_agent_version:'v1'})+'\n';
 expect(rewriteAgentProtocol(text,captureAgentProtocol(text,true),'native')).toBe(row('session_meta',{})+'\n');
});
it('stops for an unknown future protocol instead of downgrading it',()=>{
 expect(()=>captureAgentProtocol(row('session_meta',{multi_agent_version:'v3'}))).toThrow('协议');
 const baseline=captureAgentProtocol(row('session_meta',{multi_agent_version:'v2'}));
 expect(()=>rewriteAgentProtocol(row('session_meta',{multi_agent_version:'v3'}),baseline,'gateway')).toThrow('协议');
});
it('accepts the observed v2 preimage of a legacy gateway-born thread while restoring native defaults',()=>{
 const text=row('session_meta',{multi_agent_version:'v2'})+'\n';const baseline=captureAgentProtocol(text,true);
 expect(JSON.parse(rewriteAgentProtocol(text,baseline,'gateway').trim()).payload.multi_agent_version).toBe('v1');
 expect(rewriteAgentProtocol(text,baseline,'native')).toBe(row('session_meta',{})+'\n');
});
it('does not rewrite a recognized rollout with an incomplete record',()=>{
 const text=row('session_meta',{multi_agent_version:'v2'})+'\n{"type":"response_item"';expect(()=>captureAgentProtocol(text)).toThrow('协议');
});
it('accepts a known protocol written after an older baseline without protocol metadata',()=>{
 const original=row('session_meta',{id:'legacy'})+'\n';
 const baseline=captureAgentProtocol(original);
 const current=original+row('turn_context',{turn_id:'later',multi_agent_version:'v2'})+'\n';
 const gateway=rewriteAgentProtocol(current,baseline,'gateway');
 expect(gateway.trim().split('\n').map(line=>JSON.parse(line).payload.multi_agent_version)).toEqual(['v1','v1']);
 expect(rewriteAgentProtocol(current,baseline,'native')).toBe(original+row('turn_context',{turn_id:'later'})+'\n');
 expect(rewriteAgentProtocol(gateway,baseline,'native')).toBe(original+row('turn_context',{turn_id:'later'})+'\n');
});
