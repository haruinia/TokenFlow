import {expect,it,vi} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const fixture=vi.hoisted(()=>({query:vi.fn()}));
vi.mock('../packages/codebuddy-runtime/node_modules/@tencent-ai/agent-sdk/lib/index.js',async()=>{
 const actual=await vi.importActual<Record<string,unknown>>('../packages/codebuddy-runtime/node_modules/@tencent-ai/agent-sdk/lib/index.js');return {...actual,query:fixture.query};
});
import {runOfficialSDK} from '../packages/codebuddy-runtime/index.js';
it('broadcasts the same original schema that real MCP calls and streamed proposals validate',async()=>{
 const parameters={type:'object',properties:{selection:{type:'object',properties:{id:{type:'string'},name:{type:'string'}},oneOf:[{required:['id']},{required:['name']}]}},required:['selection'],additionalProperties:false};
 const args={selection:{id:'synthetic'}};let sawDeclaration=false;
 fixture.query.mockImplementation(({options}:any)=>(async function*(){
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();const client=new Client({name:'synthetic-client',version:'1.0.0'});
  try{
   await Promise.all([options.mcpServers.token_flow.instance.connect(serverTransport),client.connect(clientTransport)]);
   const listed=await client.listTools();expect(listed.tools[0]!.inputSchema).toEqual(parameters);sawDeclaration=true;
   const accepted=await client.callTool({name:'client_0',arguments:args});expect(accepted.isError).not.toBe(true);expect(JSON.stringify(accepted)).toContain('has not executed');
   const rejected=await client.callTool({name:'client_0',arguments:{selection:{id:'synthetic',name:'synthetic'}}});expect(rejected.isError).toBe(true);
   yield {type:'stream_event',event:{type:'message_start',message:{model:'test'}}};
   yield {type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'tool_use',name:'mcp__token_flow__client_0',input:args}}};
   yield {type:'stream_event',event:{type:'content_block_stop',index:0}};
   yield {type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'tool_use'}}};
   yield {type:'stream_event',event:{type:'message_stop'}};
  }finally{await client.close();}
 })());
 const result=await runOfficialSDK({token:'synthetic',region:'china',model:'test',prompt:'Use the synthetic tool',tools:[{name:'synthetic_tool',parameters}],signal:new AbortController().signal,cwd:'/tmp',configDir:'/tmp'});
 expect(sawDeclaration).toBe(true);expect(result.calls).toEqual([{name:'synthetic_tool',arguments:JSON.stringify(args),custom:undefined}]);expect(result.failed).toBe(false);
});
