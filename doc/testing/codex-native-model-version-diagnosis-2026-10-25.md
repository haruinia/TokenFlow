# Compatibility runtime model rejection — 2026-10-25

Status: root cause reproduced; installed application remains 10.15.26.72. No runtime/config/auth/history changes applied by this investigation.

## User symptom and actual logs

At 06:31 America/Los_Angeles an official gpt-6.1-sol inference request failed with HTTP 400 and `model_not_found`. At 06:32 switching to gpt-6-sol triggered native pre-turn ModelDownshift compaction. It attempted the previous model, then retried the current model; both were rejected. Requests went directly to `https://chatgpt.com/backend-api/codex/responses`. This is not evidence that the historical gateway summary is invalid.

## Differential reproduction

Same current account, isolated temporary homes, refresh disabled, empty new conversations, same low reasoning request (`Reply exactly ACCESS_OK`), same network proxy, no user conversation content:

| Model | Installed official CLI | Packaged compatibility app-server |
| --- | --- | --- |
| gpt-6.1-sol | completed / expected reply | rejected: model not supported with ChatGPT account |
| gpt-6-sol | completed / expected reply | rejected: model not supported with ChatGPT account |
| gpt-6-astra | completed / expected reply | completed / expected reply |

The compatibility engine was invoked directly: the protocol bridge and previous provider switching are not necessary to reproduce the failure.

## Single-variable live verification

Two small direct official Responses requests used the same account, model gpt-6.1-sol, body, proxy and headers except the `version` header. The user-agent was held constant at a development version in both requests.

| version header | HTTP | response.completed |
| --- | --- | --- |
| 0.0.0 | 400 model_not_found, same user error | false |
| 0.164.0-alpha.11.1 | 200 | true |

Pinned source `codex-rs/Cargo.toml` has workspace package version `0.0.0`. `model-provider-info/src/lib.rs::create_openai_provider` sets the `version` request header from `CARGO_PKG_VERSION`; the default client also uses it in user-agent. The native packaging script validates the official client version in a manifest but does not stamp/validate the compiled runtime's package version. Manifest compatibility checks therefore did not ensure wire-protocol version compatibility.

This establishes version-header-dependent server behavior for this account/model/request. It does not establish the service's internal gating policy or universal availability.

## Repair requirements

Stamp a deliberate, compatible build version before compiling; include that build input in reproducibility/manifest validation and verify compiled version. Do not silently rewrite selected models or route official inference back through TokenFlow. Preserve explicit telemetry settings. Repeat live official/native model and native compaction checks before release, including both Sol models rather than only Astra. A rebuilt/installed fix has NOT been validated yet.

The earlier Astra-based live tests were real but insufficient to detect model-dependent version behavior.
