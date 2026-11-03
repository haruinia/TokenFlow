import {expect,it} from 'vitest';
import {cursorModelCapabilities} from '../packages/core/src/cursor-model-capabilities.js';
import {codexModelCatalog} from '../packages/core/src/codex-model-catalog.js';
import type {SDKModel} from '@cursor/sdk';

it.each(['effort','reasoning_effort'])('uses SDK %s options and the default variant for the Codex catalog',id=>{
 const model={id:'fixture',displayName:'Fixture',parameters:[{id,values:[{value:'low'},{value:'high'},{value:'unrecognized'}]}],variants:[{isDefault:true,displayName:'Default',params:[{id,value:'high'}]}]} as SDKModel;
 const capability=cursorModelCapabilities(model);
 expect(capability).toEqual({reasoning:{levels:['low','high'],default:'high'}});
 const catalog=codexModelCatalog('cursor/fixture',{}, {},{}, {'cursor/fixture':capability});
 expect(catalog.models[0]).toMatchObject({supported_reasoning_levels:[{effort:'low'},{effort:'high'}],default_reasoning_level:'high'});
});
it('does not derive effort choices from model names, variants alone or unrelated parameters',()=>{
 for(const extra of [{},{parameters:[{id:'fast',values:[{value:'high'}]}]},{variants:[{isDefault:true,params:[{id:'effort',value:'high'}]}]}]){
  expect(cursorModelCapabilities({id:'claude-thinking',displayName:'Thinking',...extra} as SDKModel)).toEqual({});
 }
});
