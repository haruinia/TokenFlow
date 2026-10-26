export type CredentialReadMode='cached'|'retry'|'fresh';
export class CredentialAccessStaleError extends Error {
 readonly statusCode=409;
 constructor(){super('凭据在读取期间已变化，请刷新后重试。');}
}
type Entry<T>={revision:string;state:'pending'|'success'|'failed';promise:Promise<T>};
/** One credential scope, one revision, memory only. Source acquisition is inside
 * the mutation epoch so an old asynchronous file read cannot resurrect a value.
 * retry retries failures only; fresh starts an independent CAS read. Callers
 * serialize mutations, while unrelated credential scopes remain independent. */
export class RevisionCredentialAccess<T> {
 private epoch=0;
 private sequence=0;
 private observed=0;
 private entry?:Entry<T>;
 invalidate(options?:{retainSuccess?:boolean}){this.epoch++;if(!options?.retainSuccess||this.entry?.state!=='success')this.entry=undefined;this.observed=++this.sequence;}
 seed(revision:string,value:T){this.invalidate();this.entry={revision,state:'success',promise:Promise.resolve(value)};}
 async read<Input>(source:()=>Promise<{revision:string;input:Input}>,load:(input:Input)=>T|Promise<T>,options:{mode?:CredentialReadMode;onSuccess?:(value:T)=>void}={}):Promise<T>{
  const access=this,mode=options.mode??'cached';if(mode==='fresh')this.invalidate();
  const epoch=this.epoch,sequence=++this.sequence;
  let snapshot:Awaited<ReturnType<typeof source>>;
  try{snapshot=await source();}catch(error){if(epoch!==this.epoch||sequence<this.observed)throw new CredentialAccessStaleError();throw error;}
  const {revision,input}=snapshot;
  if(epoch!==this.epoch||sequence<this.observed&&this.entry?.revision!==revision)throw new CredentialAccessStaleError();
  this.observed=Math.max(this.observed,sequence);
  if(this.entry?.revision===revision&&!(mode==='retry'&&this.entry.state==='failed')){
   return finish(this.entry);
  }
  const entry:Entry<T>={revision,state:'pending',promise:undefined!};
  this.entry=entry;
  const current=()=>epoch===this.epoch&&this.entry===entry;
  entry.promise=Promise.resolve().then(()=>{if(!current())throw new CredentialAccessStaleError();return load(input);}).then(value=>{
   if(!current())throw new CredentialAccessStaleError();entry.state='success';return value;
  },error=>{
   if(!current())throw new CredentialAccessStaleError();entry.state='failed';throw error;
  });
  return finish(entry);
  async function finish(entry:Entry<T>){
   try{const value=await entry.promise;if(!currentEntry(entry))throw new CredentialAccessStaleError();options.onSuccess?.(value);return value;}
   catch(error){if(!currentEntry(entry))throw new CredentialAccessStaleError();throw error;}
  }
  function currentEntry(entry:Entry<T>){return epoch===access.epoch&&access.entry===entry;}
 }
}
