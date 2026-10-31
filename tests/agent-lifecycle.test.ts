import {it,expect,vi} from 'vitest';
import {QoderLifecycle} from '../packages/core/src/agent-lifecycle.js';

const fixtureIdentity=async(path:string)=>{
 const identities:{[key:string]:[string,string]}={
  '/Applications/Qoder.app':['com.qoder.app','Qoder'],
  '/Applications/Qoder IDE.app':['com.qoder.ide','Qoder'],
  '/Applications/ChatGPT.app':['com.openai.codex','ChatGPT'],
  '/Applications/WorkBuddy.app':['com.tencent.workbuddy.mac','Electron'],
  '/Applications/WorkBuddy AI.app':['com.workbuddy.workbuddy-ai','Electron'],
  '/Applications/Visual Studio Code.app':['com.microsoft.VSCode','Electron'],
  '/Applications/DeepSeek Harness.app':['com.deepseek.dsh','DeepSeek Harness'],
 };
 const entry=identities[path];return entry?{bundle:entry[0],executable:entry[1]}:undefined;
};
const qoder='/Applications/Qoder.app/Contents/MacOS/Qoder';
it('waits for standalone Qoder to exit before reopening and confirms launch',async()=>{
  const states=[qoder,qoder,'','',qoder];
  const run=vi.fn(async(file:string)=>({stdout:file==='/bin/ps'?states.shift()??'':''}));
  const lifecycle=new QoderLifecycle(run,'darwin',async()=>{},fixtureIdentity);
  await expect(lifecycle.restart()).resolves.toHaveProperty('message');
  expect(run.mock.calls.map(([file])=>file)).toEqual(['/bin/ps','/usr/bin/osascript','/bin/ps','/bin/ps','/usr/bin/open','/bin/ps','/bin/ps']);
  expect(run).toHaveBeenCalledWith('/usr/bin/open',['/Applications/Qoder.app']);
});
it('opens a stopped app without quitting Qoder IDE',async()=>{
  let opened=false;
  const run=vi.fn(async(file:string)=>{if(file==='/usr/bin/open')opened=true;return {stdout:opened?qoder:'/Applications/Qoder IDE.app/Contents/MacOS/Qoder'};});
  await new QoderLifecycle(run,'darwin',async()=>{},fixtureIdentity).restart();
  expect(run.mock.calls.some(([file])=>file==='/usr/bin/osascript')).toBe(false);
});
it.each(['workbuddy','workbuddy-ai'] as const)('leaves the other WorkBuddy edition running when changing %s',async target=>{
 const selected=target==='workbuddy'?'/Applications/WorkBuddy.app':'/Applications/WorkBuddy AI.app',other=target==='workbuddy'?'/Applications/WorkBuddy AI.app':'/Applications/WorkBuddy.app';let running=true;
 const run=vi.fn(async(file:string)=>{if(file==='/usr/bin/osascript')running=false;if(file==='/usr/bin/open')running=true;return {stdout:file==='/bin/ps'?[other+'/Contents/MacOS/Electron',...(running?[selected+'/Contents/MacOS/Electron']:[])].join('\n'):''};});
 await new QoderLifecycle(run,'darwin',async()=>{},fixtureIdentity).change(target,async()=>{});expect(run).toHaveBeenCalledWith('/usr/bin/osascript',['-e',`tell application "${selected}" to quit`]);expect(run).toHaveBeenCalledWith('/usr/bin/open',[selected]);
});
it('does not force quit or relaunch when normal quit is cancelled',async()=>{
  const run=vi.fn(async(file:string)=>{if(file==='/usr/bin/osascript')throw Error('cancelled');return {stdout:qoder};});
  await expect(new QoderLifecycle(run,'darwin',async()=>{},fixtureIdentity).restart()).rejects.toThrow('未强制结束');
  expect(run.mock.calls.map(([file])=>file)).toEqual(['/bin/ps','/usr/bin/osascript']);
});
it('reports timeout without launching a duplicate process',async()=>{
  const run=vi.fn(async()=>({stdout:qoder}));
  await expect(new QoderLifecycle(run,'darwin',async()=>{},fixtureIdentity).restart()).rejects.toThrow('尚未退出');
  expect(run).not.toHaveBeenCalledWith('/usr/bin/open',expect.anything());
});
it('reports an unconfirmed launch and rejects unsupported systems',async()=>{
  const run=vi.fn(async()=>({stdout:''}));
  await expect(new QoderLifecycle(run,'darwin',async()=>{},fixtureIdentity).restart()).rejects.toThrow('尚未确认');
  run.mockClear();
  await expect(new QoderLifecycle(run,'linux').restart()).rejects.toThrow('当前系统');
  expect(run).not.toHaveBeenCalled();
});
it('rejects duplicate restart requests until the first one finishes',async()=>{
  let release!:()=>void;
  const run=vi.fn(()=>new Promise<{stdout:string}>(resolve=>{release=()=>resolve({stdout:''});}));
  const lifecycle=new QoderLifecycle(run,'darwin',async()=>{},fixtureIdentity);
  const first=lifecycle.restart();
  await expect(lifecycle.restart()).rejects.toThrow('正在重启');
  run.mockRejectedValue(Error('unavailable'));release();
  await expect(first).rejects.toThrow('无法打开');
});

it('retries a transient LaunchServices failure after the old process exits',async()=>{
  let attempts=0,opened=false;
  const run=vi.fn(async(file:string)=>{
    if(file==='/usr/bin/open'){if(++attempts===1)throw Error('old app still terminating');opened=true;}
    return {stdout:opened?qoder:''};
  });
  await new QoderLifecycle(run,'darwin',async()=>{},fixtureIdentity).restart();
  expect(attempts).toBe(2);
});

it.each([
 ['codex','/Applications/ChatGPT.app/Contents/MacOS/ChatGPT','com.openai.codex'],
 ['workbuddy','/Applications/WorkBuddy.app/Contents/MacOS/Electron','com.tencent.workbuddy.mac'],
 ['workbuddy-ai','/Applications/WorkBuddy AI.app/Contents/MacOS/Electron','com.workbuddy.workbuddy-ai'],
 ['claude','/Applications/Visual Studio Code.app/Contents/MacOS/Electron','com.microsoft.VSCode'],
 ['deepseek','/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness','com.deepseek.dsh'],
] as const)('restarts only the selected %s desktop application',async(target,path,bundle)=>{
 let running=true;
 const run=vi.fn(async(file:string)=>{if(file==='/usr/bin/osascript')running=false;if(file==='/usr/bin/open')running=true;return {stdout:file==='/bin/ps'&&running?path:''};});
 await new QoderLifecycle(run,'darwin',async()=>{},fixtureIdentity).restart(target);
 expect(run).toHaveBeenCalledWith('/usr/bin/osascript',['-e',`tell application "${path.split('/Contents/')[0]}" to quit`]);
 expect(run).toHaveBeenCalledWith('/usr/bin/open',[path.split('/Contents/')[0]]);
});

it('does not offer a desktop restart for Claude Code on Windows',async()=>{
 const run=vi.fn(async()=>({stdout:''}));
 await expect(new QoderLifecycle(run,'win32',async()=>{}).restart('claude')).rejects.toThrow('当前系统');
 expect(run).not.toHaveBeenCalled();
});

it('launches API Codex with its own home and Electron data, then clears that environment for an ordinary restart',async()=>{
 let running=true;const path='/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
 const run=vi.fn(async(file:string)=>{if(file==='/usr/bin/osascript')running=false;if(file==='/usr/bin/open')running=true;return {stdout:file==='/bin/ps'&&running?path:''};});
 const lifecycle=new QoderLifecycle(run,'darwin',async()=>{},fixtureIdentity);
 await lifecycle.restart('codex',{CODEX_HOME:'/tmp/API source/home',CODEX_ELECTRON_USER_DATA_PATH:'/tmp/API source/desktop'});
 expect(run).toHaveBeenCalledWith('/usr/bin/open',['--env','CODEX_HOME=/tmp/API source/home','--env','CODEX_ELECTRON_USER_DATA_PATH=/tmp/API source/desktop','/Applications/ChatGPT.app','--args','--user-data-dir=/tmp/API source/desktop']);
 await lifecycle.restart('codex');
 expect(run.mock.calls.filter(([file])=>file==='/usr/bin/open').at(-1)).toEqual(['/usr/bin/open',['/Applications/ChatGPT.app']]);
});

it('matches bundle identity across renamed versions and leaves standalone ChatGPT running',async()=>{
 const legacy='/Users/test/Applications/Codex 2026.app';const chat='/Applications/ChatGPT.app';let running=true;
 const run=vi.fn(async(file:string)=>{
  if(file==='/usr/bin/osascript')running=false;if(file==='/usr/bin/open')running=true;
  return {stdout:file==='/bin/ps'?[`${chat}/Contents/MacOS/ChatGPT`,...(running?[`${legacy}/Contents/MacOS/Electron`]:[])].join('\n'):''};
 });
 const metadata=async(path:string)=>path===legacy?{bundle:'com.openai.codex',executable:'Electron'}:path===chat?{bundle:'com.openai.chat',executable:'ChatGPT'}:undefined;
 await new QoderLifecycle(run,'darwin',async()=>{},metadata).restart('codex');
 expect(run).toHaveBeenCalledWith('/usr/bin/open',[legacy]);
 expect(run).toHaveBeenCalledWith('/usr/bin/osascript',['-e',`tell application "${legacy}" to quit`]);
});

it.each(['Qoder 0.3.4.app','Qoder 0.4.8.app','中文 Qoder.app'])('reopens the same verified %s path and ignores IDE and helper processes',async name=>{
 const path=`/Users/test/Applications/${name}`;let active=true;
 const run=vi.fn(async(file:string)=>{
  if(file==='/usr/bin/osascript')active=false;if(file==='/usr/bin/open')active=true;
  return {stdout:file==='/bin/ps'?['/Applications/Qoder IDE.app/Contents/MacOS/Qoder',`${path}/Contents/Frameworks/Qoder Helper.app/Contents/MacOS/Qoder Helper`,...(active?[`${path}/Contents/MacOS/Qoder`]:[])].join('\n'):''};
 });
 const inspect=async(p:string)=>p===path?{bundle:'com.qoder.app',executable:'Qoder'}:p.includes('IDE')?{bundle:'com.qoder.ide',executable:'Qoder'}:{bundle:'com.qoder.app.helper',executable:'Qoder Helper'};
 await new QoderLifecycle(run,'darwin',async()=>{},inspect).restart('qoder');
 expect(run).toHaveBeenCalledWith('/usr/bin/open',[path]);
});
it('does not quit either version when two distinct Qoder installations are running',async()=>{
 const run=vi.fn(async()=>({stdout:'/Applications/Qoder.app/Contents/MacOS/Qoder\n/Users/me/Qoder.app/Contents/MacOS/Qoder'}));
 await expect(new QoderLifecycle(run,'darwin',async()=>{},async()=>({bundle:'com.qoder.app',executable:'Qoder'})).restart()).rejects.toThrow('多个');
 expect(run.mock.calls).toHaveLength(1);
});
it('changes login only after a normal exit and opens the same installation afterward',async()=>{
 let running=true;const events:string[]=[];
 const run=vi.fn(async(file:string)=>{if(file==='/usr/bin/osascript'){events.push('quit');running=false;}if(file==='/usr/bin/open'){events.push('open');running=true;}return {stdout:file==='/bin/ps'&&running?qoder:''};});
 await new QoderLifecycle(run,'darwin',async()=>{},fixtureIdentity).change('qoder',async()=>{expect(running).toBe(false);events.push('change');});expect(events).toEqual(['quit','change','open']);
});
it('never changes login after a cancelled quit or opens an app after failed mutation',async()=>{
 const work=vi.fn(async()=>{});const cancelled=vi.fn(async(file:string)=>{if(file==='/usr/bin/osascript')throw Error();return {stdout:qoder};});
 await expect(new QoderLifecycle(cancelled,'darwin',async()=>{},fixtureIdentity).change('qoder',work)).rejects.toThrow('未强制');expect(work).not.toHaveBeenCalled();
 const stopped=vi.fn(async()=>({stdout:''}));await expect(new QoderLifecycle(stopped,'darwin',async()=>{},fixtureIdentity).change('qoder',async()=>{throw Error('write failed');})).rejects.toThrow('write failed');expect(stopped).not.toHaveBeenCalledWith('/usr/bin/open',expect.anything());
});

it('switches only the IDE and leaves standalone Qoder running on macOS',async()=>{
 const path='/Applications/Qoder IDE.app';let running=true;const work=vi.fn(async()=>{expect(running).toBe(false);});
 const run=vi.fn(async(file:string)=>{if(file==='/usr/bin/osascript')running=false;if(file==='/usr/bin/open')running=true;return {stdout:file==='/bin/ps'?[qoder,...(running?[path+'/Contents/MacOS/Qoder']:[])].join('\n'):''};});
 await new QoderLifecycle(run,'darwin',async()=>{},fixtureIdentity).change('qoder-ide',work);expect(work).toHaveBeenCalledOnce();expect(run).toHaveBeenCalledWith('/usr/bin/osascript',['-e',`tell application "${path}" to quit`]);expect(run).toHaveBeenCalledWith('/usr/bin/open',[path]);
});

it('does not close a macOS IDE using a custom user-data directory',async()=>{
 const path='/Applications/Qoder IDE.app/Contents/MacOS/Qoder',work=vi.fn(async()=>{});
 const run=vi.fn(async(_file:string,args:string[])=>({stdout:args.includes('pid=,comm=')?'123 '+path:args.includes('args=')?path+' --user-data-dir=/private/profile':path}));
 await expect(new QoderLifecycle(run,'darwin',async()=>{},fixtureIdentity).change('qoder-ide',work)).rejects.toThrow('自定义配置');expect(work).not.toHaveBeenCalled();expect(run.mock.calls.some(([file])=>file==='/usr/bin/osascript')).toBe(false);
});
it('waits for Qoder IDE renderers to exit before applying login and ignores an orphan crash reporter',async()=>{
 const path='/Applications/Qoder IDE.app';let main=true,renderer=true,polls=0;const work=vi.fn(async()=>{expect(renderer).toBe(false);});
 const run=vi.fn(async(file:string,args:string[])=>{
  if(file==='/usr/bin/osascript')main=false;
  if(file==='/usr/bin/open')main=true;
  if(file!=='/bin/ps')return {stdout:''};
  if(args.includes('comm=')&&!main&&++polls>2)renderer=false;
  return {stdout:[...(main?[`${path}/Contents/MacOS/Qoder`]:[]),...(renderer?[`${path}/Contents/Frameworks/Qoder Helper (Renderer).app/Contents/MacOS/Qoder Helper (Renderer)`]:[]),`${path}/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler`].join('\n')};
 });
 await new QoderLifecycle(run,'darwin',async()=>{},fixtureIdentity).change('qoder-ide',work);
 expect(work).toHaveBeenCalledOnce();expect(run).toHaveBeenCalledWith('/usr/bin/open',[path]);expect(run.mock.calls.some(([,args])=>args.some(a=>a.includes('TokenFlow')))).toBe(false);
});
