# Antigravity for VS Code

Bring Google's **Antigravity CLI** (`agy`) into VS Code — an agentic coding
companion with a **Material 3 Expressive** chat panel, headless prompts,
conversation threading, editor‑selection actions, and one‑click sign‑in.

This is the VS Code counterpart to Antigravity's own IDE and CLI, in the same
spirit as the Claude Code marketplace extension: the editor provides the UI; the
official CLI does the work. The extension never bundles the CLI — it drives the
`agy` binary you install locally.

> **Unofficial / community extension.** Not affiliated with or endorsed by
> Google. "Antigravity" and "Gemini" are trademarks of Google LLC.

---

## Features

| Surface | What it does |
| --- | --- |
| **Chat panel** (Material 3 Expressive webview) | Ask questions, stream answers, see tool activity and token usage. Conversations are threaded across turns. |
| **Ask About Selection** | Send the highlighted code (with file + line context) to the agent. |
| **Goal mode** | Toggle the chip (or run *Run Goal to Completion*) to let the agent run a task end‑to‑end (`/goal`). |
| **Agent session (terminal)** | Launch the full interactive `agy` TUI in an integrated terminal. |
| **Continue / Resume** | Continue the most recent conversation or resume one by id. |
| **Account** | Sign in (Google OAuth), sign out, install, update, and show the CLI version — all from the command palette. |
| **Status bar** | At‑a‑glance readiness; click to open the chat. |

## Requirements

- **VS Code** 1.90 or newer.
- The **Antigravity CLI (`agy`)** installed and signed in. The extension shells
  out to it; it does not embed it.

### Installing the CLI

Run **“Antigravity: Install CLI”** from the command palette, or install it
yourself:

```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash
# Windows (PowerShell)
irm https://antigravity.google/cli/install.ps1 | iex
```

The installer drops the `agy` binary into `~/.local/bin` (Unix) or
`%LOCALAPPDATA%\Antigravity\` (Windows). If that directory is not on your
`PATH`, set [`antigravity.cliPath`](#configuration) to the binary's full path.

### Signing in (required)

`agy` authenticates with a **Google account**. Run **“Antigravity: Sign In”**;
the CLI opens your browser for the OAuth grant (or, on a remote/SSH host, prints
an authorization URL and a one‑time code in the terminal). Credentials are
cached in your OS keyring. Use **“Antigravity: Sign Out”** (the CLI's `/logout`)
to clear them.

## Usage

1. Open the **Antigravity** view from the activity bar (rocket icon) or press
   <kbd>Ctrl/Cmd</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd>.
2. Type a prompt and press <kbd>Enter</kbd> (<kbd>Shift</kbd>+<kbd>Enter</kbd>
   for a newline). Toggle **Goal mode** to run a task to completion.
3. To work on a snippet, select code in the editor and run **Ask About
   Selection** (<kbd>Ctrl/Cmd</kbd>+<kbd>Alt</kbd>+<kbd>K</kbd>).
4. For full interactive control, run **Start Agent Session** to open the TUI.

### Commands

All commands are under the **Antigravity:** category: *Open Chat, New Chat,
Ask…, Ask About Selection, Run Goal to Completion…, Start Agent Session,
Continue Last Conversation, Resume Conversation…, Add Directory to Agent
Workspace…, Select Model…, Stop Running Task, Sign In, Sign Out, Update CLI,
Install CLI, Show CLI Version, Open Settings.*

### Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `antigravity.cliPath` | `agy` | Binary name (resolved on `PATH`) or an absolute path. |
| `antigravity.model` | `""` | Default `--model`; empty uses the CLI default. |
| `antigravity.extraArgs` | `[]` | Extra args appended to every invocation. |
| `antigravity.skipPermissions` | `false` | Pass `--dangerously-skip-permissions` (auto‑approve everything). |
| `antigravity.printTimeoutMs` | `600000` | Headless prompt timeout (ms). |
| `antigravity.autoAddWorkspaceFolders` | `true` | Expose open folders via `--add-dir`. |
| `antigravity.outputFormat` | `json` | `json` for rich rendering, `text` for plain. |
| `antigravity.installCommand` | *(install.sh)* | Command used by *Install CLI*. |

## Development

```bash
npm install        # install dev dependencies
npm run check-types # strict TypeScript type-check
npm run compile    # bundle to dist/extension.js (esbuild)
npm test           # compile + run the unit/integration suite (Mocha)
npm run watch      # rebuild on change
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

The test suite runs entirely on Node against a **stub CLI**
(`test/fixtures/agy-stub.js`) — no real `agy` install, network, or Google login
is needed. Point `antigravity.cliPath` at that stub to exercise the UI offline.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the internal design.

## License

MIT.
