import {expect,it} from 'vitest';
import {readModelCapabilities} from '../packages/core/src/model-capabilities.js';
import {codexModelCatalog} from '../packages/core/src/codex-model-catalog.js';
import {qoderSelectedCapabilities,qoderRuntimeRequest} from '../packages/core/src/qoder-model-capabilities.js';
const native={context_length:131072,inputTokenLimit:1000000,qoder_runtime:{default_context:200000,context_windows:[200000,400000,1000000]},thinking:{levels:['none','low','high','max']},default_reasoning_level:'high'};
it.each([undefined,200000,400000,1000000])('keeps selected context %s identical in catalog, compaction and request',selected=>{
 const cap=qoderSelectedCapabilities('qoder/dfmodel',readModelCapabilities(native),selected)!;
 const size=selected??200000;
 expect(cap.contextWindow).toBe(size);expect(cap.maxInputTokens).toBe(1000000);
 const model=codexModelCatalog('qoder/dfmodel',{}, {},{}, {'qoder/dfmodel':cap}).models[0];
 expect(model.auto_compact_token_limit).toBe(size*.9);
 if(size>=272000)expect(model.context_window).toBe(size);
 expect(model.default_reasoning_level).toBe('high');expect(model.supported_reasoning_levels.map(v=>v.effort)).toEqual(['none','low','high','max']);
 const body={model:'qoder/dfmodel',input:'OK',reasoning:{effort:'low'}};
 expect(qoderRuntimeRequest(body,cap)).toEqual({...body,context_length:size});expect(body).not.toHaveProperty('context_length');
});
it('does not grant another model these options or invent options when discovery is absent',()=>{
 expect(()=>qoderSelectedCapabilities('qoder/other',{},1000000)).toThrow();
 expect(()=>qoderSelectedCapabilities('codex/gpt',readModelCapabilities(native),1000000)).toThrow();
 expect(()=>qoderSelectedCapabilities('qoder/dfmodel',readModelCapabilities(native),131072)).toThrow();
 const official={model:'gpt',input:'OK'};expect(qoderRuntimeRequest(official,readModelCapabilities(native))).toBe(official);
 const unknown={model:'qoder/unknown',input:'OK'};expect(qoderRuntimeRequest(unknown,{})).toBe(unknown);
});
