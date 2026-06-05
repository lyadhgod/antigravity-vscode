# Contributing to Antigravity for VS Code

Thanks for contributing! This document covers the branch strategy, local setup, and the workflow all contributors follow.

---

## Branch strategy

> **Pushing to `main` triggers an automatic release.** Never push directly to `main` or open PRs against it from feature branches.

We follow a **GitHub Flow** variant built around a `dev` integration branch:

```
main        ← production; every commit here becomes a published release
  └── dev   ← integration; all PRs target this branch
        ├── fix/42-loading-indicator-stuck
        ├── feat/88-settings-panel
        └── chore/update-deps
```

| Branch | Purpose | Who pushes? |
|---|---|---|
| `main` | Release-ready code only | Maintainers, via a `dev → main` PR |
| `dev` | Ongoing integration | Merged PRs from feature branches |
| `feat/*`, `fix/*`, `chore/*` | One branch per issue | Contributors |

### Rules

- **Always branch from `dev`**, not `main`.
- **Always open PRs against `dev`**, not `main`.
- `dev → main` merges are done by maintainers when a batch of work is ready to ship. That merge is the release signal — it bumps the version in `package.json`, which triggers the GitHub Actions release workflow.
- Delete your feature branch once its PR is merged.

---

## Local setup

### Prerequisites

- **Node.js** 20+
- **VS Code** 1.90+
- The **Antigravity CLI** (`agy`) — needed to test the extension end-to-end. Install from [Antigravity CLI](https://antigravity.google/product/antigravity-cli).

### 1. Clone and install

```bash
git clone https://github.com/lyadhgod/antigravity-vscode.git
cd antigravity-vscode
git checkout dev          # start from dev, not main
npm install
```

### 2. Start the dev build watcher

```bash
npm run watch
```

This re-bundles `src/` → `dist/extension.js` on every save (via esbuild) in under a second.

### 3. Launch the extension in VS Code

Open the repo folder in VS Code, then press **F5** (or **Run → Start Debugging**). This opens an **Extension Development Host** — a second VS Code window with your local build of Antigravity loaded.

Every time you save a source file, `npm run watch` rebuilds `dist/`. Press **Ctrl+Shift+P → Developer: Reload Window** in the Extension Development Host to pick up the new build.

---

## Development workflow

### Starting a piece of work

1. Find or create a GitHub issue for the change.
2. Branch from `dev`, naming the branch after the issue:
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b fix/42-loading-indicator-stuck   # or feat/88-… / chore/…
   ```

### Making changes

- Source lives in [src/](src/) (TypeScript) and [media/](media/) (webview HTML/CSS/JS).
- The extension entry point is [src/extension.ts](src/extension.ts).
- Screen-parsing logic lives in [src/core/agyScreen.ts](src/core/agyScreen.ts).
- Webview UI is [media/index.html](media/index.html) + [media/main.js](media/main.js) + [media/main.css](media/main.css).

### Type-checking

```bash
npm run check-types
```

Run this before opening a PR. The CI will catch it too, but catching it locally is faster.

### Tests

```bash
npm test
```

`pretest` compiles the test TypeScript (`tsconfig.test.json`) and runs a dev build first, then Mocha picks up `out/test/**/*.test.js`. Add tests for any logic that can be unit-tested (screen parsing, arg building, binary resolution).

### Opening a PR

- Target branch: **`dev`**.
- Title: `fix: <short description>` / `feat: <short description>` / `chore: <short description>`.
- Reference the issue: `Closes #42`.
- Keep the PR focused — one issue per branch.

---

## Release process (maintainers only)

1. Collect merged PRs in `dev` that are ready to ship.
2. Bump the version in `package.json` on `dev` following [semver](https://semver.org):
   - **patch** (`0.13.x`) — bug fixes.
   - **minor** (`0.x.0`) — new features, backwards-compatible.
   - **major** (`x.0.0`) — breaking changes.
   - **pre-release** (`0.14.0-beta.1`) — the `contains('-')` check in the workflow marks it as a pre-release automatically.
3. Update `CHANGELOG.md` with a `## [x.y.z]` section.
4. Open a PR from `dev` → `main`.
5. Merge it. The [release workflow](.github/workflows/release.yml) detects the version change and:
   - Runs `npm test`.
   - Builds the `.vsix`.
   - Creates a git tag (`vx.y.z`) and a GitHub release with the `.vsix` attached.

> Do **not** create the git tag manually — the workflow does it.

---

## Project structure (quick reference)

```
src/
  extension.ts          — activation, command registration
  core/
    agyScreen.ts        — PTY screen → ScreenView parser
    argBuilder.ts       — CLI flag construction
    binaryResolver.ts   — locates the agy binary
    types.ts            — shared interfaces
  services/
    interactiveSession.ts — PTY session lifecycle
  ui/
    chatViewProvider.ts — webview ↔ session bridge
media/
  index.html            — webview markup
  main.js               — webview runtime (no bundler)
  main.css              — Material 3 Expressive styles
test/                   — Mocha unit tests
dist/                   — compiled output (git-ignored)
```
