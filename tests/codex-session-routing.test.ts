import {expect,it} from 'vitest';
import {rewriteSessionProvider} from '../packages/core/src/codex-session-routing';
it('changes only the session bucket, retaining historical models, encrypted items and summaries byte-for-byte',()=>{
 const header=JSON.stringify({type:'session_meta',ordinal:0,payload:{id:'fixture',model_provider:'token_flow',multi_agent_version:'v1'}});
 const history='\n'+JSON.stringify({type:'turn_context',ordinal:1,payload:{model:'gateway-model',model_provider:'token_flow'}})+'\n'+JSON.stringify({type:'response_item',ordinal:2,payload:{type:'compaction',encrypted_content:'synthetic-checkpoint'}})+'\n';
 const after=rewriteSessionProvider(header+history,'openai',['token_flow','openai']);expect(JSON.parse(after.split('\n')[0]).payload.model_provider).toBe('openai');expect(after.slice(after.indexOf('\n'))).toBe(history);
 expect(rewriteSessionProvider(after,'openai',['token_flow','openai'])).toBe(after);
});
it('does not overwrite an independently changed source',()=>{
 const text=JSON.stringify({type:'session_meta',payload:{model_provider:'api_direct_other'}});
 expect(()=>rewriteSessionProvider(text,'openai',['token_flow','openai'])).toThrow('来源已被其他程序修改');
});
