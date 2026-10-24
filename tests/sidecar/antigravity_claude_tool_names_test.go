package claude

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

// The future ID is synthetic: it tests family dispatch, not vendor availability.
var tokenFlowClaudeNameModels = []string{"claude-opus-4-6", "claude-opus-4-6-thinking", "claude-sonnet-4-6", "claude-future-synthetic-2099"}

func tokenFlowNameRequest(model string, names []string) []byte {
	tools := make([]any, 0, len(names))
	calls := make([]any, 0, len(names))
	results := make([]any, 0, len(names))
	for _, name := range names {
		tools = append(tools, map[string]any{"name": name, "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}})
		calls = append(calls, map[string]any{"type": "tool_use", "id": name, "name": name, "input": map[string]any{}})
		results = append(results, map[string]any{"type": "tool_result", "tool_use_id": name, "content": "synthetic result"})
	}
	raw, _ := json.Marshal(map[string]any{"model": model, "max_tokens": 1024, "tools": tools, "tool_choice": map[string]any{"type": "tool", "name": names[0]}, "messages": []any{map[string]any{"role": "user", "content": "synthetic task"}, map[string]any{"role": "assistant", "content": calls}, map[string]any{"role": "user", "content": results}}})
	return raw
}

func TestTokenFlowAntigravityClaudeNames(t *testing.T) {
	for _, model := range tokenFlowClaudeNameModels {
		t.Run(model, func(t *testing.T) {
			names := []string{"mcp__fixture.read", "mcp__fixture:read", "mcp__fixture_read", strings.Repeat("a", 129), strings.Repeat("a", 128) + "b", "1-valid", "plain_name"}
			raw := tokenFlowNameRequest(model, names)
			translated := ConvertClaudeRequestToAntigravity(model, raw, false)
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
				nonStream := ConvertAntigravityResponseToClaudeNonStream(context.Background(), model, raw, translated, response, &state)
				if got := gjson.GetBytes(nonStream, "content.0.name").String(); got != original {
					t.Errorf("nonstream restore=%q want=%q", got, original)
				}
				state = nil
				events := ConvertAntigravityResponseToClaude(context.Background(), model, raw, translated, response, &state)
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
			other := ConvertClaudeRequestToAntigravity(model, tokenFlowNameRequest(model, reversed), false)
			for i, decl := range gjson.GetBytes(other, "request.tools.0.functionDeclarations").Array() {
				if decl.Get("name").String() != mapped[reversed[i]] {
					t.Error("mapping depends on declaration order")
				}
			}
		})
	}
}

func TestTokenFlowAntigravityClaudeHistoryOnlyName(t *testing.T) {
	for _, model := range tokenFlowClaudeNameModels {
		t.Run(model, func(t *testing.T) {
			raw := []byte(strings.Replace(`{"model":"claude-sonnet-4-6","max_tokens":1024,"tools":[{"name":"current","input_schema":{"type":"object"}}],"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"old","name":"removed.tool:read","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"old","content":"synthetic"}]}]}`, "claude-sonnet-4-6", model, 1))
			translated := ConvertClaudeRequestToAntigravity(model, raw, false)
			if !strings.Contains(string(translated), `"name":"removed_tool_read"`) {
				t.Fatal("historical tool omitted from Claude sanitization")
			}
			if strings.Contains(string(translated), `removed.tool:read`) {
				t.Fatal("historical original name leaked upstream")
			}
		})
	}
}

func TestTokenFlowAntigravityGeminiNamesUnchanged(t *testing.T) {
	raw := tokenFlowNameRequest("gemini-3.8-flash-high", []string{"mcp__fixture.read:detail"})
	translated := ConvertClaudeRequestToAntigravity("gemini-3.8-flash-high", raw, false)
	if got := gjson.GetBytes(translated, "request.tools.0.functionDeclarations.0.name").String(); got != "mcp__fixture.read:detail" {
		t.Errorf("Gemini name changed: %q", got)
	}
}

func TestTokenFlowAntigravityClaudeToolResultAdjacency(t *testing.T) {
	for _, model := range append(append([]string(nil), tokenFlowClaudeNameModels...), "gemini-3.8-flash-high") {
		for _, reminderPosition := range []string{"after-results", "between-call-and-results", "both"} {
			t.Run(model+"/"+reminderPosition, func(t *testing.T) {
				calls, results := []any{}, []any{}
				for _, id := range []string{"synthetic-call-1", "synthetic-call-2", "synthetic-call-3"} {
					calls = append(calls, map[string]any{"type": "tool_use", "id": id, "name": "fixture_tool", "input": map[string]any{}})
					results = append(results, map[string]any{"type": "tool_result", "tool_use_id": id, "content": "synthetic result"})
				}
				messages := []any{map[string]any{"role": "user", "content": "synthetic task"}, map[string]any{"role": "system", "content": "synthetic initial reminder"}, map[string]any{"role": "assistant", "content": calls}}
				if reminderPosition != "after-results" {
					messages = append(messages, map[string]any{"role": "system", "content": "synthetic intermediate reminder"})
				}
				messages = append(messages, map[string]any{"role": "user", "content": results})
				if reminderPosition != "between-call-and-results" {
					messages = append(messages, map[string]any{"role": "system", "content": "synthetic final reminder"})
				}
				raw, _ := json.Marshal(map[string]any{"model": model, "max_tokens": 1024, "tools": []any{map[string]any{"name": "fixture_tool", "input_schema": map[string]any{"type": "object"}}}, "messages": messages})
				converted := ConvertClaudeRequestToAntigravity(model, raw, false)
				contents := gjson.GetBytes(converted, "request.contents").Array()
				if len(contents) != 3 {
					t.Fatalf("contents=%d want user/model/user", len(contents))
				}
				if contents[1].Get("role").String() != "model" || contents[2].Get("role").String() != "user" {
					t.Fatal("tool turn roles changed")
				}
				parts := contents[2].Get("parts").Array()
				var ids []string
				for _, p := range parts {
					if fr := p.Get("functionResponse"); fr.Exists() {
						ids = append(ids, fr.Get("id").String())
					}
				}
				if strings.Join(ids, ",") != "synthetic-call-1,synthetic-call-2,synthetic-call-3" {
					t.Fatal("tool result IDs changed or missing")
				}
				if strings.Contains(model, "claude") {
					for i := 0; i < 3; i++ {
						if !parts[i].Get("functionResponse").Exists() {
							t.Fatalf("tool result %d must precede reminder text", i)
						}
					}
				} else if !parts[0].Get("text").Exists() {
					t.Fatal("Gemini text-before-functionResponse behavior changed")
				}
				reminders := 0
				for _, p := range parts {
					if p.Get("text").Exists() {
						reminders++
					}
				}
				want := 1
				if reminderPosition == "both" {
					want = 2
				}
				if reminders != want {
					t.Fatalf("reminder parts=%d want=%d", reminders, want)
				}
			})
		}
	}
}

func TestTokenFlowAntigravityClaudeResultOrderingPreservesSignedModelParts(t *testing.T) {
	// Opaque synthetic bytes test preservation only, not signature validity.
	modelContent := []byte(`{"role":"model","parts":[{"text":"synthetic thought","thought":true,"thoughtSignature":"synthetic-opaque-carrier"},{"functionCall":{"id":"synthetic-call","name":"fixture","args":{}}}]}`)
	for _, model := range tokenFlowClaudeNameModels {
		t.Run(model, func(t *testing.T) {
			contents := [][]byte{modelContent, []byte(`{"role":"user","parts":[{"functionResponse":{"id":"synthetic-call","name":"fixture","response":{"result":"synthetic result"}}}]}`), []byte(`{"role":"user","parts":[{"text":"synthetic reminder"}]}`)}
			merged := antigravityMergeClaudeContents(model, contents)
			if string(merged[0]) != string(modelContent) {
				t.Fatal("model parts or signature bytes changed")
			}
			if gjson.GetBytes(merged[1], "parts.0.functionResponse.id").String() != "synthetic-call" || gjson.GetBytes(merged[1], "parts.1.text").String() != "synthetic reminder" {
				t.Fatal("result or reminder content changed")
			}
		})
	}
}
