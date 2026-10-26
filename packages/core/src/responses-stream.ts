/** Pull one SSE frame at a time. Source and frame failures share one terminal
 * boundary; consumer cancellation never becomes an upstream failure event. */
export function responsesStream(source:ReadableStream<Uint8Array>,options:{
 rewrite:(frame:string)=>Promise<string>;terminal:()=>boolean;failure:(cause?:unknown)=>string;
 signal?:AbortSignal;onCancel?:()=>void;
}):ReadableStream<Uint8Array>{
 const reader=source.getReader(),decoder=new TextDecoder(),encoder=new TextEncoder();
 let buffer='',ended=false,closed=false,released=false,abort:undefined|(()=>void);
 const release=()=>{if(!released){released=true;reader.releaseLock();}};
 const detach=()=>{if(abort)options.signal?.removeEventListener('abort',abort);};
 const cancelSource=(reason?:unknown)=>{
  try{const pending=reader.cancel(reason);release();return pending.catch(()=>{});}catch{release();return Promise.resolve();}
 };
 return new ReadableStream<Uint8Array>({
  start(controller){
   abort=()=>{if(closed)return;closed=true;detach();void cancelSource(options.signal?.reason);controller.close();};
   if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});
  },
  async pull(controller){
   if(closed)return;
   try{
    for(;;){
     let frame:string|undefined;const separator=buffer.indexOf('\n\n');
     if(separator>=0){frame=buffer.slice(0,separator);buffer=buffer.slice(separator+2);}
     else if(ended&&buffer.trim()){frame=buffer;buffer='';}
     else if(ended){
      closed=true;detach();release();
      if(!options.terminal())controller.enqueue(encoder.encode(options.failure()));
      controller.close();return;
     }else{
      const chunk=await reader.read();if(closed)return;
      if(chunk.done){ended=true;buffer+=decoder.decode();}else buffer+=decoder.decode(chunk.value,{stream:true});
      buffer=buffer.replace(/\r\n/g,'\n');continue;
     }
     const output=await options.rewrite(frame);if(closed)return;
     if(output)controller.enqueue(encoder.encode(output));
     if(options.terminal()){
      closed=true;detach();buffer='';void cancelSource();controller.close();return;
     }
     if(output)return;
    }
   }catch(cause){
    if(closed)return;
    closed=true;detach();void cancelSource(cause);
    if(!options.terminal())controller.enqueue(encoder.encode(options.failure(cause)));
    controller.close();
   }
  },
  async cancel(reason){
   if(closed)return;
   closed=true;detach();const cancelled=cancelSource(reason);options.onCancel?.();await cancelled;
  },
 });
}
