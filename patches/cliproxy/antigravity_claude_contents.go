package claude

import (
	"strings"

	translatorcommon "github.com/router-for-me/CLIProxyAPI/v7/internal/translator/common"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// Message-level system/developer reminders become user parts. Claude requires
// tool results at the start of the user turn immediately following tool calls;
// Gemini's text-first ordering has a different requirement. Preserve model
// parts verbatim, including their signed thinking and tool-call ordering.
func antigravityMergeClaudeContents(model string, contents [][]byte) [][]byte {
	merged := translatorcommon.MergeAdjacentGeminiContents(contents)
	if !strings.Contains(strings.ToLower(model), "claude") {
		return merged
	}
	for i, content := range merged {
		if gjson.GetBytes(content, "role").String() != "user" {
			continue
		}
		var results, other [][]byte
		for _, part := range gjson.GetBytes(content, "parts").Array() {
			if part.Get("functionResponse").Exists() || part.Get("function_response").Exists() {
				results = append(results, []byte(part.Raw))
			} else {
				other = append(other, []byte(part.Raw))
			}
		}
		if len(results) == 0 || len(other) == 0 {
			continue
		}
		if updated, err := sjson.SetRawBytes(content, "parts", translatorcommon.JoinRawArray(append(results, other...))); err == nil {
			merged[i] = updated
		}
	}
	return merged
}
