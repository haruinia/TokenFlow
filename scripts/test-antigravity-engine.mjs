import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {sidecarOverlay} from './sidecar-overlay.mjs';
const patch=sidecarOverlay(true);
try{
 const doc=JSON.parse(readFileSync(patch.overlay,'utf8'));
 doc.Replace[resolve('upstream/CLIProxyAPI/sdk/cliproxy/token_flow_official_catalog_test.go')]=resolve('tests/sidecar/official_catalog_test.go');
 writeFileSync(patch.overlay,JSON.stringify(doc));
 const result=spawnSync('go',['test','-race','-overlay',patch.overlay,'./internal/misc','./internal/auth/antigravity','./internal/runtime/executor','./sdk/cliproxy','-run','Test(Antigravity|ResolveAntigravity|FetchProjectID|EnsureAccessToken|UpdateAntigravity|OfficialCatalog)','-count=1','-timeout=120s'],{cwd:'upstream/CLIProxyAPI',stdio:'inherit'});
 process.exitCode=result.status??1;
}finally{patch.close();}
