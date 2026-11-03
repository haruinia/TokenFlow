package helps

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/registry"
	"github.com/tidwall/gjson"
)

func TestQoderPreservesAgentContext(t *testing.T) {
	body, err := BuildQoderRequestBody([]byte(`{"messages":[{"role":"system","content":"fixture-system"},{"role":"user","content":[{"type":"text","text":"use lookup"}]},{"role":"assistant","content":null,"tool_calls":[{"id":"call_a","type":"function","function":{"name":"lookup","arguments":"{}"}}]},{"role":"tool","tool_call_id":"call_a","content":"fixture-result"}],"tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}],"max_tokens":64}`), "kmodel_latest", true)
	if err != nil {
		t.Fatal(err)
	}
	if gjson.GetBytes(body, "messages.2.content").Type != gjson.String {
		t.Error("Qoder requires text content even on a tool-only assistant message")
	}
	for path, want := range map[string]string{"system": "fixture-system", "messages.0.role": "system", "messages.0.content": "fixture-system", "messages.1.content.0.text": "use lookup", "messages.2.tool_calls.0.id": "call_a", "messages.3.tool_call_id": "call_a", "messages.3.content": "fixture-result", "tools.0.function.name": "lookup", "parameters.max_tokens": "64"} {
		if got := gjson.GetBytes(body, path).String(); got != want {
			t.Errorf("%s = %q, want %q", path, got, want)
		}
	}
}

func TestQoderHonorsDisabledThinking(t *testing.T) {
	for _, effort := range []string{"none", "medium", ""} {
		t.Run(effort, func(t *testing.T) {
			body, err := BuildQoderRequestBody([]byte(`{"messages":[{"role":"user","content":"OK"}],"reasoning_effort":"`+effort+`"}`), "kmodel_latest", true)
			if err != nil {
				t.Fatal(err)
			}
			for _, path := range []string{"parameters.enable_thinking", "chat_context.extra.modelConfig.is_reasoning", "model_config.is_reasoning"} {
				if got := gjson.GetBytes(body, path).Bool(); got != (effort != "none") {
					t.Errorf("%s = %v for effort %q", path, got, effort)
				}
			}
		})
	}
}

func TestQoderLongConversationKeepsCallerInstructionsAndToolPairs(t *testing.T) {
	instructions := "You are the caller agent. Preserve this policy exactly."
	messages := []any{map[string]any{"role": "system", "content": instructions}}
	for turn := 0; turn < 40; turn++ {
		id := fmt.Sprintf("call_%d", turn)
		messages = append(messages, map[string]any{"role": "user", "content": strings.Repeat("context ", 1000)}, map[string]any{"role": "assistant", "content": nil, "tool_calls": []any{map[string]any{"id": id, "type": "function", "function": map[string]any{"name": "lookup", "arguments": "{}"}}}}, map[string]any{"role": "tool", "tool_call_id": id, "content": fmt.Sprintf("RESULT_%d", turn)})
	}
	payload, _ := json.Marshal(map[string]any{"messages": messages, "max_tokens": 256, "parallel_tool_calls": false})
	body, err := BuildQoderRequestBody(payload, "kmodel_latest", false)
	if err != nil {
		t.Fatal(err)
	}
	if gjson.GetBytes(body, "messages.#").Int() != 121 {
		t.Fatal("long history truncated")
	}
	if gjson.GetBytes(body, "system").String() != instructions {
		t.Fatal("caller instructions changed or coding preset added")
	}
	for turn := 0; turn < 40; turn++ {
		assistant := 2 + turn*3
		result := 3 + turn*3
		id := fmt.Sprintf("call_%d", turn)
		if gjson.GetBytes(body, fmt.Sprintf("messages.%d.tool_calls.0.id", assistant)).String() != id || gjson.GetBytes(body, fmt.Sprintf("messages.%d.tool_call_id", result)).String() != id {
			t.Fatal("tool pair detached")
		}
	}
	if gjson.GetBytes(body, "parameters.max_tokens").Int() != 256 || gjson.GetBytes(body, "parallel_tool_calls").Bool() {
		t.Fatal("caller budget or tool controls changed")
	}
}

func TestQoderQwen38MaxPreservesOfficialModelKey(t *testing.T) {
	for _, requested := range []string{"qmodel_38max", "qoder/qmodel_38max", "qwen3.8-max", "qwen-3.8-max", "qwen3.8_max", "qoder/Qwen3.8-Max"} {
		t.Run(requested, func(t *testing.T) {
			key, reasoning := NormalizeQoderModel(requested)
			if key != "qmodel_38max" || !reasoning {
				t.Fatalf("NormalizeQoderModel(%q) = (%q, %v), want (qmodel_38max, true)", requested, key, reasoning)
			}
		})
	}
	key, reasoning := NormalizeQoderModel("qoder/qmodel_preview")
	if key != "qmodel_preview" || !reasoning {
		t.Fatalf("preview model changed: (%q, %v)", key, reasoning)
	}
}

func TestQoderSelectedModelReachesEveryNativeModelField(t *testing.T) {
	for _, requested := range []string{"qoder/Kimi-K3", "qoder/Qwen3.8-Max", "qoder/Auto", "qoder/future_official_key"} {
		t.Run(requested, func(t *testing.T) {
			key, reasoning := NormalizeQoderModel(requested)
			// A stale client model field must not override the resolved gateway model.
			body, err := BuildQoderRequestBody([]byte(`{"model":"stale","messages":[{"role":"user","content":"OK"}],"reasoning_effort":"none"}`), key, reasoning)
			if err != nil {
				t.Fatal(err)
			}
			if gjson.GetBytes(body, "business.model_key").Exists() {
				t.Fatal("redundant business model key must be absent")
			}
			for _, path := range []string{"model_config.key", "chat_context.extra.modelConfig.key"} {
				if got := gjson.GetBytes(body, path).String(); got != key {
					t.Errorf("%s = %q, want %q", path, got, key)
				}
			}
			if gjson.GetBytes(body, "model_config.source").String() != "system" || gjson.GetBytes(body, "model_config.is_reasoning").Bool() {
				t.Fatal("invalid model source or thinking controls")
			}
		})
	}
}

func TestQoderRuntimeChoiceSurvivesNativeBody(t *testing.T) {
	for _, effort := range []string{"low", "high", "max", "none"} {
		for _, window := range []int{200000, 400000, 1000000} {
			payload := []byte(fmt.Sprintf(`{"messages":[{"role":"user","content":"OK"}],"reasoning_effort":%q,"context_length":%d}`, effort, window))
			body, err := BuildQoderRequestBody(payload, "dfmodel", false)
			if err != nil {
				t.Fatal(err)
			}
			if gjson.GetBytes(body, "parameters.context_length").Int() != int64(window) || gjson.GetBytes(body, "parameters.reasoning_effort").String() != effort {
				t.Fatal("runtime choices lost")
			}
			for _, path := range []string{"parameters.enable_thinking", "model_config.is_reasoning", "chat_context.extra.modelConfig.is_reasoning"} {
				if gjson.GetBytes(body, path).Bool() != (effort != "none") {
					t.Fatalf("inconsistent thinking at %s", path)
				}
			}
		}
	}
}

func TestQoderRuntimeAccountValidationAndDefaults(t *testing.T) {
	options := &registry.QoderRuntimeOptions{ThinkingDeclared: true, ContextWindows: []int{200000, 400000, 1000000}, DefaultContext: 200000, Levels: []string{"none", "low", "high", "max"}, DefaultEffort: "high"}
	payload, err := ApplyQoderRuntimeOptions([]byte(`{"messages":[]}`), nil, options)
	if err != nil || gjson.GetBytes(payload, "context_length").Int() != 200000 || gjson.GetBytes(payload, "reasoning_effort").String() != "high" {
		t.Fatal("native defaults lost")
	}
	payload, err = ApplyQoderRuntimeOptions([]byte(`{"reasoning_effort":"low"}`), []byte(`{"context_length":1000000,"untrusted":"ignore"}`), options)
	if err != nil || gjson.GetBytes(payload, "context_length").Int() != 1000000 || gjson.GetBytes(payload, "untrusted").Exists() {
		t.Fatal("original envelope merge is not scoped")
	}
	for _, raw := range []string{`{"context_length":999999}`, `{"context_length":1.5}`, `{"context_length":-1}`, `{"context_length":"1000000"}`, `{"reasoning_effort":"medium"}`} {
		if _, err = ApplyQoderRuntimeOptions([]byte(raw), nil, options); err == nil {
			t.Fatalf("unsupported selection accepted: %s", raw)
		}
	}
}
