/** Real desktop startup check, isolated empty home: no credentials, no sign-out, no inference. */
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,copyFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {codexBridgeLaunch} from '../packages/core/src/codex-bridge-launch.ts';
const exec=promisify(execFile),directory=resolve('sidecars/darwin-arm64/codex-native-agents');
const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
const binary='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const home=await mkdtemp(join(tmpdir(),'tf-startup-config-'));
try{
 const args=['app-server','--print-startup-config','--startup-client-info',JSON.stringify({name:'codex_desktop',title:'Codex Desktop',version:'startup-regression'})];
 const env={PATH:process.env.PATH,HOME:home,CODEX_HOME:home};
 const launch=await codexBridgeLaunch({binary,nativeAgents:{...manifest,binary:join(directory,'codex-app-server')},officialModels:[],gatewayModels:[]},args,home,env);
 const expected=JSON.parse((await exec(binary,args,{env,timeout:20000})).stdout);
 let actual;
 const bridgeIndex=process.argv.indexOf('--bridge');
 if(bridgeIndex>=0){
  await copyFile(resolve(process.argv[bridgeIndex+1]),join(home,'bridge.mjs'));
  await writeFile(join(home,'settings.json'),JSON.stringify({binary,nativeAgents:{...manifest,binary:join(directory,'codex-app-server')},officialModels:[],gatewayModels:[]}));
  actual=JSON.parse((await exec(process.execPath,[join(home,'bridge.mjs'),...args],{env,timeout:20000})).stdout);
 }else actual=JSON.parse((await exec(launch.binary,launch.args,{env:launch.env,timeout:20000})).stdout);
 assert.ok('configRequirements' in expected);assert.deepEqual(actual,expected);assert.equal(launch.protocol,false);assert.equal(launch.binary,binary);
 console.log(JSON.stringify({passed:true,officialStartupResponsePreserved:true,protocolBridgeBypassed:true,credentialUsed:false,bundledBridge:bridgeIndex>=0}));
}finally{await rm(home,{recursive:true,force:true});}
