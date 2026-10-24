package claude

import (
	"context"
	"fmt"
	"strings"
	"testing"

	antigravityResponses "github.com/router-for-me/CLIProxyAPI/v7/internal/translator/antigravity/openai/responses"
	claudeResponses "github.com/router-for-me/CLIProxyAPI/v7/internal/translator/claude/openai/responses"
	"github.com/tidwall/gjson"
)

func TestTokenFlowAntigravityClaudeUsage(t *testing.T) {
	const input = 123000
	const cached = 122000
	const output = 28
	for _, fallback := range []bool{false, true} {
		t.Run(fmt.Sprintf("fallback=%v", fallback), func(t *testing.T) {
			candidates := output
			if fallback {
				candidates = 0
			}
			raw := []byte(fmt.Sprintf(`{"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":%d,"cachedContentTokenCount":%d,"candidatesTokenCount":%d,"totalTokenCount":%d}}}`, input, cached, candidates, input+output))
			request := []byte(`{"model":"claude-sonnet-4-6"}`)
			var state any
			nonStream := ConvertAntigravityResponseToClaudeNonStream(context.Background(), "claude-sonnet-4-6", request, request, raw, &state)
			assertUsage := func(t *testing.T, usage gjson.Result) {
				t.Helper()
				if got := usage.Get("input_tokens").Int(); got != input-cached {
					t.Errorf("Messages input_tokens=%d want %d uncached", got, input-cached)
				}
				if got := usage.Get("cache_read_input_tokens").Int(); got != cached {
					t.Errorf("cached=%d want %d", got, cached)
				}
				if got := usage.Get("output_tokens").Int(); got != output {
					t.Errorf("output_tokens=%d want %d", got, output)
				}
			}
			assertUsage(t, gjson.GetBytes(nonStream, "usage"))
			// Claude bridges correctly add disjoint input/cache fields. Verify this exact
			// mapping cannot cross a 244800-token compaction trigger on a 123k prompt.
			message := gjson.ParseBytes(nonStream)
			envelope := fmt.Sprintf("data: {\"type\":\"message_start\",\"message\":%s}\n\ndata: {\"type\":\"message_stop\"}\n\n", message.Raw)
			converted := claudeResponses.ConvertClaudeResponseToOpenAIResponsesNonStream(context.Background(), "claude-sonnet-4-6", nil, nil, []byte(envelope), &state)
			if got := gjson.GetBytes(converted, "usage.input_tokens").Int(); got != input {
				t.Errorf("Messages bridge double-counts input: %d want %d", got, input)
			}
			direct := antigravityResponses.ConvertAntigravityResponseToOpenAIResponsesNonStream(context.Background(), "claude-sonnet-4-6", nil, nil, raw, &state)
			if got := gjson.GetBytes(direct, "usage.input_tokens").Int(); got != input {
				t.Errorf("direct Responses input=%d", got)
			}
			state = nil
			early := []byte(fmt.Sprintf(`{"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"O"}]}}],"cpaUsageMetadata":{"promptTokenCount":%d,"cachedContentTokenCount":%d}}}`, input, cached))
			events := ConvertAntigravityResponseToClaude(context.Background(), "claude-sonnet-4-6", request, request, early, &state)
			events = append(events, ConvertAntigravityResponseToClaude(context.Background(), "claude-sonnet-4-6", request, request, raw, &state)...)
			var joined strings.Builder
			foundFinal := false
			for _, event := range events {
				joined.Write(event)
				for _, line := range strings.Split(string(event), "\n") {
					if !strings.HasPrefix(line, "data: ") {
						continue
					}
					parsed := gjson.Parse(strings.TrimPrefix(line, "data: "))
					if parsed.Get("type").String() == "message_start" {
						if got := parsed.Get("message.usage.input_tokens").Int(); got != input-cached {
							t.Errorf("early Messages input=%d want %d", got, input-cached)
						}
						if got := parsed.Get("message.usage.cache_read_input_tokens").Int(); got != cached {
							t.Errorf("early Messages cached=%d", got)
						}
					}
					if parsed.Get("type").String() == "message_delta" {
						assertUsage(t, parsed.Get("usage"))
						foundFinal = true
					}
				}
			}
			if !foundFinal {
				t.Fatal("missing final usage")
			}
			converted = claudeResponses.ConvertClaudeResponseToOpenAIResponsesNonStream(context.Background(), "claude-sonnet-4-6", nil, nil, []byte(joined.String()), &state)
			if got := gjson.GetBytes(converted, "usage.input_tokens").Int(); got != input {
				t.Errorf("stream bridge input=%d want %d", got, input)
			}
			if got := gjson.GetBytes(converted, "usage.output_tokens").Int(); got != output {
				t.Errorf("stream bridge output=%d want %d", got, output)
			}
		})
	}
}
