import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isAbsolute} from 'node:path';
const exec=promisify(execFile);
/** Executable paths only, never command-line arguments which can contain credentials. */
export async function cleanupRunningExecutables(platform=process.platform):Promise<string[]>{
 if(platform==='win32'){
  const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-Process | Select-Object -ExpandProperty Path -ErrorAction SilentlyContinue'],{timeout:5000,maxBuffer:2*1024*1024,windowsHide:true});
  return stdout.split(/\r?\n/).map(p=>p.trim()).filter(p=>/^[A-Za-z]:\\/.test(p));
 }
 if(platform==='darwin'){
  const {stdout}=await exec('/bin/ps',['-axo','comm='],{timeout:5000,maxBuffer:2*1024*1024});
  return stdout.split('\n').map(p=>p.trim()).filter(isAbsolute);
 }
 // ps comm on Linux contains names, not reliable full executable paths.
 const {readdir,readlink}=await import('node:fs/promises');
 const pids=(await readdir('/proc')).filter(p=>/^\d+$/.test(p));
 const result:string[]=[];for(let i=0;i<pids.length;i+=64){for(const path of await Promise.all(pids.slice(i,i+64).map(pid=>readlink(`/proc/${pid}/exe`).catch(()=>''))))if(isAbsolute(path))result.push(path.replace(/ \(deleted\)$/,''));}
 return result;
}
