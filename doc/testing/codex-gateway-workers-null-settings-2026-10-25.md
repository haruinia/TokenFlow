# Gateway worker nullable settings fix — 10.15.26.74

## User failure and cause

The new official thread had the `tokenflow_gateway` extension, the requested Gemini model was configured, and the arguments were valid. The tool returned the bridge's generic preflight failure before a worker was created. This is distinct from the earlier forked-thread test that used native collaboration.

A regression reproduces that response: after a successful parent start, a desktop-shaped `turn/start` sends `cwd: null`, `approvalPolicy: null`, `approvalsReviewer: null`, and `permissions: null`. The official engine interprets these optional nulls as no override. The bridge cached the request nulls over the effective settings from the engine, so the worker guard no longer saw a valid working directory. The test failed before the fix and passes after it. The installed desktop bundle includes nullable working-directory turn parameters; the installed engine's generated protocol schema documents optional settings and the special service-tier clear semantics. No raw production RPC trace was recorded, so the exact failing request's null fields were not captured.

## Change

Cache only effective non-null request overrides, except `serviceTier`, whose explicit null clears the existing tier. Preserve original RPC payloads to the official engine. The same rule applies to start/resume input bookkeeping and successful turn/settings updates. Server response fields remain authoritative.

Return specific locally authored validation errors for missing parent state, wrong provider, unconfigured model, task ownership, and incomplete permissions. Redact arbitrary runtime/transport errors and validation input values. No engine replacement, native collaboration interception, auth edit, or rollout migration is introduced.

## Validation

- Typecheck and 111 tests passed in worker, bridge, native-runtime, agent configuration and routing UI suites.
- Regression covers danger-full-access parent settings with nullable desktop overrides; companion test checks inherited settings and explicit service-tier clearing through provider reload. Error regression checks safe specific errors and redaction.
- Real official engine `0.164.0-alpha.11.1`, isolated HOME, copied login with refresh disabled, production service and bridge, real `gpt-6.1-sol` parent and `antigravity/gemini-3.8-flash-high` worker. Desktop nullable overrides included in each parent turn. Initial task and wait: 21.171 seconds; followup and wait: 18.910 seconds. Both task markers verified. Worker provider `token_flow`, effective permissions equal, independent session, parent provider remains `openai`.
- After stopping the isolated service, official continuation succeeded in 2.405 seconds with zero gateway requests. Same official engine PID, no official inference forwarding, isolated auth unchanged.
- Report: `results/codex-gateway-workers-desktop-nulls-gemini-2026-10-25.json`. The harness requested Code Mode but observed only dynamic tool events; it does not establish that the desktop's outer `functions.exec` wrapper was exercised. User desktop retry remains the end-to-end UI acceptance step. This bounded regression omitted a new compaction run; the earlier .73 compaction evidence remains separate.
- Production build, macOS arm64 package, ad-hoc signing verification, and all 19 packaged runtime checks passed.

## Rollout

Previous source `.73` is commit `1118391`; backup tag `backup/before-gateway-null-settings-2026-10-25`. Install archives the previous app and records config/auth hashes privately. Installation does not restart Codex. The currently running bridge keeps its old code until the user restarts Codex from TokenFlow. The user's new test thread already has the extension; reopening that thread after restart should suffice.
