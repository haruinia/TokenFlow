package cliproxy

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	management "github.com/router-for-me/CLIProxyAPI/v7/internal/api/handlers/management"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"

	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

func TestOfficialCatalogRegistersNewAccountModel(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer fixture-only" {
			t.Error("missing account authorization")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"code":0,"data":{"models":[{"id":"new-official-model","name":"New Official Model","maxInputTokens":100000,"maxOutputTokens":8000,"supportedInputModalities":["TEXT","IMAGE"]}]}}`))
	}))
	defer server.Close()
	service := &Service{cfg: &config.Config{}}
	account := &coreauth.Auth{ID: t.Name(), Provider: "workbuddy", Metadata: map[string]any{"access_token": "fixture-only", "uid": "fixture-user", "base_url": server.URL}}
	defer GlobalModelRegistry().UnregisterClient(account.ID)
	service.registerModelsForAuth(context.Background(), account)
	models := GlobalModelRegistry().GetModelsForClient(account.ID)
	for _, m := range models {
		if m.ID == "new-official-model" {
			if len(m.SupportedInputModalities) != 2 || m.SupportedInputModalities[1] != "image" {
				t.Fatal("live image capability lost")
			}
			if calls != 1 {
				t.Errorf("expected one official discovery call, got %d", calls)
			}
			return
		}
	}
	t.Fatalf("official account model missing from registered callable catalog; official requests=%d", calls)
}

func TestOfficialCatalogManagementRefreshPreservesExclusionsAndAliases(t *testing.T) {
	current := "first-model"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"models": []map[string]any{{"id": current, "supportedInputModalities": []string{"text", "image"}, "maxInputTokens": 234567}, {"id": "excluded-model"}}}})
	}))
	defer server.Close()
	manager := coreauth.NewManager(nil, nil, nil)
	cfg := &config.Config{OAuthExcludedModels: map[string][]string{"workbuddy": {"excluded-model"}}, OAuthModelAlias: map[string][]config.OAuthModelAlias{"workbuddy": {{Name: "second-model", Alias: "workbuddy/second-model", Fork: true}}}}
	s := &Service{cfg: cfg, coreManager: manager}
	a := &coreauth.Auth{ID: t.Name(), FileName: t.Name() + ".json", Provider: "workbuddy", Metadata: map[string]any{"access_token": "fixture-only", "base_url": server.URL}}
	if _, err := manager.Register(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	defer GlobalModelRegistry().UnregisterClient(a.ID)
	s.registerModelsForAuth(context.Background(), a)
	current = "second-model"
	handler := management.NewHandler(cfg, "", manager)
	handler.SetAccountModelRefreshHook(s.refreshOfficialAccountCatalog)
	response := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(response)
	c.Request = httptest.NewRequest("GET", "/auth-files/models?name="+url.QueryEscape(a.FileName)+"&refresh=true", nil)
	handler.GetAuthFileModels(c)
	if response.Code != 200 {
		t.Fatalf("management refresh: %d", response.Code)
	}
	var result struct {
		Models []struct {
			ID            string   `json:"id"`
			Modalities    []string `json:"supportedInputModalities"`
			ContextLength int      `json:"context_length"`
		} `json:"models"`
	}
	json.Unmarshal(response.Body.Bytes(), &result)
	for _, model := range result.Models {
		if len(model.Modalities) != 2 || model.Modalities[1] != "image" {
			t.Fatal("management catalog dropped image capability")
		}
		if model.ContextLength != 234567 {
			t.Fatalf("fresh context capability lost through discovery/alias/management: %d", model.ContextLength)
		}
	}
	found := false
	for _, model := range result.Models {
		if model.ID == "workbuddy/second-model" {
			found = true
		}
		if model.ID == "first-model" || model.ID == "excluded-model" {
			t.Fatalf("stale or excluded route advertised: %s", model.ID)
		}
	}
	if !found {
		t.Fatal("fresh official model was not registered under its callable namespaced alias")
	}
}

func TestOfficialCatalogQoderEmptyCLIMustNotExposeIDE(t *testing.T) {
	models, ok := parseOfficialCatalog("qoder", []byte(`{"cli":[],"chat":[{"key":"chat-only"}],"ide":[{"key":"ide-only"}]}`), nil)
	if !ok || len(models) != 0 {
		t.Fatalf("CLI empty permission list must remain empty: %v %d", ok, len(models))
	}
}

func TestOfficialCatalogManagementPreservesContextCapabilities(t *testing.T) {
	const account = "context-capability-fixture"
	GlobalModelRegistry().RegisterClient(account, "workbuddy", []*ModelInfo{
		{ID: "canonical", ContextLength: 123456, InputTokenLimit: 999999},
		{ID: "gemini-style", InputTokenLimit: 654321},
		{ID: "unknown"}, {ID: "invalid", ContextLength: -1, InputTokenLimit: -2},
	})
	defer GlobalModelRegistry().UnregisterClient(account)
	response := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(response)
	c.Request = httptest.NewRequest("GET", "/auth-files/models?name="+account, nil)
	management.NewHandler(&config.Config{}, "", nil).GetAuthFileModels(c)
	var result struct {
		Models []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	windows := map[string]float64{"canonical": 123456, "gemini-style": 654321}
	for _, model := range result.Models {
		id := model["id"].(string)
		if expected, ok := windows[id]; ok {
			if model["context_length"] != expected {
				t.Errorf("%s capacity lost: got %v, want %v", id, model["context_length"], expected)
			}
		} else if _, ok := model["context_length"]; ok {
			t.Errorf("%s invented capacity", id)
		}
	}
	if len(result.Models) != 4 {
		t.Fatalf("models missing: %d", len(result.Models))
	}
}

func TestOfficialCatalogQoderResponseCodec(t *testing.T) {
	for _, text := range []string{`{"cli":[{"key":"new","display_name":"New"}]}`, `{"cli":[]}`, `{"cli":[{"key":"测试"}]}`} {
		encoded := helps.QoderEncodeBody([]byte(text))
		if string(decodeQoderCatalog(encoded)) != text {
			t.Fatal("signed model response failed to decode")
		}
	}
}

func TestOfficialCatalogLiveRead(t *testing.T) {
	root := os.Getenv("TOKEN_FLOW_CATALOG_AUTH_DIR")
	if root == "" {
		t.Skip("explicit local account catalog probe only")
	}
	files, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{cfg: &config.Config{}}
	report := []map[string]any{}
	for _, f := range files {
		if !strings.HasSuffix(f.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(root, f.Name()))
		if err != nil {
			t.Fatal(err)
		}
		var meta map[string]any
		if json.Unmarshal(raw, &meta) != nil {
			continue
		}
		provider, _ := meta["type"].(string)
		if provider == "" || provider == "claude" {
			continue
		}
		if disabled, _ := meta["disabled"].(bool); disabled {
			continue
		}
		a := &coreauth.Auth{ID: f.Name(), Provider: provider, Metadata: meta}
		models, ok := service.fetchOfficialAccountModels(context.Background(), a, nil)
		safe := []map[string]any{}
		for _, m := range models {
			safe = append(safe, map[string]any{"id": m.ID, "name": m.DisplayName, "context": m.ContextLength, "output": m.MaxCompletionTokens})
		}
		report = append(report, map[string]any{"provider": provider, "accountId": fmt.Sprintf("%x", sha256.Sum256([]byte(f.Name())))[:12], "official": ok, "models": safe})
		t.Logf("%s official=%v models=%d", provider, ok, len(safe))
	}
	if out := os.Getenv("TOKEN_FLOW_CATALOG_REPORT"); out != "" {
		raw, _ := json.MarshalIndent(report, "", "  ")
		if err := os.WriteFile(out, append(raw, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestOfficialCatalogAuthoritativeAndFallback(t *testing.T) {
	calls := 0
	fail := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if fail {
			w.WriteHeader(503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"models":[{"id":"allowed","name":"Allowed"},{"id":"other-agent"},{"id":"disabled","disabled":true}],"agents":[{"name":"cli","models":["allowed","disabled"]}]}}`))
	}))
	defer server.Close()
	s := &Service{cfg: &config.Config{}}
	a := &coreauth.Auth{ID: t.Name(), Provider: "workbuddy", Metadata: map[string]any{"access_token": "fixture-only", "base_url": server.URL}}
	fallback := []*ModelInfo{{ID: "stale-table-model"}}
	got := s.officialAccountModels(context.Background(), a, fallback)
	if len(got) != 1 || got[0].ID != "allowed" {
		t.Fatalf("account permissions should replace the table: %+v", got)
	}
	fail = true
	got = s.officialAccountModels(context.Background(), a, fallback)
	if calls != 1 {
		t.Fatal("config reload caused duplicate discovery")
	}
	s.officialCatalog[a.ID].checked = time.Time{}
	got = s.officialAccountModels(context.Background(), a, fallback)
	if len(got) != 1 || got[0].ID != "allowed" {
		t.Fatal("failed refresh discarded last successful account catalog")
	}
	a.Metadata["access_token"] = "different-account-token"
	got = s.officialAccountModels(context.Background(), a, fallback)
	if len(got) != 0 {
		t.Fatal("credential change reused previous account permission cache")
	}
}

func TestOfficialCatalogParsers(t *testing.T) {
	for _, test := range []struct {
		provider, body string
		count          int
		valid          bool
	}{
		{"qoder", `{"cli":[{"key":"smodel","display_name":"Step-5-Preview"},{"key":"removed","enable":false}],"ide":[{"key":"smodel"},{"key":"ide-new"}]}`, 1, true},
		{"antigravity", `{"models":{"new-model":{"displayName":"New"}},"webSearchModelIds":["new-model"],"agentModelSorts":[{"groups":[{"modelIds":["new-model"]}]}]}`, 1, true},
		{"codex", `{"models":[{"slug":"gpt-next","display_name":"GPT Next","context_window":100000},{"slug":"internal-review","visibility":"hide"}]}`, 1, true},
		{"claude", `{"data":[{"id":"claude-next","display_name":"Claude Next"}]}`, 1, true},
		{"kimi", `{"data":[{"id":"kimi-next"}]}`, 1, true},
		{"xai", `{"data":[]}`, 0, true},
		{"workbuddy", `{"code":401,"data":{"models":[]}}`, 0, false},
		{"workbuddy", `{"error":{"message":"unavailable"}}`, 0, false},
		{"workbuddy", `{"data":{"models":[{}]}}`, 0, false},
	} {
		t.Run(test.provider+test.body[:8], func(t *testing.T) {
			models, ok := parseOfficialCatalog(test.provider, []byte(test.body), nil)
			if ok != test.valid || len(models) != test.count {
				t.Fatalf("got ok=%v count=%d", ok, len(models))
			}
		})
	}
}

func TestOfficialCatalogAntigravityProjectAndDeprecatedModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["project"] != "fixture-project" {
			t.Error("catalog must use the same account project as inference")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"models":{"current":{"displayName":"Current"},"old":{"displayName":"Old"},"command-flash":{"displayName":"Flash"},"internal":{"isInternal":true}},"deprecatedModelIds":{"old":{"newModelId":"current"}},"agentModelSorts":[{"groups":[{"modelIds":["current"]}]}],"commandModelIds":["command-flash"]}`))
	}))
	defer server.Close()
	s := &Service{cfg: &config.Config{}}
	a := &coreauth.Auth{ID: t.Name(), Provider: "antigravity", Metadata: map[string]any{"access_token": "fixture", "base_url": server.URL, "project_id": "fixture-project"}}
	models, ok := s.fetchOfficialAccountModels(context.Background(), a, nil)
	if !ok || len(models) != 1 {
		t.Fatalf("expected only selectable conversation model, got %v (%v)", models, ok)
	}
	for _, m := range models {
		if m.ID == "old" {
			t.Fatal("deprecated model advertised")
		}
	}
}

func TestOfficialCatalogAntigravityFailureDoesNotInventAvailableModels(t *testing.T) {
	fail := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail {
			w.WriteHeader(503)
			return
		}
		w.Write([]byte(`{"models":{"current":{"displayName":"Current"}},"agentModelSorts":[{"groups":[{"modelIds":["current"]}]}]}`))
	}))
	defer server.Close()
	s := &Service{cfg: &config.Config{}}
	a := &coreauth.Auth{ID: t.Name(), Provider: "antigravity", Metadata: map[string]any{"access_token": "fixture", "base_url": server.URL}}
	fallback := []*ModelInfo{{ID: "gemini-pro-agent"}}
	if got := s.officialAccountModels(context.Background(), a, fallback); len(got) != 0 {
		t.Fatal("failed live discovery exposed unverified static models")
	}
	fail = false
	s.officialCatalog[a.ID].checked = time.Time{}
	if got := s.officialAccountModels(context.Background(), a, fallback); len(got) != 1 || got[0].ID != "current" {
		t.Fatal("discovery did not recover")
	}
	fail = true
	s.officialCatalog[a.ID].checked = time.Time{}
	if got := s.officialAccountModels(context.Background(), a, fallback); len(got) != 1 || got[0].ID != "current" {
		t.Fatal("transient failure discarded last verified catalog")
	}
}

type officialCatalogTransportFunc func(*http.Request) (*http.Response, error)

func (f officialCatalogTransportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestOfficialCatalogAntigravityUsesInferenceTier(t *testing.T) {
	previous := http.DefaultTransport
	defer func() { http.DefaultTransport = previous }()
	http.DefaultTransport = officialCatalogTransportFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "daily-cloudcode-pa.googleapis.com" {
			t.Fatalf("catalog/inference tier mismatch: %s", r.URL.Host)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"models":{},"agentModelSorts":[]}`))}, nil
	})
	s := &Service{cfg: &config.Config{}}
	_, ok := s.fetchOfficialAccountModels(context.Background(), &coreauth.Auth{Provider: "antigravity", Metadata: map[string]any{"access_token": "fixture"}}, nil)
	if !ok {
		t.Fatal("expected successful discovery on inference tier")
	}
}

func TestOfficialCatalogNeverPublishesUnverifiedTables(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer server.Close()
	for _, provider := range []string{"workbuddy", "qoder", "codex", "kimi", "xai", "zcode", "claude", "doubao", "trae"} {
		t.Run(provider, func(t *testing.T) {
			s := &Service{cfg: &config.Config{}}
			a := &coreauth.Auth{ID: t.Name(), Provider: provider, Metadata: map[string]any{"access_token": "fixture", "uid": "fixture", "base_url": server.URL}}
			if got := s.officialAccountModels(context.Background(), a, []*ModelInfo{{ID: "obsolete"}}); len(got) != 0 {
				t.Fatal("failed live discovery exposed old static table")
			}
		})
	}
}
func TestOfficialCatalogEmptyCLIAllowlistIsAuthoritative(t *testing.T) {
	models, ok := parseOfficialCatalog("workbuddy", []byte(`{"data":{"models":[{"id":"other-client-only"}],"agents":[{"name":"cli","models":[]}]}}`), nil)
	if !ok || len(models) != 0 {
		t.Fatal("empty CLI permission list broadened to every product model")
	}
}

func TestOfficialCatalogExpiresStalePermissions(t *testing.T) {
	fail := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail {
			w.WriteHeader(503)
			return
		}
		w.Write([]byte(`{"data":[{"id":"verified"}]}`))
	}))
	defer server.Close()
	s := &Service{cfg: &config.Config{}}
	a := &coreauth.Auth{ID: t.Name(), Provider: "kimi", Metadata: map[string]any{"access_token": "fixture", "base_url": server.URL}}
	if got := s.officialAccountModels(context.Background(), a, nil); len(got) != 1 {
		t.Fatal("live model missing")
	}
	if s.officialCatalogStatus(a)["status"] != "live" {
		t.Fatal("missing provenance")
	}
	fail = true
	s.officialCatalog[a.ID].checked = time.Time{}
	if got := s.officialAccountModels(context.Background(), a, nil); len(got) != 1 || s.officialCatalogStatus(a)["status"] != "stale" {
		t.Fatal("brief outage lost last verified catalog")
	}
	s.officialCatalog[a.ID].successful = time.Now().Add(-16 * time.Minute)
	if got := s.officialAccountModels(context.Background(), a, []*ModelInfo{{ID: "old"}}); len(got) != 0 || s.officialCatalogStatus(a)["status"] != "unavailable" {
		t.Fatal("stale catalog survived expiry")
	}
}

func TestOfficialCatalogXAIOAuthUsesChatAccountEndpoint(t *testing.T) {
	previous := http.DefaultTransport
	defer func() { http.DefaultTransport = previous }()
	http.DefaultTransport = officialCatalogTransportFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "cli-chat-proxy.grok.com" || r.URL.Path != "/v1/models" {
			t.Fatalf("OAuth directory routed to a different account product: %s", r.URL)
		}
		if r.Header.Get("X-XAI-Token-Auth") != "xai-grok-cli" {
			t.Fatal("missing OAuth client identity")
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"data":[{"id":"grok-current"}]}`))}, nil
	})
	s := &Service{cfg: &config.Config{}}
	_, ok := s.fetchOfficialAccountModels(context.Background(), &coreauth.Auth{Provider: "xai", Metadata: map[string]any{"access_token": "fixture", "auth_kind": "oauth", "base_url": "https://api.x.ai/v1"}}, nil)
	if !ok {
		t.Fatal("OAuth catalog unavailable")
	}
}

func TestOfficialCatalogCacheIdentityIncludesAPIMode(t *testing.T) {
	a := &coreauth.Auth{ID: t.Name(), Provider: "xai", Metadata: map[string]any{"access_token": "fixture", "auth_kind": "oauth"}}
	previous := officialCatalogFingerprint(a)
	a.Metadata["using_api"] = true
	if officialCatalogFingerprint(a) == previous {
		t.Fatal("API/OAuth mode reused permissions")
	}
	previous = officialCatalogFingerprint(a)
	a.Attributes = map[string]string{"using_api": "false"}
	if officialCatalogFingerprint(a) == previous {
		t.Fatal("attribute override reused permissions")
	}
}

func TestOfficialCatalogAntigravityPickerIsAuthoritative(t *testing.T) {
	for _, tc := range []struct {
		picker string
		valid  bool
		count  int
	}{
		{`,"agentModelSorts":[{"groups":[{"modelIds":["current","old","internal"]}]}]`, true, 1},
		{`,"agentModelSorts":[]`, true, 0},
		{``, false, 0},
		{`,"agentModelSorts":[{"groups":"invalid"}]`, false, 0},
	} {
		raw := []byte(`{"models":{"current":{"displayName":"Current"},"aux":{"displayName":"Auxiliary"},"old":{"displayName":"Old"},"internal":{"displayName":"Internal","isInternal":true}},"deprecatedModelIds":{"old":{}},"commandModelIds":["aux"],"imageGenerationModelIds":["aux"]` + tc.picker + `}`)
		got, ok := parseOfficialCatalog("antigravity", raw, nil)
		if ok != tc.valid || len(got) != tc.count {
			t.Fatalf("picker=%s valid=%v count=%d", tc.picker, ok, len(got))
		}
		if len(got) > 0 && got[0].ID != "current" {
			t.Fatal("non-picker model published")
		}
	}
}

func TestOfficialCatalogWorkBuddyUsesOfficialCloudConfig(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/config" {
			w.WriteHeader(500)
			w.Write([]byte("<html>500 Internal Server Error</html>"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"code":0,"data":{"models":[{"id":"current-chat"},{"id":"internal-summary"}],"agents":[{"name":"cli","models":["current-chat"]}]}}`))
	}))
	defer server.Close()
	s := &Service{cfg: &config.Config{}}
	a := &coreauth.Auth{ID: t.Name(), Provider: "workbuddy", Metadata: map[string]any{"access_token": "fixture", "base_url": server.URL, "domain": "www.workbuddy.ai"}}
	got, ok := s.fetchOfficialAccountModels(context.Background(), a, nil)
	if !ok || len(got) != 1 || got[0].ID != "current-chat" {
		t.Fatalf("official conversation config not loaded: ok=%v models=%v", ok, got)
	}
}

func TestOfficialCatalogTraeConversationVisibility(t *testing.T) {
	raw := []byte(`{"config_info_list":[{"config_name":"Dola-Seed-2.0-Code","config_switch":true,"display_config":{"display_name":"Dola","multimodal":true},"context_window_tokens":{"dev":128000}},{"config_name":"summary","config_switch":true,"display_config":{}},{"config_name":"hidden-auto","config_switch":true,"is_invisible_to_user":true,"display_config":{"display_name":"Auto helper"}},{"config_name":"disabled","config_switch":false,"display_config":{"display_name":"Disabled"}},{"config_name":"byok","config_switch":true,"display_config":{"display_name":"Mine","is_custom_model":true}}]}`)
	models, ok := parseOfficialCatalog("trae", raw, nil)
	if !ok || len(models) != 1 || models[0].ID != "Dola-Seed-2.0-Code" || models[0].ContextLength != 128000 {
		t.Fatalf("unexpected conversation catalog: ok=%v models=%+v", ok, models)
	}
}
func TestOfficialCatalogZCodeUsesCodingPlanPicker(t *testing.T) {
	raw := []byte(`{"revision":23,"config":{"providerConfigRules":{"providerRules":[{"providerId":"account:zai-individual-coding-plan","config":{"builtinModelIds":["GLM-5.3","GLM-5.3-Flash"]}},{"providerId":"account:zai-team-coding-plan","config":{"builtinModelIds":["GLM-5.3"]}},{"providerId":"account:zai-start-plan","config":{"builtinModelIds":["GLM-5.2"]}},{"providerId":"account:bigmodel-individual-coding-plan","config":{"builtinModelIds":["other-family"]}}]}}}`)
	ids, ok := zcodeCodingPicker(raw, "zai")
	if !ok || len(ids) != 2 || !ids["glm-5.3"] || ids["glm-5.2"] || ids["other-family"] {
		t.Fatalf("wrong conversation scope: %v", ids)
	}
	if _, ok := zcodeCodingPicker([]byte(`{"config":{}}`), "zai"); ok {
		t.Fatal("missing config was accepted")
	}
}

func TestOfficialCatalogZCodeSeparatesLoginAndAPICredentials(t *testing.T) {
	previous := http.DefaultTransport
	defer func() { http.DefaultTransport = previous }()
	calls := 0
	http.DefaultTransport = officialCatalogTransportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		raw := ""
		switch r.URL.Host {
		case "zcode.z.ai":
			if r.URL.Path != "/api/v1/client/configs" || r.Header.Get("Authorization") != "Bearer login-fixture" || r.URL.Query().Get("platform") == "" {
				t.Fatal("wrong native discovery identity")
			}
			raw = `{"code":0,"data":{"configs":{"builtin_provider_config_json":"https://cdn-zcode.z.ai/zcode/config/current.json"}}}`
		case "cdn-zcode.z.ai":
			if r.Header.Get("Authorization") != "" {
				t.Fatal("account credential sent to CDN")
			}
			raw = `{"config":{"providerConfigRules":{"providerRules":[{"providerId":"account:zai-individual-coding-plan","config":{"builtinModelIds":["GLM-current"]}}]}}}`
		case "api.z.ai":
			if r.Header.Get("Authorization") != "Bearer api-fixture" {
				t.Fatal("wrong inference account credential")
			}
			raw = `{"data":[{"id":"glm-current"},{"id":"api-only"}]}`
		default:
			t.Fatalf("unexpected host %s", r.URL.Host)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(raw))}, nil
	})
	s := &Service{cfg: &config.Config{}}
	got, ok := s.fetchOfficialAccountModels(context.Background(), &coreauth.Auth{Provider: "zcode", Metadata: map[string]any{"access_token": "api-fixture", "jwt": "login-fixture", "provider": "zai"}}, nil)
	if !ok || calls != 3 || len(got) != 1 || got[0].ID != "glm-current" {
		t.Fatalf("unexpected result ok=%v calls=%d count=%d", ok, calls, len(got))
	}
}

func TestOfficialCatalogRetiredDoubaoMakesNoUpstreamRequest(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Write([]byte(`{"data":[{"id":"wrong-product"}]}`))
	}))
	defer server.Close()
	s := &Service{cfg: &config.Config{}}
	a := &coreauth.Auth{Provider: "doubao", Metadata: map[string]any{"access_token": "fixture", "base_url": server.URL}}
	got, ok := s.fetchOfficialAccountModels(context.Background(), a, nil)
	if ok || len(got) != 0 || calls != 0 {
		t.Fatal("retired adapter still reaches upstream")
	}
	if s.officialCatalogStatus(a)["reason"] != "legacy_adapter_removed" {
		t.Fatal("missing retirement reason")
	}
}

func TestOfficialCatalogZcodeProjectUsesFreshPickerWithoutAnUnimplementedModelsEndpoint(t *testing.T) {
	raw := []byte(`{"config":{"providerConfigRules":{"providerRules":[{"providerId":"account:bigmodel-individual-coding-plan","config":{"builtinModelIds":["glm-live"]}},{"providerId":"account:zai-individual-coding-plan","config":{"builtinModelIds":["other-region"]}}]}}}`)
	allowed, ok := zcodeCodingPicker(raw, "bigmodel")
	if !ok {
		t.Fatal("official picker missing")
	}
	models, ok := zcodeProjectCatalog(allowed, nil)
	if !ok || len(models) != 1 || models[0].ID != "glm-live" {
		t.Fatal("live scoped catalog lost")
	}
	if _, ok := zcodeProjectCatalog(nil, nil); ok {
		t.Fatal("missing catalog must not reveal static fallback models")
	}
}
