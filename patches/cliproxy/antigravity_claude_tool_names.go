package claude

import (
	"crypto/sha256"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/util"
	"github.com/tidwall/gjson"
)

var antigravityClaudeNameCharacters = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

func sanitizeAntigravityClaudeName(name string) string {
	name = antigravityClaudeNameCharacters.ReplaceAllString(name, "_")
	if len(name) > 128 {
		name = name[:128]
	}
	return name
}

// Include historical calls as well as declarations. A client can remove a tool
// after using it; its historical call/result pair must still use one mapping.
func antigravityFunctionNameMap(model string, raw []byte) map[string]string {
	if !strings.Contains(strings.ToLower(model), "claude") {
		return util.SanitizedFunctionNameMap(raw)
	}
	names := make(map[string]bool)
	add := func(name string) {
		if name != "" {
			names[name] = true
		}
	}
	gjson.GetBytes(raw, "tools").ForEach(func(_, tool gjson.Result) bool { add(tool.Get("name").String()); return true })
	gjson.GetBytes(raw, "messages").ForEach(func(_, message gjson.Result) bool {
		message.Get("content").ForEach(func(_, block gjson.Result) bool {
			if block.Get("type").String() == "tool_use" {
				add(block.Get("name").String())
			}
			return true
		})
		return true
	})
	add(gjson.GetBytes(raw, "tool_choice.name").String())
	sorted := make([]string, 0, len(names))
	counts := make(map[string]int)
	for name := range names {
		sorted = append(sorted, name)
		counts[sanitizeAntigravityClaudeName(name)]++
	}
	sort.Strings(sorted)
	out := make(map[string]string, len(sorted))
	used := make(map[string]bool, len(sorted))
	for _, name := range sorted {
		base := sanitizeAntigravityClaudeName(name)
		mapped := base
		if counts[base] > 1 || used[base] {
			for attempt := 0; ; attempt++ {
				digest := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d", name, attempt)))
				suffix := fmt.Sprintf("_%x", digest[:6])
				prefix := base
				if len(prefix) > 128-len(suffix) {
					prefix = prefix[:128-len(suffix)]
				}
				mapped = prefix + suffix
				if !used[mapped] {
					break
				}
			}
		}
		out[name] = mapped
		used[mapped] = true
	}
	return out
}

func mapAntigravityFunctionName(model string, names map[string]string, name string) string {
	if !strings.Contains(strings.ToLower(model), "claude") {
		return util.MapSanitizedFunctionName(names, name)
	}
	if mapped, ok := names[name]; ok {
		return mapped
	}
	return sanitizeAntigravityClaudeName(name)
}

func antigravityToolNameMap(model string, raw []byte) map[string]string {
	if !strings.Contains(strings.ToLower(model), "claude") {
		return util.DisambiguatedToolNameMap(raw)
	}
	out := make(map[string]string)
	for original, mapped := range antigravityFunctionNameMap(model, raw) {
		if original != mapped {
			out[mapped] = original
		}
	}
	return out
}
