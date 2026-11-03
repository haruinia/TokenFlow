# .83 installation and LAN download service

- Built Apple Silicon and Intel macOS applications from the native-agent/model-directory change. Both bundles pass ad-hoc signature verification; both DMGs pass `hdiutil verify`. Apple Silicon packaged runtime passed all 19 checks. Intel is cross-built, not validated on physical Intel hardware; packages remain unnotarized as indicated on the download page.
- Installed .83 at `/Applications/TokenFlow.app`. App archive matches the build, service returned HTTP 200, and the installer left Codex config/auth unchanged. No replacement Codex engine was packaged. Previous .82 app retained in `release/v10.15.26.83/installed-before-83.app` and `/Applications/.TokenFlow-before-83.app`.
- Updated the existing website at `analysis-corpus/sites/tokenflow-story-4180/dist`: version, both chip-specific download links, and asset hashes. Previous website files saved in its `research/downloads-before-83/`. Prior release artifacts retained.
- Both DMGs were downloaded through `http://10.10.10.196:4180/`; HTTP 200 and SHA-256 matched the release files. Receipts are in `release/v10.15.26.83/installers/`.
- Replaced terminal-bound serving with LaunchAgent `com.tokenflow.downloads4180`. It runs `/usr/bin/python3 -m http.server` against the existing static directory, starts at login, and restarts on exit. Deliberately terminated its owned process once: launchd started a new PID and the site recovered successfully.

Commands:

```sh
./scripts/download-server-4180.command start
./scripts/download-server-4180.command restart
./scripts/download-server-4180.command status
./scripts/download-server-4180.command stop
```

Logs: `~/Library/Logs/TokenFlow/downloads-4180.log` and `downloads-4180-error.log`. Serving survives terminal closure; a sleeping/offline computer cannot serve LAN requests.

The normal TokenFlow UI apply/restart action completed. A later read-only verification confirmed the active provider is `token_flow`, `/codex/v1` is selected, native `multi_agent=true` / `multi_agent_v2=false`, all catalog entries use v1, and the managed directory is present. Subsequent protocol investigations run in isolated homes and do not reapply production configuration.
