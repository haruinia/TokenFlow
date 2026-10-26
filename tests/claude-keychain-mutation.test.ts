import {beforeEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
const fixture=vi.hoisted(()=>({value:'fixture-old' as string|null,hold:false,entered:()=>{},release:Promise.resolve(),reads:0,active:0,maxActive:0,failWrite:false}));
const exec=vi.hoisted(()=>vi.fn());
Object.defineProperty(exec,Symbol.for('nodejs.util.promisify.custom'),{value:async(_file:string,args:string[])=>{
 if(args[0]==='delete-generic-password'){fixture.value=null;return {stdout:'',stderr:''};}
 if(fixture.value===null)throw Object.assign(Error('missing'),{code:44});
 const value=fixture.value;if(args.includes('-w')){fixture.reads++;if(fixture.hold){fixture.hold=false;fixture.entered();await fixture.release;}}
 return {stdout:args.includes('-w')?value:'fixture-same-metadata',stderr:''};
}});
vi.mock('node:child_process',()=>({execFile:exec,spawn:vi.fn(()=>{
 const child=new EventEmitter() as EventEmitter&{stderr:PassThrough;stdin:Writable;kill:ReturnType<typeof vi.fn>};
 fixture.active++;fixture.maxActive=Math.max(fixture.maxActive,fixture.active);child.stderr=new PassThrough();child.kill=vi.fn();let command='';
 child.stdin=new Writable({write(chunk,_encoding,done){command+=String(chunk);done();},final(done){
  const match=command.match(/-w "((?:\\.|[^"\\])*)"\n$/);if(!match)throw Error('Unexpected fixture command');const failed=fixture.failWrite;fixture.failWrite=false;if(!failed)fixture.value=JSON.parse(`"${match[1]}"`) as string;done();queueMicrotask(()=>{fixture.active--;child.emit('close',failed?1:0);});
 }});return child;
})}));
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};};
beforeEach(()=>{Object.assign(fixture,{value:'fixture-old',hold:false,entered:()=>{},release:Promise.resolve(),reads:0,active:0,maxActive:0,failWrite:false});});
it('serializes writes, verifies each fresh value, and makes queued readers observe the latest mutation',async()=>{
 const {claudeKeychain}=await import('../packages/core/src/claude-accounts.js');const store=claudeKeychain('/fixture');
 await store.read();await Promise.all([store.write('fixture-first'),store.write('fixture-second')]);expect(await store.read()).toBe('fixture-second');expect(fixture.maxActive).toBe(1);expect(fixture.reads).toBe(3);
});
it('rejects an old protected read completing after a write even when Keychain metadata is unchanged',async()=>{
 const {claudeKeychain}=await import('../packages/core/src/claude-accounts.js');const {CredentialAccessStaleError}=await import('../packages/core/src/revision-credential-access.js');const store=claudeKeychain('/fixture');
 const entered=deferred(),release=deferred();Object.assign(fixture,{hold:true,entered:entered.resolve,release:release.promise});
 const old=store.read(),rejected=expect(old).rejects.toBeInstanceOf(CredentialAccessStaleError);await entered.promise;
 await store.write('fixture-new');release.resolve();await rejected;expect(await store.read()).toBe('fixture-new');
});
it('invalidates cached values after deletion and loads a recreated item with identical metadata',async()=>{
 const {claudeKeychain}=await import('../packages/core/src/claude-accounts.js');const store=claudeKeychain('/fixture');await store.read();await store.write(null);expect(await store.read()).toBeNull();fixture.value='fixture-recreated';expect(await store.read()).toBe('fixture-recreated');
});
it('releases the write queue after a definite failed child exit so the next explicit write can recover',async()=>{
 const {claudeKeychain}=await import('../packages/core/src/claude-accounts.js');const store=claudeKeychain('/fixture');fixture.failWrite=true;
 const first=store.write('fixture-rejected'),rejected=expect(first).rejects.toThrow('无法写入');const next=store.write('fixture-recovered');await rejected;await next;expect(await store.read()).toBe('fixture-recovered');expect(fixture.maxActive).toBe(1);
});
