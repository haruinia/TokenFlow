package claude

// Gemini-style promptTokenCount includes cachedContentTokenCount; Anthropic's
// input_tokens excludes cache reads. Keep the fields disjoint before a client
// or Responses bridge sums them to decide whether context compaction is needed.
func antigravityClaudeUncachedPromptTokens(prompt, cached int64) int64 {
	if prompt <= 0 {
		return 0
	}
	if cached < 0 {
		cached = 0
	}
	if cached >= prompt {
		return 0
	}
	return prompt - cached
}
