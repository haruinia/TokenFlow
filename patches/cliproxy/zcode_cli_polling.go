package zcode

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ZCodeCLICallbackURL is the server callback ZCode registers for each account family.
const ZCodeCLICallbackURL = "https://zcode.z.ai/api/v1/oauth/cli/callback/"

// CLIFlow uses ZCode's registered server callback, not an invented loopback URI.
// The poll token is private and must never be returned to the desktop renderer.
type CLIFlow struct {
	URL       string
	State     string
	ExpiresAt time.Time
	Interval  time.Duration
	provider  string
	flowID    string
	pollToken string
}

// ZCodeAccountFamily returns the ZCode OAuth provider: "bigmodel" (open.bigmodel.cn) or "zai" (z.ai, the default).
func ZCodeAccountFamily(provider string) string {
	if strings.EqualFold(strings.TrimSpace(provider), "bigmodel") {
		return "bigmodel"
	}
	return "zai"
}

func validCLIAuthorizeURL(u *url.URL, provider string) bool {
	if u.Scheme != "https" || u.User != nil || u.Fragment != "" {
		return false
	}
	if provider == "bigmodel" {
		// BigModel signs in on its own site and returns to the same ZCode server callback family.
		return u.Host == "bigmodel.cn" && u.Path == "/login" && strings.HasPrefix(u.Query().Get("redirect_uri"), ZCodeCLICallbackURL)
	}
	return u.Host == "chat.z.ai" && u.Path == "/api/oauth/authorize" && u.Query().Get("redirect_uri") == ZCodeCLICallbackURL+"zai" && u.Query().Get("state") != ""
}

func (a *ZCodeAuth) cliRequest(ctx context.Context, method, target, token string, body []byte, result any) error {
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	// Never forward polling credentials through an unexpected redirect.
	client := *a.httpClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("ZCode authorization service is unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("ZCode authorization service returned HTTP %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(result); err != nil {
		return errors.New("invalid ZCode authorization response")
	}
	return nil
}

func (a *ZCodeAuth) StartCLIFlow(ctx context.Context) (*CLIFlow, error) {
	return a.StartCLIFlowFor(ctx, "zai")
}

// StartCLIFlowFor starts the official CLI polling login for a Z.ai or BigModel account.
func (a *ZCodeAuth) StartCLIFlowFor(ctx context.Context, provider string) (*CLIFlow, error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}
	provider = ZCodeAccountFamily(provider)
	flow := &CLIFlow{pollToken: hex.EncodeToString(random), provider: provider}
	var result struct {
		Code int `json:"code"`
		Data struct {
			FlowID    string `json:"flow_id"`
			URL       string `json:"authorize_url"`
			ExpiresAt int64  `json:"expires_at"`
			Interval  int64  `json:"poll_interval_sec"`
		} `json:"data"`
	}
	body, err := json.Marshal(map[string]string{"provider": provider})
	if err != nil {
		return nil, err
	}
	if err := a.cliRequest(ctx, http.MethodPost, ZCodeInitURL, flow.pollToken, body, &result); err != nil {
		return nil, err
	}
	data := result.Data
	u, err := url.Parse(data.URL)
	if err != nil || result.Code != 0 || data.FlowID == "" || !validCLIAuthorizeURL(u, provider) {
		return nil, errors.New("invalid ZCode authorization session")
	}
	flow.URL, flow.State, flow.flowID = data.URL, u.Query().Get("state"), data.FlowID
	if flow.State == "" {
		// Polling is keyed by the flow ID; the session state only has to be unique and well-formed.
		state := make([]byte, 16)
		if _, err := rand.Read(state); err != nil {
			return nil, err
		}
		flow.State = "zcode-" + hex.EncodeToString(state)
	}
	flow.ExpiresAt, flow.Interval = time.Unix(data.ExpiresAt, 0), time.Duration(data.Interval)*time.Second
	if !flow.ExpiresAt.After(time.Now()) || flow.Interval < time.Second || flow.Interval >= time.Until(flow.ExpiresAt) {
		return nil, errors.New("invalid ZCode authorization lifetime")
	}
	return flow, nil
}

type cliProviderTokens struct {
	AccessToken       string `json:"access_token"`
	AccessTokenCamel  string `json:"accessToken"`
	RefreshToken      string `json:"refresh_token"`
	RefreshTokenCamel string `json:"refreshToken"`
	ExpiresIn         int64  `json:"expires_in"`
}

func (a *ZCodeAuth) PollCLIFlow(ctx context.Context, flow *CLIFlow) (*ZCodeTokenStorage, error) {
	if !flow.ExpiresAt.After(time.Now()) {
		return nil, errors.New("ZCode authorization expired")
	}
	var result struct {
		Code int `json:"code"`
		Data struct {
			Status   string            `json:"status"`
			Token    string            `json:"token"`
			ZAI      cliProviderTokens `json:"zai"`
			BigModel cliProviderTokens `json:"bigmodel"`
			User     struct {
				ID    string `json:"user_id"`
				Email string `json:"email"`
			} `json:"user"`
		} `json:"data"`
	}
	if err := a.cliRequest(ctx, http.MethodGet, ZCodePollURL+"/"+url.PathEscape(flow.flowID), flow.pollToken, nil, &result); err != nil {
		return nil, err
	}
	data := result.Data
	if result.Code != 0 {
		return nil, errors.New("ZCode authorization failed")
	}
	if data.Status == "pending" {
		return nil, ErrDeviceFlowPending
	}
	provider := ZCodeAccountFamily(flow.provider)
	tokens := data.ZAI
	if provider == "bigmodel" {
		tokens = data.BigModel
	}
	accessToken := firstNonEmpty(tokens.AccessToken, tokens.AccessTokenCamel)
	if data.Status != "ready" || accessToken == "" || data.Token == "" || data.User.ID == "" {
		return nil, errors.New("ZCode authorization returned incomplete credentials")
	}
	storage := &ZCodeTokenStorage{AccessToken: accessToken, RefreshToken: firstNonEmpty(tokens.RefreshToken, tokens.RefreshTokenCamel), JWT: data.Token, UID: data.User.ID, Email: data.User.Email, Provider: provider, Type: "zcode", TokenType: "Bearer"}
	if provider == "bigmodel" {
		// The official client has no business-login step for BigModel; its OAuth token is the API credential.
		if tokens.ExpiresIn > 0 {
			storage.Expired = time.Now().Add(time.Duration(tokens.ExpiresIn) * time.Second).UTC().Format(time.RFC3339)
		}
		return storage, nil
	}
	// A chat OAuth token is not a model API credential. Match the official
	// client's mandatory business-token exchange before marking login complete.
	token, expiresIn, err := a.ExchangeBusinessToken(ctx, accessToken)
	if err != nil {
		return nil, err
	}
	storage.AccessToken = token
	if expiresIn > 0 {
		storage.Expired = time.Now().Add(time.Duration(expiresIn) * time.Second).UTC().Format(time.RFC3339)
	}
	return storage, nil
}

// ExchangeBusinessToken turns a Z.ai chat OAuth token into the ZCode business token used for model calls.
func (a *ZCodeAuth) ExchangeBusinessToken(ctx context.Context, zaiAccessToken string) (string, int64, error) {
	var business struct {
		Code    json.Number `json:"code"`
		Success *bool       `json:"success"`
		Data    struct {
			AccessToken      string `json:"access_token"`
			AccessTokenCamel string `json:"accessToken"`
			ExpiresIn        int64  `json:"expires_in"`
		} `json:"data"`
	}
	body, err := json.Marshal(map[string]string{"token": zaiAccessToken})
	if err != nil {
		return "", 0, err
	}
	if err := a.cliRequest(ctx, http.MethodPost, ZCodeBusinessLoginURL, "", body, &business); err != nil {
		return "", 0, err
	}
	if (business.Code != "" && business.Code != "0" && business.Code != "200") || (business.Success != nil && !*business.Success) {
		return "", 0, errors.New("ZCode business authorization failed")
	}
	token := firstNonEmpty(business.Data.AccessToken, business.Data.AccessTokenCamel)
	if token == "" {
		return "", 0, errors.New("ZCode business authorization returned no token")
	}
	return token, business.Data.ExpiresIn, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
