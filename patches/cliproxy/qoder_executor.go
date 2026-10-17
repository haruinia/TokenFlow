package executor

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/auth/qoder"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
	log "github.com/sirupsen/logrus"
)

// QoderExecutor implements the executor for Alibaba Qoder API.
// It wraps OpenAICompatExecutor with Qoder credential resolution, default routing,
// native Cosy protocol encryption, and token refresh handling on 401 responses.
type QoderExecutor struct {
	*OpenAICompatExecutor
	cfg *config.Config
}

// NewQoderExecutor constructs a new Qoder executor instance.
func NewQoderExecutor(cfg *config.Config) *QoderExecutor {
	return &QoderExecutor{
		OpenAICompatExecutor: NewOpenAICompatExecutor("qoder", cfg),
		cfg:                  cfg,
	}
}

// Identifier returns the provider identifier "qoder".
func (e *QoderExecutor) Identifier() string {
	return "qoder"
}

// RequestToFormat reports the format expected by the Qoder upstream API.
func (e *QoderExecutor) RequestToFormat(req cliproxyexecutor.Request, opts cliproxyexecutor.Options) sdktranslator.Format {
	if opts.Alt == "responses/compact" && !opts.Stream {
		return sdktranslator.FormatOpenAIResponse
	}
	return sdktranslator.FormatOpenAI
}

// PrepareRequest injects Qoder credentials and headers into the outgoing HTTP request.
func (e *QoderExecutor) PrepareRequest(req *http.Request, auth *cliproxyauth.Auth) error {
	adaptedAuth := e.adaptAuth(auth)
	return e.OpenAICompatExecutor.PrepareRequest(req, adaptedAuth)
}

// HttpRequest prepares and sends an HTTP request using Qoder credentials.
func (e *QoderExecutor) HttpRequest(ctx context.Context, auth *cliproxyauth.Auth, req *http.Request) (*http.Response, error) {
	adaptedAuth := e.adaptAuth(auth)
	return e.OpenAICompatExecutor.HttpRequest(ctx, adaptedAuth, req)
}

// Execute routes this source through the shared Responses representation.
func (e *QoderExecutor) Execute(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return executeAgentResponse(ctx, auth, req, opts, e.executeNativeStream)
}

func (e *QoderExecutor) ExecuteStream(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	return executeAgentResponseStream(ctx, auth, req, opts, e.executeNativeStream)
}

func (e *QoderExecutor) executeNativeStream(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	modelKey, isReasoning := helps.NormalizeQoderModel(req.Model)

	var accessToken, uid, email string
	if auth != nil && auth.Metadata != nil {
		accessToken, _ = auth.Metadata["access_token"].(string)
		uid, _ = auth.Metadata["uid"].(string)
		email, _ = auth.Metadata["email"].(string)
	}
	if accessToken == "" && auth != nil && auth.Attributes != nil {
		accessToken = auth.Attributes["api_key"]
	}
	if accessToken == "" {
		return nil, statusErr{code: http.StatusUnauthorized, msg: "qoder: access token missing"}
	}
	if uid == "" {
		return nil, statusErr{code: http.StatusUnauthorized, msg: "qoder: account identity missing; sign in again"}
	}

	rawBody, errBuild := helps.BuildQoderRequestBody(req.Payload, modelKey, isReasoning)
	if errBuild != nil {
		return nil, fmt.Errorf("qoder: failed to build request body: %w", errBuild)
	}
	encodedBody := helps.QoderEncodeBody(rawBody)

	chatURL := helps.QoderDefaultChatURL
	if auth != nil && auth.Attributes != nil && auth.Attributes["chat_url"] != "" {
		chatURL = auth.Attributes["chat_url"]
	}

	headers, errHeaders := helps.BuildQoderAuthHeaders(encodedBody, chatURL, uid, accessToken, email)
	if errHeaders != nil {
		return nil, fmt.Errorf("qoder: failed to build auth headers: %w", errHeaders)
	}
	headers["X-Model-Key"] = modelKey
	headers["X-Model-Source"] = "system"

	httpReq, errReq := http.NewRequestWithContext(ctx, http.MethodPost, chatURL, bytes.NewReader(encodedBody))
	if errReq != nil {
		return nil, errReq
	}
	for k, v := range headers {
		httpReq.Header.Set(k, v)
	}

	httpClient := helps.NewProxyAwareHTTPClient(ctx, e.cfg, auth, 0)
	resp, errDo := httpClient.Do(httpReq)
	// Do returns EOF when the peer closes before sending response headers. No
	// output has reached the caller yet; retry this inference once on the same
	// source. Never replay a response body that has already begun streaming.
	if errors.Is(errDo, io.EOF) && ctx.Err() == nil {
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
		retry := httpReq.Clone(ctx)
		retry.Body, errDo = httpReq.GetBody()
		if errDo == nil {
			resp, errDo = httpClient.Do(retry)
		}
	}

	if errDo != nil {
		return nil, errDo
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) && canRefreshQoder(auth) {
			if refreshedAuth, errRefresh := e.Refresh(ctx, auth); errRefresh == nil {
				refreshedAuth = refreshedAuth.Clone()
				delete(refreshedAuth.Metadata, "refresh_token")
				return e.executeNativeStream(ctx, refreshedAuth, req, opts)
			}
		}
		return nil, statusErr{code: resp.StatusCode, msg: fmt.Sprintf("qoder upstream error: %d: %s", resp.StatusCode, string(bodyBytes))}
	}

	return readAgentChatStream(ctx, resp, "qoder"), nil
}

// CountTokens calculates the token count for a Qoder request.
func (e *QoderExecutor) CountTokens(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	adaptedAuth := e.adaptAuth(auth)
	return e.OpenAICompatExecutor.CountTokens(ctx, adaptedAuth, req, opts)
}

// adaptAuth clones auth and injects Qoder-specific defaults for baseURL and apiKey.
func (e *QoderExecutor) adaptAuth(auth *cliproxyauth.Auth) *cliproxyauth.Auth {
	if auth == nil {
		return nil
	}
	cloned := *auth
	attrs := make(map[string]string, len(auth.Attributes)+4)
	for k, v := range auth.Attributes {
		attrs[k] = v
	}

	// Resolve API Key / Token
	apiKey := strings.TrimSpace(attrs["api_key"])
	if apiKey == "" && auth.Metadata != nil {
		if token, ok := auth.Metadata["access_token"].(string); ok && strings.TrimSpace(token) != "" {
			apiKey = strings.TrimSpace(token)
		}
	}
	attrs["api_key"] = apiKey
	cloned.Attributes = attrs
	return &cloned
}

func canRefreshQoder(auth *cliproxyauth.Auth) bool {
	if auth == nil || auth.Metadata == nil {
		return false
	}
	v, ok := auth.Metadata["refresh_token"].(string)
	return ok && strings.TrimSpace(v) != ""
}

// Refresh refreshes the Qoder access token using its refresh token.
func (e *QoderExecutor) Refresh(ctx context.Context, auth *cliproxyauth.Auth) (*cliproxyauth.Auth, error) {
	if auth == nil || auth.Metadata == nil {
		return nil, fmt.Errorf("qoder executor: auth is nil")
	}
	refreshToken, _ := auth.Metadata["refresh_token"].(string)
	refreshToken = strings.TrimSpace(refreshToken)
	if refreshToken == "" {
		return auth, nil
	}

	machineID, _ := auth.Metadata["machine_id"].(string)
	if strings.TrimSpace(machineID) == "" {
		machineID = uuid.NewString()
	}
	authSvc := qoder.NewQoderAuth(e.cfg).WithMachineID(machineID)
	td, err := authSvc.RefreshToken(ctx, refreshToken)
	if err != nil {
		log.Warnf("qoder executor: failed to refresh token: %v", err)
		return nil, err
	}

	auth.Metadata["machine_id"] = strings.TrimSpace(machineID)
	auth.Metadata["access_token"] = td.AccessToken
	if td.RefreshToken != "" {
		auth.Metadata["refresh_token"] = td.RefreshToken
	}
	if td.ExpiresAt > 0 {
		auth.Metadata["expired"] = time.Unix(td.ExpiresAt, 0).UTC().Format(time.RFC3339)
	}
	auth.Metadata["last_refresh"] = time.Now().Format(time.RFC3339)

	// Save updated token to file if storage is present
	if auth.Storage != nil {
		if setter, ok := auth.Storage.(interface{ SetMetadata(map[string]any) }); ok {
			setter.SetMetadata(auth.Metadata)
		}
		if path, ok := auth.Attributes[cliproxyauth.AttributePath]; ok && path != "" {
			if errSave := auth.Storage.SaveTokenToFile(path); errSave != nil {
				log.Warnf("qoder executor: failed to save refreshed token to %s: %v", path, errSave)
			}
		}
	}
	return auth, nil
}
