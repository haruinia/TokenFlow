# .94: API source direct mode and switching costs

## Scope

API direct is a configuration operation. It uses saved credentials and route metadata; applying it does not probe, start a model turn, migrate threads, convert checkpoints or back up conversations. Configuration backups remain private and reversible. API conversations should be created as new conversations under the API provider. Existing conversation files are not cleared or overwritten.

The user selects a saved API source. Codex receives its compatible Responses catalog; Claude Code receives its compatible Messages menu. A native provider has one base URL, so only models sharing the selected compatible route can populate that native provider. Mixed-protocol or different-endpoint models remain available through the unified gateway. Model capability metadata is reused locally. Choosing another saved model inside the client is accepted when restoring configuration; unknown routing/credential edits remain conflicts.

Gateway ↔ official history compatibility remains a separate operation. API-born provider IDs are excluded by the existing migration selection. Native opaque compaction is not treated as portable plaintext; API mode does not promise cross-provider continuation.

## Confirmed causes and changes

1. The .93 direct endpoint required a model ID; a source-only request reproduced HTTP 400. The request now accepts a source ID, chooses its saved default and writes the compatible model list. The UI shows sources rather than model rows.
2. Gateway → API called the full official restoration wrapper. A configuration-only restoration seam now releases managed routing without invoking history restoration. The service regression checks that the migration restore method is never called for that transition, with zero inference requests.
3. Saved accounts previously stayed `not-inspected`. The Agent page now rechecks the current identity once when an authorized saved account is available. It does not import new accounts or switch the signed-in account. Removed the persistent uninspected notice and restored visible account/model loading feedback.
4. Source deletion now has an explicit cascade confirmation. It removes that source from native menus, managed routes and scoped keys, restores an active direct source, and clears matching maintenance/reviewer selections. Other sources remain intact. Client settings take effect on reload; active maintenance tasks and conflicting external edits remain guarded. Conversation and usage records are retained.
5. macOS used a nearly edge-to-edge brand image for both the app bundle and runtime Dock. A dedicated platform image uses transparent outer padding; the brand artwork and other platform assets are unchanged. `scripts/render-mac-icon.swift` reproduces the asset.

## Backup performance

The immutable full-baseline plus delta design already existed. It avoided repeated full backup storage, but maintenance still repeated hashing and macOS ACL/xattr commands during switches.

Maintenance now caches hashes in memory against device/inode/size/mtime/ctime, invalidates on change and limits cache size. ACL/xattr comparisons run only for equal-content candidates on different inodes. Reference validation, metadata stability checks and orphan rules are retained. The migration object reuses the maintenance instance between switches.

`npx tsx doc/testing/prototypes/backup-maintenance-benchmark.mts` creates and removes 100 synthetic, distinct, equal-sized histories (~12.5 MiB), with no real conversation content:

| Run | Before | After |
| --- | ---: | ---: |
| First check | 1366 ms | 672 ms |
| Unchanged repeat | 1150 ms | 30 ms |

The unchanged repeat reads no payload hashes and runs no ACL comparisons. This measures the maintenance stage, not the entire Codex shutdown/history migration/relaunch. First-time reference checking and required history migration still take time.

## Verification

- 202 distinct relevant regression cases passed across configuration, source cascade, native accounts, startup, packaging and history backup/migration suites. Added source-only apply, native model switching/restoration, partial-source removal, Claude Desktop live-menu removal and hash-cache invalidation checks.
- Typecheck and production build passed; packaged Electron runtime checks are recorded with the release.
- Isolated production UI: saved Codex account caused an identity inspection automatically; no persistent uninspected banner. Claude source apply wrote both `fixture-fast` and `fixture-large`, with a fake unreachable API endpoint and no probe.
- No real provider inference, real account switching or real conversation migration was used in verification.
- Installation uses an app-bundle replacement while the existing gateway process keeps running. See the release install receipt for version, hashes, retained backup, HTTP continuity and unchanged Codex configuration/auth checks. Reopening the installed application is required to load the new version.
