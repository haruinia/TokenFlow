import { useRef, useState } from 'react';
import type { SupplierImportPreview } from '../../../packages/core/src/supplier-import';
import { FlowDialog } from './FlowDialog';
import { requestJSON } from './request';
import type { Notify } from './notify';

const post=(body:unknown)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
export function SupplierImport({onChange,notify,disabled}:{onChange:()=>Promise<void>;notify:Notify;disabled:boolean}){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState<SupplierImportPreview>(),[selected,setSelected]=useState<string[]>([]);
 const file=useRef<HTMLInputElement>(null);
 const close=()=>{if(busy)return;if(preview)void requestJSON(`/api/sources/import/${preview.token}`,{method:'DELETE'}).catch(()=>{});setOpen(false);setPreview(undefined);setSelected([]);setError('');};
 const read=async(local:boolean,input?:File)=>{
  setBusy(true);setError('');try{
   let body:unknown={local:true};
   if(!local){if(!input)return;if(input.size>16*1024*1024)throw new Error('文件超过 16 MB，请导出需要的供应商后重试。');const bytes=new Uint8Array(await input.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));body={file:input.name,content:btoa(binary)};}
   if(preview){await requestJSON(`/api/sources/import/${preview.token}`,{method:'DELETE'});setPreview(undefined);setSelected([]);}
   const value=await requestJSON<SupplierImportPreview>('/api/sources/import/preview',post(body));setPreview(value);setSelected(value.rows.filter(r=>r.status==='ready').map(r=>r.id));
  }catch(e){setError(e instanceof Error?e.message:'读取供应商失败。');}finally{setBusy(false);if(file.current)file.current.value='';}
 };
 const apply=async()=>{if(!preview)return;setBusy(true);setError('');try{const result=await requestJSON<{imported:number;skipped:number;routingError?:string}>('/api/sources/import/apply',post({token:preview.token,ids:selected}));setPreview(undefined);setSelected([]);try{await onChange();}catch{throw new Error('供应商已导入，但页面刷新失败，请关闭窗口后刷新页面。');}setOpen(false);notify({kind:result.routingError?'error':'ok',text:result.routingError??`已导入 ${result.imported} 个供应商${result.skipped?`，跳过 ${result.skipped} 个已存在的供应商`:''}。`});}catch(e){setError(e instanceof Error?e.message:'导入失败，请重试。');}finally{setBusy(false);}};
 return <><button type="button" className="textButton" disabled={disabled} onClick={()=>setOpen(true)}>导入</button>
  <FlowDialog open={open} title="导入供应商" className="tfApiEditorDialog" busy={busy} onClose={close}>
   <p className="tfHint">从 CC Switch 数据库、SQL 备份或 JSON 配置读取，选择需要的 API 供应商。</p>
   <div className="tfRow"><button type="button" disabled={busy} onClick={()=>void read(true)}>读取本机 CC Switch</button><button type="button" disabled={busy} onClick={()=>file.current?.click()}>选择文件</button><input ref={file} type="file" hidden accept=".db,.sqlite,.sqlite3,.sql,.json" onChange={e=>{const value=e.target.files?.[0];if(value)void read(false,value);}}/></div>
   {preview&&<div className="tfGroup">{preview.rows.map(row=><label key={row.id} className="toggle"><input type="checkbox" disabled={busy||row.status!=='ready'} checked={selected.includes(row.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,row.id]:ids.filter(id=>id!==row.id))}/><span>{row.name} · {row.app}{row.baseURL&&<small className="tfHint">{row.baseURL} · {row.models.length} 个模型</small>}{row.reason&&<small className="tfHint">{row.reason}</small>}</span></label>)}</div>}
   {error&&<p className="tfError" role="alert">{error}</p>}
   <footer><button type="button" disabled={busy} onClick={close}>取消</button><button type="button" className="primary" disabled={busy||!selected.length} onClick={()=>void apply()}>导入所选（{selected.length}）</button></footer>
  </FlowDialog>
 </>;
}
