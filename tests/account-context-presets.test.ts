import {expect,it} from 'vitest';
import {accountContextPreset,accountModelCapabilities} from '../packages/core/src/account-context-presets.js';
import {modelCapabilityPreset} from '../packages/core/src/model-capabilities.js';
it('uses reviewed source-specific capacity hints without granting or guessing models',()=>{
 expect(accountContextPreset('antigravity','gemini-3.8-flash-high')).toEqual({contextWindow:1048576});
 expect(accountContextPreset('antigravity','claude-opus-4-6-thinking')).toEqual({contextWindow:200000});
 expect(accountContextPreset('claude','claude-opus-4-6')).toEqual({contextWindow:1000000});
 expect(accountContextPreset('codex','gpt-6.1-sol')).toEqual({contextWindow:500000});
 expect(accountContextPreset('qoder','dfmodel')).toBeUndefined();
 expect(accountContextPreset('workbuddy','claude-opus-4-6')).toBeUndefined();
 expect(accountContextPreset('__proto__','constructor')).toBeUndefined();
});
it('replaces obsolete cached capacities only with authoritative discovery and lets live limits win',()=>{
 expect(accountModelCapabilities('antigravity',{id:'gemini-3.8-flash-high',context_metadata_version:2},{contextWindow:131072})).toEqual({contextWindow:1048576});
 expect(accountModelCapabilities('workbuddy',{id:'unknown',context_metadata_version:2},{contextWindow:131072})).toEqual({});
 const current={id:'gpt-6.1-sol',context_metadata_version:2,context_length:600000,inputTokenLimit:1000000};
 expect(accountModelCapabilities('codex',current).contextWindow).toBe(600000);
 const inputOnly={id:'gpt-6.1-sol',context_metadata_version:2,inputTokenLimit:700000};
 expect(accountModelCapabilities('codex',inputOnly).contextWindow).toBe(700000);
 expect(accountModelCapabilities('workbuddy',{id:'unknown'},{contextWindow:64000})).toEqual({contextWindow:64000});
});
it('scopes reviewed API capacities to exact endpoints and IDs',()=>{
 expect(modelCapabilityPreset('https://open.bigmodel.cn/api/v1','responses','glm-5.3-flash')?.contextWindow).toBe(1048576);
 expect(modelCapabilityPreset('https://api.ppio.com/openai/v1','chat','deepseek/deepseek-v4.1-flash')?.contextWindow).toBe(1048576);
 expect(modelCapabilityPreset('https://api.siliconflow.com/v1','chat','MiniMaxAI/MiniMax-M3')?.contextWindow).toBe(1048576);
 expect(modelCapabilityPreset('https://api.siliconflow.cn/v1','chat','MiniMaxAI/MiniMax-M3')).toBeUndefined();
 expect(modelCapabilityPreset('https://other.example/v1','chat','deepseek/deepseek-v4.1-flash')).toBeUndefined();
});
