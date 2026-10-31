# .97 API workspace isolation and switch feedback

## Verified causes

The .96 native-engine provider tests passed, but provider-filtered listing was not the desktop's actual behavior. The installed desktop requests `thread/list` with no provider filter, so retaining provider IDs alone did not separate its sidebar. Shared `forced_login_method=api` also blocked selecting a saved official account before the API transaction was restored. A service regression reproduced that exact policy error before the fix.

The installed desktop supports `CODEX_HOME`, `CODEX_ELECTRON_USER_DATA_PATH` and `--user-data-dir`. These native launch settings isolate state without replacing the engine or modifying Codex application files.

## Boundaries

- Each API source has its own native Codex home and desktop data under `codex-api-workspaces/<source-id>`. Official/unified-gateway routing, login and conversations remain in the original home.
- Entering API mode does not run official/gateway history conversion or create migration backups for their conversations. Selecting an official account exits API mode and uses the existing official restoration/account switch flow. Selecting gateway models uses the existing gateway migration flow.
- API summaries and histories stay with their source. Re-enter that source through TokenFlow to continue them. Launching Codex independently through its ordinary app icon uses its ordinary home; this release does not modify global launch environment or install a replacement launcher.
- On upgrade, only legacy API-provider chats are copied into their matching source home and registered through native app-server. The old copies are archived only after successful registration. Import journals permit retries without overwriting an adopted conversation. No official/gateway history is imported into API homes.
- Source removal retires its saved direct route, including an inactive API workspace; conversation files are retained. Existing configuration recovery records remain.
- Isolated API usage enters the local index. Same-thread legacy token samples deduplicate across original/archive/import paths; different thread IDs remain separate. Cache schema 20 rebuilds the affected Codex index.

## Feedback and performance

Official, gateway and API switching share a compact dialog with actual current stage, elapsed time and counts when available. The gateway confirmation now has one `包含官方账号模型` checkbox and one short explanation. Completion uses notifications. Removing the final gateway model restores the original configuration; a saved empty selection stays empty after reopening the page.

History backup policy remains immutable baseline plus incremental deltas with reference validation. Unchanged known rollouts now reuse verified file identity (device, inode, size, nanosecond modification/change times), avoiding full snapshot reconstruction on every switch. Changed files still go through capture and validation. No historical backups are deleted by this release.

Synthetic 60-file / 30 MiB warm-cache comparison measured 209 ms before identity reuse and 84 ms with reuse for the backup-preparation step only. This is not a measurement or guarantee of total switching time. Native projection rebuilding, genuine context conversion and first legacy API import can still take time and now report their stage.

## Validation

- 189 targeted cases passed across 12 files: the 187-case suite passed, followed by the affected account and usage files with two additional regressions. These explicitly cover switching a chosen official account from legacy shared-home API mode, and indexing only isolated session directories while deduplicating their imported copy. Final source-retirement behavior also passed its service regression.
- Seven browser fixture checks passed: saved auth behavior, startup skeleton, completion notification, failure recovery, blur scope, last-model removal/remount, and compact API progress with real counts/busy cleanup.
- `codex-api-workspace-isolation.mts` used the installed native app-server, temporary homes and a synthetic Responses upstream. All ten checks passed: untouched original config/auth; legacy API adoption (including archived chats) and original archival; both directions of history isolation; same-source summary continuation; isolation between API sources; API exclusion from original database and gateway migration backups.
- macOS launch arguments and Windows environment propagation have regression tests. Windows desktop execution was not performed. Native desktop environment handling was inspected in the installed app; a second production GUI instance was not launched during this conversation.
- Typecheck, production build, whitespace checks, signature verification and 20 packaged-runtime checks passed. The packaged test now reads the API workspace revision rather than the main configuration revision, and asserts that API application leaves the main configuration unchanged. No production model requests were sent; live Codex config/auth and conversations were not modified during testing.

Release installation and packaged-runtime results are recorded in `release/v10.15.26.97/install-receipt.json`. The running application is preserved during bundle replacement; .97 takes effect on the user's next TokenFlow launch.
