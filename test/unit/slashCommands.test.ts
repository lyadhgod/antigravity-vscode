import * as assert from "node:assert";

import { SLASH_COMMANDS, filterSlashCommands, findSlashCommand, parseSlash } from "../../src/core/slashCommands";

describe("slashCommands.parseSlash", () => {
  it("returns null for non-slash input", () => {
    assert.strictEqual(parseSlash("hello world"), null);
  });

  it("splits a command with no args", () => {
    assert.deepStrictEqual(parseSlash("/diff"), { command: "/diff", args: "" });
  });

  it("splits a command with trailing args", () => {
    assert.deepStrictEqual(parseSlash("/goal ship the feature"), { command: "/goal", args: "ship the feature" });
  });
});

describe("slashCommands.filterSlashCommands", () => {
  it("returns the whole catalog for empty or '/'", () => {
    assert.strictEqual(filterSlashCommands("/").length, SLASH_COMMANDS.length);
    assert.strictEqual(filterSlashCommands("").length, SLASH_COMMANDS.length);
  });

  it("ranks prefix matches and includes substring matches", () => {
    const res = filterSlashCommands("/co");
    assert.ok(res.length > 0);
    // every result should reference the query somewhere in its name
    assert.ok(res.every((c) => c.name.toLowerCase().includes("co")));
    // a pure prefix match (/config, /context, /copy) should come before any
    // non-prefix substring match
    assert.ok(res[0].name.toLowerCase().startsWith("/co"));
  });

  it("matches without the leading slash too", () => {
    assert.ok(filterSlashCommands("goal").some((c) => c.name === "/goal"));
  });

  it("matches an alias too (e.g. 'new' finds /clear)", () => {
    assert.ok(filterSlashCommands("/new").some((c) => c.name === "/clear"));
    assert.ok(filterSlashCommands("quit").some((c) => c.name === "/exit"));
  });
});

describe("slashCommands.findSlashCommand", () => {
  it("finds a known command case-insensitively", () => {
    assert.strictEqual(findSlashCommand("/GOAL")?.name, "/goal");
  });

  it("returns undefined for unknown commands", () => {
    assert.strictEqual(findSlashCommand("/nope"), undefined);
  });

  it("routes /clear, /help, /logout, /changelog natively", () => {
    for (const name of ["/clear", "/help", "/logout", "/changelog"]) {
      assert.strictEqual(findSlashCommand(name)?.target, "native", name);
    }
  });

  it("routes interactive commands to a session", () => {
    for (const name of ["/goal", "/diff", "/model", "/mcp", "/permissions"]) {
      assert.strictEqual(findSlashCommand(name)?.target, "session", name);
    }
  });

  it("resolves an alias to its canonical command", () => {
    assert.strictEqual(findSlashCommand("/new")?.name, "/clear");
    assert.strictEqual(findSlashCommand("/quit")?.name, "/exit");
    assert.strictEqual(findSlashCommand("/undo")?.name, "/rewind");
  });

  it("does not include removed/non-existent commands", () => {
    for (const name of ["/compact", "/memory", "/init", "/commit", "/cost"]) {
      assert.strictEqual(findSlashCommand(name), undefined, name);
    }
  });
});
