# Native delegation entrypoint comparison — 2026-10-25

Previous research and the single compatibility namespace prototype are saved in commit `947c7d9`. This follow-up tests whether official delegation can retain its original entrypoint, and whether a smaller native mechanism can avoid an alias entirely.

## Two-entry implementation

Isolated source-engine patch: [codex-native-dual-entry.patch](prototypes/codex-native-dual-entry.patch), against OpenAI Codex source `970111f6cb62cc02fe36a82ea7d71b37a2889c97`.

The original collaboration schemas are restored unchanged, including their encrypted message annotations. Three additional tools (`tokenflow_agents.spawn_agent`, `followup_task`, `send_message`) wrap the same native handler objects with readable-message schemas. The native registry still handles parent identity, permission configuration, status, waiting, cancellation and failures. No independent `thread/start` worker replaces the native child.

Provider selection remains a separate hook at child creation: explicit model allowlist → provider ID/info. Renaming a tool alone does not select a provider. A gateway parent can already inherit `token_flow`; an official parent cannot inherit a provider it does not have.

Real result: `results/codex-native-dual-entry-live-2026-10-25.json`, PASS. One OpenAI parent created an official child through original collaboration and a SiliconFlow DeepSeek child through the alias. Both were present in the same native tree with the same parent and matching approval/sandbox configuration. Original native listing saw both children. A gateway followup returned a new exact marker. With the isolated gateway service stopped, the official parent completed native compaction and continuation. Official forwarding attempts: zero; one engine PID; isolated auth unchanged.

Deterministic real-engine/local-upstream controls also passed for official and gateway children. These assert that all three original message schemas retain `encrypted=true`, while aliases omit it. Original listing and interruption manage the alias-created child, including aborting an in-flight HTTP response and surfacing a synthetic failure to the parent. See `scripts/codex-native-dual-entry-probe.mts` and corresponding `results/codex-native-dual-entry-control-*.json`.

## Smaller candidate: native Code Mode

Upstream `core/tests/suite/code_mode_agent_message_tests.rs::code_mode_spawn_delivers_plaintext` demonstrates the existing native path: `functions.exec` calls `tools.collaboration__spawn_agent(...)`, and `ToolCallSource::CodeMode` delivers a readable attributed message. It does not require altering the reserved direct collaboration schema or creating an alias. The child still needs the provider-selection hook: [codex-native-provider-selection.patch](prototypes/codex-native-provider-selection.patch).

Real-probe prerequisites proved significant:

1. Code Mode must have a functioning host. Without one, permissive configuration fell back to direct encrypted calls. The matching source host could not be built because its V8 152.2.0 prebuilt binding URL returned HTTP 404. The later experiment uses the already-installed Codex host via a temporary symlink, with fallback disabled; installed files were not changed.
2. Allowing both direct and code-mode tools did not force the model to choose the readable path, despite the test prompt. Raw rollout tool identities showed direct collaboration calls, and readable task markers were absent at the gateway.
3. Restricting the official model to `code_mode_only` removed direct tools, but bundled role hints still required direct collaboration. The model correctly refused. The subsequent probe uses supported root/subagent usage-hint settings to describe the enabled native tool surface; approval and sandbox settings remain unchanged.

These are recorded separately in `results/codex-native-code-mode-{unavailable,direct-choice,role-conflict}-2026-10-25.json`. Do not treat the first two fixed-marker answers as successful task delivery: the gateway task-text assertion failed.

## Scope

All experiments use isolated configuration/homes and synthetic tasks, actual authorized OpenAI/DeepSeek inference, and the temporary source-built engine. The user's installed application, real config, login and active conversation are unchanged. Existing source control points and earlier results remain available. The desktop child panel and product installation are not tested here. Permission inheritance assertions compare effective configuration, not every sandbox enforcement case. Cross-provider full-history forks remain rejected by the prototype.

## Final Code Mode result and comparison

`results/codex-native-code-mode-live-2026-10-25.json`: PASS. The real official parent created both an official child and a DeepSeek child, followed up with the gateway child, and listed both in the same native tree. Gateway task markers were present in the first actual request; no shell/file operations were needed to recover missing tasks. Raw rollout tool identities explicitly show `exec` invoking `collaboration__spawn_agent` and `collaboration__followup_task`, with no alias tools. The passing run used `tool_mode=code_mode_only` for the parent, `features.multi_agent_v2.non_code_mode_only=false`, an enabled Code Mode host with fallback disabled, and root/subagent usage hints that match this tool surface.

Only the provider-selection patch is active for this case; the dual-entry environment flag is absent. The binary also contains the opt-in alias code, which is not registered in this mode. Gateway spawn required one upstream request (parent round 9.761 s); followup required one (7.868 s). Official native compaction succeeded with the isolated gateway service stopped (20.517 s), followed by successful recall (2.543 s). Parent remained `openai`; child providers were `openai` and `token_flow`; one engine PID; official forwarding attempts zero; isolated auth unchanged.

| Approach | Extra tool names | Original direct official dispatch | Additional integration |
| --- | --- | --- | --- |
| Dual entrypoints | Three native aliases | Preserved and real-tested | Provider-selection hook + alias registration/plaintext handling |
| Native Code Mode | None | Official delegation also uses Code Mode in the passing test | Provider-selection hook + host, tool exposure, accurate usage hints |

Both reuse native agent management. Code Mode reduces source changes and avoids a second namespace, but is not a drop-in configuration toggle: prompt-only routing and inconsistent role guidance failed. Dual entrypoints are the more conservative choice if preserving the existing direct official delegation behavior is the priority. Code Mode is a valid smaller-source alternative if changing the delegation tool surface is acceptable. Neither experiment establishes that production installation, every model, long child histories in this new Code Mode configuration, or the desktop panel is finished. The earlier single-alias test covers long child compaction; this comparison does not silently reuse that result as a new Code Mode long-history test.

Reproduce the comparison with `scripts/codex-native-entrypoint-live.mts --live --engine <isolated-app-server> --proxy <network-proxy> --gateway-model <configured-source-model> --out <report.json>`. Add `--code-mode` for the second approach. That variant requires a compatible `codex-code-mode-host` beside the isolated engine. `scripts/codex-native-dual-entry-probe.mts --route-child --engine <isolated-app-server>` runs the deterministic lifecycle/schema control; add `--official-child` for original official dispatch.
