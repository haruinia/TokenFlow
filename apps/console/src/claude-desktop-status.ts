import {useCallback,useEffect,useRef,useState} from 'react';
import {requestJSON} from './request';

export type ClaudeDesktopStatus={revision:string;connected:boolean;mode:string;apiDirect?:{sourceId:string;name:string;model:string;configured:boolean}|null;configurationChanged?:boolean;mappingUpdateRequired?:boolean;backup:{state:string}|null;selections:{model:string;sourceId:string}[];fastModel?:string;unavailableReason:string;pids:number[];automaticRestart:boolean;installation:{installed:boolean;version?:string;download?:string};message?:string};

export function useClaudeDesktopStatus(enabled:boolean){
 const [status,setStatus]=useState<ClaudeDesktopStatus>();
 const [error,setError]=useState('');
 const revision=useRef(0);
 const refresh=useCallback(async()=>{
  const current=++revision.current;
  try{
   const state=await requestJSON<ClaudeDesktopStatus>('/api/claude-desktop');
   if(current===revision.current){setStatus(state);setError('');}
   return state;
  }catch(error){
   if(current===revision.current)setError(error instanceof Error?error.message:'无法读取 Claude Desktop 配置');
   throw error;
  }
 },[]);
 useEffect(()=>{
  if(!enabled)return;
  void refresh().catch(()=>{});
  const timer=setInterval(()=>void refresh().catch(()=>{}),5000);
  return()=>{clearInterval(timer);revision.current++;};
 },[enabled,refresh]);
 return {status,error,refresh};
}
