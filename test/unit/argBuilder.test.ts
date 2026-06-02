import * as assert from "node:assert";

import {
  buildPrintArgs,
  buildSessionArgs,
  buildUpdateArgs,
  buildVersionArgs,
  quoteCommand
} from "../../src/core/argBuilder";
import { AntigravityConfig } from "../../src/core/types";

/** A baseline config with every feature off, overridable per test. */
function config(overrides: Partial<AntigravityConfig> = {}): AntigravityConfig {
  return {
    cliPath: "agy",
    model: "",
    extraArgs: [],
    skipPermissions: false,
    printTimeoutMs: 600000,
    autoAddWorkspaceFolders: true,
    outputFormat: "json",
    installCommand: "install.sh",
    ...overrides
  };
}

describe("argBuilder.buildPrintArgs", () => {
  it("puts the prompt last and requests the configured output format", () => {
    const args = buildPrintArgs({ prompt: "hello" }, config());
    assert.strictEqual(args[0], "--print");
    assert.deepStrictEqual(args.slice(1, 3), ["--output-format", "json"]);
    assert.strictEqual(args[args.length - 1], "hello");
  });

  it("includes the print timeout", () => {
    const args = buildPrintArgs({ prompt: "p" }, config({ printTimeoutMs: 1234 }));
    const i = args.indexOf("--print-timeout");
    assert.ok(i !== -1);
    assert.strictEqual(args[i + 1], "1234");
  });

  it("prefixes goal prompts with /goal", () => {
    const args = buildPrintArgs({ prompt: "ship it", goal: true }, config());
    assert.strictEqual(args[args.length - 1], "/goal ship it");
  });

  it("threads conversation continuity flags", () => {
    const cont = buildPrintArgs({ prompt: "p", continueConversation: true }, config());
    assert.ok(cont.includes("--continue"));

    const resume = buildPrintArgs({ prompt: "p", conversationId: "c-1" }, config());
    const i = resume.indexOf("--conversation");
    assert.strictEqual(resume[i + 1], "c-1");
  });

  it("adds model, add-dir, skip-permissions, and extra args", () => {
    const args = buildPrintArgs(
      { prompt: "p", addDirs: ["/a", "/b"], model: "gemini-x" },
      config({ skipPermissions: true, extraArgs: ["--verbose"] })
    );
    assert.deepStrictEqual(
      args.filter((_a, i) => args[i - 1] === "--model"),
      ["gemini-x"]
    );
    assert.strictEqual(args.filter((a) => a === "--add-dir").length, 2);
    assert.ok(args.includes("--dangerously-skip-permissions"));
    assert.ok(args.includes("--verbose"));
  });

  it("falls back to the configured model when none is passed", () => {
    const args = buildPrintArgs({ prompt: "p" }, config({ model: "default-model" }));
    const i = args.indexOf("--model");
    assert.strictEqual(args[i + 1], "default-model");
  });

  it("requests text output format explicitly when configured", () => {
    const args = buildPrintArgs({ prompt: "p" }, config({ outputFormat: "text" }));
    const i = args.indexOf("--output-format");
    assert.strictEqual(args[i + 1], "text");
  });
});

describe("argBuilder.buildSessionArgs", () => {
  it("is empty for a bare interactive session", () => {
    assert.deepStrictEqual(buildSessionArgs({}, config()), []);
  });

  it("passes an initial prompt via --prompt-interactive last", () => {
    const args = buildSessionArgs({ initialPrompt: "start here" }, config());
    assert.strictEqual(args[args.length - 2], "--prompt-interactive");
    assert.strictEqual(args[args.length - 1], "start here");
  });
});

describe("argBuilder misc", () => {
  it("builds version and update argv", () => {
    assert.deepStrictEqual(buildVersionArgs(), ["--version"]);
    assert.deepStrictEqual(buildUpdateArgs(), ["update"]);
  });

  it("quotes only arguments that need it", () => {
    const line = quoteCommand("agy", ["--print", "hello world", "safe-arg"]);
    assert.strictEqual(line, "agy --print 'hello world' safe-arg");
  });

  it("escapes embedded single quotes when quoting", () => {
    assert.strictEqual(quoteCommand("agy", ["it's"]), `agy 'it'\\''s'`);
  });
});
