import {beforeEach,expect,it,vi} from 'vitest';
import {cursorVariantProbePlan,probeCursorLocalModel} from '../scripts/probe-cursor-local-model.js';
const sdk=vi.hoisted(()=>({models:vi.fn(),create:vi.fn(),close:vi.fn(),cancel:vi.fn()}));
vi.mock('@cursor/sdk',()=>({Cursor:{models:{list:sdk.models}},Agent:{create:sdk.create},JsonlLocalAgentStore:class{}}));
const catalog={id:'grok-4.7',displayName:'Grok 4.7',parameters:[{id:'context',values:[{value:'256k'},{value:'500k'}]}],variants:[{isDefault:true,displayName:'Default',params:[{id:'context',value:'500k'},{id:'effort',value:'high'},{id:'speed',value:'fast'}]}]};
beforeEach(()=>{vi.clearAllMocks();sdk.models.mockResolvedValue([structuredClone(catalog)]);sdk.cancel.mockResolvedValue(undefined);sdk.create.mockResolvedValue({close:sdk.close,send:async()=>({wait:async()=>({status:'finished',result:'PRIVATE_RESPONSE'}),cancel:sdk.cancel})});});
it('prepares advertised context A/B without changing effort, speed or the catalog',()=>{
 const before=structuredClone(catalog);expect(cursorVariantProbePlan(catalog)).toEqual([{label:'catalog_default',params:catalog.variants[0].params},{label:'advertised_256k',params:[{id:'context',value:'256k'},{id:'effort',value:'high'},{id:'speed',value:'fast'}]}]);expect(catalog).toEqual(before);
});
it('never invents context support or a variant when 256k is not advertised',()=>{
 expect(cursorVariantProbePlan({...catalog,parameters:[]})).toHaveLength(1);
 expect(cursorVariantProbePlan({...catalog,variants:[{...catalog.variants[0],params:[{id:'context',value:'256k'}]}]})).toHaveLength(1);
});
it('defaults to a read-only official catalog request with no inference or credential disclosure',async()=>{
 const result=await probeCursorLocalModel({get:async()=>JSON.stringify({apiKey:'PRIVATE_FIXTURE_KEY'})});
 expect(sdk.models).toHaveBeenCalledWith({apiKey:'PRIVATE_FIXTURE_KEY'});expect(sdk.create).not.toHaveBeenCalled();expect(result.probes).toEqual([]);expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
it('bounds inference to two same-account/same-model probes changing only advertised context',async()=>{
 let turn=0;sdk.create.mockImplementation(async()=>({close:sdk.close,send:async()=>({wait:async()=>++turn===1?{status:'error',error:{code:'model_not_found',message:'PRIVATE_UPSTREAM'}}:{status:'finished',result:'PRIVATE_RESPONSE'},cancel:sdk.cancel})}));
 const result=await probeCursorLocalModel({get:async()=>JSON.stringify({version:1,accounts:[{apiKey:'PRIVATE_FIXTURE_KEY'}]})},{runInference:true});
 expect(result.probes).toMatchObject([{label:'catalog_default',status:'error',error:'model_not_found'},{label:'advertised_256k',status:'finished'}]);expect(sdk.create).toHaveBeenCalledTimes(2);
 for(const [options]of sdk.create.mock.calls){expect(options.apiKey).toBe('PRIVATE_FIXTURE_KEY');expect(options.model.id).toBe('grok-4.7');expect(options).toMatchObject({tools:[],mcpServers:{},agents:{},local:{settingSources:[],customTools:{}}});}
 expect(sdk.close).toHaveBeenCalledTimes(2);expect(JSON.stringify(result)).not.toContain('PRIVATE');
});

it('retains only a safe HTTP status for catalog failures and never starts an inference',async()=>{
 sdk.models.mockRejectedValue({status:401,message:'PRIVATE_TOKEN'});
 const result=await probeCursorLocalModel({get:async()=>JSON.stringify({apiKey:'PRIVATE_KEY'})},{runInference:true});
 expect(result).toMatchObject({available:false,catalogError:'unauthenticated',catalogHttpStatus:401,probes:[]});
 expect(sdk.create).not.toHaveBeenCalled();expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
