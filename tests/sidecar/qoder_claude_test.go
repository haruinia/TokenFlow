package executor

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	log "github.com/sirupsen/logrus"
	logtest "github.com/sirupsen/logrus/hooks/test"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	_ "github.com/router-for-me/CLIProxyAPI/v7/internal/translator"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
	"github.com/tidwall/gjson"
)

func TestQoderClaudeWireFormat(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, chunk := range []string{`{"id":"fixture","model":"kmodel_latest","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}`, `{"id":"fixture","model":"kmodel_latest","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}`} {
			envelope, _ := json.Marshal(map[string]string{"body": chunk})
			fmt.Fprintf(w, "data: %s\n\n", envelope)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()
	exec := NewQoderExecutor(&config.Config{})
	auth := &cliproxyauth.Auth{ID: "fixture", Provider: "qoder", Attributes: map[string]string{"chat_url": server.URL}, Metadata: map[string]any{"access_token": "synthetic", "uid": "fixture-user"}}
	req := cliproxyexecutor.Request{Model: "kmodel_latest", Payload: []byte(`{"model":"kmodel_latest","messages":[{"role":"user","content":"Reply OK"}],"max_tokens":16}`)}
	opts := cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatClaude, OriginalRequest: req.Payload}
	t.Run("stream", func(t *testing.T) {
		result, err := exec.ExecuteStream(context.Background(), auth, req, opts)
		if err != nil {
			t.Fatal(err)
		}
		var wire strings.Builder
		for chunk := range result.Chunks {
			if chunk.Err != nil {
				t.Fatal(chunk.Err)
			}
			wire.Write(chunk.Payload)
		}
		for _, expected := range []string{"event: message_start", "event: content_block_delta", "event: message_stop"} {
			if !strings.Contains(wire.String(), expected) {
				t.Errorf("missing %s in Claude stream: %s", expected, wire.String())
			}
		}
	})
	t.Run("nonstream", func(t *testing.T) {
		result, err := exec.Execute(context.Background(), auth, req, opts)
		if err != nil {
			t.Fatal(err)
		}
		if gjson.GetBytes(result.Payload, "type").String() != "message" {
			t.Fatalf("not an Anthropic Message: %s", result.Payload)
		}
		if gjson.GetBytes(result.Payload, "content.0.text").String() != "OK" {
			t.Fatalf("missing text: %s", result.Payload)
		}
	})
	t.Run("responses", func(t *testing.T) {
		req.Payload = []byte(`{"model":"kmodel_latest","input":"Reply OK","max_output_tokens":16}`)
		opts = cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAIResponse, OriginalRequest: req.Payload}
		result, err := exec.Execute(context.Background(), auth, req, opts)
		if err != nil {
			t.Fatal(err)
		}
		if gjson.GetBytes(result.Payload, "object").String() != "response" || gjson.GetBytes(result.Payload, "output.0.content.0.text").String() != "OK" {
			t.Fatalf("invalid Responses output: %s", result.Payload)
		}
		stream, err := exec.ExecuteStream(context.Background(), auth, req, opts)
		if err != nil {
			t.Fatal(err)
		}
		var wire strings.Builder
		for chunk := range stream.Chunks {
			if chunk.Err != nil {
				t.Fatal(chunk.Err)
			}
			wire.Write(chunk.Payload)
		}
		for _, expected := range []string{"response.created", "response.output_text.delta", "response.completed"} {
			if !strings.Contains(wire.String(), expected) {
				t.Errorf("missing %s in Responses stream: %s", expected, wire.String())
			}
		}
	})
}

func TestQoderToolCallAndInvalidStream(t *testing.T) {
	for _, mode := range []string{"tool", "empty", "truncated", "premature-done", "wrapped-done", "json-error"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				if mode == "json-error" {
					fmt.Fprint(w, `{"error":{"message":"private upstream diagnostic"}}`)
					return
				}
				if mode == "empty" {
					fmt.Fprint(w, "data: [DONE]\n\n")
					return
				}
				chunks := []string{`{"id":"fixture-tool","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_new","type":"function","function":{"name":"lookup","arguments":"{\"path\":"}}]},"finish_reason":null}]}`}
				if mode == "tool" {
					chunks = append(chunks, `{"id":"fixture-tool","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"README.md\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}`)
				}
				for _, chunk := range chunks {
					envelope, _ := json.Marshal(map[string]string{"body": chunk})
					fmt.Fprintf(w, "data: %s\n\n", envelope)
				}
				if mode == "wrapped-done" {
					fmt.Fprint(w, "data: {\"body\":\"[DONE]\"}\n\n")
				}
				if mode == "tool" || mode == "premature-done" {
					fmt.Fprint(w, "data: [DONE]\n\n")
				}
			}))
			defer server.Close()
			exec := NewQoderExecutor(&config.Config{})
			auth := &cliproxyauth.Auth{ID: "fixture", Provider: "qoder", Attributes: map[string]string{"chat_url": server.URL}, Metadata: map[string]any{"access_token": "synthetic", "uid": "fixture-user"}}
			req := cliproxyexecutor.Request{Model: "kmodel_latest", Payload: []byte(`{"model":"kmodel_latest","stream":true,"system":"fixture-system","messages":[{"role":"user","content":"use lookup"}],"tools":[{"name":"lookup","description":"fixture","input_schema":{"type":"object","properties":{"path":{"type":"string"}}}}],"max_tokens":64}`)}
			opts := cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatClaude, OriginalRequest: req.Payload, Stream: true}
			result, err := exec.Execute(context.Background(), auth, req, opts)
			if mode != "tool" {
				if err == nil {
					t.Fatalf("invalid %s stream accepted: %s", mode, result.Payload)
				}
				stream, streamErr := exec.ExecuteStream(context.Background(), auth, req, opts)
				if streamErr != nil {
					t.Fatal(streamErr)
				}
				failed := false
				for chunk := range stream.Chunks {
					if chunk.Err != nil {
						failed = true
					}
					if strings.Contains(string(chunk.Payload), "event: message_stop") {
						t.Fatal("invalid stream fabricated completion")
					}
				}
				if !failed {
					t.Fatal("invalid streaming response accepted")
				}
				if strings.Contains(err.Error(), "private upstream") {
					t.Fatal("upstream diagnostic exposed")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for path, want := range map[string]string{"type": "message", "stop_reason": "tool_use", "content.0.type": "tool_use", "content.0.id": "call_new", "content.0.name": "lookup", "content.0.input.path": "README.md", "usage.input_tokens": "11", "usage.output_tokens": "3"} {
				if got := gjson.GetBytes(result.Payload, path).String(); got != want {
					t.Errorf("%s = %q, want %q", path, got, want)
				}
			}
			stream, err := exec.ExecuteStream(context.Background(), auth, req, opts)
			if err != nil {
				t.Fatal(err)
			}
			var wire strings.Builder
			for chunk := range stream.Chunks {
				if chunk.Err != nil {
					t.Fatal(chunk.Err)
				}
				wire.Write(chunk.Payload)
			}
			for _, want := range []string{"event: message_start", `"type":"tool_use"`, `"type":"input_json_delta"`, `"stop_reason":"tool_use"`, "event: message_stop"} {
				if !strings.Contains(wire.String(), want) {
					t.Errorf("missing %s in tool stream", want)
				}
			}
		})
	}
}

func TestQoderLongToolNamesRoundTrip(t *testing.T) {
	name := "mcp__fixture__" + strings.Repeat("long_tool_", 9)
	payload, _ := json.Marshal(map[string]any{"model": "kmodel_latest", "input": []any{
		map[string]any{"type": "function_call", "call_id": "old", "name": name, "arguments": "{}"},
		map[string]any{"type": "function_call_output", "call_id": "old", "output": "previous result"},
	}, "tools": []any{map[string]any{"type": "function", "name": name, "parameters": map[string]any{"type": "object"}}}, "tool_choice": map[string]any{"type": "function", "name": name}})
	native := func(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
		short := gjson.GetBytes(req.Payload, "tools.0.function.name").String()
		if len(short) > 64 {
			t.Fatalf("Qoder rejects tool name length %d", len(short))
		}
		if gjson.GetBytes(req.Payload, "tool_choice.function.name").String() != short || gjson.GetBytes(req.Payload, "messages.0.tool_calls.0.function.name").String() != short {
			t.Fatal("tool selection/history did not use the same alias")
		}
		chunks := make(chan cliproxyexecutor.StreamChunk, 2)
		first, _ := json.Marshal(map[string]any{"id": "fixture", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "new", "type": "function", "function": map[string]any{"name": short, "arguments": "{}"}}}}, "finish_reason": "tool_calls"}}})
		chunks <- cliproxyexecutor.StreamChunk{Payload: first}
		close(chunks)
		return &cliproxyexecutor.StreamResult{Headers: http.Header{}, Chunks: chunks}, nil
	}
	opts := cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAIResponse, OriginalRequest: payload}
	result, err := executeAgentResponse(context.Background(), nil, cliproxyexecutor.Request{Model: "kmodel_latest", Payload: payload}, opts, native)
	if err != nil {
		t.Fatal(err)
	}
	if gjson.GetBytes(result.Payload, "output.0.name").String() != name {
		t.Fatal("tool name was not restored")
	}
}

func TestQoderInvalidParameterIsRequestFault(t *testing.T) {
	body := `data: {"body":"{\"error\":{\"code\":\"invalid_parameter_error\",\"type\":\"invalid_request_error\",\"message\":\"The length of the tool name cannot exceed 64. private-payload\"}}"}` + "\n\n"
	resp := &http.Response{Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}
	stream := readAgentChatStream(context.Background(), resp, "qoder")
	var failure error
	for chunk := range stream.Chunks {
		if chunk.Err != nil {
			failure = chunk.Err
		}
	}
	typed, ok := failure.(interface{ StatusCode() int })
	if !ok || typed.StatusCode() != 400 {
		t.Fatalf("parameter error poisoned source health: %v", failure)
	}
	if !strings.Contains(failure.Error(), "a2a_invalid_request") || strings.Contains(failure.Error(), "private-payload") {
		t.Fatal("missing safe request category or exposed diagnostic")
	}
}

// An application-level denial can arrive in an HTTP 200 SSE stream which
// remains open. Classify it before waiting for more events or transport EOF.
func TestQoderResourceLimitFrameFailsBeforeOpenStreamEnds(t *testing.T) {
	reader, writer := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer reader.Close()
	defer writer.Close()
	queue, _ := json.Marshal(map[string]any{"isQueued": true, "modelKey": "dfmodel", "queueCount": 0, "queueType": "p3", "retryAfterSeconds": 30, "serviceAvailable": false, "subCode": "RESOURCE_LIMIT"})
	body, _ := json.Marshal(map[string]any{"code": "10605", "message": string(queue)})
	envelope, _ := json.Marshal(map[string]any{"statusCode": "FORBIDDEN", "statusCodeValue": 403, "body": string(body)})
	stream := readAgentChatStream(ctx, &http.Response{StatusCode: http.StatusOK, Body: reader, Header: http.Header{"Content-Type": []string{"text/event-stream"}}}, "qoder")
	go func() {
		// Do not close the pipe: the production denial frame leaves SSE open.
		_, _ = fmt.Fprintf(writer, "data: %s\n\n", envelope)
	}()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	for {
		select {
		case chunk, ok := <-stream.Chunks:
			if !ok {
				t.Fatal("resource-limited stream ended without a classified failure")
			}
			if chunk.Err == nil {
				continue
			}
			typed, ok := chunk.Err.(interface{ StatusCode() int })
			if !ok || typed.StatusCode() != http.StatusTooManyRequests {
				t.Fatalf("resource limit must be retryable HTTP 429, got %v", chunk.Err)
			}
			if !strings.Contains(chunk.Err.Error(), "qoder_resource_limit") {
				t.Fatal("resource limit lost its explicit safe category")
			}
			if _, ok := <-stream.Chunks; ok {
				t.Fatal("resource-limited stream did not terminate")
			}
			if _, err := writer.Write([]byte("unexpected event")); err != io.ErrClosedPipe {
				t.Fatal("resource-limited upstream body was not closed")
			}
			return
		case <-deadline.C:
			t.Fatal("RESOURCE_LIMIT frame was ignored while the upstream SSE connection remained open")
		}
	}
}

func TestQoderEnvelopeFailuresAreSafeAndBounded(t *testing.T) {
	for _, tc := range []struct {
		name       string
		status     int
		body       any
		wantStatus int
		code       string
		retry      time.Duration
	}{
		{"object resource", 403, map[string]any{"code": "10605", "message": map[string]any{"subCode": "RESOURCE_LIMIT", "retryAfterSeconds": 999999}}, 429, "qoder_resource_limit", 300 * time.Second},
		{"string resource", 403, `{"code":"10605","message":"{\"subCode\":\"RESOURCE_LIMIT\",\"retryAfterSeconds\":-1}"}`, 429, "qoder_resource_limit", 30 * time.Second},
		{"structured subcode", 403, map[string]any{"subCode": "RESOURCE_LIMIT", "retryAfterSeconds": 5}, 429, "qoder_resource_limit", 5 * time.Second},
		{"authentication", 401, map[string]any{"message": "private-payload"}, 401, "qoder_authentication_failed", 0},
		{"forbidden plain text", 403, map[string]any{"message": "private-payload RESOURCE_LIMIT"}, 403, "qoder_access_denied", 0},
		{"server failure", 503, `{"message":"private-payload"}`, 503, "qoder_upstream_error", 0},
		{"request failure", 422, map[string]any{"message": "private-payload"}, 422, "qoder_request_rejected", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			envelope, _ := json.Marshal(map[string]any{"statusCodeValue": tc.status, "body": tc.body})
			stream := readAgentChatStream(context.Background(), &http.Response{Body: io.NopCloser(strings.NewReader("data: " + string(envelope) + "\n\n")), Header: http.Header{}}, "qoder")
			chunk, ok := <-stream.Chunks
			if !ok || chunk.Err == nil {
				t.Fatal("error envelope became model output")
			}
			typed, ok := chunk.Err.(interface {
				StatusCode() int
				RetryAfter() *time.Duration
			})
			if !ok || typed.StatusCode() != tc.wantStatus {
				t.Fatalf("wrong status: %v", chunk.Err)
			}
			if !strings.Contains(chunk.Err.Error(), tc.code) || strings.Contains(chunk.Err.Error(), "private-payload") {
				t.Fatal("missing safe code or leaked message")
			}
			retry := typed.RetryAfter()
			if tc.retry == 0 && retry != nil || tc.retry != 0 && (retry == nil || *retry != tc.retry) {
				t.Fatal("wrong retry bound")
			}
			if _, ok := <-stream.Chunks; ok {
				t.Fatal("error envelope did not terminate stream")
			}
		})
	}
}

func TestQoderSuccessfulEnvelopeDoesNotClassifyOutputAsResourceLimit(t *testing.T) {
	for _, wrapped := range []bool{false, true} {
		body := `{"choices":[{"delta":{"content":"RESOURCE_LIMIT"},"finish_reason":"stop"}]}`
		var value any = json.RawMessage(body)
		if wrapped {
			value = body
		}
		envelope, _ := json.Marshal(map[string]any{"statusCodeValue": 200, "body": value})
		stream := readAgentChatStream(context.Background(), &http.Response{Body: io.NopCloser(strings.NewReader("data: " + string(envelope) + "\n\ndata: [DONE]\n\n")), Header: http.Header{}}, "qoder")
		count := 0
		for chunk := range stream.Chunks {
			if chunk.Err != nil {
				t.Fatal(chunk.Err)
			}
			count++
		}
		if count != 1 {
			t.Fatalf("successful event lost: %d", count)
		}
	}
}

func TestQoderRejectsMissingAccountIdentity(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(http.StatusOK) }))
	defer server.Close()
	exec := NewQoderExecutor(&config.Config{})
	auth := &cliproxyauth.Auth{ID: "fixture", Provider: "qoder", Attributes: map[string]string{"chat_url": server.URL}, Metadata: map[string]any{"access_token": "synthetic"}}
	_, err := exec.Execute(context.Background(), auth, cliproxyexecutor.Request{Model: "kmodel_latest", Payload: []byte(`{"messages":[{"role":"user","content":"OK"}]}`)}, cliproxyexecutor.Options{SourceFormat: sdktranslator.FromString("openai")})
	if err == nil || !strings.Contains(err.Error(), "account identity missing") {
		t.Fatalf("expected missing identity rejection, got %v", err)
	}
	if calls != 0 {
		t.Fatal("request with missing account identity reached upstream")
	}
}

// A blocked upstream body must be released when the caller stops a long task.
func TestQoderStreamCancellationClosesBody(t *testing.T) {
	reader, writer := io.Pipe()
	defer writer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	stream := readAgentChatStream(ctx, &http.Response{Body: reader, Header: http.Header{}}, "qoder")
	cancel()
	select {
	case _, ok := <-stream.Chunks:
		if ok {
			t.Fatal("cancelled stream returned an event")
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not unblock the upstream reader")
	}
}

func TestQoderLargeToolArgumentsAndStandaloneUsage(t *testing.T) {
	argument := strings.Repeat("x", 2*1024*1024)
	body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "large", "type": "function", "function": map[string]any{"name": "write", "arguments": argument}}}}, "finish_reason": "tool_calls"}}})
	wire := "data: " + string(body) + "\n\ndata: {\"usage\":{\"prompt_tokens\":300,\"completion_tokens\":4,\"total_tokens\":304,\"prompt_tokens_details\":{\"cached_tokens\":250}}}\n\ndata: [DONE]\n\n"
	stream := readAgentChatStream(context.Background(), &http.Response{Body: io.NopCloser(strings.NewReader(wire)), Header: http.Header{}}, "qoder")
	events := 0
	for chunk := range stream.Chunks {
		if chunk.Err != nil {
			t.Fatal(chunk.Err)
		}
		events++
		if events == 1 && len(gjson.GetBytes(chunk.Payload, "choices.0.delta.tool_calls.0.function.arguments").String()) != len(argument) {
			t.Fatal("large tool arguments truncated")
		}
		if events == 2 && (gjson.GetBytes(chunk.Payload, "usage.prompt_tokens").Int() != 300 || !gjson.GetBytes(chunk.Payload, "choices").IsArray()) {
			t.Fatal("standalone usage lost")
		}
	}
	if events != 2 {
		t.Fatalf("got %d events, expected tool + usage", events)
	}
}

func TestQoderStandaloneUsageReachesClientAccounting(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"usage\":{\"prompt_tokens\":300,\"completion_tokens\":4,\"total_tokens\":304,\"prompt_tokens_details\":{\"cached_tokens\":250}}}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	exec := NewQoderExecutor(&config.Config{})
	auth := &cliproxyauth.Auth{ID: "fixture", Provider: "qoder", Attributes: map[string]string{"chat_url": server.URL}, Metadata: map[string]any{"access_token": "synthetic", "uid": "fixture-user"}}
	req := cliproxyexecutor.Request{Model: "kmodel_latest", Payload: []byte(`{"input":"OK","max_output_tokens":16}`)}
	result, err := exec.Execute(context.Background(), auth, req, cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAIResponse})
	if err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]int64{"usage.input_tokens": 300, "usage.output_tokens": 4, "usage.input_tokens_details.cached_tokens": 250} {
		if got := gjson.GetBytes(result.Payload, path).Int(); got != want {
			t.Fatalf("%s=%d, want %d", path, got, want)
		}
	}
}

func TestQoderWireKeepsHeaderAndSelectedModelConsistent(t *testing.T) {
	for _, format := range []sdktranslator.Format{sdktranslator.FormatOpenAI, sdktranslator.FormatOpenAIResponse, sdktranslator.FormatClaude} {
		for _, model := range []string{"Kimi-K3", "Qwen3.8-Max"} {
			t.Run(string(format)+model, func(t *testing.T) {
				key := "kmodel_latest"
				if model == "Qwen3.8-Max" {
					key = "qmodel_38max"
				}
				checked := false
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					raw, err := io.ReadAll(r.Body)
					if err != nil {
						t.Error(err)
						return
					}
					const alphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!"
					const standard = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
					var b strings.Builder
					for _, c := range string(raw) {
						if c == '$' {
							b.WriteByte('=')
						} else if i := strings.IndexRune(alphabet, c); i >= 0 {
							b.WriteByte(standard[i])
						} else {
							t.Error("invalid encoded byte")
							return
						}
					}
					encoded := b.String()
					n := len(encoded) / 3
					decoded, err := base64.StdEncoding.DecodeString(encoded[len(encoded)-n:] + encoded[n:len(encoded)-n] + encoded[:n])
					if err != nil {
						t.Error(err)
						return
					}
					if gjson.GetBytes(decoded, "business.model_key").Exists() {
						t.Fatal("redundant business model key must be absent")
					}
					for _, path := range []string{"model_config.key", "chat_context.extra.modelConfig.key"} {
						if got := gjson.GetBytes(decoded, path).String(); got != key {
							t.Errorf("%s=%s, want %s", path, got, key)
						}
					}
					if r.Header.Get("X-Model-Key") != key {
						t.Error("model header diverged")
					}
					if gjson.GetBytes(decoded, "parameters.context_length").Int() != 400000 || gjson.GetBytes(decoded, "parameters.reasoning_effort").String() != "max" {
						t.Errorf("selected runtime controls lost across %s translation", format)
					}
					checked = true
					fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
				}))
				defer server.Close()
				payload := []byte(`{"model":"stale","messages":[{"role":"user","content":"OK"}],"input":"OK","max_tokens":16,"max_output_tokens":16,"context_length":400000,"reasoning_effort":"max","reasoning":{"effort":"max"},"output_config":{"effort":"max"}}`)
				auth := &cliproxyauth.Auth{Provider: "qoder", Attributes: map[string]string{"chat_url": server.URL}, Metadata: map[string]any{"access_token": "synthetic", "uid": "fixture"}}
				_, err := NewQoderExecutor(&config.Config{}).Execute(context.Background(), auth, cliproxyexecutor.Request{Model: model, Payload: payload}, cliproxyexecutor.Options{SourceFormat: format, OriginalRequest: payload})
				if err != nil {
					t.Fatal(err)
				}
				if !checked {
					t.Fatal("request was not sent")
				}
			})
		}
	}
}

func TestQoderAccountingLogsOnlyTypedBillingFields(t *testing.T) {
	logger := log.StandardLogger()
	originalHooks := logger.ReplaceHooks(make(log.LevelHooks))
	defer logger.ReplaceHooks(originalHooks)
	hook := logtest.NewGlobal()
	for _, usage := range []string{`{"billable":false,"credits":0}`, `{"billable":true,"credits":0.125}`} {
		logQoderAccounting(gjson.Parse(`{"usage":` + usage + `,"content":"PRIVATE","authorization":"SECRET"}`))
		entry := hook.LastEntry()
		if entry == nil {
			t.Fatal("missing billing log")
		}
		if len(entry.Data) != 3 || entry.Data["billable"] != gjson.Get(usage, "billable").Bool() || entry.Data["credits"] != gjson.Get(usage, "credits").Float() {
			t.Fatalf("unexpected fields: %v", entry.Data)
		}
		serialized, _ := entry.String()
		if bytes.Contains([]byte(serialized), []byte("PRIVATE")) || bytes.Contains([]byte(serialized), []byte("SECRET")) {
			t.Fatal("private data leaked")
		}
	}
	hook.Reset()
	logQoderAccounting(gjson.Parse(`{"usage":{"billable":"SECRET","credits":"PRIVATE"}}`))
	if hook.LastEntry() != nil {
		t.Fatal("invalid accounting fields logged")
	}
}

// The recorded production failure is EOF from Do, before response headers.
// A socket that closes once must recover without replaying any emitted output.
func TestQoderRecoversOnePreHeaderEOF(t *testing.T) {
	var attempts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			conn.Close()
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"body\":\"{\\\"id\\\":\\\"fixture\\\",\\\"model\\\":\\\"kmodel_latest\\\",\\\"choices\\\":[{\\\"index\\\":0,\\\"delta\\\":{\\\"content\\\":\\\"OK\\\"},\\\"finish_reason\\\":\\\"stop\\\"}]}\"}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	executor := NewQoderExecutor(&config.Config{})
	auth := &cliproxyauth.Auth{ID: "fixture", Provider: "qoder", Attributes: map[string]string{"chat_url": server.URL}, Metadata: map[string]any{"access_token": "synthetic", "uid": "fixture-user"}}
	req := cliproxyexecutor.Request{Model: "kmodel_latest", Payload: []byte(`{"messages":[{"role":"user","content":"OK"}]}`)}
	result, err := executor.ExecuteStream(context.Background(), auth, req, cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAI, OriginalRequest: req.Payload})
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	for chunk := range result.Chunks {
		if chunk.Err != nil {
			t.Fatal(chunk.Err)
		}
		output.Write(chunk.Payload)
	}
	if attempts != 2 || !strings.Contains(output.String(), "OK") {
		t.Fatalf("attempts=%d, output=%s", attempts, output.String())
	}
}

func TestQoderPreHeaderEOFRetryIsBounded(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		conn.Close()
	}))
	defer server.Close()
	executor := NewQoderExecutor(&config.Config{})
	auth := &cliproxyauth.Auth{ID: "fixture", Provider: "qoder", Attributes: map[string]string{"chat_url": server.URL}, Metadata: map[string]any{"access_token": "synthetic", "uid": "fixture-user"}}
	req := cliproxyexecutor.Request{Model: "kmodel_latest", Payload: []byte(`{"messages":[{"role":"user","content":"OK"}]}`)}
	_, err := executor.ExecuteStream(context.Background(), auth, req, cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAI, OriginalRequest: req.Payload})
	if err == nil || attempts != 2 {
		t.Fatalf("err=%v attempts=%d", err, attempts)
	}
}

func TestQoderCapacityWait(t *testing.T) {
	resource := func(delay time.Duration) error {
		return statusErr{code: 429, msg: `{"error":{"code":"qoder_resource_limit"}}`, retryAfter: &delay}
	}
	cases := []struct {
		name    string
		failure error
		output  bool
		budget  time.Duration
		want    int
	}{
		{"resource retries", resource(time.Millisecond), false, time.Second, 3},
		{"generic 429", statusErr{code: 429, msg: `{"error":{"code":"qoder_rate_limited"}}`}, false, time.Second, 1},
		{"quota", statusErr{code: 429, msg: `{"error":{"code":"quota_exceeded"}}`}, false, time.Second, 1},
		{"retry after exceeds budget", resource(time.Second), false, time.Millisecond, 1},
		{"never replay output", resource(time.Millisecond), true, time.Second, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			native := func(context.Context, *cliproxyauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
				calls++
				chunks := make(chan cliproxyexecutor.StreamChunk, 2)
				if tc.output {
					chunks <- cliproxyexecutor.StreamChunk{Payload: []byte("model event")}
				}
				chunks <- cliproxyexecutor.StreamChunk{Err: tc.failure}
				close(chunks)
				return &cliproxyexecutor.StreamResult{Chunks: chunks}, nil
			}
			stream, err := qoderWaitForCapacity(context.Background(), nil, cliproxyexecutor.Request{}, cliproxyexecutor.Options{}, native, tc.budget)
			if tc.output {
				if err != nil {
					t.Fatal(err)
				}
				count := 0
				for range stream.Chunks {
					count++
				}
				if count != 2 {
					t.Fatalf("got %d events", count)
				}
			} else if err == nil {
				chunk := <-stream.Chunks
				if chunk.Err == nil {
					t.Fatal("expected error")
				}
			}
			if calls != tc.want {
				t.Fatalf("calls=%d want %d", calls, tc.want)
			}
		})
	}
	t.Run("cancel wait", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		native := func(context.Context, *cliproxyauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
			cancel()
			return nil, resource(time.Second)
		}
		_, err := qoderWaitForCapacity(ctx, nil, cliproxyexecutor.Request{}, cliproxyexecutor.Options{}, native, time.Minute)
		if err != context.Canceled {
			t.Fatalf("got %v", err)
		}
	})
}

func TestQoderCapacityWaitRecovers(t *testing.T) {
	calls := 0
	delay := time.Millisecond
	native := func(context.Context, *cliproxyauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
		calls++
		chunks := make(chan cliproxyexecutor.StreamChunk, 1)
		if calls == 1 {
			chunks <- cliproxyexecutor.StreamChunk{Err: statusErr{code: 429, msg: `{"error":{"code":"qoder_resource_limit"}}`, retryAfter: &delay}}
		} else {
			chunks <- cliproxyexecutor.StreamChunk{Payload: []byte("recovered")}
		}
		close(chunks)
		return &cliproxyexecutor.StreamResult{Chunks: chunks}, nil
	}
	started := time.Now()
	stream, err := qoderWaitForCapacity(context.Background(), nil, cliproxyexecutor.Request{}, cliproxyexecutor.Options{}, native, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	chunk := <-stream.Chunks
	if string(chunk.Payload) != "recovered" || calls != 2 || time.Since(started) < delay {
		t.Fatalf("unexpected recovery calls=%d", calls)
	}
	for range stream.Chunks {
	}
}

func TestQoderHTTPResourceLimit(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(http.StatusTooManyRequests)
		fmt.Fprint(w, `{"code":"10605","subCode":"RESOURCE_LIMIT","retryAfterSeconds":1}`)
	}))
	defer server.Close()
	executor := NewQoderExecutor(&config.Config{})
	auth := &cliproxyauth.Auth{Attributes: map[string]string{"chat_url": server.URL}, Metadata: map[string]any{"access_token": "synthetic", "uid": "fixture-user"}}
	req := cliproxyexecutor.Request{Model: "kmodel_latest", Payload: []byte(`{"messages":[{"role":"user","content":"Hi"}]}`)}
	_, err := executor.executeNativeStream(context.Background(), auth, req, cliproxyexecutor.Options{})
	status, ok := err.(statusErr)
	if !ok || status.code != 429 || !strings.Contains(status.msg, "qoder_capacity_wait_exhausted") || status.retryAfter == nil || *status.retryAfter != 120*time.Second || calls != 1 {
		t.Fatalf("unexpected capacity result calls=%d", calls)
	}
}
