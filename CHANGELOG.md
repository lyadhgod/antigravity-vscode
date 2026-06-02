# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-05-29

### Added

- Initial release: a VS Code wrapper for the Antigravity CLI (`agy`).
- **Material 3 Expressive chat panel** (webview) with streamed responses, tool
  activity, token usage, conversation threading, and Goal mode.
- **Ask About Selection** — send highlighted code with file/line context.
- **Interactive agent session** in an integrated terminal, plus **Continue** and
  **Resume by id**.
- Account & lifecycle commands: **Sign In** (Google OAuth), **Sign Out**,
  **Install CLI**, **Update CLI**, **Show CLI Version**, **Select Model**.
- Status‑bar readiness indicator and onboarding that guides install/sign‑in.
- Configuration: `cliPath`, `model`, `extraArgs`, `skipPermissions`,
  `printTimeoutMs`, `autoAddWorkspaceFolders`, `outputFormat`, `installCommand`.
- `vscode`‑free core (binary resolution, argument building, fault‑tolerant
  JSON‑stream parsing, onboarding logic, process runner) with a 46‑case
  unit/integration suite running against a stub CLI.
