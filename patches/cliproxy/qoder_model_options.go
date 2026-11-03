package registry

import "sort"

// QoderRuntimeOptions contains only advertised runtime controls, never account data.
type QoderRuntimeOptions struct {
	ThinkingDeclared bool     `json:"thinking_declared"`
	ContextWindows   []int    `json:"context_windows"`
	DefaultContext   int      `json:"default_context,omitempty"`
	Levels           []string `json:"levels"`
	DefaultEffort    string   `json:"default_effort,omitempty"`
}

func ParseQoderRuntimeOptions(item map[string]any) *QoderRuntimeOptions {
	contexts, hasContext := item["contextConfig"].(map[string]any)
	thinking, hasThinking := item["thinkingConfig"].(map[string]any)
	if !hasContext && !hasThinking {
		return nil
	}
	result := &QoderRuntimeOptions{ContextWindows: []int{}, Levels: []string{}, ThinkingDeclared: hasThinking}
	seen := map[int]bool{}
	for _, raw := range contexts {
		value, _ := raw.(map[string]any)
		n, _ := value["tokenCount"].(float64)
		if n <= 0 || n > 1e9 || n != float64(int(n)) {
			continue
		}
		count := int(n)
		if !seen[count] {
			result.ContextWindows = append(result.ContextWindows, count)
			seen[count] = true
		}
		if value["isDefault"] == true {
			result.DefaultContext = count
		}
	}
	sort.Ints(result.ContextWindows)
	enabled, _ := thinking["enabled"].(map[string]any)
	efforts, _ := enabled["efforts"].(map[string]any)
	for _, level := range []string{"minimal", "low", "medium", "high", "xhigh", "max"} {
		if _, ok := efforts[level]; ok {
			result.Levels = append(result.Levels, level)
		}
	}
	// Match the IDE's explicit default keys before per-option default markers.
	for _, field := range []string{"defaultEffortKey", "defaultEffort", "defaultKey", "default", "defaultValue", "defaultOption", "defaultOptionKey", "defaultReasoningEffort", "default_effort", "default_effort_key", "default_key", "default_option", "default_option_key", "default_reasoning_effort", "default_value", "reasoningEffort", "reasoning_effort", "selectedEffort", "selectedEffortKey", "selected_effort", "selected_effort_key"} {
		raw := enabled[field]
		if obj, ok := raw.(map[string]any); ok {
			for _, key := range []string{"key", "value", "name", "id"} {
				if obj[key] != nil {
					raw = obj[key]
					break
				}
			}
		}
		if value, ok := raw.(string); ok {
			for _, level := range result.Levels {
				if level == value {
					result.DefaultEffort = value
					break
				}
			}
		}
		if result.DefaultEffort != "" {
			break
		}
	}
	if result.DefaultEffort == "" {
		for _, level := range result.Levels {
			option, _ := efforts[level].(map[string]any)
			for _, flag := range []string{"default", "is_default", "isChecked", "isSelected", "checked", "selected", "isDefault"} {
				if option[flag] == true {
					result.DefaultEffort = level
					break
				}
			}
			if result.DefaultEffort != "" {
				break
			}
		}
	}
	if disabled, ok := thinking["disabled"].(map[string]any); ok {
		result.Levels = append([]string{"none"}, result.Levels...)
		if disabled["isDefault"] == true {
			result.DefaultEffort = "none"
		}
	}
	return result
}
