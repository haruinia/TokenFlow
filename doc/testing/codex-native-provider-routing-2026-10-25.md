# Native cross-provider child routing feasibility — 2026-10-25

## Question and correction

The user wants official parents to retain the built-in `openai` provider, while native `spawn_agent` selects `token_flow` for configured gateway models. They correctly challenged the earlier claim that task status, cancellation, failures and permission inheritance would have to be rebuilt. Those requirements applied to the previous independent-thread dynamic-tool prototype, which bypassed native AgentControl. They are not an inherent consequence of using different inference providers.

No installed application, real Codex configuration, credentials, system proxy or current conversation was changed in this investigation. The product still uses the installed engine; the patched engine below is an isolated experiment.

## Source evidence

Primary source: local OpenAI Codex checkout at commit `970111f6cb62cc02fe36a82ea7d71b37a2889c97` (2026-10-23). Installed comparison engine: `codex-cli 0.164.0-alpha.11.1`.

- `codex-rs/core/src/agent/child_config.rs`: child config inherits the parent provider. Requested model changes the model, but not the provider. This explains why a gateway parent can already use native gateway children, while merely selecting a gateway model under an official parent does not work.
- `core/src/tools/handlers/multi_agents/spawn.rs` → `core/src/agent/control/spawn.rs`: native spawn receives the completed child config and preserves the parent edge, registry, runtime environment, permission overrides and execution policy. Provider selection can happen before this call without replacing lifecycle management.
- Native interrupt/watch operations identify the child by agent/thread identity, not its provider. Cold-resume source already restores the stored child provider; cold-resume behavior was not separately exercised in this experiment.
- Custom agent role configuration intentionally ignores `model_provider`. `SubagentStart` hook output schema does not expose a provider override. `thread/start(modelProvider=...)` can create an independent session, but does not attach it to the native parent registry.
- An actual native child remained on its original provider after `thread/unsubscribe` followed by `thread/resume(modelProvider=token_flow)`. The parent still holds the child runtime. External reloading is not a reliable pre-inference interception point.

## Minimal source experiment

Patch: [codex-native-model-provider-routing.patch](prototypes/codex-native-model-provider-routing.patch).

The routing portion changes one native child-config generation point. An explicit launcher-provided model allowlist selects `openai` or `token_flow`, setting both provider ID and provider info before native AgentControl creates the child. Unmapped models retain existing behavior. Runtime permissions and native spawn/control code are unchanged.

This uses a test-only environment variable, not a proposed production configuration interface. Cross-provider full-history forks are rejected: OpenAI opaque compaction state is not portable to DeepSeek. Fresh children receive the explicitly delegated task; supporting complete history transfer requires a separate context conversion design.

Built an isolated `codex-app-server` with Rust 1.99.1, using the locked source dependencies. Compilation succeeded, with a debug-build linker unwind-table-size warning. No installed engine was replaced.

## Actual native engine / simulated upstream tests

Harness: `scripts/codex-native-child-provider-probe.mts`. This invokes real native spawn, followup, list and interrupt tools; HTTP provider endpoints return deterministic fixtures. This is not a mocked AgentControl test and is not real vendor inference.

| Engine | Parent → child | First child request | Native lifecycle |
| --- | --- | --- | --- |
| Installed | openai → openai | Official fixture | Pass |
| Installed | token_flow → token_flow | Gateway fixture | Pass |
| Patched source | openai → token_flow | Gateway fixture | Pass |
| Patched source | token_flow → openai | Official fixture | Pass |
| Patched source, mixed routing enabled | openai → openai | Official fixture | Pass |

All five cases verify the native parent edge, unchanged child identity, `followup_task`, presence in `list_agents`, HTTP cancellation through `interrupt_agent`, failed child events and failure visibility to the parent. Parent provider remains unchanged. Approval policy and sandbox configuration match the parent; this checks inherited configuration, not an exhaustive sandbox enforcement suite. Synthetic official and gateway credentials stay on the correct endpoints.

Results: `results/codex-native-child-provider-{openai,token_flow}-2026-10-25.json` and `results/codex-native-child-provider-{openai-patched-token_flow,token_flow-patched-openai}-2026-10-25.json`.

## Product implications

Preserve native spawn and AgentControl; add model-to-provider resolution at child creation. Do not replace children with unrelated work sessions just to change inference routing. Each native child then has its own provider, context and compaction behavior, while management stays native.

This requires engine support (a maintained compatible custom engine or an upstream implementation). Current configuration and the existing external stdio bridge alone do not supply that internal interception point. The experiment does not establish compatibility with the desktop UI, all plugins, remote hosts, or full-history forks. Native parent metadata and management are tested; the desktop child panel was not visually tested.

## Real-provider finding: native encrypted delegation messages

The routing-only patch is insufficient with real OpenAI. Native v2 advertises encrypted `message` arguments on `spawn_agent`, `followup_task` and `send_message`. `tools/router.rs` recognizes readable messages only when the provider explicitly marks `encrypted_function_args=[]` or the call uses code mode. `agent_message_from_tool` otherwise stores an encrypted agent message. A third-party model cannot interpret the official encrypted task.

Real tests found absent readable task markers at the gateway, repeated obsolete responses after followup, and an official error saying encrypted content could not be decoded. An initial fixed answer obtained after the child searched local synthetic test files was not evidence of successful direct task delivery. See `results/codex-native-provider-encrypted-message-failure-2026-10-25.json`.

The next experimental patch also removes the encrypted message-schema annotation when the explicit test routing mode is enabled, and accepts third-party calls with missing encrypted-argument metadata as plaintext in that mode. It does not try to decrypt opaque data. This affects collaboration task messages in the mixed-provider experimental session, including official-to-official delegation there; it does not change official inference routing or official context compaction. A production design must account for this difference instead of claiming zero native behavior changes.

OpenAI also rejects removing the encrypted annotation from the reserved `collaboration` schemas: HTTP 400, “Function 'collaboration.followup_task' is reserved for use by this model and must match the configured schema.” Therefore a simple plaintext substitution under the same direct-model tool name is not a valid solution. Result: `results/codex-native-provider-reserved-schema-failure-2026-10-25.json`.

The compatibility experiment uses the configurable namespace `tokenflow_agents` with the same native spawn/followup/list/interrupt handlers and AgentControl. The engine still creates native child identities and emits native subagent activity. Only the exposed namespace and task-message transport change. This is distinct from creating an unrelated `thread/start` worker, but also distinct from claiming the exact original `collaboration.spawn_agent` schema works unchanged.

## Final real-provider result

`results/codex-native-provider-live-2026-10-25.json`: PASS with the isolated patched source engine, actual OpenAI `gpt-6-astra`, and actual SiliconFlow `deepseek-ai/DeepSeek-V4.1-Flash` through the existing local CLIProxy service. The `tokenflow_agents` namespace invokes native AgentControl; there is no dynamic independent-thread delegation tool or inference stdio bridge in this probe.

- Initial task text is explicitly asserted readable at the gateway. The child answered the fixed marker in one gateway request without running shell commands. Initial parent round: 14.904 s.
- A second native followup delivered a different fixed marker in one gateway request: 7.938 s.
- The native child read a synthetic 172,778-byte file. Its catalog auto-compaction threshold was deliberately lowered to 18,000 tokens to exercise automatic compaction; this does not measure the production context-window limit. A native contextCompaction start/completion pair was observed. The entire long-task parent round, including child tools, compaction and result delivery, took 19.295 s (not an isolated compaction duration).
- The synthetic input file was removed before the next native followup. The child retained both random requirement codes after compaction and returned them through the native relationship. Followup parent round: 8.943 s.
- Child provider `token_flow`, parent edge and matching approval/sandbox settings were verified; parent remained `openai`.
- After closing the isolated TokenFlow service, the official parent completed native compaction (21.740 s) and recalled both codes (2.241 s). Official inference/compaction forwarding attempts: zero. Engine PID unchanged; isolated auth file unchanged.
- Final synthetic lifecycle controls were rerun using the compatibility namespace: official→gateway, gateway→official and official→official passed. Installed-engine same-provider controls also passed.

Reproduction:

```sh
node --import tsx scripts/codex-native-child-provider-probe.mts \
  --engine /tmp/tokenflow-codex-native-provider-probe/codex-rs/target/debug/codex-app-server --route-child
node --import tsx scripts/codex-native-provider-live.mts --live \
  --engine /tmp/tokenflow-codex-native-provider-probe/codex-rs/target/debug/codex-app-server \
  --proxy http://127.0.0.1:7897 \
  --gateway-model api-f254d61008aa5e1648614c7e/deepseek-ai/DeepSeek-V4.1-Flash \
  --out doc/testing/results/codex-native-provider-live-2026-10-25.json
```

The test proxy and source ID above are machine-specific; the scripts require an existing authorized local account. No credentials are included in these artifacts. The archived patch is against the source commit stated above; the temporary built binary is not the installed application.

## Recommended product direction and limits

Retain the native agent tree, lifecycle, permissions and UI events. Keep the official reserved collaboration tools for official delegation, and provide a readable-message gateway entry backed by those same native handlers. Route the child before its first inference. Add guards so an encrypted official message is never silently handed to a gateway child. Full-history forks remain outside this proof.

The passing prototype uses the compatibility namespace for the entire test session. A dual-entry product that leaves official-to-official delegation completely unchanged is the recommended next design, not something already implemented or tested here. Exact original `collaboration.spawn_agent` with only a provider change did not pass the real-provider message-delivery test. The native desktop panel was not visually tested, and no custom engine was installed into the user's application.

Further tests now validate the dual-entry design and a native Code Mode alternative; see [entrypoint comparison](codex-native-entrypoint-comparison-2026-10-25.md). The earlier statement above that dual-entry was untested describes the original 947c7d9 experiment, not this later follow-up.
