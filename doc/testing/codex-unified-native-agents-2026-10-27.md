# Unified-provider native agent diagnosis — 2026-10-27

## Installed state and scope

- Installed TokenFlow: 10.15.26.82. Installed unmodified Codex CLI: 0.165.0-alpha.1.2.
- Current managed provider: `token_flow`; endpoint `/codex/v1`; `requires_openai_auth=true`; `capabilities.remote_compaction=v2`.
- All probes ran in temporary Codex homes with synthetic tasks. No production config, login, engine, or history was rewritten. Small real official/Qiniu inference requests were made for the authorized integration test.
- The probe's isolated engine authenticates to its local inspection relay with a dummy API key. The relay uses the existing managed gateway key; official upstream requests use the existing ChatGPT access token in memory. Credentials are never written into reports.

## Findings

### 1. Discovery and execution disagree

With the current model catalog and native v2 agent tools, the displayed model description omits Qiniu DeepSeek, but an exact-ID native `spawn_agent` request succeeds. The child has a native parent relation and inherits `token_flow`.

The researched upstream source limits displayed model overrides to five (`MAX_SPAWN_AGENT_MODEL_OVERRIDES`). The configured official models occupy those entries. Native `model_catalog_in_context=true` was also tested: it still omits the gateway model; its renderer uses the same limit. Do not enable this flag as a claimed fix. Missing display entries are not an execution allowlist.

Evidence: `results/codex-unified-deepseek-baseline-synthetic-2026-10-27.json` and `results/codex-unified-deepseek-catalog-live-2026-10-27.json`.

### 2. Native v2 task payload is not portable just because the provider ID matches

Native v2 agent messages contain an encrypted task plus a readable routing prefix. The existing `portableCodexItem` discarded the encrypted block and forwarded the prefix. A deterministic parent/real DeepSeek child test returned an empty-task complaint.

A real official `gpt-6.1-sol` parent also produced an encrypted child task with no plaintext task marker in the first child request. The child eventually produced the expected number after tool activity, but this is **not a valid task-delivery pass**. The original reply-only assertion was inadequate. The saved report includes this validation correction; subsequent probes require the task marker in the first plaintext child input.

Evidence: `results/codex-unified-deepseek-baseline-live-parent-2026-10-27.json`.

Source change now rejects encrypted agent payloads explicitly instead of silently discarding task content. It does not decrypt, guess, or fabricate a task, and does not change ordinary official passthrough.

### 3. Cross-chat delivery is a separate native message kind

The observed native `send_message_to_thread` deliveries are `function_call_output` items without `call_id`, with a name, namespace, and chat metadata. Codex's protocol explicitly makes `FunctionCallOutput.call_id` optional. They are standalone notifications, not missing halves of a local function call.

Reproduction command before correction:

```sh
npx vitest run tests/codex-cross-chat-context.test.ts
```

It failed with the exact reported message: `Tool result has no matching call; resend complete history before compaction`.

Correction belongs at the Codex-to-portable-context boundary. Standalone notifications become attributed user messages with their text/image content retained, before inference and compaction. Actual call IDs still require matching calls. No tool call is invented and no unmatched result is silently discarded. The generic gateway pairing check is unchanged.

## Validated native compatibility option

Run:

```sh
npx tsx scripts/codex-unified-deepseek-probe.mts --live-parent --native-v1
```

The **same installed official executable**, with its native v1 agent protocol selected only in the isolated catalog/config, produced:

- Actual official `gpt-6.1-sol` parent → actual Qiniu `deepseek/deepseek-v4.1-flash-1017` child.
- Native child relation retained; provider `token_flow`.
- Plaintext task present in the first child request.
- Child returned `CHILD_PROBE_OK 323` without tool calls.
- Explicit `thread/compact/start` completed and a remote compaction request was observed.
- Parent used native `send_input` to the same child; child returned `FOLLOWUP_OK 323` without tool calls.

Evidence: `results/codex-unified-deepseek-v1-live-parent-2026-10-27.json`.

This is a short-context manual-compaction/continuation test, not a long-context summary quality or load test. Native v1 agent protocol and remote compaction v2 are different settings; changing one does not require changing the other.

## Product implementation after user approval

The user approved native plaintext agents for unified coexistence, including the changed official-to-official agent tool interface. `AgentConnections.apply` now generates a native v1 catalog and disables the v2 feature override only for aggregate coexistence. Official direct/hybrid modes retain their native metadata and settings. Official inference/remote compaction routing, model context metadata, login and native model instructions remain unchanged.

`codex-unified-agent-catalog.ts` supplies the complete directory through Codex's native `developer_instructions` config, alongside the short built-in tool descriptions. It uses the same final catalog as the picker: display/source name, exact routing ID, official/gateway classification and supported reasoning efforts. No routing alias replaces an ID. The model is instructed to resolve friendly names, pass exact IDs, and clarify ambiguous sources instead of guessing. Catalog entries are serialized as data. No custom spawn tool or engine is installed.

The owned directory refreshes with official account catalog changes, preserves user instructions and active profile policies, and is removed by the existing journaled restore. Tests cover inherited global instructions in active profiles, repeated refresh, account catalog replacement, and byte-exact restore. The mode dialog explains plaintext native agent communication.

Real product-config verification:

```sh
npx tsx scripts/codex-unified-deepseek-probe.mts --live-parent --product-config
```

The product's actual `AgentConnections.apply` generated the isolated configuration. The user prompt said only **“七牛的 DeepSeek Flash”**, with no exact model ID or implementation hints. The real official parent saw the full directory and selected `api-731ee387f7aff3e89a4133d7/deepseek/deepseek-v4.1-flash-1017`. The native child received plaintext, returned `CHILD_PROBE_OK 323`, compacted successfully and returned `FOLLOWUP_OK 323` after a native follow-up. No child tool calls occurred. See `results/codex-unified-deepseek-product-live-parent-2026-10-27.json`.

## Verification

- 185 targeted connection, account-switch, context/compaction and directory tests passed across the full run and rerun of the changed catalog expectations.
- `npm run typecheck` passed.
- `npm run build` passed.
- No application install, engine replacement, production mode switch, or production history repair performed. Installed application remains .82; applying the updated product mode requires the updated application and the normal journaled apply/restart flow.
