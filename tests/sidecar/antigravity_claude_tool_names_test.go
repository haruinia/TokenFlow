package claude

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

func tokenFlowNameRequest(names []string) []byte {
	tools := make([]any, 0, len(names))
	calls := make([]any, 0, len(names))
	results := make([]any, 0, len(names))
	for _, name := range names {
		tools = append(tools, map[string]any{"name": name, "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}})
		calls = append(calls, map[string]any{"type": "tool_use", "id": name, "name": name, "input": map[string]any{}})
		results = append(results, map[string]any{"type": "tool_result", "tool_use_id": name, "content": "synthetic result"})
	}
	raw, _ := json.Marshal(map[string]any{"model": "claude-sonnet-4-6", "max_tokens": 1024, "tools": tools, "tool_choice": map[string]any{"type": "tool", "name": names[0]}, "messages": []any{map[string]any{"role": "user", "content": "synthetic task"}, map[string]any{"role": "assistant", "content": calls}, map[string]any{"role": "user", "content": results}}})
	return raw
}

func TestTokenFlowAntigravityClaudeNames(t *testing.T) {
	names := []string{"mcp__fixture.read", "mcp__fixture:read", "mcp__fixture_read", strings.Repeat("a", 129), strings.Repeat("a", 128) + "b", "1-valid", "plain_name"}
	raw := tokenFlowNameRequest(names)
	translated := ConvertClaudeRequestToAntigravity("claude-sonnet-4-6", raw, false)
	declarations := gjson.GetBytes(translated, "request.tools.0.functionDeclarations").Array()
	if len(declarations) != len(names) {
		t.Fatalf("declarations=%d want=%d", len(declarations), len(names))
	}
	allowed := regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)
	seen := make(map[string]bool)
	mapped := make(map[string]string)
	for i, decl := range declarations {
		name := decl.Get("name").String()
		if !allowed.MatchString(name) || seen[name] {
			t.Errorf("invalid or colliding declaration %q", name)
		}
		seen[name] = true
		mapped[names[i]] = name
	}
	for _, content := range gjson.GetBytes(translated, "request.contents").Array() {
		for _, part := range content.Get("parts").Array() {
			if call := part.Get("functionCall"); call.Exists() {
				if mapped[call.Get("id").String()] != call.Get("name").String() {
					t.Errorf("history call mapping mismatch: %s", call.Raw)
				}
			}
			if result := part.Get("functionResponse"); result.Exists() {
				if !seen[result.Get("name").String()] {
					t.Errorf("history result mapping mismatch: %s", result.Raw)
				}
			}
		}
	}
	if got := gjson.GetBytes(translated, "request.toolConfig.functionCallingConfig.allowedFunctionNames.0").String(); got != mapped[names[0]] {
		t.Errorf("tool choice=%q want %q", got, mapped[names[0]])
	}
	for original, name := range mapped {
		response, _ := json.Marshal(map[string]any{"response": map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"role": "model", "parts": []any{map[string]any{"functionCall": map[string]any{"name": name, "args": map[string]any{}}}}}, "finishReason": "STOP"}}}})
		var state any
		nonStream := ConvertAntigravityResponseToClaudeNonStream(context.Background(), "claude-sonnet-4-6", raw, translated, response, &state)
		if got := gjson.GetBytes(nonStream, "content.0.name").String(); got != original {
			t.Errorf("nonstream restore=%q want=%q", got, original)
		}
		state = nil
		events := ConvertAntigravityResponseToClaude(context.Background(), "claude-sonnet-4-6", raw, translated, response, &state)
		found := false
		for _, event := range events {
			for _, line := range strings.Split(string(event), "\n") {
				if strings.HasPrefix(line, "data: ") {
					if gjson.Get(strings.TrimPrefix(line, "data: "), "content_block.name").String() == original {
						found = true
					}
				}
			}
		}
		if !found {
			t.Errorf("stream did not restore %q", original)
		}
	}
	// Sorting makes collisions independent of client declaration order.
	reversed := append([]string(nil), names...)
	for i, j := 0, len(reversed)-1; i < j; i, j = i+1, j-1 {
		reversed[i], reversed[j] = reversed[j], reversed[i]
	}
	other := ConvertClaudeRequestToAntigravity("claude-sonnet-4-6", tokenFlowNameRequest(reversed), false)
	for i, decl := range gjson.GetBytes(other, "request.tools.0.functionDeclarations").Array() {
		if decl.Get("name").String() != mapped[reversed[i]] {
			t.Error("mapping depends on declaration order")
		}
	}
}

func TestTokenFlowAntigravityClaudeHistoryOnlyName(t *testing.T) {
	raw := []byte(`{"model":"claude-sonnet-4-6","max_tokens":1024,"tools":[{"name":"current","input_schema":{"type":"object"}}],"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"old","name":"removed.tool:read","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"old","content":"synthetic"}]}]}`)
	translated := ConvertClaudeRequestToAntigravity("claude-sonnet-4-6", raw, false)
	if !strings.Contains(string(translated), `"name":"removed_tool_read"`) {
		t.Fatal("historical tool omitted from Claude sanitization")
	}
	if strings.Contains(string(translated), `removed.tool:read`) {
		t.Fatal("historical original name leaked upstream")
	}
}

func TestTokenFlowAntigravityGeminiNamesUnchanged(t *testing.T) {
	raw := tokenFlowNameRequest([]string{"mcp__fixture.read:detail"})
	translated := ConvertClaudeRequestToAntigravity("gemini-3.8-flash-high", raw, false)
	if got := gjson.GetBytes(translated, "request.tools.0.functionDeclarations.0.name").String(); got != "mcp__fixture.read:detail" {
		t.Errorf("Gemini name changed: %q", got)
	}
}
