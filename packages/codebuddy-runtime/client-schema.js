import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);

function legacyTuple(schema){
 if(!schema||typeof schema!=='object'||Array.isArray(schema))return false;
 if(Array.isArray(schema.items))return true;
 const children=[];
 for(const key of ['properties','patternProperties','$defs','definitions'])if(schema[key]&&typeof schema[key]==='object')children.push(...Object.values(schema[key]));
 for(const key of ['anyOf','oneOf','allOf','prefixItems'])if(Array.isArray(schema[key]))children.push(...schema[key]);
 for(const key of ['items','additionalItems','additionalProperties','contains','if','then','else','not'])if(schema[key]&&typeof schema[key]==='object'&&!Array.isArray(schema[key]))children.push(schema[key]);
 return children.some(legacyTuple);
}

// JSON Schema is authoritative. Zod conversion changes required-only branches,
// tuples, formats and defaults, so it must not validate or rewrite client args.
export function createClientSchemaCompiler(){
 const options={strict:false,allErrors:true,addUsedSchema:false,ownProperties:true,coerceTypes:false,useDefaults:false,removeAdditional:false,validateFormats:true,logger:false};
 const legacy=addFormats(new Ajv(options));legacy.addMetaSchema(require('ajv/dist/refs/json-schema-draft-06.json'));
 const current=addFormats(new Ajv2020(options));
 return parameters=>{
  if(!parameters||typeof parameters!=='object'||Array.isArray(parameters))throw Error('Invalid client tool schema');
  if(parameters.type!==undefined&&parameters.type!=='object'&&!(Array.isArray(parameters.type)&&parameters.type.includes('object')))throw Error('Client tools require object arguments');
  // Add the MCP root object constraint in place: wrapping under allOf would
  // relocate root-relative refs such as #/$defs/item or #/properties/item.
  const inputSchema=parameters.type==='object'?parameters:{...parameters,type:'object'};
  const draft=parameters.$schema;
  // Explicit dialect wins. Unlabelled legacy tuple syntax selects draft7;
  // other unlabelled declarations use 2020-12. Unknown dialects fail closed.
  const validator=(draft?/\/draft-0[67]\/schema#?$/.test(draft)?legacy:current:legacyTuple(parameters)?legacy:current).compile(inputSchema);
  return {inputSchema,parse(args){if(!args||typeof args!=='object'||Array.isArray(args)||!validator(args))throw Error('Invalid client tool arguments');return args;}};
 };
}
