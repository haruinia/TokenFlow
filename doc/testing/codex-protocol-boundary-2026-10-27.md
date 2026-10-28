# Codex model discovery, message phases, and inline history round trips

## Scope

The installed application remains 10.15.26.83. Tests use temporary Codex homes and the installed, unmodified native engine. They do not rewrite production login, configuration or rollouts. Live tests make small synthetic-task inference calls through the existing official login and gateway accounts. No replacement app-server, custom task manager, or model-ID alias is introduced.

## Reproduction and cause

A three-turn official → Qoder DeepSeek → official test reproduced the reported error **without compaction**. Official and gateway first turns completed; the return received HTTP 400, `param=input`, `code=invalid_encrypted_content`. The raw upstream error identified a translated reasoning item whose encrypted content could not be verified.

The original official-boundary conversion expanded private response IDs and checkpoints, but returned full inline history unchanged when neither was present. Codex commonly sends full history with `store=false`, so short conversations bypassed conversion. A focused regression first failed on retaining a synthetic, unsigned gateway reasoning item. Converting that inline item made the real three-turn test pass, retaining the exact synthetic requirement marker.

Evidence:
- `results/codex-short-roundtrip-live-before.json`: actual HTTP 400 from the official service.
- `results/codex-short-roundtrip-live-after.json`: same live scenario after only inline-reasoning correction.
- `results/codex-short-roundtrip-protocol-live-after.json`: complete boundary adapter; all turns completed and final phases observed.

Reproduction:

```sh
TF_PROBE_GATEWAY_MODEL=qoder/dfmodel TF_PROBE_OFFICIAL_MODEL=gpt-6.1-sol \
  node --import tsx scripts/codex-coexist-roundtrip.mts --short --live --out /tmp/roundtrip.json
```

## Boundary design

### Model discovery

- Configured API source names are stored separately from display names and exact dispatch IDs. Picker labels have explicit source prefixes; IDs and authorization remain unchanged.
- The managed developer directory contains every configured visible, agent-capable model, source, route and supported reasoning level.
- Native `spawn_agent` and relevant exec-wrapper descriptions receive that same directory at the point of use. Existing schemas and lifecycle tools are unchanged. Refresh replaces only the owned directory block.
- User-message text cannot supply the managed directory. Entries remain descriptive data, not routing authority; existing key/model permissions still apply.
- Official metadata remains intact except the intentional display prefix and the already-enabled native v1 agent protocol.

### Gateway response boundary

`codex-response-protocol.ts` adapts only managed Codex gateway responses. The generic context service receives an adapter callback; it has no Codex-specific response dependency.

- Each gateway output item receives a stable, response-local `tfitem_` ID. Streaming item IDs and terminal output agree; tool `call_id` is preserved. This makes foreign provenance explicit rather than guessing from a provider's model or ID format.
- Existing explicit phases are preserved. For missing phases, actual tool/terminal events distinguish intermediate commentary from a final answer. Text deltas continue streaming; only an unclassified message's done event waits for that decision.
- Incomplete streams never acquire a fake final answer or successful completion. Cancellation reaches the source.
- JSON and streaming outputs use the same interpretation.

### Official input boundary

Private checkpoints are expanded as before. Full inline history additionally converts marked foreign items and legacy unsigned/synthetic reasoning to portable records. Visible reasoning summaries are retained; foreign opaque state is not represented as official ciphertext. Valid native official encrypted reasoning and compaction remain unchanged. Tool call/result pairings and message phases are preserved. This conversion is request-local and does not rewrite user history or ask another model to summarize it.

The legacy regression covers the observed unsigned translated reasoning. Arbitrary unmarked nonempty ciphertext from older providers cannot safely be identified as foreign solely by its value; newly emitted gateway provenance removes that ambiguity going forward.

## Validation

- 212 related tests passed across the main regression run and the added terminal-phase regression: configuration/restore, identity switching, official coexistence, context/checkpoints, native notifications, source discovery, streaming failure/cancellation and response phases. Account-switch fixture cleanup uses bounded `rm` retries for an observed `ENOTEMPTY` teardown race; functional assertions are unchanged.
- Typecheck and production build passed.
- Installed native engine with synthetic source: full official/gateway compaction round trips passed (`results/codex-protocol-compaction-roundtrip-fixture.json`). This is not a live long-context stress test.
- Installed native engine executed a harmless isolated `printf` tool round: app-server reported `commentary`, then `final_answer`, and subsequent official continuation succeeded (`results/codex-native-tool-phases-roundtrip.json`).
- Live official/Qoder DeepSeek three-turn round trip passed with the complete adapter. All final messages were recognized as `final_answer`.
- Live official parent received only the friendly request “Qoder 的 GLM 5.3 Flash”, selected exact `qoder/gfmodel`, created a native child with parent relation and inherited `token_flow`, and sent the full plaintext task. The child **did not complete**: upstream returned a streaming rate-limit/capacity error. HTTP 200 alone was not counted as success (`results/codex-unified-source-discovery-product-live-parent-2026-10-27.json`). This establishes discovery/dispatch, not successful GLM inference.
- Desktop visual folding has not yet been verified in the installed app. Native phase delivery is verified; the current .83 still lacks these new source changes.

Official phase semantics: https://developers.openai.com/api/docs/guides/reasoning — commentary denotes intermediate updates and final_answer denotes the completed answer; preserve phases when replaying history.
