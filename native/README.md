# Codex native agent compatibility runtime

The runtime is an opt-in, separately installed app-server, not a replacement of the official Codex executable. Source revision and supported official CLI version are pinned in `codex-agent-runtime.json`. `codex-agent-runtime.patch` adds model/provider selection, native tool aliases, readable gateway-parent messages and encrypted-message guards. Native agent lifecycle, permission handling and official compaction are retained.

Build from the pinned upstream checkout with the patch applied:

```
npm run codex-agents:build -- --source /path/to/patched/codex
```

A prebuilt **release** app-server from that same patched tree may be supplied with `--prebuilt /path/to/codex-app-server`. The builder checks the source revision and exact diff, strips/signs a copy and generates the platform-specific manifest in `sidecars/darwin-<arch>/codex-native-agents/`. Generated binaries are not committed. The macOS package includes this directory. Apache license and upstream notice are in `LICENSES/`.

TokenFlow verifies platform, architecture, binary hash and exact official CLI version before applying the integration and before starting the runtime. The copy lives in `codex-direct-bridge/engines/<revision>/`; earlier versions remain available. The official Code Mode host is linked from the compatible installed Codex distribution. Official CLI commands other than bridged stdio app-server still use the official executable.

The launcher sets `TOKENFLOW_CODEX_AGENT_ROUTES_FILE` only for the compatibility app-server. It points to the private, atomically written bridge settings. Every spawn reads current model selections, so adding an allowed model need not replace the engine. Official providers are selected for official slugs and `token_flow` for selected gateway slugs. Unknown or ambiguous routes, missing provider definitions, cross-provider full-history forks and official ciphertext sent to gateway children fail before inference. Gateway parents can use original native tools with readable arguments; official parents use the `tokenflow_agents` message tools for gateway children. Original listing, waiting and interruption manage both kinds.

Configuration records save the original config before replacement. Launcher/routing changes save exact previous bridge files in `codex-direct-bridge/backups/` first. Identical launches create no extra snapshot. Restoring official routing uses the existing config recovery path and launches the untouched official app. No global launch environment or login file is changed by this integration. A Codex update outside the pinned version requires a validated runtime update, rather than silently running an untested engine against the new client.
