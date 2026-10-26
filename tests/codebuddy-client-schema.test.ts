import {expect,it} from 'vitest';
import {createClientSchemaCompiler} from '../packages/codebuddy-runtime/client-schema.js';
const compile=createClientSchemaCompiler();
it.each([
 {label:'anyOf',schema:{anyOf:[{type:'string'},{type:'integer'}]},valid:['x',1],invalid:[null,[]]},
 {label:'oneOf required-only',schema:{type:'object',oneOf:[{required:['a']},{required:['b']}]},valid:[{a:1},{b:2}],invalid:[{}, {a:1,b:2}]},
 {label:'nullable',schema:{type:['string','null']},valid:['x',null],invalid:[1,{}]},
 {label:'OpenAPI nullable',schema:{type:'string',nullable:true},valid:['x',null],invalid:[1,{}]},
 {label:'uniqueItems',schema:{type:'array',items:{type:'integer'},uniqueItems:true},valid:[[],[1,2]],invalid:[[1,1],['1']]},
 {label:'contains',schema:{type:'array',contains:{type:'integer'},minContains:2},valid:[[1,2]],invalid:[[1,'x']]},
 {label:'additionalProperties',schema:{type:'object',properties:{a:{type:'string'}},additionalProperties:false},valid:[{}, {a:'x'}],invalid:[{a:1},{other:2}]},
 {label:'prefixItems',schema:{type:'array',prefixItems:[{type:'string'}]},valid:[[],['x',2]],invalid:[[1]]},
 {label:'prefixItems items false',schema:{type:'array',prefixItems:[{type:'string'}],items:false},valid:[[],['x']],invalid:[['x',2],[1]]},
] as const)('validates $label without widening or changing arguments',({schema,valid,invalid})=>{
 const validator=compile({type:'object',properties:{value:schema},required:['value']});
 for(const value of valid){const args={value};expect(validator.parse(args)).toBe(args);expect(JSON.stringify(args)).toBe(JSON.stringify({value}));}
 for(const value of invalid)expect(()=>validator.parse({value})).toThrow();
});
it('preserves root refs and definitions for untyped root unions',()=>{
 for(const defs of ['$defs','definitions']){
  const parameters={[defs]:{item:{type:'integer'}},anyOf:[{required:['id']},{required:['name']}],properties:{id:{$ref:`#/${defs}/item`},name:{type:'string'}}};
  const validator=compile(parameters);expect(validator.inputSchema).toEqual({...parameters,type:'object'});expect(validator.parse({id:7})).toEqual({id:7});expect(validator.parse({name:'x'})).toEqual({name:'x'});expect(()=>validator.parse({id:'7'})).toThrow();expect(()=>validator.parse({})).toThrow();
 }
 const root=compile({properties:{source:{type:'integer'},copy:{$ref:'#/properties/source'}},required:['copy']});expect(root.parse({copy:7})).toEqual({copy:7});expect(()=>root.parse({copy:'7'})).toThrow();
});
it.each([undefined,'http://json-schema.org/draft-07/schema#','http://json-schema.org/draft-06/schema#'])('supports legacy tuple semantics with dialect %s',dialect=>{
 const schema={...(dialect?{$schema:dialect}:{}),type:'object',properties:{items:{type:'array',items:[{type:'string'}]}}};const validator=compile(schema);
 for(const items of [[],['x'],['x',7]])expect(validator.parse({items})).toEqual({items});expect(()=>validator.parse({items:[7]})).toThrow();
});
it('supports explicit 2020-12 and keeps defaults, extra fields and value types unchanged',()=>{
 const validator=compile({$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{n:{type:'integer',default:7}}});const args={extra:'fixture'};expect(validator.parse(args)).toBe(args);expect(args).toEqual({extra:'fixture'});expect(()=>validator.parse({n:'7'})).toThrow();
});
it.each([
 {type:'object',properties:{a:{$ref:'https://invalid.example/private-schema'}}},
 {type:'object',properties:{a:{$ref:'#/$defs/missing'}}},
 {$schema:'https://invalid.example/unknown-dialect',type:'object'},
 {type:'object',required:'not-an-array'},
])('fails closed on invalid or unresolved schemas without fetching references',schema=>{expect(()=>compile(schema)).toThrow();});
