# Model context catalog refresh — 2026-11-03

## Reviewed evidence

- CC Switch `7afceec14b977ecc2f4373e8ffb40e7223b435ac` (2026-11-02), `src/config/codexProviderPresets.ts` and its bundled DeepSeek catalog.
  https://github.com/farion1231/cc-switch/blob/7afceec14b977ecc2f4373e8ffb40e7223b435ac/src/config/codexProviderPresets.ts
- CLIProxyAPI `6e6afab99a1939525ecb6bb1f0873c8e7a9df877` (2026-11-03 UTC), `internal/registry/models/models.json` and `codex_client_models.json`.
  https://github.com/router-for-me/CLIProxyAPI/tree/6e6afab99a1939525ecb6bb1f0873c8e7a9df877/internal/registry/models
- DeepSeek official Codex integration page fetched successfully: declares context_window 1048576 and effective_context_window_percent 95.
  https://api-docs.deepseek.com/quick_start/agent_integrations/codex/
- Read only capacity fields from local official Codex cache (fetched 2026-10-31). Sol/Terra 6.1 default 500000, maximum 872000; other listed GPT-6 variants default 272000. Matches latest upstream client snapshot. A forced authenticated model-list refresh failed through the current network; no fresh account-list claim is made. Existing official entries were preserved.

## Behavior

Unknown gateway capacity defaults to 200000, with a 180000 compaction trigger. The runtime first-contact summary planner uses the same fallback. This is a scheduling fallback, not a claim that every upstream accepts 200K.

A reviewed source-specific snapshot supplies 96 capacity hints across Claude, Gemini, Gemini CLI, Antigravity, Kimi, xAI and Codex account routes. It cannot add models or authorize access. Codex hints use the client catalog default, not the larger maximum or the older static account-tier table. Live source capacity overrides hints. Unknown Qoder/WorkBuddy capacities do not inherit old static 128K entries.

Examples: Antigravity Gemini 3.8 Flash High 1048576; Antigravity Claude Opus 4.6 Thinking 200000; direct Claude Opus 4.6 1000000. The source boundary matters even when branding is similar. Real smaller windows for older models remain smaller.

API presets remain exact endpoint + protocol + ID matches. Added reviewed GLM-5.3-Flash, PPIO DeepSeek V4.1 Flash and SiliconFlow international MiniMax M3 entries; no model-name prefix guessing or .cn/.com cross-application. Existing DeepSeek official 1M settings confirmed.

Qoder keeps advertised default/explicit selection (200K/400K/1M where available), and forwards the corresponding runtime parameter. Cursor reads the advertised default context variant, not the largest option; its existing runtime model-rejection recovery remains unchanged.

Source refresh no longer skips entries merely because cached capabilities exist. Sidecar context metadata version 2 distinguishes current fields from historical static defaults; an absent live field uses a reviewed preset or the unknown fallback. An unavailable source preserves known metadata. Input-only metadata overrides stale preset capacities; explicit source defaults still take precedence over maximum input.

Explicit account/provider refresh and API metadata refresh update generated gateway catalogs. Catalog writes serialize with connection changes. Official merged entries, config/auth bytes, conversation history and backups remain untouched. Codex must reload its catalog before an already-running client sees revised thresholds. The existing small-window cross-provider switch workaround remains: below 272K expose the native 90% trigger rather than inducing old-model pre-compaction.

## Validation

- 304 Vitest cases across 12 targeted files: initial run passed 303; Cursor's expected metadata was updated to include the newly discovered 500K default, and that case passed on recheck.
- Final runtime fallback change: 35 cases across A2A service, initial compaction and Qoder/context service passed (318 unique cases across the targeted runs).
- Real product refresh endpoint with an isolated fake sidecar: WorkBuddy 131072 → 1000000 updated catalog and removed the stale trigger; config and history byte-identical.
- Go official-catalog overlay suite passed, including actual provider-specific response shapes and native Qoder defaults overriding maximum capacity.
- TypeScript typecheck, production build and sidecar build passed.
- No paid inference, production credential changes, app install or Codex/TokenFlow restart. No claim of a real 1M-token inference load test.
