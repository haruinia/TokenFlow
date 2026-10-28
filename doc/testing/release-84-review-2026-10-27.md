# .84 review and release

Reviewed `8f262f4...9f280cf` against the user's request for source-aware native dispatch, gateway message folding and safe official/gateway continuation. Two independent review agents examined standards/structure and specification behavior. No root repository coding-standard files were found.

## Standards review

Found and fixed completed server tools being confused with pending client tools, and explicit streaming message phases being contradicted by terminal copies. A follow-up review found nonterminal inferred commentary being remembered as explicit evidence; the phase state now remembers only explicitly supplied phases. All have focused red-to-green regressions.

Structural coupling was addressed by splitting:

- `codex-item-provenance.ts`: stable gateway item identity, including ID-less items via output index; no task/phase logic.
- `codex-message-phases.ts`: explicit phase evidence and client-versus-server tool completion; no ciphertext/routing logic.
- `codex-response-protocol.ts`: JSON/SSE transport adaptation and cancellation.
- `codex-history-items.ts`: separate destination policies for gateway-readable history and official input.
- `codex-agent-messages.ts`: only explicit `agent_message` task decoding on the gateway path.
- `codex-context.ts`: local checkpoint recovery and history persistence; uses the destination policies.

## Spec review

Found and fixed missing provenance for ID-less foreign reasoning, server-tool phase classification, current-directory precedence over historical directories, and JSON cancellation propagation. Re-review reported no remaining release blocker in this scope.

An additional checkpoint regression reproduced the user's specific concern: official encrypted agent tasks restored from a local checkpoint were being passed into the gateway-only rejection branch. Official-bound native agent messages, reasoning and compaction now have explicit preservation policies. A combined test includes ordinary foreign reasoning and a native encrypted agent task in the same official request: only the foreign reasoning is converted. Native task lifecycle APIs remain unchanged.

## Validation

- Main regression run: 219 tests passed; added snapshot regression and rerun passed (220 distinct tests total).
- Typecheck and production build passed after the review fixes.
- Installed native engine, isolated home, real official → Qoder DeepSeek → official: all turns completed and the exact requirement marker survived. Evidence: `results/codex-84-review-live-roundtrip.json`.
- Tests cover official native opaque state, local checkpoint recovery, plain subagent tasks, encrypted gateway task rejection, ordinary messages, source discovery, JSON/SSE phases, tool call pairs and cancellation.
- Desktop visual folding remains a separate UI verification boundary; phase correctness alone is not claimed as visual equivalence.

## Release actions

Target version: 10.15.26.84. Installation, package checks, website replacement and normal Codex apply/restart receipts are recorded as they complete. Previous .83 artifacts and installed app are retained for rollback.
