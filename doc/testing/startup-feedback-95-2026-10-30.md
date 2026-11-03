# .95 startup authentication and feedback

## Scope

- Removed the renderer's automatic `POST .../inspect` effect when a saved account exists. Ordinary page reads use the existing on-demand service boundary and TokenFlow's saved account metadata. Native import and explicit account switch/restore remain user-initiated operations.
- TokenFlow's credential store continues to use revision-aware in-memory decryption caching. No new secret copies, external-client authentication polling permissions, or changes to inference routing were introduced.
- Initial Agent rendering now waits for saved accounts, target configuration and login-status metadata together. Other pages wait for initial account discovery. Once displayed, a page stays visible during background refresh.
- Completed Agent application/restart operations use existing notifications when no restart decision remains. Claude Desktop uses the same completion behavior. Confirmation and failure/retry dialogs remain.
- Standalone thinking uses a blurred backdrop. Open dialogs and loading skeletons retain their own progress presentation; the hidden shared indicator's backdrop is explicitly disabled.

## Reproduction and validation

Browser fixture: `doc/testing/prototypes/feedback-ui/index.html`, served from repository root by `npx vite --host 127.0.0.1 --port 17495`. All fetch calls are intercepted with synthetic data. It never starts/stops clients or reads credentials.

Before the fix, four checks failed: automatic external inspection, partial initial page, completed restart modal, missing standalone blur. After the fix five browser checks passed:

1. Saved Qoder account visible without `/inspect`; remount uses session read cache.
2. Complete initial skeleton; loaded panel appears; later account refresh preserves content.
3. Application retains restart choice; successful restart closes the dialog and emits a notification.
4. Claude Desktop success emits a notification; failed restart preserves error and retry.
5. Standalone indicator has backdrop blur; detailed dialog suppresses the shared indicator.

`npm run typecheck`, `npm run build`, `git diff --check` passed.
37 targeted Vitest tests passed across credential-access-service, startup-credential-order, secrets, agent-saved-accounts-ui and native-login-visibility. Service tests cover an actual background observation tick without external credential reads before import. Secret-store tests cover cached reads and credential changes.

macOS authorization dialogs were not operated. Actual user keychain prompting after a new process starts remains a manual verification; TokenFlow's own authorized vault access can still legitimately require macOS permission. This release does not restart the running gateway or Codex during installation.

## Package and installation

macOS arm64 .95 signature verification and all 20 packaged-runtime checks passed. Installed at `/Applications/TokenFlow.app` by staging and atomic bundle renames, preserving .94 in the backup path recorded in `release/v10.15.26.95/install-receipt.json`. Existing processes were preserved, gateway health was HTTP 200 before/after, and Codex config/auth hashes remained unchanged. The running app was not restarted; new-process startup is pending the user's next launch.
