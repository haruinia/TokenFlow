package cliproxy

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/misc"
	runtimeexecutor "github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/proxyutil"
)

// A catalog is scoped to the credential, provider and endpoint. Failed refreshes
// retain that account's last verified list briefly; static tables never grant access.
type officialCatalogEntry struct {
	mu          sync.Mutex
	fingerprint [32]byte
	checked     time.Time
	models      []*ModelInfo
	succeeded   bool
	successful  time.Time
	latestOK    bool
}

func metadataText(a *coreauth.Auth, key string) string {
	if a == nil {
		return ""
	}
	if value, ok := a.Metadata[key].(string); ok && strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return strings.TrimSpace(a.Attributes[key])
}

func officialCatalogFingerprint(a *coreauth.Auth) [32]byte {
	mode, _ := json.Marshal([]any{a.Attributes["using_api"], a.Metadata["using_api"], a.Attributes["auth_kind"], a.Metadata["auth_kind"]})
	return sha256.Sum256([]byte(a.Provider + "\x00" + metadataText(a, "jwt") + "\x00" + metadataText(a, "provider") + "\x00" + metadataText(a, "zcode_client_version") + "\x00" + metadataText(a, "access_token") + "\x00" + metadataText(a, "base_url") + "\x00" + metadataText(a, "enterprise_id") + "\x00" + metadataText(a, "enterpriseId") + "\x00" + metadataText(a, "uid") + "\x00" + a.ProxyURL + "\x00" + metadataText(a, "project_id") + "\x00" + metadataText(a, "domain") + "\x00" + string(mode) + "\x00" + codexCatalogVersion(a)))
}

func (s *Service) refreshOfficialAccountCatalog(ctx context.Context, id string, force bool) map[string]any {
	a, ok := s.latestAuthForModelRegistration(id)
	if !ok || a.Disabled {
		return map[string]any{"status": "unavailable"}
	}
	s.officialCatalogMu.Lock()
	entry := s.officialCatalog[id]
	s.officialCatalogMu.Unlock()
	if entry != nil {
		entry.mu.Lock()
	}
	fresh := entry != nil && entry.fingerprint == officialCatalogFingerprint(a) && time.Since(entry.checked) < 30*time.Second
	if force && entry != nil {
		entry.checked = time.Time{}
	}
	if entry != nil {
		entry.mu.Unlock()
	}
	if fresh && !force {
		return s.officialCatalogStatus(a)
	}
	s.refreshModelRegistrationForAuthWithContext(ctx, a, nil)
	return s.officialCatalogStatus(a)
}

// Discovery provenance is returned separately from the registry; a registry entry
// alone is not proof that the vendor still advertises the model.
func (s *Service) officialCatalogStatus(a *coreauth.Auth) map[string]any {
	result := map[string]any{"status": "unavailable"}
	if a.Provider == "doubao" {
		result["status"] = "unsupported"
		result["reason"] = "legacy_adapter_removed"
		return result
	}

	s.officialCatalogMu.Lock()
	entry := s.officialCatalog[a.ID]
	s.officialCatalogMu.Unlock()
	if entry == nil {
		return result
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	result["checkedAt"] = entry.checked.UTC().Format(time.RFC3339)
	if entry.succeeded && time.Since(entry.successful) < 15*time.Minute {
		result["status"] = "stale"
		if entry.latestOK {
			result["status"] = "live"
		}
		result["verifiedAt"] = entry.successful.UTC().Format(time.RFC3339)
	}
	return result
}

func (s *Service) officialAccountModels(ctx context.Context, a *coreauth.Auth, fallback []*ModelInfo) []*ModelInfo {
	if s == nil || a == nil || metadataText(a, "access_token") == "" {
		return initialOfficialCatalog(a, fallback)
	}
	fingerprint := officialCatalogFingerprint(a)
	// Serialize refreshes so config reloads and polling do not duplicate requests.
	// No application credentials or model permissions are persisted by discovery.
	s.officialCatalogMu.Lock()
	if s.officialCatalog == nil {
		s.officialCatalog = make(map[string]*officialCatalogEntry)
	}
	entry := s.officialCatalog[a.ID]
	if entry == nil || entry.fingerprint != fingerprint {
		entry = &officialCatalogEntry{fingerprint: fingerprint}
		s.officialCatalog[a.ID] = entry
	}
	s.officialCatalogMu.Unlock()
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if time.Since(entry.checked) >= 30*time.Second {
		live, ok := s.fetchOfficialAccountModels(ctx, a, fallback)
		entry.checked = time.Now()
		entry.latestOK = ok
		if ok {
			entry.successful = entry.checked
			entry.models = live
			entry.succeeded = true
		}
	}
	if entry.succeeded && time.Since(entry.successful) < 15*time.Minute {
		return cloneOfficialModels(entry.models)
	}
	return initialOfficialCatalog(a, fallback)
}

// Static definitions supply capabilities for verified IDs, never permissions.
func initialOfficialCatalog(_ *coreauth.Auth, _ []*ModelInfo) []*ModelInfo { return nil }

func cloneOfficialModels(models []*ModelInfo) []*ModelInfo {
	copyModels := make([]*ModelInfo, 0, len(models))
	for _, model := range models {
		if model != nil {
			v := *model
			copyModels = append(copyModels, &v)
		}
	}
	return copyModels
}

func (s *Service) fetchOfficialAccountModels(ctx context.Context, a *coreauth.Auth, fallback []*ModelInfo) ([]*ModelInfo, bool) {
	provider := strings.ToLower(a.Provider)
	token := metadataText(a, "access_token")
	base := metadataText(a, "base_url")
	method, path := "GET", ""
	headers := map[string]string{"Authorization": "Bearer " + token, "Accept": "application/json"}
	body := ""
	switch provider {
	case "workbuddy":
		if base == "" {
			base = "https://copilot.tencent.com"
			if domain := metadataText(a, "domain"); domain == "www.workbuddy.ai" || domain == "https://www.workbuddy.ai" {
				base = "https://www.workbuddy.ai"
			}
		}
		// Official CLI CloudProductProvider reads the account-scoped conversation config.
		path = "/v3/config"
		headers["X-User-Id"] = metadataText(a, "uid")
		headers["X-Product"] = "SaaS"
		headers["Origin"] = "https://www.codebuddy.cn"
		if base == "https://www.workbuddy.ai" {
			headers["Origin"] = base
		}
		headers["Referer"] = headers["Origin"] + "/"
		headers["User-Agent"] = "CLI/2.161.0 CodeBuddy/2.161.0"
		headers["X-Requested-With"] = "XMLHttpRequest"
	case "qoder":
		if base == "" {
			base = "https://api3.qoder.sh/algo"
		}
		path = "/api/v2/model/list?Encode=1"
		signed, err := helps.BuildQoderAuthHeaders(nil, strings.TrimRight(base, "/")+path, metadataText(a, "uid"), token, metadataText(a, "email"))
		if err != nil {
			return nil, false
		}
		headers = signed
		headers["Accept"] = "application/json"
	case "antigravity":
		if base == "" {
			// Match resolveAntigravityRequestBaseURL: catalogs and inference must use the same tier.
			base = antigravityModelBaseURLDaily
		}
		path = antigravityModelsPath
		method = "POST"
		payload, _ := json.Marshal(map[string]string{"project": metadataText(a, "project_id")})
		body = string(payload)
		headers["User-Agent"] = misc.AntigravityUserAgent()
	case "codex":
		if base == "" {
			base = "https://chatgpt.com/backend-api/codex"
		}
		path = "/models?client_version=" + url.QueryEscape(codexCatalogVersion(a))
		if account := metadataText(a, "account_id"); account != "" {
			headers["ChatGPT-Account-Id"] = account
		}
	case "claude":
		if base == "" {
			base = "https://api.anthropic.com"
		}
		path = "/v1/models?limit=1000"
		headers["anthropic-version"] = "2023-06-01"
		headers["anthropic-beta"] = "oauth-2025-04-20"
	case "kimi":
		if base == "" {
			base = "https://api.kimi.com/coding"
		}
		path = "/v1/models"
	case "xai":
		resolved, identityHeaders := runtimeexecutor.TokenFlowXAICatalogRequest(a, token)
		base = resolved
		for key, values := range identityHeaders {
			if len(values) > 0 {
				headers[key] = values[0]
			}
		}
		path = "/models"
	case "zcode":
		if base == "" && metadataText(a, "jwt") != "" {
			return s.fetchZCodeConversationCatalog(ctx, a, fallback)
		}
		if base == "" {
			switch metadataText(a, "provider") {
			case "zai":
				base = "https://api.z.ai/api/coding/paas/v4"
			case "bigmodel":
				base = "https://open.bigmodel.cn/api/coding/paas/v4"
			default:
				base = "https://open.bigmodel.cn/api/paas/v4"
			}
		}
		path = "/models"
	case "trae":
		if base == "" {
			base = "https://trae-api-us.mchost.guru"
		}
		path = "/api/ide/v1/get_detail_param?function=chat_v3&need_prompt=false"
		headers["Authorization"] = "Cloud-IDE-JWT " + token
		headers["X-App-Id"] = helps.TraeAppID
		headers["X-App-Version"] = "default"
		headers["X-IDE-Version"] = "3.6.2"
		headers["X-IDE-Version-Code"] = "20260212"
		headers["X-App-Version-Code"] = "20260212"
		headers["X-IDE-Version-Type"] = "stable"
		headers["Request-Traffic-Type"] = "prod"
	case "doubao":
		return nil, false
	default:
		// Unknown protocols never publish guessed permissions.
		return nil, false
	}
	requestCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, method, strings.TrimRight(base, "/")+path, strings.NewReader(body))
	if err != nil {
		return nil, false
	}
	for k, v := range headers {
		if v != "" {
			req.Header.Set(k, v)
		}
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	proxy := a.ProxyURL
	if proxy == "" && s.cfg != nil {
		proxy = s.cfg.ProxyURL
	}
	transport, _, err := proxyutil.BuildHTTPTransport(proxy)
	if err != nil {
		return nil, false
	}
	if transport != nil {
		client.Transport = transport
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, false
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024+1))
	if err != nil || len(raw) > 4*1024*1024 {
		return nil, false
	}
	if provider == "qoder" && !json.Valid(raw) {
		raw = decodeQoderCatalog(raw)
	}
	return parseOfficialCatalog(provider, raw, fallback)
}

// The server filters Codex models by runtime version. The desktop's local model
// cache records that version; only this non-secret field is read, never its list
// as an account permission source. CLI-only installs retain the pinned fallback.
func codexCatalogVersion(a *coreauth.Auth) string {
	if a == nil || a.Provider != "codex" {
		return ""
	}
	if version := metadataText(a, "codex_client_version"); validCatalogVersion(version) {
		return version
	}
	dir := os.Getenv("CODEX_HOME")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err == nil {
			dir = filepath.Join(home, ".codex")
		}
	}
	raw, err := os.ReadFile(filepath.Join(dir, "models_cache.json"))
	if err == nil && len(raw) < 8*1024*1024 {
		var value struct {
			Version string `json:"client_version"`
		}
		if json.Unmarshal(raw, &value) == nil && validCatalogVersion(value.Version) {
			return value.Version
		}
	}
	return "0.154.0"
}
func validCatalogVersion(value string) bool {
	if len(value) == 0 || len(value) > 40 {
		return false
	}
	for _, r := range value {
		if (r < '0' || r > '9') && r != '.' && r != '-' && r != '+' && (r < 'a' || r > 'z') {
			return false
		}
	}
	return true
}

// Qoder applies its public response alphabet/three-block permutation to model
// catalogs as well as inference payloads. A plain JSON response is also valid.
func decodeQoderCatalog(raw []byte) []byte {
	const alphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!"
	const standard = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	raw = bytes.TrimSpace(raw)
	if len(raw) > 1 && raw[0] == '"' {
		var value string
		if json.Unmarshal(raw, &value) == nil {
			raw = []byte(value)
		}
	}
	decoded := make([]byte, len(raw))
	for i, b := range raw {
		if b == '$' {
			decoded[i] = '='
		} else if p := strings.IndexByte(alphabet, b); p >= 0 {
			decoded[i] = standard[p]
		} else {
			decoded[i] = b
		}
	}
	n := len(decoded)
	third := n / 3
	restored := append(append(append([]byte{}, decoded[n-third:]...), decoded[third:n-third]...), decoded[:third]...)
	data, err := base64.StdEncoding.DecodeString(string(restored))
	if err != nil {
		return nil
	}
	return data
}

func parseOfficialCatalog(provider string, raw []byte, fallback []*ModelInfo) ([]*ModelInfo, bool) {
	var root map[string]any
	if json.Unmarshal(raw, &root) != nil {
		return nil, false
	}
	if code, ok := root["code"].(float64); ok && code != 0 && code != 200 {
		return nil, false
	}
	if success, ok := root["success"].(bool); ok && !success {
		return nil, false
	}
	data := root
	if nested, ok := root["data"].(map[string]any); ok {
		data = nested
	}
	var items []any
	recognized := false
	switch provider {
	case "trae":
		configs, ok := data["config_info_list"].([]any)
		if !ok {
			return nil, false
		}
		recognized = true
		for _, value := range configs {
			c, ok := value.(map[string]any)
			if !ok {
				return nil, false
			}
			display, _ := c["display_config"].(map[string]any)
			if c["config_switch"] == false || c["is_invisible_to_user"] == true || display["is_custom_model"] == true || stringField(display, "display_name") == "" {
				continue
			}
			item := map[string]any{"id": stringField(c, "config_name"), "display_name": stringField(display, "display_name"), "supportedInputModalities": []any{"text"}}
			if display["multimodal"] == true {
				item["supportedInputModalities"] = []any{"text", "image"}
			}
			if window, ok := c["context_window_tokens"].(map[string]any); ok {
				item["context_length"] = window["dev"]
			}
			if details, ok := c["model_detail_list"].([]any); ok && len(details) > 0 {
				if detail, ok := details[0].(map[string]any); ok {
					item["max_output_tokens"] = detail["max_tokens"]
				}
			}
			items = append(items, item)
		}
	case "qoder":
		// Current official CLI uses the chat picker (verified with --list-models).
		// Honor an explicit CLI list on versions that provide one; never union IDE scenes.
		items, recognized = data["cli"].([]any)
		if !recognized {
			items, recognized = data["chat"].([]any)
		}
		if !recognized {
			items, recognized = data["models"].([]any)
		}
	case "antigravity":
		if models, ok := data["models"].(map[string]any); ok {
			recognized = true
			keys := make([]string, 0, len(models))
			for id := range models {
				keys = append(keys, id)
			}
			sort.Strings(keys)
			for _, id := range keys {
				if item, ok := models[id].(map[string]any); ok {
					copyItem := make(map[string]any, len(item)+1)
					for k, v := range item {
						copyItem[k] = v
					}
					copyItem["id"] = id
					items = append(items, copyItem)
				}
			}
		}
	default:
		items, recognized = data["models"].([]any)
	}
	if !recognized {
		items, recognized = root["data"].([]any)
	}
	if !recognized {
		items, recognized = data["items"].([]any)
	}
	if !recognized {
		return nil, false
	}
	deprecated, _ := data["deprecatedModelIds"].(map[string]any)
	allowed := map[string]bool{}
	allowlistDeclared := false
	if provider == "antigravity" {
		// The models map also contains completion, image and historical aliases.
		// Only the server's conversation picker grants agent model visibility.
		sorts, ok := data["agentModelSorts"].([]any)
		if !ok {
			return nil, false
		}
		allowlistDeclared = true
		for _, value := range sorts {
			sort, ok := value.(map[string]any)
			if !ok {
				return nil, false
			}
			groups, ok := sort["groups"].([]any)
			if !ok {
				return nil, false
			}
			for _, value := range groups {
				group, ok := value.(map[string]any)
				if !ok {
					return nil, false
				}
				ids, ok := group["modelIds"].([]any)
				if !ok {
					return nil, false
				}
				for _, value := range ids {
					id, ok := value.(string)
					if !ok || id == "" {
						return nil, false
					}
					allowed[id] = true
				}
			}
		}
	}
	if provider == "workbuddy" {
		if agents, ok := data["agents"].([]any); ok {
			for _, v := range agents {
				agent, _ := v.(map[string]any)
				if stringField(agent, "name") == "cli" {
					if ids, ok := agent["models"].([]any); ok {
						allowlistDeclared = true
						for _, id := range ids {
							if value, ok := id.(string); ok {
								allowed[value] = true
							}
						}
					}
				}
			}
		}
	}
	known := map[string]*ModelInfo{}
	for _, m := range fallback {
		if m != nil {
			known[m.ID] = m
		}
	}
	seen := map[string]bool{}
	models := make([]*ModelInfo, 0, len(items))
	invalid := false
	for _, value := range items {
		item, ok := value.(map[string]any)
		if !ok {
			invalid = true
			continue
		}
		id := stringField(item, "id", "key", "model_key", "slug", "modelId", "name")
		if id == "" || len(id) > 280 || strings.ContainsAny(id, "\r\n\x00") {
			invalid = true
			continue
		}
		if provider == "antigravity" {
			if _, retired := deprecated[id]; retired {
				continue
			}
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		if enabled, ok := item["enable"].(bool); ok && !enabled {
			continue
		}
		if internal, ok := item["isInternal"].(bool); ok && internal {
			continue
		}
		if visibility := stringField(item, "visibility"); visibility == "hide" || visibility == "hidden" {
			continue
		}
		if supported, ok := item["supported_in_api"].(bool); ok && !supported {
			continue
		}
		if provider == "antigravity" && stringField(item, "displayName", "display_name", "name") == "" {
			continue
		}
		if disabled, ok := item["disabled"].(bool); ok && disabled {
			continue
		}
		if allowlistDeclared && !allowed[id] {
			continue
		}
		if source := stringField(item, "source"); provider == "qoder" && (source == "custom" || source == "local" || stringField(item, "outer_provider") != "") {
			continue
		}
		m := &ModelInfo{ID: id, Object: "model", OwnedBy: provider, Type: provider}
		if existing := known[id]; existing != nil {
			copyModel := *existing
			m = &copyModel
		}
		if name := stringField(item, "display_name", "displayName", "displayNameZh", "name", "title"); name != "" {
			m.DisplayName = name
		}
		// Explicit live capability declarations override the fallback catalog.
		for _, field := range []string{"supportedInputModalities", "input_modalities"} {
			if values, ok := item[field].([]any); ok {
				m.SupportedInputModalities = nil
				for _, value := range values {
					if modality, ok := value.(string); ok {
						m.SupportedInputModalities = append(m.SupportedInputModalities, strings.ToLower(modality))
					}
				}
				break
			}
		}
		if n := numberField(item, "maxInputTokens", "max_input_tokens", "inputTokenLimit", "context_length", "context_window", "maxTokens"); n > 0 {
			m.ContextLength = n
			m.InputTokenLimit = n
		}
		if n := numberField(item, "maxOutputTokens", "max_output_tokens", "outputTokenLimit", "max_completion_tokens"); n > 0 {
			m.MaxCompletionTokens = n
			m.OutputTokenLimit = n
		}
		m.SupportsWebSearch = false
		if searches, ok := data["webSearchModelIds"].([]any); ok {
			for _, v := range searches {
				if v == id {
					m.SupportsWebSearch = true
				}
			}
		}
		models = append(models, m)
	}
	if len(items) > 0 && len(models) == 0 && invalid {
		return nil, false
	}
	return models, true
}

func stringField(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if v, ok := m[key].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
func numberField(m map[string]any, keys ...string) int {
	for _, key := range keys {
		if v, ok := m[key].(float64); ok && v > 0 && v < 1e9 {
			return int(v)
		}
	}
	return 0
}
