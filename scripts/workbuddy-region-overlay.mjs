import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join,basename} from 'node:path';
export function workbuddyRegionOverlay(replacements,dir){
 replacements[resolve('upstream/CLIProxyAPI/internal/auth/workbuddy/workbuddy_region_test.go')]=resolve('tests/sidecar/workbuddy_region_test.go');
 replacements[resolve('upstream/CLIProxyAPI/internal/auth/workbuddy/workbuddy_local_paths.go')]=resolve('patches/cliproxy/workbuddy_local_paths.go');
 replacements[resolve('upstream/CLIProxyAPI/internal/auth/workbuddy/workbuddy_local_paths_test.go')]=resolve('tests/sidecar/workbuddy_local_paths_test.go');
 const patch=(path,fn)=>{const source=resolve('upstream/CLIProxyAPI',path),target=join(dir,'region-'+basename(path));writeFileSync(target,fn(readFileSync(replacements[source]??source,'utf8')));replacements[source]=target;};
 const replace=(s,a,b)=>{if(!s.includes(a))throw Error('WorkBuddy region anchor changed: '+a);return s.replace(a,b);};
 patch('internal/auth/workbuddy/workbuddy.go',s=>{
  const start=s.indexOf('\tvar candidates []string',s.indexOf('func ImportLocalAuth()'));
  const end=s.indexOf('\n\tvar raw []byte',start);
  if(start<0||end<0)throw Error('WorkBuddy import paths anchor changed');
  s=s.slice(0,start)+'\tcandidates := localWorkBuddyAuthPathsFor(runtime.GOOS, homeDir, os.Getenv, overseas)\n'+s.slice(end);
  s=replace(s,'func ImportLocalAuth() (*WorkBuddyTokenData, error) {',`func ImportLocalAuth() (*WorkBuddyTokenData, error) { return ImportLocalAuthRegion(false) }

// ImportLocalAuthRegion reads the domestic WorkBuddy or the international WorkBuddyAI desktop login.
func ImportLocalAuthRegion(overseas bool) (*WorkBuddyTokenData, error) {`);
  // A logged-out client may retain an auth file; never import that stale session.
  s=replace(s,'for _, p := range candidates {','for _, p := range candidates {\n if _, err := os.Stat(p+".logged-out"); err == nil || !os.IsNotExist(err) { continue }');
  s=replace(s,'cfg    *config.Config','cfg    *config.Config\n base string');
  s=replace(s,'func (w *WorkBuddyAuth) setCommonHeaders',`// Only the two verified public regions may receive credentials.
func OfficialBase(domain string) string {
 if domain == "www.workbuddy.ai" || domain == "https://www.workbuddy.ai" { return "https://www.workbuddy.ai" }
 return WorkBuddyBaseURL
}
func (w *WorkBuddyAuth) SetDomain(domain string) { w.base = OfficialBase(domain) }
func (w *WorkBuddyAuth) setCommonHeaders`);
  s=replace(s,'req.Header.Set("User-Agent", WorkBuddyClientUA)','req.Header.Set("User-Agent", WorkBuddyClientUA)\n if w.base == "https://www.workbuddy.ai" { req.Header.Set("Origin",w.base); req.Header.Set("Referer",w.base+"/") }');
  s=replace(s,'req, err := http.NewRequestWithContext(ctx, method, fullURL, body)','if w.base != "" { fullURL = strings.Replace(fullURL,WorkBuddyBaseURL,w.base,1) }\n req, err := http.NewRequestWithContext(ctx, method, fullURL, body)');
  s=s.replaceAll('Domain:       tok.Domain,','Domain:       strings.TrimPrefix(OfficialBase(w.base), "https://"),');
  s=replace(s,'workbuddyRefreshGroup.Do(refreshToken,','workbuddyRefreshGroup.Do(OfficialBase(w.base)+refreshToken,');
  s=replace(s,'http.MethodPost, WorkBuddyRefreshURL,','http.MethodPost, OfficialBase(w.base)+"/v2/plugin/auth/token/refresh",');
  if(!s.includes('filepath.'))s=replace(s,'\"path/filepath\"','');
  return s;
 });
 patch('internal/api/handlers/management/auth_files_provider_oauth.go',s=>{
  const start=s.indexOf('func (h *Handler) RequestWorkBuddyToken'),end=s.indexOf('func (h *Handler) ImportWorkBuddyLocalToken',start);let part=s.slice(start,end);
  part=replace(part,'wbAuth := workbuddy.NewWorkBuddyAuth(h.cfg)','wbAuth := workbuddy.NewWorkBuddyAuth(h.cfg)\n overseas := c.Query("region") == "overseas"\n if c.Query("region") != "" && !overseas { c.JSON(400,gin.H{"error":"unsupported region"}); return }\n if overseas { wbAuth.SetDomain("www.workbuddy.ai") }');
  part=replace(part,'record := &coreauth.Auth{','if overseas { fileName = "workbuddy-overseas-"+strings.TrimPrefix(fileName,"workbuddy-"); label += " · 海外" }\n record := &coreauth.Auth{');
  s=s.slice(0,start)+part+s.slice(end);
  const importStart=s.indexOf('func (h *Handler) ImportWorkBuddyLocalToken'),importEnd=s.indexOf('\nfunc ',importStart+1);let imported=s.slice(importStart,importEnd);
  imported=replace(imported,'tokenData, errImport := workbuddy.ImportLocalAuth()','overseas := c.Query("region") == "overseas"\n if c.Query("region") != "" && !overseas { c.JSON(400,gin.H{"error":"unsupported region"}); return }\n tokenData, errImport := workbuddy.ImportLocalAuthRegion(overseas)');
  imported=replace(imported,'wbAuth := workbuddy.NewWorkBuddyAuth(h.cfg)','wbAuth := workbuddy.NewWorkBuddyAuth(h.cfg)\n if overseas { wbAuth.SetDomain("www.workbuddy.ai"); tokenData.Domain = "www.workbuddy.ai" }');
  imported=replace(imported,'record := &coreauth.Auth{','if overseas { fileName = "workbuddy-overseas-"+strings.TrimPrefix(fileName,"workbuddy-"); label += " · 海外" }\n record := &coreauth.Auth{');
  return s.slice(0,importStart)+imported+s.slice(importEnd);
 });
}
