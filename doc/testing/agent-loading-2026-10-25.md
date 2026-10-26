# Local Agent loading layout (.77)

The initial account response and gateway catalog settle separately. Previously the page inserted a loading paragraph, rendered an unpooled account as a vertically stacked div (missing flex display), then replaced it with pooled account buttons. Gateway labels changed from raw IDs to catalog labels and the current-model badge could disappear until availability was established.

Changes:
- Reserve the official-account section while login is initially unknown; render row-shaped field skeletons while account metadata is incomplete.
- Share horizontal flex layout between noninteractive account identities and loaded account buttons.
- Remove the catalog-loading paragraph from this page; use inline existing shimmer styles on unknown model/source names and tab labels.
- Keep the configured default model visible while catalog availability is pending.
- Mark the renderer's initial empty account snapshot as loading, rather than confirmed empty.
- Reduced-motion preference uses the existing nonanimated skeleton rules.

Validation: TypeScript and production build pass; 18 source selection, identity, visibility and routing UI tests pass. Packaged runtime validation is recorded in /tmp/tf-77-runtime.log. No Codex configuration, login or backend routing changes are part of this patch. An isolated browser preview could not read authenticated local API endpoints; it was closed without mutations. Desktop verification follows installation.
