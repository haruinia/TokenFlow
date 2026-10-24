# Protocol and import robustness review — 2026-10-24

Review baseline: `cccc283`. This review uses source inspection, synthetic credentials, local mock HTTP servers and maintained Go overlays. **New real provider requests: 0. Real credentials read: 0.** No production process, user configuration or installed binary was changed by this review. The initial protocol repairs do not change UI; a subsequently authorized Desktop workflow correction is recorded below. The coordinator owns final sidecar builds and installation.

## Confirmed defects and repairs

### Context capacity was lost between the registry and Core

The official catalog parser already populates `ModelInfo.ContextLength` and `InputTokenLimit`. Management `/auth-files/models` previously emitted ID, names and image modalities, dropping capacity. Core normally creates its model from that per-account endpoint and does not replace it with the provider-wide `/v1/models` entry. Consequently, the existing common `compactionModelWindow` consumer could receive no provider capacity despite successful discovery. This is a metadata plumbing defect across providers, not evidence of the original Claude compaction loop's cause.

The maintained `official-catalog-overlay.mjs` now emits positive `context_length`, preferring registry `ContextLength` and falling back to `InputTokenLimit`. Core normalizes `context_length`, legacy `context_window`, then `inputTokenLimit` into the existing `LocalModel.contextWindow`. Unknown capacity remains unknown. Optional malformed, zero, fractional, negative or unsafe capacity values are ignored rather than causing schema parsing to discard the entire callable model catalog. No model-name heuristic, guessed window, or universal 256k setting was introduced. The internal Codex client override `MaxContextLength` remains separate from advertised provider capacity.

Red evidence: `node scripts/test-official-catalog.mjs` failed with both canonical and Gemini-style capacities `<nil>` instead of 123456/654321. A Core integration fixture additionally showed one malformed capacity causing even the valid `canonical` model to disappear. Green coverage now includes canonical priority, Gemini-style fallback, unknown/invalid capacity, legacy Core field normalization, and actual mock vendor discovery → refresh → namespaced alias → management serialization.

### Supplier import could choose an unrelated credential

A synthetic Codex export declared `env_key="VENDOR_API_KEY"` while its separate exported `auth.OPENAI_API_KEY` held another synthetic value. Preview incorrectly marked it ready, and the initial ignored repro confirmed apply stored the unrelated value. Nested `[model_providers.custom.auth]` command credentials were also missed because the old guard only checked `provider.command`. This is an actual credential-source selection defect; no real user import or authentication request was required to prove it.

The importer now treats explicit credential sources as authoritative:

- Environment credentials are skipped with an explanation to enter the supplier API key manually; the importer neither reads environment values nor substitutes an exported global key.
- Command credentials, including the nested `auth` configuration, are skipped without executing commands. Extra headers remain unsupported with a specific explanation.
- `requires_openai_auth=true` ignores `env_key` and accepts only the exported API key. OAuth token data is not converted into an API source.
- OpenAI authentication combined with a direct bearer is treated as an ambiguous configuration and skipped. No undocumented precedence is invented.
- Existing supported CC Switch direct bearer and exported API-key imports without an explicit external credential source retain their behavior.

These decisions follow the official [authentication documentation](https://learn.chatgpt.com/docs/auth) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), opened on 2026-10-24. The former defines OpenAI-vs-environment selection; the latter defines nested command authentication and its incompatible combinations. The fixture initially reported `ready/exists/ready` for environment/command/conflicting environment configurations; it now reports three unsupported rows, rejects their application and stores nothing. Separate tests cover documented OpenAI/environment selection, unavailable OAuth-only exports and ambiguous direct bearer selection. Preview errors never disclose the credential values, environment variable name or command.

## Existing mechanisms reviewed

### Cursor model compatibility

The narrow Grok 4.7 policy is supported by the coordinator's earlier same-account installed SDK-key A/B: advertised 500k/high/fast returned `model_not_found`, while changing only context to the advertised 256k variant finished successfully. This evidence does not justify changing other models or every request to 256k.

Responsibility is already localized: `cursorLocalAlternative` describes the one demonstrated parameter compatibility case; the account runner implements bounded retry and execution safety; `CursorLocalModelCompatibility` owns temporary scoped selection. The alternate must be an exact advertised variant and preserves effort/speed. Retry requires an explicit model rejection with no observed output, generated usage or tool activity, plus successful disposal. Disposal failure, cancellation, credential replacement, authorization errors and other failures veto replay. Cache scope includes the credential object, complete model catalog definition and complete parameter combination, with a five-minute absolute expiry that does not renew on hits. Tests cover create/send/wait failure paths, output/tool vetoes, cleanup failure, cache scope and sustained-hit expiration.

The SDK can fail during send startup or report asynchronous failure through wait; both paths are covered offline. The original A/B summary does not record its precise SDK failure phase, so it cannot prove which path that historical request took. The coordinator's later production-entry smoke verified the implemented recovery separately. The earlier temporary harness's `/var` symlink rejection occurred before send and was a harness path issue, not an SDK or production compatibility defect.

Keep the demonstrated value policy narrow. If a second proven incompatibility appears, adding a small policy definition at this seam is reasonable; a global parameter downgrade or speculative provider framework would remove useful guarantees without evidence.

### Antigravity Claude CLI/Desktop translation

The tool-name mapping is a target protocol adaptation, scoped to Anthropic Messages input targeting Claude through Antigravity. It includes declarations, historical tool calls and `tool_choice`, deterministic collision suffixes and reverse mapping for responses. Gemini retains its prior name handling. Historical tools removed from current declarations remain represented. This is a justified protocol boundary; duplicating it by CLI/Desktop client brand would make behavior less consistent.

The usage adapter converts Gemini-style prompt totals, which include cached tokens, into Anthropic's disjoint input/cache categories. Messages → Responses adds them once. The existing red fixture reproduced 123000 prompt / 122000 cached becoming 245000 input; the maintained fix keeps 123000. Missing-candidate output fallback similarly no longer treats cache input as output. Direct Antigravity → Responses already had the correct total and was not changed. Safe error paths retain structural positions without retaining arbitrary tool names or prompt text.

Historical validation boundaries remain those in [the prior model protocol report](model-protocol-repair-2026-10-23.md): real synthetic upstream requests established dot-name rejection and underscore acceptance, normal native signatures, and rejection of intentionally corrupted signatures. Corrupted signatures are a negative control, not the user's original root cause. A real isolated CLI→mock capture sampled CLI structure; Desktop was not captured live. Neither original client failure can be conclusively attributed to these defects without its original request. This review adds no real inference, signature handling probe or claim of complete Desktop payload coverage.

### Catalog refresh and supplier import recovery

Official catalogs are scoped by account and credential/provider/endpoint fingerprint, serialize refreshes, coalesce reads for 30 seconds and retain only a recently verified list for up to 15 minutes on transient failure. Static model metadata does not grant account permissions. Empty verified lists, unsupported providers and unavailable catalogs remain distinct; aliases and exclusions survive refresh. Existing tests exercise these behaviors. The capacity repair carries capability information through that existing flow rather than introducing a second discovery mechanism.

Supplier import uses bounded literal JSON/SQL or read-only SQLite adapters, central API-source validation and bounded preview lifetime. SQL exports are parsed rather than executed; SQLite extension loading is disabled and reads include committed WAL data. Deduplication compares address, protocol, key, real model IDs and per-model routes. Apply rechecks duplicates after preview. Batch import stages encrypted values and metadata, rolls back on storage failure and supports retry. HTTP source mutations, including import apply, already share the service mutation owner; a direct-module concurrency scenario is not evidence of an exposed HTTP race. Existing tests cover rollback/retry, idempotency, read-only ingestion, duplicate rechecks and route preservation.

The new authentication guard belongs in this common data adapter. It does not call provider APIs, refresh credentials, inspect a user's environment or create another credential cache. Credential acquisition and refresh concurrency remain separate work owned by the coordinator's credential-module review.

## Validation

- Red then green: three new TypeScript tests and one new Go test, plus the strengthened existing Go discovery/alias test.
- `npx vitest run tests/supplier-import.test.ts tests/cliproxy-login.test.ts tests/initial-compaction.test.ts tests/cursor-local-service.test.ts tests/upstream-errors.test.ts`: **132 passed**.
- `npx vitest run tests/cursor.test.ts tests/cursor-model-probe.test.ts`: **83 passed**.
- `node scripts/test-official-catalog.mjs`: **23 top-level official-catalog tests passed** using maintained overlays and local fixtures.
- `node scripts/test-sidecar-model-protocol.mjs`: Antigravity Claude translator package passed, including maintained name/collision/history/Gemini and usage regressions.
- `npm run typecheck` and `git diff --check`: passed.

The final sidecar binaries must be rebuilt for both architectures by the coordinator because the management serialization overlay changed. TypeScript and Go fixture success verifies behavior at these boundaries; it is not a new live vendor or installed-application validation.

## Bounded follow-up: client configuration, installation and UI

Read the existing client-configuration/UI reports, `doc/design.md` and `.impeccable.md`, then checked production paths and reran their relevant tests. The following mechanisms match the intended design:

- Missing standalone Claude CLI does not block shared configuration for the VS Code extension. `detectAgent` declares `configurationSupported` independently from installation, and `AgentsPage.applySelected` gates on that capability. CLI installation and the CLI/Desktop switch remain available. This verifies configuration capability, not a live extension conversation.
- Installation uses fixed npm package names, the official registry and direct process arguments. An identified global npm installation updates in its verified existing prefix; a local project's `node_modules` does not become a global prefix. Native/desktop channels open their existing official download entry, and their versions are not compared with npm releases. Tests mock files and installer processes; no package was installed or updated. Automatic native-channel updates remain outside the implemented npm scope.
- Bad Codex TOML is recovered from a completely parsed backup or a minimal legal base. The original bytes are retained in a private repair backup; public previews omit them. The configuration mutation queue and exclusive lock serialize TokenFlow writers. Revision checks occur before staging and immediately before atomic rename. Account restoration additionally checks the native login identity. Tests exercise malformed apply/restore, prepared journals, original-byte preservation and intervening writes. These protections do not claim a filesystem-wide transaction with arbitrary unrelated editors.
- Navigation renders “使用” before “供应商”. Claude CLI/Desktop switching remains in the existing Agent page. One `ThinkingFeedback` popover is shared by mounted callers, closed dialogs do not register loading, and its fallback is hidden when a dialog or skeleton already provides loading context. The existing fixed application-dialog class provides 440×360 sizing with viewport shrinkage. No style change is needed.

The additional regression command was:

`npx vitest run tests/agent-installation.test.ts tests/agent-updates.test.ts tests/agent-connections.test.ts tests/client-configuration-repair-service.test.ts tests/codex-accounts.test.ts tests/ui-request.test.ts tests/flow-model.test.ts tests/agent-model-switching.test.ts tests/claude-desktop.test.ts tests/claude-desktop-service.test.ts`

Result: **10 files / 156 tests passed**. This includes mocked installers, temporary configuration directories and local HTTP service tests. It does not establish live VS Code, native installer, Windows or real Desktop restart behavior.

### Confirmed Desktop workflow omission and authorized correction

`ClaudeDesktopPanel.apply` previously closed its operation dialog and emitted a success notification; failure emitted an error notification. Its dialog used only `tfRestartDialog`, so its height followed its contents. This violated the existing design requirement that progress, result, failure and restart controls stay in the same fixed application window. Existing UI checks asserted that the Desktop entry existed but did not exercise this operation path. Backend tests passing therefore did not cover the UI requirement.

After reporting that evidence, the coordinator authorized a correction limited to `ClaudeDesktopPanel` and the existing UI fixture script. The component now reuses `tfModelApplyDialog`, the shared `Thinking`, and confirm/working/saved/error state transitions. Default/fast model choices remain in the application flow; request results, failures and retries remain in its window. Restart confirmation, progress, failure, retry and completion use the same window. An automatically reopened client shows completion; an application failure with a configured Desktop may offer restart in that window. No CSS, decoration or backend behavior was added.

The expanded `scripts/client-capabilities-ui-check.cjs` fixture exercises Desktop application failure → retry → success, submitted default/fast roles, restart failure → retry → success, one shared Thinking, no error toast, and identical window position/size at each phase. Against the old built renderer it failed deterministically: Desktop height was **360.6875 rather than fixed 360**. After the coordinator rebuilt the UI, the script passed all seven scenario groups. Desktop confirmation, progress, failure, success and restart kept exactly the same 440×360 rectangle; the separate default and fast choices were submitted correctly, with one Thinking while busy and no operation error toast. Screenshots `08-desktop-apply-error.png`, `09-desktop-applied.png` and `10-desktop-restarted.png` in ignored `release/client-capabilities-ui/` were opened and visually inspected. The existing light/small-window and supplier preview checks also passed. Type checking, script syntax and diff checks pass. This is an isolated built-renderer test with fixture HTTP endpoints and a temporary Electron profile; it does not restart the real Claude Desktop or change any real client configuration.

The coordinator's screenshot review additionally clarified the user's original requirement: Desktop's normal model list must not display default/fast roles at all. The list now omits role badges, role usage descriptions and first-model highlighting, while retaining ordinary model/source labels, actual unavailable states and the model-count limit. Role selection and explanations remain solely in the application dialog. `doc/design.md` records this distinction. The maintained UI script checks the absence of list roles before applying and after closing application/restart results, while retaining its two-role selectors and submitted-role assertions. No CSS was added. After the coordinator's final UI rebuild (2026-10-24 00:45:54 local), all seven scenario groups passed again, including the new role-display assertions. The refreshed Desktop result screenshot was opened and checked: background model rows are plain, have no role badges or role descriptions, and no first-row role highlight. The application role choices, fixed dialog and single Thinking assertions still pass.
