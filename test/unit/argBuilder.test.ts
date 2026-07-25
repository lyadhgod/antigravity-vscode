import * as assert from "node:assert";

import {
  buildSessionArgs,
  buildSubcommandArgs,
  buildVersionArgs,
  detectShellKind,
  quoteCommand
} from "../../src/core/argBuilder";
import { AntigravityConfig } from "../../src/core/types";

/** Baseline config with every feature off, overridable per test. */
function config(overrides: Partial<AntigravityConfig> = {}): AntigravityConfig {
  return {
    cliPath: "agy",
    skipPermissions: false,
    sandbox: false,
    autoAddWorkspaceFolders: true,
    ...overrides
  };
}

describe("argBuilder.buildSessionArgs", () => {
  it("is empty for a bare interactive session", () => {
    assert.deepStrictEqual(buildSessionArgs({}, config()), []);
  });

  it("adds add-dir (repeatable), sandbox, and skip-permissions", () => {
    const args = buildSessionArgs(
      { addDirs: ["/a", "/b"] },
      config({ sandbox: true, skipPermissions: true })
    );
    assert.strictEqual(args.filter((a) => a === "--add-dir").length, 2);
    assert.ok(args.includes("--sandbox"));
    assert.ok(args.includes("--dangerously-skip-permissions"));
  });

  it("NEVER emits --model or --output-format (the real CLI rejects them)", () => {
    const args = buildSessionArgs({ addDirs: ["/a"] }, config({ skipPermissions: true }));
    assert.ok(!args.includes("--model"));
    assert.ok(!args.includes("--output-format"));
  });

  it("threads conversation continuity flags", () => {
    assert.ok(buildSessionArgs({ continueConversation: true }, config()).includes("--continue"));
    const resume = buildSessionArgs({ conversationId: "c-1" }, config());
    assert.strictEqual(resume[resume.indexOf("--conversation") + 1], "c-1");
  });

  it("forces --sandbox when requested per-session even if config is off", () => {
    assert.ok(buildSessionArgs({ sandbox: true }, config({ sandbox: false })).includes("--sandbox"));
  });

  it("forces --dangerously-skip-permissions per-session even if config is off", () => {
    assert.ok(
      buildSessionArgs({ skipPermissions: true }, config({ skipPermissions: false }))
        .includes("--dangerously-skip-permissions")
    );
  });

  it("an unset per-session toggle falls back to the config value", () => {
    // sandbox undefined ⇒ use config (on); skipPermissions undefined ⇒ config (off)
    const args = buildSessionArgs({}, config({ sandbox: true, skipPermissions: false }));
    assert.ok(args.includes("--sandbox"));
    assert.ok(!args.includes("--dangerously-skip-permissions"));
  });

  it("passes an initial prompt via --prompt-interactive last", () => {
    const args = buildSessionArgs({ initialPrompt: "start here" }, config());
    assert.strictEqual(args[args.length - 2], "--prompt-interactive");
    assert.strictEqual(args[args.length - 1], "start here");
  });
});

describe("argBuilder misc", () => {
  it("builds version and subcommand argv", () => {
    assert.deepStrictEqual(buildVersionArgs(), ["--version"]);
    assert.deepStrictEqual(buildSubcommandArgs("update"), ["update"]);
    assert.deepStrictEqual(buildSubcommandArgs("changelog"), ["changelog"]);
  });

  it("quotes only arguments that need it and escapes single quotes (POSIX default)", () => {
    assert.strictEqual(quoteCommand("agy", ["--print", "hello world", "safe"]), "agy --print 'hello world' safe");
    assert.strictEqual(quoteCommand("agy", ["it's"]), `agy 'it'\\''s'`);
  });
});

describe("argBuilder.detectShellKind (#2)", () => {
  it("is always POSIX off Windows regardless of shell path", () => {
    assert.strictEqual(detectShellKind("darwin", "/bin/zsh"), "posix");
    assert.strictEqual(detectShellKind("linux", "/usr/bin/bash"), "posix");
    assert.strictEqual(detectShellKind("linux", undefined), "posix");
  });

  it("classifies Windows PowerShell (Windows PowerShell + pwsh)", () => {
    assert.strictEqual(
      detectShellKind("win32", "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
      "powershell"
    );
    assert.strictEqual(detectShellKind("win32", "C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "powershell");
  });

  it("classifies cmd.exe", () => {
    assert.strictEqual(detectShellKind("win32", "C:\\WINDOWS\\System32\\cmd.exe"), "cmd");
  });

  it("treats Git Bash / WSL / sh on Windows as POSIX", () => {
    assert.strictEqual(detectShellKind("win32", "C:\\Program Files\\Git\\bin\\bash.exe"), "posix");
    assert.strictEqual(detectShellKind("win32", "C:\\WINDOWS\\System32\\wsl.exe"), "posix");
    assert.strictEqual(detectShellKind("win32", "C:\\msys64\\usr\\bin\\sh.exe"), "posix");
  });

  it("defaults an unknown Windows shell to PowerShell (VS Code's modern default)", () => {
    assert.strictEqual(detectShellKind("win32", undefined), "powershell");
    assert.strictEqual(detectShellKind("win32", "C:\\weird\\shell.exe"), "powershell");
  });
});

describe("argBuilder.quoteCommand shells (#2)", () => {
  const winPath = "C:\\Users\\me\\AppData\\Local\\Antigravity\\agy.exe";
  const winPathSpace = "C:\\Program Files\\Antigravity\\agy.exe";

  it("PowerShell prefixes the call operator so a quoted path is executed, not echoed", () => {
    // The bug: without `&`, `'C:\…\agy.exe'` is a string literal PS just prints.
    assert.strictEqual(
      quoteCommand(winPath, ["update"], "powershell"),
      "& 'C:\\Users\\me\\AppData\\Local\\Antigravity\\agy.exe' update"
    );
  });

  it("PowerShell quotes a path with spaces and doubles embedded single quotes", () => {
    assert.strictEqual(
      quoteCommand(winPathSpace, ["plugin", "list"], "powershell"),
      "& 'C:\\Program Files\\Antigravity\\agy.exe' plugin list"
    );
    assert.strictEqual(quoteCommand("agy", ["it's"], "powershell"), "& agy 'it''s'");
  });

  it("PowerShell keeps a bare command and simple flags unquoted (still prefixes &)", () => {
    assert.strictEqual(quoteCommand("agy", ["--version"], "powershell"), "& agy --version");
  });

  it("cmd leaves a backslash path without spaces bare and double-quotes one with spaces", () => {
    assert.strictEqual(
      quoteCommand(winPath, ["update"], "cmd"),
      "C:\\Users\\me\\AppData\\Local\\Antigravity\\agy.exe update"
    );
    assert.strictEqual(
      quoteCommand(winPathSpace, ["update"], "cmd"),
      '"C:\\Program Files\\Antigravity\\agy.exe" update'
    );
  });
});
