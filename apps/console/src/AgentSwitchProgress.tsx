import {useEffect,useState} from 'react';
import {Thinking} from './LoadingState';
import {requestJSON} from './request';
import type {MigrationStatus} from '../../../packages/core/src/codex-thread-migration';

export function switchStage(progress?:MigrationStatus,fallback='正在准备切换'){
 if(progress?.lifecyclePhase==='stopping')return '正在退出 Codex';
 if(progress?.lifecyclePhase==='opening')return '正在重新打开 Codex';
 if(progress?.phase==='migrating'||progress?.phase==='restoring')return `${progress.phase==='restoring'?'正在恢复':'正在迁移'}对话来源`;
 return progress?.operation?.label??fallback;
}
export function useSwitchProgress(active:boolean){
 const [progress,setProgress]=useState<MigrationStatus>();
 useEffect(()=>{if(!active){setProgress(undefined);return;}let live=true;
  const read=()=>void requestJSON<MigrationStatus>('/api/a2a/codex-migration').then(p=>{if(live)setProgress(p);}).catch(()=>{});
  read();const timer=setInterval(read,1000);return()=>{live=false;clearInterval(timer);};
 },[active]);return progress;
}
export function AgentSwitchProgress({progress,label}:{progress?:MigrationStatus;label?:string}){
 const [started]=useState(Date.now),[now,setNow]=useState(Date.now);
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const lifecycle=progress?.lifecyclePhase,route=progress?.phase==='migrating'||progress?.phase==='restoring';
 const total=lifecycle==='stopping'||lifecycle==='opening'?0:route?progress?.total:progress?.operation?.total;
 const done=route?progress?.done:progress?.operation?.done;
 const stage=label??switchStage(progress),seconds=Math.floor((now-started)/1000);
 return <div className="tfMigrationProgress" aria-busy="true">
  <Thinking label={stage}/><p className="tfMigrationStage" role="status">{stage}</p>
  {!!total&&<progress max={total} value={done??0} aria-label="切换进度"/>}
  <small className="tfHint">{!!total?`${done??0} / ${total} · `:''}已用 {seconds} 秒</small>
 </div>;
}
