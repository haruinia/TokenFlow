export type ClientSchema={inputSchema:Record<string,unknown>;parse<T>(args:T):T};
export function createClientSchemaCompiler():(parameters:Record<string,unknown>)=>ClientSchema;
