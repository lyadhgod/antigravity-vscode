# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Cross-platform robustness and interactive-output fixes, grounded in probing the
real `agy` TUI end-to-end.

### Fixed

- **Windows sign-in / lifecycle commands no longer fail on PowerShell (#2).**
  Command lines sent to the integrated terminal are now quoted for the actual
  shell — PowerShell gets the call operator (`& 'C:\…\agy.exe'`) so a quoted path
  is executed instead of echoed as a string literal; cmd.exe gets double-quote
  rules; POSIX is unchanged.
- **The chat reply no longer starts with the tail of your own message (#reply-leak).**
  A long prompt is word-wrapped by the TUI onto rows indented exactly like the
  reply; the wrapped tail was leaking into the assistant text. It is now stripped.
- **Selector separators are no longer shown as dead options.** A group divider
  such as `/resume`'s "── other workspaces ──" is recognised and skipped.
- **Sessions no longer hang / drop replies after a few turns (#hang).** A
  readiness tweak had made *any* frame showing the pinned input box read as
  "idle" — including a mid-generation frame that momentarily lacks the
  "esc to cancel" line — so a turn could be finalized while the agent was still
  answering; the next prompt was then sent while the CLI was busy and never ran.
  Readiness ("ready for input") and turn-completion ("idle") are now separate
  signals: idle still requires the "? for shortcuts" status line, while a new
  structural `ready` flag (the input box is painted) clears the startup guard.
- **Fewer false "session ended before it was ready" errors (#5).** Readiness now
  also uses the structural pinned input box (the new `ready` flag), not only the
  exact "? for shortcuts" status wording, so a CLI version that rewords the
  status line is still detected as ready. The sign-in gate no longer hard-blocks when the
  on-disk token check misses a keychain-stored or terminal-established login
  (#3, #5) — "Continue anyway" is always offered.
- **macOS sessions and the sign-in check now work at all (#3).** The PTY shim was
  `script` everywhere, but macOS/BSD `script` cannot be used from an extension:
  besides not having the util-linux `-c`/`-e` flags, it calls `tcgetattr` on its
  own stdin and aborts unless that fails with `ENOTTY` — and every stdin we can
  write to (Node's piped stdio is a socketpair, as is a pipe or FIFO) fails with
  `EOPNOTSUPP` instead. So it exited immediately with
  `script: tcgetattr/ioctl: Operation not supported on socket`, before `agy` ever
  ran. The auth probe saw no screen at all and fell through to "signed in", so
  macOS reported a working CLI while signed out, and every session died at once.
  macOS/BSD now use `expect` (also part of the base system), which allocates the
  PTY itself and doesn't care what its own stdio is; Linux still uses `script`.
- **No more duplicate browser launch on sign-in.** `agy` runs `open <url>` itself
  the moment it paints the OAuth screen (it ignores `$BROWSER` and has no flag to
  stop it), so the extension's own `openExternal` only added a redundant "open the
  external website?" prompt for a page that was already open. The extension no
  longer opens the URL automatically; the gate's Open button still does, on click.
- **Sign-in no longer hangs with the button stuck disabled (#8).** Refreshing the
  onboarding state launches a throwaway `agy` to ask whether a login is needed —
  and the OAuth step opens the external browser, so returning to the editor fired
  the panel's visibility refresh and spawned that second CLI *during* the sign-in,
  racing the live one for the same credential store. It also swapped the gate card
  for the "checking" skeleton and back on every return trip, clearing the OAuth URL
  row and any code typed into it. A refresh is now skipped entirely while a sign-in
  flow owns the CLI. Clicking "Sign in" again mid-flow no longer starts a second
  CLI *or* silently swallows the click (which left the button, disabled on click,
  with nothing able to re-enable it) — it re-surfaces the running flow instead.
- **Closing a session no longer leaves an `agy` process behind.** `agy` ignores
  SIGHUP and the PTY shim puts it in its own session, so killing the shim orphaned
  it. Teardown now closes the shim's stdin first, which ends its forwarding loop
  and kills `agy` by pid; the signals remain as a fallback.
- **Native Windows chat now actually works (#1, #2).** The ConPTY backend is
  shipped with the extension as prebuilt Node-API binaries
  (`@lydell/node-pty-win32-x64` / `-arm64`), so no node-gyp rebuild per VS Code
  version is needed and the WSL-only workaround is gone. A `.cmd`/`.bat` shim on
  `PATH` (how npm-installed CLIs land there) is run through `cmd.exe /c`, since
  ConPTY cannot execute one directly. If the backend is somehow missing, the
  message names it instead of claiming `agy` isn't installed.
- **A session that dies before the prompt now reports what it printed.** The
  last output line (e.g. a `script` usage error or a CLI crash) is surfaced, and
  spawn failures carry the OS error, instead of everything being blamed on
  "check that `agy` is installed and you're signed in".

### Changed

- Option cards parse an inline `(current)` marker and secondary description
  (seen on `/model`, `/permissions`, `/hooks`) into a bold name, a "current"
  badge, and muted description text.

## [0.5.0] — 2026-06-03

Fifth feedback round — chat-output layout and UI polish.

### Changed

- **Model output is no longer a chat bubble (#4).** Your prompts still appear as
  right-aligned bubbles, but the model's reply now renders as **full-width
  document content** filling the chat section below the input — easier to read
  for long, structured answers.
- **New Session option checkboxes are rounded and larger (#1)**, with a custom
  tick that sits comfortably inside.
- **The back button springs open (#2).** Entering a chat now expands the back
  button from its centre to take its space (and collapses the same way), instead
  of flipping in and out abruptly.
- **Title-bar overflow menu reorganised (#5).** Removed **Update CLI** and **Show
  CLI Changelog**; **Manage Plugins** and **Add Directory to Agent Workspace**
  lost their trailing ellipses; **Manage Plugins** and **Show CLI Version** moved
  up into the top section, directly under **Add Directory to Agent Workspace**.

### Removed

- The **New Session** ("+") button from the view title bar (#3) — start sessions
  from the **New Session** button in the list instead.

## [0.4.0] — 2026-06-03

Fourth feedback round — UI polish and a corrected, real slash-command catalog.

### Added

- **Real slash-command catalog (#8).** Replaced the partly-guessed list with the
  **actual 35 commands** captured directly from `agy` v1.0.4 by driving its TUI
  through a PTY and reading the `/` autocomplete — including parenthesised
  aliases (`/clear`↔`new`, `/exit`↔`quit`, `/fork`↔`branch`, `/resume`↔`switch`,
  `/rewind`↔`undo`, `/usage`↔`quota`, `/config`↔`settings`). Non-existent
  commands (`/compact`, `/memory`, `/init`, `/commit`, `/cost`) are gone. The
  navigator now matches aliases too.
- **New Session options menu (#5).** A dropdown to the left of **New Session**
  with **Sandbox** and **Bypass permissions** checkboxes; the new session
  launches its `agy` with the matching flags (`--sandbox`,
  `--dangerously-skip-permissions`), stored per session. The toggles seed from
  your `antigravity.*` settings.

### Changed

- **Terminal button now toggles (#4).** Clicking it once reveals the session's
  terminal mirror; clicking it again **closes** it (the background process keeps
  running).
- **Ending a session is graceful (#6).** On delete/shutdown the extension first
  sends **Ctrl+Z** so `agy` ends the session from its own perspective, then —
  after a short grace period — terminates the process (SIGCONT + SIGKILL, which
  reliably reaps both the `script` wrapper and `agy` with no orphans).
- **Consistent top-bar height (#2).** The app bar is now a fixed height on every
  step, so switching between the sessions list and a chat no longer makes it grow
  to fit the back button.

### Fixed

- **Sign-in button is never blank (#7).** The gate action now has a default label
  and a "Checking…" loading state, and `refreshState` always posts a state (even
  on error), so the button always shows "Sign in with Google" / "Install CLI"
  instead of an empty pill.

### Removed

- The **version chip** in the app bar (#1).
- The **Continue Last Conversation** and **Resume Conversation by ID** title-menu
  items (#3), and **Start Sandboxed Agent Session** (replaced by the New Session
  options menu, #5).

## [0.3.0] — 2026-06-03

Chat is now backed by a **live interactive `agy` session per chat**, replacing the
headless `--print` path. This fixes conversation continuity at the root: state
lives in one long-running process, so follow-up turns just work — no fragile
`--conversation <id>` threading (which had no reliable CLI signal to capture).

### Added

- **Interactive session engine.** Each chat owns its own `agy` TUI process,
  spawned under a `script` PTY shim (no native dependency). Its repainting
  terminal output is reconstructed with a headless terminal emulator
  (`@xterm/headless`) and parsed into run-state + replies by the new, unit-tested
  `core/agyScreen` module. Replies stream live as the agent types.
- **Session ↔ terminal lifecycle coupling.** The process runs hidden in the
  background. Deleting a session kills its process (and closes any open mirror);
  the process exiting drops the session from the list automatically.
- **On-demand terminal mirror.** The title-bar terminal button reveals a VS Code
  terminal mirroring the *same* live session (and routes your keystrokes back),
  instead of spawning a fresh exploring agent.

### Changed

- **Stop** now sends ESC to the live session (as its "esc to cancel" prompt),
  rather than killing a headless process.
- Slash commands that aren't handled natively are sent straight to the live
  session.

### Removed

- The headless `--print` chat path and the `--conversation`-id capture hack
  (`CliService.runPrint`, `latestConversationId`, `buildPrintArgs`), and the now
  unused **`antigravity.printTimeout`** setting and `duration` helper.

## [0.2.3] — 2026-06-03

Third feedback round — session-panel polish.

### Fixed

- **Back chevron no longer appears on the sessions list.** It shares the
  `.icon-btn` class, whose later `display: grid` rule was overriding the
  intended `display: none` at equal specificity; the visibility rules now
  out-specify it, so the chevron shows only in the chat step.
- **Reopening a running session restores its live state.** Leaving a running
  chat for the list and coming back now replays the text streamed so far, the
  loading indicator, and the orange stop button — instead of a frozen
  transcript. The host tracks each run's accumulated text for the replay.

### Changed

- The **＋ New chat** button is now **＋ New Session**; the empty-list hint reads
  **“No sessions yet. Start one above.”**; untitled rows read **New Session** —
  unifying the wording on "session".

## [0.2.2] — 2026-06-03

Second feedback round.

### Added

- **Two-step session panel (#5).** The panel now opens to a **list of saved
  chats**; click one to open it, or the trash icon to delete it. A back chevron
  (left of the title) returns to the list. Any chat with a prompt still running
  shows a loading indicator in its row.
- **Per-session conversation isolation (#5/#3).** Each session owns its own `agy`
  conversation; turns resume *that* conversation by id, never the global
  most-recent — so replies can no longer bleed in context from another session.

### Changed

- **Terminal button now attaches to the active chat's session (#4)** — it runs
  `agy --conversation <id>` so the terminal shows that ongoing conversation,
  instead of spawning a fresh agent that immediately explores the workspace.
- **Brand logo (#1/#6):** the app bar and sign-in screen now use `media/logo.svg`.
- **Loader (#2):** an M3‑Expressive‑style morphing‑shape indicator (the official
  morphing loading indicator ships only for Android/Compose, not Material Web).

### Known limitation (#3)

- `agy --print` is an autonomous **agent**: on any prompt it may read/grep the
  project to be helpful, so a bare "hi" can trigger exploration rather than a
  one-line greeting. The CLI exposes **no flag** to disable this for headless
  prompts (verified against v1.0.4). Per-session isolation removes the
  cross-session context bleed; the agentic exploration itself is intrinsic to
  the CLI's print mode.

## [0.2.1] — 2026-06-03

Polish from a second feedback round.

### Fixed

- **Conversation isolation.** The chat no longer uses `--continue` (which means
  "the globally most‑recent conversation" and could resume an unrelated session).
  Each chat now starts a fresh conversation and threads follow‑ups by the
  conversation's own id; **New Chat** starts a clean one. This fixes replies that
  bled context from other sessions.
- **Composer alignment:** the input, expand, and send/stop controls are now
  vertically centered.
- **Expanded editor + slash navigator:** in full‑panel mode the editor now
  reserves the dropup's height so the slash list stays fully visible.
- **Slash keyboard navigation:** arrowing past the visible area now scrolls the
  selected item into view, without disturbing manual scrolling.

### Changed

- Replaced the bouncing‑dots loader with a **Material 3 circular progress**
  indicator.
- Replaced the multicolour gradient orb (app bar **and** sign‑in screen) with the
  **brand icon** used in the activity bar.

## [0.2.0] — 2026-06-02

Reworked against the **real `agy` v1.0.4** binary and user feedback.

### Fixed / Changed

- **Corrected the CLI contract.** Removed the non‑existent `--model` and
  `--output-format` flags (the CLI rejected them); headless `--print` now streams
  **plain text**. `--print-timeout` now uses a Go duration (`antigravity.printTimeout`,
  default `10m`).
- Stopped re‑adding the primary workspace folder to `--add-dir` (the CLI already
  uses the working directory); auto‑add now contributes only extra multi‑root folders.
- **Unified send/stop** into a single composer button (violet send ↔ orange stop).
- **Removed** the status‑bar item, the duplicate bottom "Settings" chip, and the
  redundant top "Stop" action.
- **New Chat** reliably resets the thread and transcript.

### Added

- **Sign‑in gate (#7):** the panel shows only an install / "Sign in with Google"
  action until the CLI is present and authenticated (detected via the on‑disk
  OAuth token). Auth is re‑checked when the panel is revealed.
- **Slash‑command navigator (#8):** type `/` for autocomplete over the command
  catalog (`/goal`, `/diff`, `/model`, `/mcp`, …) with keyboard navigation.
  Native commands (`/clear`, `/help`, `/login`, `/logout`, `/changelog`) are
  handled in‑extension; the rest run in an interactive session terminal. The old
  "Goal mode" toggle is folded into `/goal` here.
- **Expandable composer (#6):** grow the input to a full‑panel editor and back.
- `--sandbox` support, sandboxed sessions, changelog viewer, and plugin
  management (list/import/install/uninstall/enable/disable).

## [0.1.0] — 2026-05-29

- Initial release: chat panel, interactive sessions, account/lifecycle commands,
  status bar, and a `vscode`‑free core with a unit/integration suite.
