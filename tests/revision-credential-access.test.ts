import {expect,it,vi} from 'vitest';
import {CredentialAccessStaleError,RevisionCredentialAccess} from '../packages/core/src/revision-credential-access.js';
const deferred=<T>()=>{let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const source=(revision='one')=>async()=>({revision,input:revision});
it('shares pending, successful and failed reads while retry only retries a settled failure',async()=>{
 const access=new RevisionCredentialAccess<string>(),pending=deferred<string>(),load=vi.fn(()=>pending.promise);
 const reads=[access.read(source(),load),access.read(source(),load,{mode:'retry'})];await Promise.resolve();expect(load).not.toHaveBeenCalled();await Promise.resolve();expect(load).toHaveBeenCalledOnce();pending.resolve('value');expect(await Promise.all(reads)).toEqual(['value','value']);
 await access.read(source(),load,{mode:'retry'});expect(load).toHaveBeenCalledOnce();
 access.invalidate();const denied=vi.fn(()=>{throw Error('fixture denied');});await expect(access.read(source(),denied)).rejects.toThrow('denied');await expect(access.read(source(),denied)).rejects.toThrow('denied');expect(denied).toHaveBeenCalledOnce();
 await expect(access.read(source(),denied,{mode:'retry'})).rejects.toThrow('denied');expect(denied).toHaveBeenCalledTimes(2);
});
it('does not publish a late protected load after a mutation, deletion, or newer revision',async()=>{
 for(const mutation of ['seed','invalidate','revision'] as const){
  const access=new RevisionCredentialAccess<string>(),pending=deferred<string>();const old=access.read(source(),()=>pending.promise);const rejected=expect(old).rejects.toBeInstanceOf(CredentialAccessStaleError);await Promise.resolve();await Promise.resolve();
  if(mutation==='seed')access.seed('two','new');else if(mutation==='invalidate')access.invalidate();else await access.read(source('two'),()=> 'new');
  pending.resolve('old');await rejected;
  expect(await access.read(source('two'),()=> 'new')).toBe('new');
 }
});
it('rejects an old delayed source that resolves after seed, without loading the old ciphertext',async()=>{
 const access=new RevisionCredentialAccess<string>(),pending=deferred<{revision:string;input:string}>(),load=vi.fn((value:string)=>value);
 const old=access.read(()=>pending.promise,load),rejected=expect(old).rejects.toBeInstanceOf(CredentialAccessStaleError);access.seed('new','new');pending.resolve({revision:'old',input:'old'});await rejected;expect(load).not.toHaveBeenCalled();expect(await access.read(source('new'),load)).toBe('new');
});
it('does not let an older source roll back a newer observed revision',async()=>{
 const access=new RevisionCredentialAccess<string>(),pending=deferred<{revision:string;input:string}>();const old=access.read(()=>pending.promise,value=>value),rejected=expect(old).rejects.toBeInstanceOf(CredentialAccessStaleError);
 await access.read(source('new'),()=> 'new');pending.resolve({revision:'old',input:'old'});await rejected;expect(await access.read(source('new'),()=> 'wrong')).toBe('new');
});
it('fresh ignores successful cache and invalidates an older in-flight read',async()=>{
 const access=new RevisionCredentialAccess<string>();access.seed('one','old');expect(await access.read(source(),()=> 'fresh',{mode:'fresh'})).toBe('fresh');
 const pending=deferred<string>(),old=access.read(source(),()=>pending.promise,{mode:'fresh'}),rejected=expect(old).rejects.toBeInstanceOf(CredentialAccessStaleError);await Promise.resolve();await Promise.resolve();
 expect(await access.read(source(),()=> 'new',{mode:'fresh'})).toBe('new');pending.resolve('old');await rejected;
});
it('does not start a protected load that became obsolete while queued in a microtask',async()=>{
 const access=new RevisionCredentialAccess<string>(),load=vi.fn(()=> 'old'),accepted=vi.fn();const old=access.read(source(),load,{onSuccess:accepted}),rejected=expect(old).rejects.toBeInstanceOf(CredentialAccessStaleError);
 await Promise.resolve();access.seed('two','new');await rejected;expect(load).not.toHaveBeenCalled();expect(accepted).not.toHaveBeenCalled();
});
it('keeps credential scopes independent even when their revision strings are identical',async()=>{
 const first=new RevisionCredentialAccess<string>(),second=new RevisionCredentialAccess<string>();await expect(first.read(source(),()=>{throw Error('fixture denied');})).rejects.toThrow('denied');expect(await second.read(source(),()=> 'independent')).toBe('independent');
});
