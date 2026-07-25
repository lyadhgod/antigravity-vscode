import * as assert from "node:assert";

import {
  LaunchPlan,
  missingPtyBackendMessage,
  planLaunch,
  scriptInnerCommand,
  shQuote,
  tclQuote
} from "../../src/core/ptyLauncher";

const GEO = { cols: 120, rows: 40 };

describe("ptyLauncher.planLaunch (#1, #2)", () => {
  it("uses the util-linux `script -c` form on Linux", () => {
    const plan = planLaunch("linux", "/usr/local/bin/agy", ["--sandbox"], GEO);
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
  });

  // BSD `script` aborts on any piped stdin ("tcgetattr/ioctl: Operation not
  // supported on socket"), so macOS must not spawn it at all — that instant exit
  // is what made the auth probe report "signed in" while signed out (#3).
  it("uses `expect` on macOS/BSD — never `script`", () => {
    for (const platform of ["darwin", "freebsd"] as NodeJS.Platform[]) {
      const plan = planLaunch(platform, "/usr/local/bin/agy", ["--sandbox"], GEO);
      assert.strictEqual(plan.kind, "script");
      if (plan.kind !== "script") {
        return;
      }
      assert.strictEqual(plan.command, "expect");
      assert.deepStrictEqual(plan.args.slice(0, 1), ["-c"]);
      const prog = plan.args[1];
      assert.ok(prog.includes(`set stty_init "rows 40 cols 120"`), prog);
      assert.ok(prog.includes(`spawn -noecho "/usr/local/bin/agy" "--sandbox"`), prog);
      assert.ok(prog.includes("interact"), prog);
    }
  });

  it("tclQuote escapes the characters expect would substitute", () => {
    assert.strictEqual(tclQuote("/a b/agy"), `"/a b/agy"`);
    assert.strictEqual(tclQuote(`a$b[c]"d\\e`), `"a\\$b\\[c\\]\\"d\\\\e"`);
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

  it("wraps a .cmd/.bat shim in cmd.exe (ConPTY can't exec one directly)", () => {
    const plan = planLaunch("win32", "C:\\npm\\agy.cmd", ["--sandbox"], GEO);
    assert.strictEqual(plan.kind, "conpty");
    if (plan.kind !== "conpty") {
      return;
    }
    assert.strictEqual(plan.command, "cmd.exe");
    assert.deepStrictEqual(plan.args, ["/c", "C:\\npm\\agy.cmd", "--sandbox"]);
  });

  it("the missing-backend message names the pty backend, not 'agy not installed'", () => {
    const msg = missingPtyBackendMessage();
    assert.ok(/node-pty/i.test(msg));
    assert.ok(!/not installed/i.test(msg));
  });
});
