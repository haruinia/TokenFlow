# .96 Codex API-direct provider lifecycle

## Report and reproduction

Entering API direct from the unified gateway removed `model_providers.token_flow` through configuration-only restoration, while SQLite routes and rollout headers still named `token_flow`. The API restore and account-switch paths also skipped gateway history restoration. An isolated installed-native-Codex app-server reproduced `Model provider token_flow not found`, including resume without a caller-supplied provider override. Removing the API provider on restoration reproduced the same error for `api_direct_<source>`.

The original records were not deleted. Provider-based thread listing can exclude other buckets; this differs from missing history. Further native testing found that `thread/resume` updates SQLite routing but can leave the first rollout `session_meta.model_provider` unchanged. `thread/list` then omitted the restored official thread despite successful resume.

## Boundary agreed with user

API histories remain source-specific. Restoring account direct access leaves their content and summaries intact; continuing them requires reselecting their API source. They are not included in official/unified-gateway migrations.

- Entering API direct from the gateway first completes the existing **gateway exit** transaction: context portability, original protocol restoration, provider routing and recovery records. The subsequent API configuration transaction does not migrate API conversations.
- API restoration retains a credential-free inactive provider identity, with a fixed local inactive endpoint. The selected default returns to the original official configuration. This identity only allows Codex to load the conversation; it does not forward inference. The endpoint refuses requests before body parsing and does not resolve secrets, store prompts or call an upstream.
- Reselecting the API replaces its inactive table with its saved live configuration and reuses the same source/provider ID.
- Account switching also repairs gateway history left behind by older API-direct versions.
- A separate session-routing transform updates only the session header provider. Historical turn model metadata and encrypted/message/compaction items are unchanged. It uses the existing offline history editor for backups, branch byte-boundary updates and projection repair. Prior restored journals get a one-time header reconciliation; new journal records avoid repeating that scan.
- UI action: `恢复原账号直连`.

No live Codex configuration, auth file or conversations were modified during the research/tests.

## Upstream comparison (latest main fetched 2026-10-30)

CC Switch source files:

- https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/live/project/codex.rs — fetched blob `da74d3935433e7076efcea825c4ba4ddb1ef1800`. `RouteWrite::Official` retains `custom` as a dormant table with a local proxy address and placeholder key, explicitly to avoid breaking resume. Its third-party sources share `custom`; TokenFlow keeps independent source IDs per the requested boundary.
- https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/provider/codex_direct.rs — fetched blob `031219792bca663621b74679a9c403e1c6a1257a`. Normal official access and optional unified history are separate route projections.
- https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/codex_config.rs — fetched blob `a0f12790a1c1bf323785a86df0e26cad40c1adad`.

DeepSeek documentation: https://api-docs.deepseek.com/quick_start/agent_integrations/codex/ describes backing up config.toml, generating model metadata and writing the DeepSeek provider. It is not a promise of translating other providers' existing conversation history.

## Verification

`doc/testing/prototypes/codex-api-provider-lifecycle.mts` runs the installed native engine against a temporary Codex home, the real TokenFlow service and a synthetic upstream. No production inference/account credentials. Verified:

- Gateway-created thread can resume after entering API direct and after restoring official access.
- Official and API threads appear in their respective native `thread/list` buckets.
- Inactive API history can load after official restoration.
- API compaction summary survives restoration and is used after reselecting the same API.
- Re-entering the gateway does not migrate the API thread or include it in migration backups.
- Inactive-source requests return `api_direct_inactive` without upstream inference.

Additional tests cover metadata/content separation, third-party drift rejection, one-time legacy header repair, model capability preservation, independent config edits, interrupted restore journals, and explicit UI wording.

## Backup policy

Configuration recovery is still required for API direct. API history is not modified, so it needs no migration backup. Gateway/official transitions do alter provider/protocol metadata and may materialize portable context; retain recovery points for those affected records. Existing immutable baselines, incremental deltas and reference checks remain. This fix does not delete old backups or claim every existing backup is redundant.

## Release verification

110 targeted tests passed (including distinct API sources with identical model IDs and rejecting malformed inactive requests before parsing). Typecheck, build, whitespace checks and the native lifecycle fixture passed. The signed macOS arm64 package passed 20 packaged-runtime checks.

Installed .96 to `/Applications/TokenFlow.app` without stopping the current process. Installation receipt: `release/v10.15.26.96/install-receipt.json`; .95 was retained as recorded there. Gateway health remained HTTP 200, process PIDs were preserved, and live Codex config/auth hashes were unchanged. New GUI-process startup remains pending the user's next launch.
