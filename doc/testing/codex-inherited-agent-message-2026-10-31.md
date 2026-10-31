# Unified gateway continuation: historical encrypted agent replies

## Finding

The reported October 31 08:49 America/Los_Angeles failures are `codex_encrypted_agent_message` with HTTP 422 on the Qiniu DeepSeek route. This is not a new inference rejection from DeepSeek. The local conversion boundary fails before sending the recovered history upstream.

At inspection, main config selected `token_flow`, disabled `multi_agent_v2`, and all official/gateway catalog entries were v1. The latest failing rollout also had v1 metadata. Its native compaction checkpoint depends on five rollout segments. The ancestor contains two encrypted `agent_message` replies dated October 23, sent from a child to its parent, rather than newly generated dispatch tasks.

Read-only replay of that exact checkpoint with the current product `CodexContext.recover` reproduced status 422 and `codex_encrypted_agent_message`. Only the selected lineage was read; a temporary derived cache was used and removed. No real config, auth, history, or backup files were written. No model request was sent. The result artifact contains only lineage count and error code/status.

Protocol migration changes future tool/dispatch behavior; it deliberately leaves encrypted message bodies intact. Native-checkpoint recovery reconstructs prior history and therefore encounters the retained ciphertext again. Switching to v1 does not decode it. Existing fixes for v1 migration are not a lossless historical-ciphertext converter. The present generic error also calls all such messages tasks, which is inaccurate for this return-message case.

The process serving port 9527 was still mapped to the .96 bundle retained during the .97 hot replacement. .97 was installed at 09:21 local time, after these 08:49 errors. Restart is needed for API-workspace isolation to take effect, but the historical ciphertext limitation reproduces in the .97 source as well; restart alone is not a remedy.

## Isolation tests

`node --import tsx doc/testing/prototypes/codex-unified-api-protocol-continuation.mts`

Uses the installed native engine `0.166.0-alpha.5.1`, temporary homes, the product migration and API-workspace components, and deterministic local responses. It does not use production credentials or paid model inference.

- Existing official-v2 metadata → product gateway migration → v1 native dispatch succeeds; restoring native settings restores the original v2 setting.
- Fresh unified-provider chat: official model identity → gateway model identity completes with v1.
- Entering and leaving an isolated API home preserves the original unified config. Resuming the fresh main chat with the official model, then switching to the gateway model again completes with v1.
- These successful fresh-chat cases contain no historical encrypted agent messages. They do not establish that arbitrary old ciphertext can be converted.

`npx vitest run tests/codex-context.test.ts -t 'encrypted ancestral agent replies|rejects encrypted agent tasks'`

Two targeted cases verify that neither current v1 metadata nor a readable routing prefix substitutes for an old encrypted reply. Parent/child history remains unchanged. The additional case captures the reported branch + native-compaction seam so a future recovery design must explicitly address it.

## Recovery boundary

Keep the original history and protocol migration independent. To continue an affected old history on a gateway, obtain a complete readable handoff summary from an official model that can consume the ciphertext, or recover an exact, identity-linked plaintext counterpart. Do not drop the ciphertext, substitute its routing prefix, use an unrelated later message, or relabel it as plaintext. Automatic official-summary handoff has not been implemented or validated by this investigation. The currently supported manual handoff is a readable summary used to start a gateway conversation.

An official model selected inside the unified gateway remains v1. An official-direct conversation may use its original v2 setting; entering the gateway later migrates future protocol behavior but does not make previously created encrypted messages readable.
