# Cross-provider task UX: alternatives to visible independent chats

Research only. Installed product remains 10.15.26.74. No user config, login, rollout, desktop bundle, or installed engine was changed. The new probe uses temporary homes, dummy credentials and loopback synthetic Responses streams, then removes its temporary state.

## Findings

The previous choice between visible independent threads and a unified inference gateway was incomplete. Independent workers can use a separate process of the **installed, unmodified official engine**, with task history stored under a TokenFlow-owned `CODEX_HOME`. This separates worker history and notifications from the main desktop session without replacing its backend or putting its official inference through TokenFlow.

This improves list cleanliness and recovery, but does not turn the worker into a native collaboration child. The main conversation still uses the extension's task tools. Worker task state/ownership and user-facing progress remain integration responsibilities.

### Native provider selection remains unavailable in the inspected version

- Installed engine: `codex-cli 0.164.0-alpha.11.1`.
- Local upstream checkout: `970111f6cb62cc02fe36a82ea7d71b37a2889c97`, October 23, 2026.
- `core/src/agent/child_config.rs`: child configuration starts from the parent's effective config/provider. Model and role overrides do not provide a provider selection extension point.
- `core/src/agent/role.rs`, `role_overrides::build_next_config`: allowlisted overrides cover model/instructions/reasoning/features/skills; no provider assignment.
- `hooks/src/schema.rs`: `SubagentStartHookSpecificOutputWire` supplies `additional_context`, not a provider override. Pre-tool input rewriting cannot add a provider field that the native spawn tool does not support.
- The installed app-server schema has no writable native `parentThreadId` field on `thread/start` or `thread/metadata/update`. `threadSource` is analytics classification, and turn lineage fields do not register an AgentControl child.
- Earlier actual-engine native lifecycle test remains relevant: `results/codex-native-child-provider-openai-2026-10-25.json`. Unsubscribe/resume requested `token_flow` for an existing native child but the effective provider stayed `openai`; native lifecycle otherwise passed. This was not rerun, and is not new evidence.
- Installed desktop bundle reads native parent/source ancestry and discovers children from `collabAgentToolCall` / `subAgentActivity`. Merely adding a label or returning a task ID does not produce this topology. Injecting fabricated native events would still leave real engine ownership/list/cancel/reload semantics inconsistent; it is not recommended.

Official documentation agrees that custom agent files inherit the parent's provider and cannot override it:
https://learn.chatgpt.com/docs/agent-configuration/subagents

Thread lifecycle, ephemeral history and list/source filters:
https://learn.chatgpt.com/docs/app-server

### Actual installed-engine visibility/lifecycle probe

Run:

```sh
node --import tsx scripts/codex-worker-visibility-probe.mts --out doc/testing/results/codex-worker-visibility-2026-10-25.json
```

All three variants passed. Thread lists explicitly included both providers and all relevant source kinds, avoiding false invisibility from default provider filtering.

| Variant | Main engine receives worker-start event | In main stored thread list | Worker rollout persisted | Resumes after worker process restart |
|---|---|---|---|---|
| Same engine, ephemeral worker | Yes | No | No | Not tested; in-memory lifetime only |
| Separate official engine, ephemeral worker | No | No | No | No, as expected |
| Separate official engine, private persistent home | No | No | Yes, only in private home | Yes |

For every variant: effective sandbox and approval policy matched the parent, provider was `token_flow`, followup requests contained earlier task context, interrupt aborted the upstream HTTP request, and HTTP 400 produced a failed turn. Private persistent workers were visible in their own explicitly filtered list and recovered context after process restart. Main thread remained `openai` and continued successfully. Fixture credentials stayed on the correct routes. No native parent edge was created.

The probe exercised real engine state transitions with synthetic upstream replies, not real Gemini reasoning or desktop visual rendering. It does not establish all named profiles, desktop approval dialogs, plugin/MCP inheritance, remote hosts, daemon upgrades, task ownership persistence, or cross-process crash races. These must be addressed before shipping a replacement worker implementation. The .74 real Gemini evidence is separate and uses the existing shared-engine implementation.

## Recommendation

If official direct networking is a priority, prototype **private persistent background workers**, rather than archive-after-completion or ephemeral-only workers. Start the official worker process on demand, keep its task history outside the user's Codex session store, and expose progress/results through the parent tool interaction. Persist the parent-task mapping so restart recovery is usable. Route approval/cancellation explicitly and verify effective permission profiles, plugin restrictions and workspace configuration before inference. Do not silently copy official account credentials to gateway workers. A private home changes default config/plugin discovery; this needs explicit inheritance, not assumptions.

If identical native subagent UI and lifecycle is the overriding priority, a unified provider remains the already-validated approach. Running its gateway as a separately supervised background service can decouple the **GUI** lifetime from inference. This is an architectural alternative, not a newly tested implementation: official traffic would still traverse that service, and stopping the service would still break that route. It must not be called official direct networking.

An official native child acting as a supervisor for a gateway tool could preserve a native card, but adds official inference/latency and still requires cancellation and task-result bridging. It is not equivalent to a gateway-native child and was not prototyped. Replacing the whole app-server, patching the desktop UI, modifying live agent graph databases, or forging native events would violate the requested narrow integration boundary or create brittle state.

The available findings support cleaner background worker UX without changing the official parent. They do not support a claim that cross-provider workers can already be made indistinguishable from native children on this engine.
