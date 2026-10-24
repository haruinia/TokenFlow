# Codex migration boundary repair — 2026-10-24

## Failure evidence and scope

The user cited the recorded Codex connection failure at **2026-10-24T08:27:55.434Z**, targeting `antigravity/gemini-3.8-flash-high`. This was an earlier failed operation shown in the UI, not proof of a new attempt in `.60`.

Read-only inspection of the TokenFlow profile found a `codex-context-backups` manifest at **08:27:54.147Z** with **zero rollout rewrites** and a `thread_history_1.sqlite` backup. No corresponding new `codex-thread-backups` migration manifest or configuration-application journal exists. The most recent thread-migration manifest is older and restored. This places the failure in the **ancestor projection repair before thread migration**, rather than proving a `thread/resume` failure.

`applyConnection` runs `codexContext.repairLineage` before `codexThreads.prepare`. That repair calls `thread/fork`; previously, `codex-runtime.ts` converted every JSON-RPC error, regardless of method, into the same “Codex cannot restore this old conversation” text. The original raw RPC error was not retained, so its exact historical text cannot be recovered from the switch record.

The current read-only structural scan found seven lineages requiring native ancestor materialization and two invalid projections. The first candidate had a leaf `turn_context` whose events were `task_started`, `item_completed`, and `turn_aborted`. It had no visible terminal turn for that context. The fallback boundary picker in `codex-context.ts` can select the last persisted `turn_context`; that is not proof that `ThroughTurn` can resolve it as a visible turn.

No running Codex process, real conversation, login, configuration, backup or database was stopped or modified during diagnosis. Only structure/counts and safe error categories were emitted. No conversation text or credentials were printed.

## Isolated reproduction

A temporary profile contained one sanitized thread route and the two required rollout segments. Conversation text and instruction text were replaced with synthetic content; required event types, technical identifiers, lineage relationships and ordinal boundaries were retained. Byte cutoffs were recomputed for the sanitized files. No real auth file or credential was copied. The fixture used a synthetic provider directed at loopback, and no turn was started.

Using the installed **Codex 0.163.0-alpha.11.2**, `initialize` succeeded and the same ephemeral `thread/fork` with the context-only boundary returned **RPC -32600, `turn not found`**. That is the minimized, actual-runtime red reproduction matching the identified pre-migration failure pattern.

In this runtime, `ThroughTurn` materializes ancestors before resolving its requested visible boundary. A subsequent official `thread/turns/list` returned four completed visible turns from the same lineage. An ephemeral fork at one of those actual visible IDs succeeded. This distinguishes a non-resolvable boundary from unreadable conversation contents and avoids guessing an unrelated thread or silently skipping it. The existing cached pinned-source research in `doc/testing/codex-continuation-repair-2026-10-23.md` describes that materialization order; the isolated installed-runtime result confirms it for the tested version.

The unsupported-experimental-capability hypothesis was also checked with synthetic missing-thread requests and did not reproduce this error. No production capability change was made on that basis.

## Shared repair

- `CodexRuntimeRPCError` now retains only a whitelisted RPC method, integer error code and safe classification. `-32600` with an anchored `turn not found` message becomes `turn_not_found`; everything else remains `unknown`. The original message, paths and identifiers are not stored in the public error. The existing `codex_migration_failed` code remains intact, with a safe method/code/reason hint.
- Projection repair attempts its existing ephemeral `ThroughTurn` fork. **Only** a classified `thread/fork` / `turn_not_found` failure enables recovery. It queries official `thread/turns/list` for the same thread, using at most eight 100-entry pages, rejects cursor loops, ignores in-progress turns and accepts a terminal ID actually returned by Codex. It retries the ephemeral fork once.
- Unknown errors, missing visible boundaries, new concurrent Codex processes, a failed retry, non-ephemeral results and incomplete/misaligned ancestor projections continue to fail. The runtime is closed on all paths. No failed thread is skipped.
- Existing final validation still requires every ancestor projection to cover the inherited ordinal/byte cutoff and align with the durable rollout's exact byte boundary. No direct repair SQL, copied history projection, new persistent fork, inference or tool execution was introduced.

The repair is in `codex-runtime.ts` and `codex-projection-repair.ts`. `codex-thread-migration.ts`, service/account-switch code and the UI required no changes from this agent. It addresses a shared native-index boundary condition rather than a Gemini-specific migration rule.

## Red → green and validation

Before the fix, two new regressions failed: the runtime discarded the RPC method/code/reason, and the projection helper stopped at an invisible aborted boundary. After the fix:

```text
npx vitest run tests/codex-runtime.test.ts tests/codex-projection-repair.test.ts tests/codex-thread-migration.test.ts tests/codex-context.test.ts
4 files / 85 tests passed
```

The new projection cases cover paginated visible-turn discovery, in-progress exclusion, unknown errors, no usable boundary, cursor loops, another process appearing, retry failure and unsuccessful final projection validation. The runtime subprocess fixture asserts that private-looking synthetic paths/history never appear in public errors. Existing archive/restore, concurrent-process, missing-history and provider-migration tests continue to pass. `npm run typecheck` and `git diff --check` pass.

The **actual production helper** was then run against a fresh sanitized isolated profile using the installed Codex runtime. It completed with:

```text
thread/fork → thread/turns/list → thread/fork → thread/unsubscribe
startedInference=false
durableThreadCountUnchanged=true
leafRolloutUnchanged=true
ancestorCount=1, final byte/ordinal validation passed
```

This is a real installed-runtime RPC check with synthetic/sanitized local history, not a live model request or a modification of the user's original profile. The original historical RPC payload was discarded by the old implementation; the matched phase, local boundary evidence and minimized runtime reproduction support this repair, but do not reconstruct that lost payload. Production installation and a user-initiated switch remain the coordinator's final acceptance steps. This agent did not build, package, install or commit the change.
