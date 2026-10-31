import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({failed:false,onlyHelpers:false,windowsCodex:false,embeddedClaude:false,calls:[] as string[][]}));
vi.mock('node:child_process',()=>{
 const execFile=Object.assign(()=>{}, {[Symbol.for('nodejs.util.promisify.custom')]:async(_file:string,args:string[])=>{
  fixture.calls.push(args);
  if(fixture.failed)throw Error('private-command-secret');
  if(fixture.embeddedClaude&&_file==='tasklist')return {stdout:'"claude.exe","100"\n"claude.exe","101"\n"claude.exe","102"\n"claude.exe","103"\n'};
  if(fixture.embeddedClaude&&_file==='powershell.exe')return {stdout:Buffer.from(args.at(-1)!,'base64').toString('utf16le').includes('ExecutablePath')?JSON.stringify([
   {ProcessId:100,ExecutablePath:'C:\\Users\\test\\.vscode\\extensions\\anthropic.claude-code-2.1.312-win32-x64\\resources\\native-binary\\claude.exe'},
   {ProcessId:101,ExecutablePath:'C:\\Users\\test\\AppData\\Roaming\\Claude\\claude-code\\2.1.309\\claude.exe'},
   {ProcessId:102,ExecutablePath:'C:\\Users\\test\\.npm-global\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'},
   {ProcessId:103,ExecutablePath:null},
  ]):'[]'};
  if(fixture.embeddedClaude&&_file==='ps'&&args.includes('pid=,comm='))return {stdout:'100 /Users/test/.qoder/extensions/anthropic.claude-code-2.1.312-darwin-arm64/resources/native-binary/claude\n101 /Users/test/Library/Application Support/Claude-3p/claude-code/2.1.309/hash/claude.app/Contents/MacOS/claude\n102 /Users/test/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe\n103 /Users/test/.local/share/claude/versions/2.1.311\n'};
  if(fixture.onlyHelpers)return {stdout:'900 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/browser_crashpad_handler\n901 /Users/test/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService\n'};
  if(_file==='tasklist')return {stdout:fixture.windowsCodex?'"Codex.exe","1001"\n"CodexCLI.exe","1002"\n"ChatGPT.exe","1003"\n"node.exe","555"':'"Pi Agent Desktop.exe","999"\n"node.exe","555"'};
  if(_file==='powershell.exe')return {stdout:JSON.stringify([{ProcessId:555,CommandLine:'"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\test\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" --api-key private-command-secret'},{ProcessId:777,CommandLine:'node unrelated.js --prompt pi'}])};
  return {stdout:args.includes('pid=,comm=')?'123 node\n456 node\n678 node\n789 pi\n880 /Applications/Claude.app/Contents/MacOS/Claude\n881 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper\n882 /Users/test/.local/bin/claude\n883 /Users/test/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe\n884 /Users/test/.local/share/claude/versions/2.1.121\n222 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n223 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex\n224 /Applications/Codex.app/Contents/MacOS/Codex\n225 /usr/local/bin/codex\n900 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/browser_crashpad_handler\n901 /Users/test/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService\n902 /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex-code-mode-host\n903 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)\n999 /Applications/Pi Agent Desktop.app/Contents/MacOS/Pi Agent Desktop\n':'123 node /fixture/bin/dsh --api-key private-command-secret\n456 node /fixture/unrelated.js --prompt dsh\n678 node /fixture/@earendil-works/pi-coding-agent/dist/bundle/cli.js --api-key private-command-secret\n'};
 }});return {execFile};
});
import {agentProcesses} from '../packages/core/src/agent-connections';
beforeEach(()=>{fixture.failed=false;fixture.onlyHelpers=false;fixture.windowsCodex=false;fixture.embeddedClaude=false;fixture.calls=[];});
const platformDescriptor=Object.getOwnPropertyDescriptor(process,'platform')!;
afterEach(()=>{Object.defineProperty(process,'platform',platformDescriptor);vi.restoreAllMocks();});
it('identifies a DeepSeek Node launcher without treating prompt arguments as program names or exposing them',async()=>{
 expect(await agentProcesses('deepseek')).toEqual([123]);expect(await agentProcesses('pi')).toEqual([789,678]);
 expect(fixture.calls).toContainEqual(['-p','123,456,678','-o','pid=,args=']);
});
it('keeps process-query failures opaque and refuses an unsafe write',async()=>{
 fixture.failed=true;await expect(agentProcesses('deepseek')).rejects.toThrow('无法检查 Agent 进程');
});

it('finds official Pi Node launcher on Windows and excludes community desktop and prompt mentions',async()=>{
 Object.defineProperty(process,'platform',{value:'win32',configurable:true});
 expect(await agentProcesses('pi')).toEqual([555]);
 expect(fixture.calls[1]).toContain('-EncodedCommand');
});

it('reports Windows Codex runtime PIDs without requiring a desktop ASAR so migration can exclude its own child',async()=>{
 Object.defineProperty(process,'platform',{value:'win32',configurable:true});fixture.windowsCodex=true;
 const pids=await agentProcesses('codex');expect(pids).toEqual([1001,1002,1003]);
 expect(pids.filter(pid=>pid!==1001)).toEqual([1002,1003]);
 expect(fixture.calls).toEqual([['/FO','CSV','/NH']]);
});

it('blocks on real Codex clients but ignores crash reporters and helpers that survive desktop exit',async()=>{expect(await agentProcesses('codex')).toEqual([222,223,224,225]);});

it('allows migration once the Mac desktop exits even while its crash reporter remains',async()=>{fixture.onlyHelpers=true;expect(await agentProcesses('codex')).toEqual([]);});

it('does not block Claude Code installation on the Claude desktop chat app',async()=>{expect(await agentProcesses('claude')).toEqual([882,883,884]);});

it('ignores independently bundled Claude runtimes only for CLI installation, retaining shared configuration guards',async()=>{
 fixture.embeddedClaude=true;
 expect(await agentProcesses('claude')).toEqual([100,101,102,103]);
 expect(await agentProcesses('claude',{scope:'installation'})).toEqual([102,103]);
});
it('checks Windows executable paths for installation and retains unknown Claude processes as blockers',async()=>{
 Object.defineProperty(process,'platform',{value:'win32',configurable:true});fixture.embeddedClaude=true;
 expect(await agentProcesses('claude')).toEqual([100,101,102,103]);
 expect(await agentProcesses('claude',{scope:'installation'})).toEqual([102,103]);
});
