// @ts-nocheck
/*
 * Activation smoke test.
 *
 * Loads the *real bundled* extension (dist/extension.js) with a minimal mock of
 * the `vscode` API injected into the module loader, then calls `activate` and
 * asserts the extension registers its chat webview and the full command set
 * without throwing. This exercises the actual wiring path
 * (extension.ts → commands → services → core) that the unit tests don't cover,
 * yet needs no real editor, network, or `agy` binary.
 *
 * It is plain JS (no TS compile step) and requires the bundle, so `pretest`
 * builds dist/ before Mocha runs.
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const Module = require("node:module");

// --- Minimal vscode mock ----------------------------------------------------
const registered = { commands: [], webviews: [], subscriptions: 0 };

function disposable() {
  return { dispose() {} };
}

const vscodeMock = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  EventEmitter: class { constructor() { this.event = () => disposable(); } fire() {} dispose() {} },
  Uri: {
    joinPath: (base, ...parts) => {
      const fsPath = [base.fsPath || base, ...parts].join("/");
      return { fsPath, toString: () => fsPath };
    }
  },
  window: {
    registerWebviewViewProvider: (id) => {
      registered.webviews.push(id);
      return disposable();
    },
    createTerminal: () => ({ show() {}, sendText() {}, dispose() {} }),
    onDidCloseTerminal: () => disposable(),
    terminals: [],
    activeTextEditor: undefined,
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(undefined),
    showOpenDialog: () => Promise.resolve(undefined),
    showQuickPick: () => Promise.resolve(undefined)
  },
  commands: {
    registerCommand: (id, fn) => {
      registered.commands.push({ id, fn });
      return disposable();
    },
    executeCommand: () => Promise.resolve(undefined)
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_k, def) => def, update: () => Promise.resolve() }),
    onDidChangeConfiguration: () => disposable(),
    asRelativePath: (u) => String(u)
  }
};

// Intercept `require("vscode")` for the bundle and its descendants.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return vscodeMock;
  }
  return originalLoad.call(this, request, parent, isMain);
};

describe("extension activation (against the bundled dist with a mocked vscode)", () => {
  let ext;

  before(() => {
    ext = require(path.join(process.cwd(), "dist", "extension.js"));
  });

  after(() => {
    Module._load = originalLoad;
  });

  it("exports activate/deactivate", () => {
    assert.strictEqual(typeof ext.activate, "function");
    assert.strictEqual(typeof ext.deactivate, "function");
  });

  it("activates and registers the chat webview + every command", () => {
    const context = {
      subscriptions: [],
      extensionUri: { fsPath: process.cwd() },
      // The chat provider persists sessions in workspaceState.
      workspaceState: { get: (_k, def) => def, update: () => Promise.resolve() }
    };
    ext.activate(context);

    assert.ok(registered.webviews.includes("antigravity.chatView"), "chat webview not registered");

    const ids = registered.commands.map((c) => c.id);
    for (const expected of [
      "antigravity.openChat",
      "antigravity.newChat",
      "antigravity.ask",
      "antigravity.askWithSelection",
      "antigravity.insertSlashCommand",
      "antigravity.startSession",
      "antigravity.login",
      "antigravity.logout",
      "antigravity.showChangelog",
      "antigravity.managePlugins",
      "antigravity.stop"
    ]) {
      assert.ok(ids.includes(expected), `missing command: ${expected}`);
    }
    assert.ok(context.subscriptions.length > 0, "no disposables registered");
  });

  it("runs a command handler without throwing when the CLI is absent", async () => {
    // showVersion probes `agy` (ENOENT here) and must degrade gracefully.
    const handler = registered.commands.find((c) => c.id === "antigravity.showVersion").fn;
    await handler();
  });
});
