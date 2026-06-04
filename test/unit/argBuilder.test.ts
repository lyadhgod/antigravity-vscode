import * as assert from "node:assert";

import {
  buildSessionArgs,
  buildSubcommandArgs,
  buildVersionArgs,
  quoteCommand
} from "../../src/core/argBuilder";
import { AntigravityConfig } from "../../src/core/types";

/** Baseline config with every feature off, overridable per test. */
function config(overrides: Partial<AntigravityConfig> = {}): AntigravityConfig {
  return {
    cliPath: "agy",
    extraArgs: [],
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

  it("adds add-dir (repeatable), sandbox, skip-permissions, and extra args", () => {
    const args = buildSessionArgs(
      { addDirs: ["/a", "/b"] },
      config({ sandbox: true, skipPermissions: true, extraArgs: ["--log-file", "x.log"] })
    );
    assert.strictEqual(args.filter((a) => a === "--add-dir").length, 2);
    assert.ok(args.includes("--sandbox"));
    assert.ok(args.includes("--dangerously-skip-permissions"));
    assert.ok(args.includes("--log-file"));
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

  it("quotes only arguments that need it and escapes single quotes", () => {
    assert.strictEqual(quoteCommand("agy", ["--print", "hello world", "safe"]), "agy --print 'hello world' safe");
    assert.strictEqual(quoteCommand("agy", ["it's"]), `agy 'it'\\''s'`);
  });
});
