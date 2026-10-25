import {join} from 'node:path';
import type {CodexBridgeRouting} from './codex-provider-bridge.js';
import {verifyNativeAgentRuntime,type NativeAgentRuntime} from './codex-native-agents.js';

export type CodexBridgeSettings=CodexBridgeRouting&{binary:string;nativeAgents?:NativeAgentRuntime};
export async function codexBridgeLaunch(settings:CodexBridgeSettings,args:string[],directory:string,environment:NodeJS.ProcessEnv=process.env){
 const index=args.indexOf('app-server');
 // Desktop policy discovery is a one-shot CLI command, not an app-server stream.
 // Keep its validation and sign-out recovery on the official executable.
 const oneShot=args.some(a=>['--print-startup-config','--startup-sign-out','--help','-h','--version','-V'].includes(a));
 const protocol=index>=0&&!oneShot&&!['daemon','proxy','generate-ts','generate-json-schema','help'].includes(args[index+1])&&!args.some(a=>a.startsWith('ws://')||a.startsWith('unix://'));
 const env:NodeJS.ProcessEnv={...environment,CODEX_APP_RUNTIME_CLI_PATH:settings.binary};delete env.CODEX_CLI_PATH;delete env.TOKENFLOW_CODEX_AGENT_ROUTES_FILE;
 if(!protocol||!settings.nativeAgents)return {binary:settings.binary,args,env,protocol};
 await verifyNativeAgentRuntime(settings.nativeAgents,settings.binary);
 env.TOKENFLOW_CODEX_AGENT_ROUTES_FILE=join(directory,'settings.json');
 return {binary:settings.nativeAgents.binary,args:[...args.slice(0,index),...args.slice(index+1),'-c','features.multi_agent=true','-c','features.multi_agent_v2.enabled=true','-c','features.multi_agent_v2.non_code_mode_only=true','-c','features.multi_agent_v2.tool_namespace="collaboration"'],env,protocol,nativeAgentsRevision:settings.nativeAgents.revision};
}
