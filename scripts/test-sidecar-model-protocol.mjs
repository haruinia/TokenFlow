import {spawnSync} from 'node:child_process';
import {sidecarOverlay} from './sidecar-overlay.mjs';
const patch=sidecarOverlay(true);
try{
 const result=spawnSync('go',['test','-overlay',patch.overlay,'./internal/translator/antigravity/claude','-count=1'],{cwd:'upstream/CLIProxyAPI',stdio:'inherit'});
 process.exitCode=result.status??1;
}finally{patch.close();}
