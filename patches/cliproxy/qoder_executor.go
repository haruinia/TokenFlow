package executor

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/auth/qoder"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
	log "github.com/sirupsen/logrus"
	"github.com/tidwall/gjson"
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
	return qoderWaitForCapacity(ctx, auth, req, opts, e.executeNativeAttempt, time.Minute)
}

// Delay exposing the stream until its first model event. Resource failures may
// then be retried without replaying any event already delivered to the caller.
func qoderWaitForCapacity(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options, native nativeAgentStream, budget time.Duration) (*cliproxyexecutor.StreamResult, error) {
	started := time.Now()
	for attempt := 0; ; attempt++ {
		attemptCtx, cancel := context.WithCancel(ctx)
		stream, err := native(attemptCtx, auth, req, opts)
		var first cliproxyexecutor.StreamChunk
		var open bool
		if err == nil {
			select {
			case first, open = <-stream.Chunks:
				err = first.Err
			case <-ctx.Done():
				cancel()
				return nil, ctx.Err()
			}
		}
		if err == nil {
			out := make(chan cliproxyexecutor.StreamChunk)
			go func() {
				defer close(out)
				defer cancel()
				send := func(chunk cliproxyexecutor.StreamChunk) bool {
					select {
					case out <- chunk:
						return true
					case <-ctx.Done():
						return false
					}
				}
				if open && !send(first) {
					return
				}
				if open {
					for chunk := range stream.Chunks {
						if !send(chunk) {
							return
						}
					}
				}
			}()
			return &cliproxyexecutor.StreamResult{Headers: stream.Headers, Chunks: out}, nil
		}
		cancel()
		var status statusErr
		if !errors.As(err, &status) || status.code != 429 || gjson.Get(status.msg, "error.code").String() != "qoder_resource_limit" || attempt >= 2 {
			if status.code == 429 && gjson.Get(status.msg, "error.code").String() == "qoder_resource_limit" && attempt >= 2 {
				status.msg = strings.Replace(status.msg, "qoder_resource_limit", "qoder_capacity_wait_exhausted", 1)
				first.Err, err = status, status
			}
			if stream != nil && open {
				chunks := make(chan cliproxyexecutor.StreamChunk, 1)
				chunks <- first
				close(chunks)
				return &cliproxyexecutor.StreamResult{Headers: stream.Headers, Chunks: chunks}, nil
			}
			return nil, err
		}
		delay := 30 * time.Second
		if status.retryAfter != nil && *status.retryAfter > 0 {
			delay = *status.retryAfter
		}
		if time.Since(started)+delay >= budget {
			status.msg = strings.Replace(status.msg, "qoder_resource_limit", "qoder_capacity_wait_exhausted", 1)
			return nil, status
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func (e *QoderExecutor) executeNativeAttempt(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
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

	var options *registry.QoderRuntimeOptions
	if auth != nil {
		for _, info := range registry.GetGlobalRegistry().GetModelsForClient(auth.ID) {
			if info.ID == req.Model || strings.TrimPrefix(info.ID, "qoder/") == modelKey {
				options = info.QoderRuntime
				break
			}
		}
	}
	payload, runtimeErr := helps.ApplyQoderRuntimeOptions(req.Payload, opts.OriginalRequest, options)
	if runtimeErr != nil {
		return nil, statusErr{code: http.StatusBadRequest, msg: runtimeErr.Error()}
	}
	rawBody, errBuild := helps.BuildQoderRequestBody(payload, modelKey, isReasoning)
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
				return e.executeNativeAttempt(ctx, refreshedAuth, req, opts)
			}
		}
		if gjson.ValidBytes(bodyBytes) {
			envelope := gjson.Parse(fmt.Sprintf(`{"statusCodeValue":%d,"body":%s}`, resp.StatusCode, bodyBytes))
			envelopeErr := qoderEnvelopeError(envelope)
			if status, ok := envelopeErr.(statusErr); ok && gjson.Get(status.msg, "error.code").String() == "qoder_resource_limit" {
				var delay time.Duration
				if seconds, parseErr := strconv.Atoi(resp.Header.Get("Retry-After")); parseErr == nil && seconds > 0 {
					delay = time.Duration(seconds) * time.Second
				} else if date, parseErr := http.ParseTime(resp.Header.Get("Retry-After")); parseErr == nil {
					delay = time.Until(date)
				}
				if delay > 0 && (status.retryAfter == nil || delay > *status.retryAfter) {
					status.retryAfter = &delay
				}
				envelopeErr = status
			}
			if envelopeErr != nil {
				return nil, envelopeErr
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
