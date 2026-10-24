import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runtimeLaunch,codexRuntimeClient} from '../packages/core/src/codex-runtime';

it.runIf(process.platform!=='win32')('classifies RPC failures by method/code without exposing raw paths or history',async()=>{
 const home=await mkdtemp(join(tmpdir(),'codex-rpc-failure-'));
 const binary=join(home,'fixture-runtime');
 await writeFile(binary,`#!/usr/bin/env node
const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;process.stdout.write(JSON.stringify({id:m.id,...(m.method==='initialize'?{result:{}}:{error:{code:-32600,message:'turn not found: PRIVATE_THREAD /private/user/history PRIVATE_PROMPT'}})})+'\\n');});`,{mode:0o700});
 let client:Awaited<ReturnType<typeof codexRuntimeClient>>|undefined;
 try{client=await codexRuntimeClient(home,binary);await expect(client.rpc('thread/fork',{})).rejects.toMatchObject({code:'codex_migration_failed',rpcMethod:'thread/fork',rpcCode:-32600,rpcReason:'turn_not_found',hint:expect.stringContaining('thread/fork')});
 try{await client.rpc('thread/resume',{});}catch(error){expect(String(error)+JSON.stringify(error)).not.toMatch(/PRIVATE_|private\/user/);}
 }finally{await client?.close();await rm(home,{recursive:true,force:true});}
});

it('starts the native npm Codex executable on Windows instead of leaving a Node wrapper process',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'codex-shim-'));
 try{
  await mkdir(join(dir,'node_modules/@openai/codex/bin'),{recursive:true});await writeFile(join(dir,'node_modules/@openai/codex/bin/codex.js'),'');
  const vendor=join(dir,'node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin');
  await mkdir(vendor,{recursive:true});const native=join(vendor,'codex.exe');await writeFile(native,'fixture');
  expect(await runtimeLaunch(join(dir,'codex.cmd'),'win32','x64')).toEqual({file:native,args:[],env:{}});
  await expect(runtimeLaunch(join(dir,'other','codex.cmd'),'win32')).rejects.toThrow('codex.cmd');
  expect(await runtimeLaunch('C:\\Codex\\codex.exe','win32')).toEqual({file:'C:\\Codex\\codex.exe',args:[],env:{}});
  expect(await runtimeLaunch('/usr/local/bin/codex','darwin')).toEqual({file:'/usr/local/bin/codex',args:[],env:{}});
 }finally{await rm(dir,{recursive:true,force:true});}
});

it.each([
 ['x64','node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin'],
 ['arm64','node_modules/@openai/codex/node_modules/@openai/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/bin'],
 ['x64','node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/codex'],
])('resolves the official %s npm layout %s without a shell',async(arch,vendor)=>{
 const dir=await mkdtemp(join(tmpdir(),'Codex 中文 & runtime-'));
 try{
  const path=join(dir,vendor);await mkdir(path,{recursive:true});const native=join(path,'codex.exe');await writeFile(native,'fixture');
  expect(await runtimeLaunch(join(dir,'codex.cmd'),'win32',arch as NodeJS.Architecture)).toEqual({file:native,args:[],env:{}});
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('rejects an incomplete Windows npm install rather than starting its orphan-prone Node launcher',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'codex-incomplete-'));
 try{
  const bin=join(dir,'node_modules/@openai/codex/bin');await mkdir(bin,{recursive:true});await writeFile(join(bin,'codex.js'),'');
  await expect(runtimeLaunch(join(dir,'codex.cmd'),'win32')).rejects.toThrow('原生');
 }finally{await rm(dir,{recursive:true,force:true});}
});
