// Isolated full-console fixture for manual/CUA interaction. No real config, auth
// files or Codex lifecycle are touched. Run after npm run build.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
const choice={sourceId:'fixture-source',model:'antigravity/gemini-3.8-flash-low'};
const connection={id:'fixture-connection',target:'codex',keyId:'fixture-key',...choice,selections:[choice],state:'applied',codexCoexist:false};
const target={id:'codex',name:'Codex',installation:{installed:true,version:'0.163.0'},restartSupported:true,exists:true,revision:'fixture-revision',pids:[],connection:null,configurationState:'unmanaged',codexRoutingMode:'official',backups:[{...connection,state:'restored'}]};
const local={state:'running',loginState:'idle',port:8317,logs:[],accounts:[{id:choice.sourceId,provider:'antigravity',label:'fixture@example.test',status:'active',disabled:false,unavailable:false,models:[choice.model]}],models:[{id:choice.model,provider:'antigravity'}],quotas:{},quotaBusy:false,providers:[]};
const calls=[];let failure=false,phase='idle';
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost'),path=url.pathname;
 try{
  if(path==='/fixture/state'){res.setHeader('content-type','application/json');res.end(JSON.stringify({calls,mode:target.codexRoutingMode}));return;}
  if(path==='/fixture/scenario'&&req.method==='POST'){let text='';for await(const c of req)text+=c;const scenario=JSON.parse(text);failure=!!scenario.failure;if(scenario.mode){target.codexRoutingMode=scenario.mode;target.connection=scenario.mode==='official'?null:{...connection,codexCoexist:scenario.mode==='coexist'};target.configurationState=target.connection?'configured':'unmanaged';}res.end('{}');return;}
  if(path.startsWith('/api/')){
   res.setHeader('content-type','application/json');
   if(path==='/api/a2a/codex-migration'){res.end(JSON.stringify({phase:'idle',done:0,total:0,lifecyclePhase:phase}));return;}
   if(path.startsWith('/api/a2a/restore-preview/')){res.end(JSON.stringify({id:connection.id,target:'codex',revision:target.revision,canRestore:true,destination:{kind:'official',provider:'openai'}}));return;}
   if(path==='/api/a2a/connect'||path==='/api/a2a/restore'){
    let text='';for await(const c of req)text+=c;const body=JSON.parse(text);calls.push({path,body});
    assert.equal(body.restartCodex,true);assert.equal(body.revision,target.revision);
    if(path.endsWith('/connect'))assert.equal(body.codexCoexist,false);else assert.equal(body.restoreHistory,true);
    phase='stopping';await new Promise(r=>setTimeout(r,2000));phase='changing';await new Promise(r=>setTimeout(r,1800));
    if(failure){failure=false;phase='idle';res.statusCode=409;res.end(JSON.stringify({code:'codex_migration_failed',error:'测试：对话备份未完成，切换已停止，备份保留。'}));return;}
    target.codexRoutingMode=path.endsWith('/connect')?'gateway':'official';target.connection=target.codexRoutingMode==='gateway'?connection:null;target.configurationState=target.connection?'configured':'unmanaged';phase='idle';res.end(JSON.stringify(connection));return;
   }
   const value=path==='/api/local-agent'?local:path==='/api/a2a'?{targets:[target]}:path==='/api/a2a/program-updates'?{updates:{}}:path.startsWith('/api/native-accounts/')||path==='/api/codex-accounts'?{revision:'fixture',accounts:[],pids:[],backup:null}:path==='/api/usage/overview'?{rows:[],combinedRows:[],allRows:[],nativeRows:[],coverage:[],scanning:false}:path==='/api/gateway-keys'?{keys:[]}:path==='/api/gateway/activity'?{recent:[]}:path==='/api/activity/traces'?{records:[]}:path==='/api/maintenance'?{status:'idle',messages:[]}:{};
   res.end(JSON.stringify(value));return;
  }
  const file=resolve('dist/console','.'+(path==='/'?'/index.html':path));if(!file.startsWith(resolve('dist/console')+'/')){res.writeHead(404);res.end();return;}
  res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)]??'application/octet-stream');res.end(await readFile(file));
 }catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}));}
});
server.listen(0,'127.0.0.1',()=>console.log(`http://127.0.0.1:${server.address().port}`));
