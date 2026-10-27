# Local Agent downloads select desktop clients — .82

The Codex download action could install `@openai/codex` through npm. Its detector also preferred a CLI on PATH over an installed desktop application, displaying the CLI version. Qoder and WorkBuddy could similarly report a PATH command as evidence of a desktop install.

The Local Agent download/status entry now treats every client except Claude Code CLI and Pi as a desktop client. It uses desktop app/Windows Store detection and opens the existing official desktop download page. A PATH CLI no longer makes these desktop entries appear installed. Codex has no npm installation recipe or npm release comparison in this entry. Internal CLI discovery/maintenance for Codex is separate and was not changed. Claude Desktop keeps its separate desktop download entry.

UI tooltips identify desktop downloads and CLI actions. CLI clients with a non-npm installation still show CLI wording when their official setup page is opened.

Verification:

- Added regression tests first; installation suite failed four cases against the old behavior (three CLI-only desktop detections and desktop/CLI precedence).
- Installation, updates and connection suites: 113 tests passed. Existing CLI installer/prefix/error coverage now exercises Pi; Claude installer verification remains covered.
- Typecheck and production build passed.
- On this machine, actual Codex detection reports `channel: application`, `automatic: false`, desktop version `26.1021.31345`, and the official desktop download URL.
- Tests mock installers and external navigation; no agent was installed or upgraded as part of verification.
