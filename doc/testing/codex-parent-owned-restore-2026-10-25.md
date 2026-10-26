# Official restore blocked by native child ownership (.79)

The reported error is the existing provider-confirmation check in `codexMigrationClient` (introduced October 13), not a new .77/.78 validation. The interrupted journal had completed 270 entries and next attempted to resume a Gemini native child independently.

Installed official Codex was exercised using private copies of state_5.sqlite, thread_history_1.sqlite, all rollouts (including unindexed source segments), and unfinished migration manifests. No live history/config/auth was modified. No inference was requested.

Evidence:
- `thread/resume` on a cold native V2 child rejects independent loading and asks for its parent.
- After loading the parent, requesting `modelProvider: openai` on the child returns its stored `token_flow` and Gemini model. The native thread processor explicitly strips caller overrides for parent-owned children.
- Official-only configuration can reopen the parent successfully. It does not convert or promise continued execution of an old gateway child.

Fix:
- Native subagent records are excluded from standalone provider migration and routing mismatch repair.
- Already journaled children become `parent_managed`; original IDs, history, provider, archive state and ownership are retained. Interrupted archive restoration still completes first.
- Main thread response validation and persisted provider/model checks are unchanged.
- New official children follow the official parent. Previously gateway-owned children are historical records, not converted to official workers.

Validation:
- Two regression tests failed before the fix and passed afterward. An earlier fake-runtime test incorrectly assumed child overrides worked; it now checks preservation instead.
- 59 migration/runtime/projection/coexist tests passed, plus typecheck/build/signing/packaged runtime checks.
- Existing installed-engine synthetic provider probe: three complete switch cycles, model addition/removal, archived history and continuation passed.
- `node --import tsx scripts/codex-child-restore-probe.mts <child-id>`: real-history copy restore passed, 23 entries processed, 906 child rows unchanged, one pre-existing missing-rollout record retained as unavailable. Parent reopened as openai with no token_flow provider in configuration. Zero inference requests.
- The probe's `--reproduce` mode intentionally asserts the unsupported direct-child override and demonstrates the original error; the default mode exercises the corrected migration manager.

Prevention: model native child ownership as a migration boundary, and include real installed-engine child history in provider-switch verification rather than relying on a fake resume handler that updates every row.
