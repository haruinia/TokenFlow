# Official-engine gateway workers — 10.15.26.73

## Scope

The desktop no longer supplies `codexNativeAssets`; its packaged resources exclude the patched Codex engine. The existing stdio model-switch bridge launches the installed official `codex` executable with its original desktop arguments. Official→official native tools are not intercepted; gateway→gateway native tools are not intercepted. The hybrid catalog no longer forces multi-agent v2 for gateway models.

New official threads receive an additive `tokenflow_gateway` dynamic-tool namespace through the public app-server `thread/start.dynamicTools` interface. Only an official parent can invoke it; the selected target must be in TokenFlow's configured gateway model list. Each task starts an independent `modelProvider=token_flow` thread using the SAME unmodified official app-server. No custom engine starts when the task is invoked. Only the explicit task text is forwarded; no encrypted/full parent history is copied.

`spawn_agent`, `list_agents`, `wait_agent`, `interrupt_agent`, and `followup_task` manage these independent tasks. They are not aliases for native collaboration and do not appear as native child edges. Ownership is scoped to the requesting parent. Four simultaneous tasks and 64 task records per parent are allowed. Parent turn cancellation and parent settings changes request cancellation of running tasks. Work is limited to 30 minutes; wait requests are bounded to 30 seconds. Restarting the bridge loses its in-memory task index; ordinary persisted worker conversations remain available in Codex.

Before any task content is sent, `thread/start`'s actual provider, model, sandbox and approval policy must match the intended gateway route and parent permissions. Named profiles/runtime roots are passed through; unsupported or mismatched sandboxes fail closed. Disabled plugin settings are carried over. Followup validates the existing worker's current provider/permissions again. The client forwards native approval requests through the normal desktop channel; it does not automatically approve them.

Old conversations are not rewritten or forked just to inject tools: the public resume/settings interface has no dynamic-tool registration field. This first scoped release therefore needs a NEW official conversation created through the updated bridge. New gateway conversations get no extension. If an official engine rejects the optional extension schema, the bridge retries original thread creation without it, never swaps binaries or spoofs version headers.

The prior native-engine research remains in source as an explicit probe dependency, not a shipped/default desktop runtime. Launch always refreshes the managed bridge with a backup, so stale native-engine settings cannot survive a TokenFlow-managed restart. The UI identifies an already-running old engine; installation does not silently restart Codex.

## Evidence

- 107 tests across agent configuration, native-runtime withdrawal, bridge routing, independent workers and routing UI passed. After adding compatibility fallback, the worker/bridge suites passed all 16 tests (one additional regression). Typecheck and production build passed.
- `scripts/codex-native-child-provider-probe.mts`, installed official engine, synthetic endpoints: both official→official and gateway→gateway native lifecycle controls passed. Covered initial provider, parent edge, followup, list, cancellation aborting upstream HTTP, failed status and credential routing. Copies of results use the `codex-official-engine-*-native-control-2026-10-25.json` names; previous baseline artifacts were preserved.
- `scripts/codex-gateway-workers-live.mts --live --proxy http://127.0.0.1:7897 --gateway-model api-f254d61008aa5e1648614c7e/deepseek-ai/DeepSeek-V4.1-Flash`: isolated HOME, copied current login with refresh disabled, actual GPT-6.1 Sol parent and SiliconFlow DeepSeek worker, production bridge. Spawn (18.927 s), followup (11.660 s), worker permissions/provider, independent relation, parent remains openai all passed. Two explicit task markers survived.
- After stopping the isolated TokenFlow service, official continuation succeeded in 4.581 s, native compaction in 14.577 s, and post-compaction continuation eventually succeeded in 246.370 s. That last request encountered HTTP 429 and official-client retry backoff; this is NOT a normal latency measurement. No extra request was added to evade the limit. Same bridge/engine PID, zero official inference forwarding, auth copy unchanged. Report: `results/codex-gateway-workers-live-2026-10-25.json`.
- Initial live attempt caught a real verification bug: a fresh thread has no rollout before its first turn, so `thread/resume` cannot validate it. Fixed by checking the authoritative `thread/start` result before inference; failed attempts sent no gateway task content.
- Desktop argument startup probe now supports `--official` to test initialization, organization requirements, thread creation and analytics opt-out on the original engine without credentials/inference.

## Limits

Live tasks were explicit fixed-response instructions, not broad coding benchmarks or implicit routing acceptance. Native UI approval clicks and every named permission profile were not exercised. Manager cancellation was unit-tested; actual native interrupt HTTP-abort behavior was independently exercised. User desktop acceptance after restart remains required. The separately observed paginated-history fork/side-chat limitation was not repaired or bypassed, and this release does not rewrite history.
