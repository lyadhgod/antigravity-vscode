import * as assert from "node:assert";

import {
  LaunchPlan,
  missingPtyBackendMessage,
  planLaunch,
  scriptInnerCommand,
  shQuote
} from "../../src/core/ptyLauncher";

const GEO = { cols: 120, rows: 40 };

describe("ptyLauncher.planLaunch (#1, #2)", () => {
  it("uses the `script` PTY shim on macOS/Linux", () => {
    for (const platform of ["darwin", "linux", "freebsd"] as NodeJS.Platform[]) {
      const plan = planLaunch(platform, "/usr/local/bin/agy", ["--sandbox"], GEO);
      assert.strictEqual(plan.kind, "script");
      if (plan.kind !== "script") {
        return;
      }
      assert.strictEqual(plan.command, "script");
      assert.deepStrictEqual(plan.args.slice(0, 3), ["-q", "-e", "-c"]);
      assert.strictEqual(plan.args[plan.args.length - 1], "/dev/null");
      const inner = plan.args[3];
      assert.ok(inner.includes("stty rows 40 cols 120"), inner);
      assert.ok(inner.includes("exec '/usr/local/bin/agy' '--sandbox'"), inner);
    }
  });

  it("uses a ConPTY plan (node-pty) on native Windows — never spawns `script`", () => {
    const plan: LaunchPlan = planLaunch("win32", "C:\\Users\\me\\agy.exe", ["--continue"], GEO);
    assert.strictEqual(plan.kind, "conpty");
    if (plan.kind !== "conpty") {
      return;
    }
    assert.strictEqual(plan.command, "C:\\Users\\me\\agy.exe");
    assert.deepStrictEqual(plan.args, ["--continue"]);
    assert.strictEqual(plan.cols, 120);
    assert.strictEqual(plan.rows, 40);
  });

  it("scriptInnerCommand sizes the PTY then execs agy with quoted argv", () => {
    assert.strictEqual(
      scriptInnerCommand("agy", ["--add-dir", "/a b"], { cols: 100, rows: 30 }),
      "stty rows 30 cols 100 2>/dev/null; exec 'agy' '--add-dir' '/a b'"
    );
  });

  it("shQuote escapes embedded single quotes", () => {
    assert.strictEqual(shQuote("it's"), `'it'\\''s'`);
  });

  it("the missing-backend message names node-pty and the WSL fallback (not 'agy not installed')", () => {
    const msg = missingPtyBackendMessage();
    assert.ok(/node-pty/i.test(msg));
    assert.ok(/wsl/i.test(msg));
    assert.ok(!/not installed/i.test(msg));
  });
});
