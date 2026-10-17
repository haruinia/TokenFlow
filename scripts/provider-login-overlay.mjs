import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

export function providerLoginOverlay(replacements, patchDir) {
  const patch = (path, transform) => {
    const source = resolve('upstream/CLIProxyAPI', path);
    const target = join(patchDir, basename(path));
    writeFileSync(target, transform(readFileSync(source, 'utf8')));
    replacements[source] = target;
  };
  const replace = (text, from, to) => {
    if (text.split(from).length !== 2) throw new Error('Provider login source changed; inspect before building: ' + from.slice(0, 80));
    return text.replace(from, to);
  };
  replacements[resolve('upstream/CLIProxyAPI/internal/auth/zcode/cli_polling.go')] = resolve('patches/cliproxy/zcode_cli_polling.go');
  patch('internal/api/handlers/management/auth_files_provider_oauth.go', text => {
    // The retired "doubao" adapter was MarsCode/Trae, not the Doubao product.
    for (const name of ['RequestDoubaoToken','ImportDoubaoLocalToken']) {
      const start=text.indexOf(`func (h *Handler) ${name}(`);
      const next=text.indexOf('\nfunc ',start+1);
      if(start<0||next<0)throw Error('Retired provider handler moved: '+name);
      text=text.slice(0,start)+`func (h *Handler) ${name}(c *gin.Context) { c.JSON(http.StatusGone,gin.H{"error":"Legacy MarsCode adapter removed; Trae is a separate provider"}) }\n`+text.slice(next);
    }
    text=text.replace('\n\t"github.com/router-for-me/CLIProxyAPI/v7/internal/auth/doubao"','');

    const start = text.indexOf('func (h *Handler) RequestZCodeToken(');
    const end = text.indexOf('func (h *Handler) ImportZCodeLocalToken(', start);
    let section = text.slice(start, end);
    const from = section.indexOf('\n\tstate, errState :=');
    const to = section.indexOf('\n\t\tmetadata :=', from);
    if (from < 0 || to < 0) throw new Error('ZCode login source changed');
    section = section.slice(0, from) + `
 zcAuth := zcode.NewZCodeAuth(h.cfg)
 flow, errStart := zcAuth.StartCLIFlowFor(c.Request.Context(), c.Query("provider"))
 if errStart != nil {
  c.JSON(http.StatusBadGateway, gin.H{"error":"ZCode official authorization could not be started"})
  return
 }
 state := flow.State
 if errState := ValidateOAuthState(state); errState != nil {
  c.JSON(http.StatusBadGateway, gin.H{"error":"invalid ZCode authorization state"})
  return
 }
 RegisterOAuthSession(state, "zcode")
 go func() {
  pollContext, cancel := context.WithDeadline(ctx, flow.ExpiresAt)
  defer cancel()
  ticker := time.NewTicker(flow.Interval)
  defer ticker.Stop()
  var storage *zcode.ZCodeTokenStorage
  for storage == nil {
   select {
   case <-pollContext.Done():
    if IsOAuthSessionPending(state,"zcode") { SetOAuthSessionError(state,"ZCode authorization expired") }
    return
   case <-ticker.C:
    if !IsOAuthSessionPending(state,"zcode") { return }
    var errPoll error
    storage,errPoll = zcAuth.PollCLIFlow(pollContext,flow)
    if errors.Is(errPoll,zcode.ErrDeviceFlowPending) { continue }
    if errPoll != nil { SetOAuthSessionError(state,"ZCode authorization failed; please reconnect"); return }
   }
  }
` + section.slice(to);
    section = replace(section, '"url":    authURL,', '"url":    flow.URL,');
    section = replace(section, '"flow":   "oauth",', '"flow":   "device",\n "expires_in": int(time.Until(flow.ExpiresAt).Seconds()),');
    section = replace(section, '"access_token": storage.AccessToken,', '"access_token": storage.AccessToken,\n "refresh_token": storage.RefreshToken,');
    text = text.slice(0, start) + section + text.slice(end);
    // Trae validates this exact path and echoes login_trace_id, not state.
    text = replace(text, `redirectURI, errTarget := h.managementCallbackURL("/trae/callback")
\tif errTarget != nil {
\t\tlog.WithError(errTarget).Error("failed to compute trae callback target")
\t\tc.JSON(http.StatusInternalServerError, gin.H{"error": "callback URL computation failed"})
\t\treturn
\t}`, 'redirectURI := "http://127.0.0.1:1455/authorize"');
    const traeStart = text.indexOf('func (h *Handler) RequestTraeToken(');
    const traeEnd = text.indexOf('func (h *Handler) ImportTraeLocalToken(', traeStart);
    let traeSection = text.slice(traeStart, traeEnd);
    traeSection = replace(traeSection, 'if _, errSave := h.saveTokenRecord(ctx, record); errSave != nil {', 'if errGuard := guardOAuthSessionPendingForSave(state, "trae"); errGuard != nil { return }\n\t\tif _, errSave := h.saveTokenRecord(ctx, record); errSave != nil {');
    return text.slice(0, traeStart) + traeSection + text.slice(traeEnd);
  });
  patch('internal/auth/trae/trae.go', text => replace(text,
    'auth_type=local&client_id=%s&state=%s',
    'auth_type=local&client_id=%s&login_trace_id=%s'));
  patch('internal/api/handlers/management/oauth_callback.go', text => {
    text = replace(text, '"errors"', '"errors"\n "encoding/json"');
    text = replace(text, 'errMsg := strings.TrimSpace(req.Error)', 'errMsg := strings.TrimSpace(req.Error)\n var authCodeInfo, userInfo, host string');
    text = replace(text, 'q := u.Query()', `q := u.Query()
  if req.Provider == "trae" {
   authCodeInfo,userInfo,host = q.Get("authCodeInfo"),q.Get("userInfo"),q.Get("host")
   if host != "" {
    api, err := url.Parse(host)
    if err != nil || api.Scheme != "https" || !strings.HasSuffix(api.Hostname(),".trae.ai") || api.Port() != "" || api.User != nil || (api.Path != "" && api.Path != "/") || api.RawQuery != "" || api.Fragment != "" {
     c.JSON(http.StatusBadRequest,gin.H{"error":"invalid Trae API host"}); return
    }
   }
   if authCodeInfo == "" && q.Get("userJwt") != "" && q.Get("refreshToken") != "" {
    var tokens map[string]any
    if json.Unmarshal([]byte(q.Get("userJwt")), &tokens) != nil || tokens == nil { tokens = map[string]any{"Token":q.Get("userJwt")} }
    tokens["RefreshToken"] = q.Get("refreshToken")
    encoded, _ := json.Marshal(tokens)
    authCodeInfo = string(encoded)
   }
  }`);
    text = replace(text, 'if code == "" && errMsg == "" {', 'if code == "" && errMsg == "" && authCodeInfo == "" {');
    return replace(text, 'WriteOAuthCallbackFileForPendingSession(h.cfg.AuthDir, canonicalProvider, state, code, errMsg)', 'WriteOAuthCallbackFileWithDataForPendingSession(h.cfg.AuthDir, canonicalProvider, state, code, errMsg, authCodeInfo, userInfo, host)');
  });
}
