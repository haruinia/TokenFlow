import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
const state=vi.hoisted(()=>({children:[] as any[],respond:true}));
vi.mock('electron',()=>({app:{getPath:()=>'/fixture',isPackaged:true},safeStorage:{}}));
vi.mock('../apps/desktop/src/qoder-crypto-profile.js',()=>({qoderCryptoProfile:()=>'/fixture-crypto'}));
vi.mock('node:fs',()=>({rmSync:vi.fn()}));
vi.mock('node:child_process',()=>({spawn:vi.fn(()=>{
 const child=new EventEmitter() as any;child.stdout=new PassThrough();child.stdin=new PassThrough();
 child.kill=vi.fn(()=>{child.emit('close',1);});state.children.push(child);
 let input='';child.stdin.on('data',(chunk:Buffer)=>{
  input+=chunk.toString();let newline;
  while((newline=input.indexOf('\n'))>=0){const line=input.slice(0,newline);input=input.slice(newline+1);if(!line)continue;const request=JSON.parse(line);if(state.respond)queueMicrotask(()=>child.stdout.write(`TOKENFLOW_CRYPTO:${JSON.stringify({id:request.id,value:`decoded:${request.value}`})}\n`));}
 });
 // Support the old one-shot protocol so the regression measures process reuse.
 child.stdin.on('finish',()=>{if(input){const request=JSON.parse(input);queueMicrotask(()=>{child.stdout.write(`TOKENFLOW_CRYPTO:${JSON.stringify({value:`decoded:${request.value}`})}\n`);child.emit('close',0);});}});
 return child;
})}));
beforeEach(()=>{vi.resetModules();state.children=[];state.respond=true;});
afterEach(()=>{for(const child of state.children)child.emit('close',0);});
it('reads four credentials in one client crypto session instead of opening four OS storage sessions',async()=>{
 const {qoderCryptoFor}=await import('../apps/desktop/src/qoder-crypto.js');
 const read=qoderCryptoFor('qoder');
 expect(await Promise.all(['one','two','three','four'].map(value=>read('decrypt',value)))).toEqual(['decoded:one','decoded:two','decoded:three','decoded:four']);
 expect(state.children).toHaveLength(1);
});
it('keeps client identities separate and closes all helper processes on shutdown',async()=>{
 const {qoderCryptoFor,closeQoderCrypto}=await import('../apps/desktop/src/qoder-crypto.js');
 const desktop=qoderCryptoFor('qoder'),ide=qoderCryptoFor('qoder-ide');
 await Promise.all([desktop('decrypt','desktop'),ide('decrypt','ide')]);expect(state.children).toHaveLength(2);
 await closeQoderCrypto();expect(state.children.every(child=>child.kill.mock.calls.length===1)).toBe(true);
 await desktop('decrypt','after-restart');expect(state.children).toHaveLength(3);
});
it('rejects a failed helper and opens a new session for an explicit retry',async()=>{
 const {qoderCryptoFor}=await import('../apps/desktop/src/qoder-crypto.js');const read=qoderCryptoFor('qoder');
 await read('decrypt','first');state.children[0].emit('close',1);
 expect(await read('decrypt','retry')).toBe('decoded:retry');expect(state.children).toHaveLength(2);
});

it('rejects all pending reads on helper failure without hanging the request',async()=>{
 const {qoderCryptoFor}=await import('../apps/desktop/src/qoder-crypto.js');state.respond=false;
 const read=qoderCryptoFor('qoder'),pending=Promise.all([read('decrypt','one'),read('decrypt','two')]);
 const rejected=expect(pending).rejects.toThrow('Qoder');state.children[0].emit('close',1);await rejected;
});
