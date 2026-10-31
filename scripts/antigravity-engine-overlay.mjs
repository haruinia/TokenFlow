import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';

// Backport the Hub client/control-plane changes from CLIProxyAPI
// 02e9e85204052dfed9bf73b7075c7b414111a4b3 without replacing TokenFlow's
// maintained provider adapters. TokenFlow owns its catalog/cache separately.
export function antigravityEngineOverlay(replacements,dir,test){
 const patch=(path,change)=>{const source=resolve('upstream/CLIProxyAPI',path),target=join(dir,'antigravity-engine-'+basename(path));writeFileSync(target,change(readFileSync(replacements[source]??source,'utf8')));replacements[source]=target;};
 const replace=(text,from,to)=>{if(text.split(from).length!==2)throw Error('Antigravity engine boundary changed: '+from.slice(0,90));return text.replace(from,to);};
 replacements[resolve('upstream/CLIProxyAPI/internal/misc/antigravity_version.go')]=resolve('patches/cliproxy/antigravity_version.go');
 patch('internal/auth/antigravity/auth.go',t=>replace(t,'fmt.Sprintf("%s/%s:loadCodeAssist", APIEndpoint, APIVersion)','fmt.Sprintf("%s/%s:loadCodeAssist", DailyAPIEndpoint, APIVersion)').replace('\treq.Header.Set("Accept", "*/*")\n\treq.Header.Set("Content-Type", "application/json")\n\treq.Header.Set("User-Agent", userAgent)','\treq.Header.Set("Content-Type", "application/json")\n\treq.Header.Set("User-Agent", userAgent)'));
 patch('internal/runtime/executor/antigravity_executor_request.go',t=>replace(t,`func antigravityLoadCodeAssistBaseURL(auth *cliproxyauth.Auth) string {
	if base := resolveCustomAntigravityBaseURL(auth); base != "" {
		return base
	}
	return antigravityBaseURLProd
}`,`func antigravityLoadCodeAssistBaseURL(auth *cliproxyauth.Auth) string {
	return resolveAntigravityRequestBaseURL(auth)
}`)+'\n// TokenFlowAntigravityUserAgent keeps account discovery and inference on the same client identity.\nfunc TokenFlowAntigravityUserAgent(auth *cliproxyauth.Auth) string { return resolveUserAgent(auth) }\n');
 patch('internal/runtime/executor/antigravity_executor_credits.go',t=>replace(replace(t,'userAgent := resolveUserAgent(auth)','userAgent := resolveLoadCodeAssistUserAgent(auth)'),'\thttpReq.Header.Set("Accept", "*/*")\n',''));
 if(test){
  replacements[resolve('upstream/CLIProxyAPI/internal/misc/antigravity_version_test.go')]=resolve('tests/sidecar/antigravity_version_test.go');
  // Existing upstream fixtures assert the old control-plane URL. Preserve their
  // coverage while aligning just that expectation with the backported change.
  for(const file of ['internal/auth/antigravity/auth_test.go','internal/runtime/executor/antigravity_executor_buildrequest_test.go','internal/runtime/executor/antigravity_executor_credits_test.go'])patch(file,t=>{
   t=t.replaceAll('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist','https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
   if(file.endsWith('/auth_test.go'))t=t.replace('if got := req.Header.Get("Accept"); got != "*/*" {','if got := req.Header.Get("Accept"); got != "" {');
   if(file.endsWith('/antigravity_executor_buildrequest_test.go'))t=replace(t,`func TestAntigravityLoadCodeAssistBaseURLRemainsProdByDefault(t *testing.T) {
	if got := antigravityLoadCodeAssistBaseURL(&cliproxyauth.Auth{}); got != antigravityBaseURLProd {
		t.Fatalf("loadCodeAssist base URL = %q, want %q", got, antigravityBaseURLProd)
	}
}`,`func TestAntigravityLoadCodeAssistBaseURLMatchesInference(t *testing.T) {
	for _, auth := range []*cliproxyauth.Auth{{}, {Attributes: map[string]string{"base_url": "https://enterprise.example.com/"}}, {Metadata: map[string]any{"base_url": "https://enterprise.example.com/"}}} {
		if got := antigravityLoadCodeAssistBaseURL(auth); got != resolveAntigravityRequestBaseURL(auth) {
			t.Fatalf("loadCodeAssist and inference disagree: %q", got)
		}
	}
}`);
   return t;
  });
 }
}
