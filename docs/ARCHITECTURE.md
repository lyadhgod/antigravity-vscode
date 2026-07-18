# Architecture

The extension is a thin, well‑tested wrapper around the official Antigravity CLI
(`agy`). It spawns the binary you have installed and renders its output — it
contains no model logic, credentials, or network calls of its own.

## Layered design

```
┌──────────────────────────── VS Code ──────────────────────────────────┐
│  commands/        ui/                    services/                     │
│  registerCommands ChatViewProvider ─┐    InteractiveSessionService ─┐  │
│                   (auth gate,        │    CliService (env/auth)      │  │
│                    slash routing,    │    TerminalService (lifecycle)│  │
│                    lifecycle, mirror)│                               │  │
│        └──────────┴─────────────────┴───────────────────┬───────────┘  │
│                                                          │ uses         │
├────────────────────────────────────────────────────────┼──────────────┤
│  core/  (NO `vscode` import — pure, unit-tested)         ▼              │
│  agyScreen · argBuilder · binaryResolver · onboarding · slashCommands   │
│  sessionStore · processRunner · types                                   │
└─────────────────────────────────────────────────────────────────────────┘
        │ spawns via core/ptyLauncher:                 ▲ raw PTY bytes
        │   Unix → `script -c "stty …; exec agy"`      │ (→ @xterm/headless)
        ▼   Windows → node-pty ConPTY                  │
                              agy  (interactive TUI)
```

### Verified CLI surface (agy v1.0.4)

The implementation is grounded in the real binary, not assumptions:

- **Chat runs the interactive TUI** (`agy` with no `--print`). Interactive mode
  needs a **real PTY** — on a plain pipe `agy` degrades to a timeout — so we
  spawn it under `script` and `stty` the PTY size before `exec agy`.
- The TUI is a **full-screen, repainting** interface (box-drawing rules, a `>`
  input box, a braille "Generating…" spinner). We reconstruct the rendered
  screen with `@xterm/headless`, then `core/agyScreen` reads off the run-state
  and the reply. There is **no** `--output-format`/`--model` flag (they error).
- Real flags: `--add-dir` (repeatable), `--continue`/`-c`, `--conversation`,
  `--prompt-interactive`/`-i`, `--dangerously-skip-permissions`, `--sandbox`.
  Subcommands: `install`, `update`, `changelog`, `plugin`.
- **Auth** is an OAuth token cached at
  `~/.gemini/antigravity-cli/antigravity-oauth-token`; there is no `login`
  subcommand — the first interactive run starts the Google sign‑in flow.
- `agy` is **agentic**: it may read the project and run tools to answer, so a
  turn can take a while; the UI streams the reply and offers a stop (esc) control.

### `core/` — pure logic, no `vscode`

Unit‑tested on bare Node (`tsconfig.test.json` compiles only `core/` + tests):

- **`agyScreen`** — interprets a *rendered* `agy` TUI screen (array of lines)
  into a run-state (`starting`/`signin`/`generating`/`idle`) and conversation
  turns, discarding the banner, rules, status line, spinner, and tool output.
  `replyFor` matches a reply to the prompt that produced it. Unit-tested against
  frames captured from the real CLI.
- **`binaryResolver`** — resolves `agy` from an explicit path, then `PATH`
  (honoring Windows `PATHEXT`), then the installer's well‑known locations.
- **`ptyLauncher`** — decides how to put `agy` on a real PTY per platform: the
  `script`/`stty` shim on macOS/Linux, a `node-pty` ConPTY on Windows (#1, #2).
  Pure (the argv + `stty` string are unit-tested); the spawn itself lives in the
  service. `node-pty` is an optional runtime require (external in esbuild), so
  when it's absent on Windows the session reports that plainly and points at WSL
  instead of ENOENT-ing on the missing `script`.
- **`argBuilder`** — builds exact argv for session/version/subcommands; we always
  spawn with an explicit argv (no shell).
- **`onboarding`** — install → sign‑in → ready decisions, the OAuth token path,
  login‑error classification, and version parsing.
- **`slashCommands`** — the catalog surfaced by the navigator. It is the **real**
  35-command set captured from `agy` v1.0.4 by driving its TUI through a PTY and
  reading the `/` autocomplete (aliases included), with routing (`native` vs.
  `session`), plus `parseSlash` / `filterSlashCommands` (which also match
  aliases) and `findSlashCommand` (which resolves an alias to its canonical name).
- **`sessionStore`** — the extension's own model of saved sessions (title + our
  transcript copy). Persistence is injected, so it unit-tests on bare Node; the
  VS Code layer wires it to `workspaceState`.
- **`processRunner`** — a promise wrapper over `child_process.spawn` with
  streaming callbacks, timeout, and cancellation; never rejects (spawn failures
  surface as `result.spawnError`). Used for one-shot probes like `--version`.

### `services/` — the VS Code bridge

- **`InteractiveSessionService`** owns one interactive `agy` process per chat
  session. It spawns `agy` on a real PTY via `core/ptyLauncher` (the `script`
  shim on Unix, a `node-pty` ConPTY on Windows — behind a backend-agnostic
  `write`/`terminate` pair), feeds the raw output through `@xterm/headless`,
  debounces, and emits an
  interpreted `ScreenView` on each settled frame. It also queues input until the
  prompt is ready, takes per-session launch toggles (sandbox / skip-permissions),
  and exposes a raw mirror sink for the on-demand terminal. On dispose it ends a
  session **gracefully**: it sends **Ctrl+Z** (so `agy` ends the session from its
  own perspective), then after a short grace terminates with SIGCONT + SIGKILL —
  which reliably reaps both the `script` wrapper and `agy` (SIGTERM does not, as
  the wrapper blocks on a Ctrl+Z'd child). It depends on a small `AgyEnv`
  interface (not the whole `CliService`), so it carries no `vscode` import and is
  bundle-testable.
- **`CliService`** reads settings + folders, resolves the binary, and checks
  sign‑in (token on disk) + version. (It no longer runs prompts.)
- **`TerminalService`** owns a reusable integrated terminal for the
  command‑palette lifecycle actions: sign‑in, install/update/changelog, plugins.

### `ui/` — presentation

- **`ChatViewProvider`** hosts the Material 3 webview as a **two-step panel**: a
  sessions list and a per-session chat (`body[data-view]` switches them). It
  gates on sign‑in (#7); routes input — native slash commands handled
  in-extension, everything else sent to the session's live process (#8); and
  drives each turn from the interpreted screen, finalizing on the
  generating→idle transition. Lifecycle is coupled both ways (delete ⇒ end
  process; process exit ⇒ drop session), and the terminal button **toggles** a
  `Pseudoterminal` mirroring the live process (open if hidden, close if showing).
  New sessions carry the sandbox / bypass-permissions toggles chosen in the New
  Session menu. The typed `protocol.ts` models a
  turn as `streamStart → assistantText* → streamEnd`, where `assistantText`
  carries the full current reply (a replace, since the screen is the source of
  truth).

### `commands/` and `extension.ts`

`extension.ts` builds the service graph and registers the webview + commands.
`registerCommands` maps every `antigravity.*` command (chat, sessions, account,
CLI lifecycle, plugins) onto the services; the panel's title‑menu overflow
surfaces the same actions.

## Material 3 Expressive

`media/main.css` implements M3 Expressive: a vivid accent ramp, a rounder shape
scale, an emphatic type scale, springy "emphasized" motion, and tactile state
layers. Neutral surfaces derive from the live VS Code theme via `color-mix()`,
so the panel matches the editor in light/dark; `prefers-reduced-motion` is
honored. Notable components: the sign‑in gate card, the slash navigator popup,
the single send/stop FAB (`data-busy` toggles paper‑plane↔square, violet↔orange),
and the expand‑to‑full‑panel composer.

## Testing

`npm test` compiles `core/` + tests to `out/` and runs Mocha. Coverage: the
**`agyScreen` parser** against screens captured from the real CLI (state
detection, reply extraction, discarding tool/banner noise), argument building
(incl. the *absence* of `--model`/`--output-format`), binary resolution,
onboarding/auth decisions, the slash catalog and parsing, and an integration
suite that drives the **stub CLI** through `processRunner`. An activation test
loads the real bundled `dist/` with a mocked `vscode` and asserts the webview +
every command register. The thin `vscode` layer is otherwise covered by the
strict type‑check.

The interactive engine itself was validated end-to-end against the real `agy`
(the `InteractiveSessionService` → `@xterm/headless` → `agyScreen` pipeline),
confirming live streaming, the `signin→idle→generating→idle` lifecycle, and
multi-turn conversation continuity within one process.
