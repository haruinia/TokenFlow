import {beforeEach,expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({revision:'revision-1',value:'fixture-one',denied:false}));
const exec=vi.hoisted(()=>vi.fn((_file:string,args:string[],_options:unknown,callback:(error:unknown,result?:string,stderr?:string)=>void)=>{
 queueMicrotask(()=>callback(fixture.denied&&args.includes('-w')?new Error('denied'):null,args.includes('-w')?fixture.value:fixture.revision,''));
}));
Object.defineProperty(exec,Symbol.for('nodejs.util.promisify.custom'),{value:(file:string,args:string[],options:unknown)=>new Promise((resolve,reject)=>exec(file,args,options,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})))});
vi.mock('node:child_process',()=>({execFile:exec,spawn:vi.fn()}));
beforeEach(()=>{exec.mockClear();fixture.revision='revision-1';fixture.value='fixture-one';fixture.denied=false;});
it('shares a single protected read across concurrent status and usage readers and unchanged refreshes',async()=>{
 const {claudeKeychain}=await import('../packages/core/src/claude-accounts.js');const store=claudeKeychain('/fixture');
 expect(await Promise.all(Array.from({length:4},()=>store.read()))).toEqual(Array(4).fill('fixture-one'));
 expect(await store.read()).toBe('fixture-one');
 expect(exec.mock.calls.filter(call=>call[1].includes('-w'))).toHaveLength(1);
 fixture.revision='revision-2';fixture.value='fixture-two';expect(await store.read()).toBe('fixture-two');
 expect(exec.mock.calls.filter(call=>call[1].includes('-w'))).toHaveLength(2);
});
it('preserves OS denial and retries instead of caching an unreadable credential',async()=>{
 const {claudeKeychain}=await import('../packages/core/src/claude-accounts.js');const store=claudeKeychain('/fixture');
 fixture.denied=true;await expect(store.read()).rejects.toThrow('无法读取');
 fixture.denied=false;await expect(store.read()).resolves.toBe('fixture-one');
});
it('forces conflict and write verification reads even when metadata timestamps are unchanged',async()=>{
 const {claudeKeychain}=await import('../packages/core/src/claude-accounts.js');const store=claudeKeychain('/fixture');
 expect(await store.read()).toBe('fixture-one');fixture.value='external-change';
 expect(await store.read({fresh:true})).toBe('external-change');
 expect(exec.mock.calls.filter(call=>call[1].includes('-w'))).toHaveLength(2);
});
