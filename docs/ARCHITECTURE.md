# Architecture

The extension is a thin, well‑tested wrapper around the official Antigravity CLI
(`agy`). It spawns the binary you have installed and renders its output — it
contains no model logic, credentials, or network calls of its own.

## Layered design

```
┌──────────────────────────── VS Code ────────────────────────────┐
│  commands/        ui/                       services/            │
│  registerCommands ChatViewProvider ─┐       CliService  ──┐      │
│        │          StatusBar         │       TerminalService│      │
│        └──────────┴─────────────────┴──────────────┬───────┘      │
│                                                     │ uses        │
├─────────────────────────────────────────────────────┼────────────┤
│  core/  (NO `vscode` import — pure, unit-tested)      ▼            │
│  binaryResolver · argBuilder · jsonStream · onboarding · types    │
│  processRunner (Node child_process only)                          │
└───────────────────────────────────────────────────────────────────┘
                          │ spawns
                          ▼
                   agy  (the CLI)
```

### `core/` — pure logic, no `vscode`

Everything error‑prone lives here so it can be unit‑tested on bare Node without
launching an editor (see `tsconfig.test.json`, which compiles **only** `core/`
plus the tests):

- **`binaryResolver`** — resolves `agy` from an explicit path, then `PATH`
  (honoring Windows `PATHEXT`), then the installer's well‑known locations. All
  environment/filesystem access is injected (`ResolverEnv`) for testability.
- **`argBuilder`** — builds exact argv vectors for `--print`, interactive
  sessions, `--version`, and `update`; plus display‑quoting. The prompt is
  always the final argument, and we always spawn with an explicit argv (never a
  shell string) so prompts can't trigger injection.
- **`jsonStream`** — a fault‑tolerant incremental parser that normalizes the
  CLI's `--output-format json` stream into a small `AgyEvent` union. Because the
  exact schema is not publicly pinned, it accepts several field spellings, falls
  back to NDJSON and then raw passthrough, and never throws.
- **`onboarding`** — maps a `DetectionResult` to an install / login / ready
  decision; also classifies login errors and parses version strings.
- **`processRunner`** — a promise wrapper over `child_process.spawn` with
  streaming callbacks, a hard timeout, and cancellation. It never rejects:
  failures to start surface as `result.spawnError`.

### `services/` — the VS Code bridge

- **`CliService`** reads `antigravity.*` settings and open folders, resolves the
  binary, runs **headless** prompts (streaming normalized events to an
  observer), and probes the CLI for detection. This is the path behind the chat
  panel.
- **`TerminalService`** owns a single reusable integrated terminal for
  everything that wants a live TTY: the interactive TUI, the Google sign‑in
  flow, install, update, and `/logout`.

### `ui/` — presentation

- **`ChatViewProvider`** hosts the Material 3 Expressive webview. It builds a
  locked‑down page (CSP + per‑load nonce, local resources only), translates
  webview messages into `CliService` calls, streams events back, and threads the
  conversation id across turns. The typed `protocol.ts` defines both message
  directions.
- **`StatusBar`** reflects readiness and links to the chat.

### `commands/` and `extension.ts`

`extension.ts` constructs the service graph, registers the webview + status bar,
and wires config‑change refresh. `commands/registerCommands` maps each
`antigravity.*` command onto the chat (headless) or terminal (interactive)
surface — the two ways the CLI is actually used.

## Request flow (a chat turn)

1. The webview posts `{type:"submit", text, goal}`.
2. `ChatViewProvider.submit` echoes the user message and calls
   `CliService.runPrint`, passing the remembered `conversationId` for continuity.
3. `CliService` builds argv (`argBuilder`) and spawns `agy` (`processRunner`),
   feeding stdout through `JsonStreamParser`.
4. Each normalized `AgyEvent` is posted to the webview, which appends/streams it.
5. On exit, a login‑error heuristic may offer a **Sign In** action; the captured
   `conversationId` threads the next turn.

## Material 3 Expressive

`media/main.css` implements the M3 Expressive language: a vivid accent ramp,
a notably rounder shape scale, an emphatic type scale, springy "emphasized"
motion, and tactile state layers. Neutral surfaces are derived from the live VS
Code theme variables via `color-mix()`, so the panel always matches the user's
editor in light or dark mode. `prefers-reduced-motion` is honored.

## Why a stub CLI?

The development sandbox is firewalled to Google's marketing domain only — the
download, OAuth, and API hosts are unreachable — so the real `agy` cannot be
installed or signed into here. `test/fixtures/agy-stub.js` emulates the
documented surface (`--version`, `update`, `--print` NDJSON, auth/error
scenarios) so the parser, runner, and end‑to‑end streaming are fully exercised
offline. On a real machine the extension talks to the genuine binary unchanged.

## Testing

`npm test` compiles `core/` + the tests to `out/` and runs Mocha. Coverage:
argument building, binary resolution (incl. Windows), stream parsing/normalization,
onboarding decisions, and an integration suite that spawns the stub through
`processRunner` and asserts streaming, exit codes, spawn errors, timeout, and
cancellation. The `vscode`‑dependent layer is kept deliberately thin and is
validated by the strict type‑check (`npm run check-types`).
