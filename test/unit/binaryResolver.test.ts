import * as assert from "node:assert";
import * as path from "node:path";

import { ResolverEnv, resolveBinary } from "../../src/core/binaryResolver";

/** Builds a fake environment whose `fileExists` returns true for a given set. */
function env(opts: {
  platform?: NodeJS.Platform;
  vars?: Record<string, string | undefined>;
  existing?: string[];
}): ResolverEnv {
  const existing = new Set(opts.existing ?? []);
  return {
    platform: opts.platform ?? "linux",
    env: opts.vars ?? {},
    join: path.posix.join,
    fileExists: (c) => existing.has(c)
  };
}

describe("binaryResolver.resolveBinary", () => {
  it("expands ~ for an explicit path-like setting without touching PATH", () => {
    const e = env({ vars: { HOME: "/home/me" } });
    assert.strictEqual(resolveBinary("~/bin/agy", e), "/home/me/bin/agy");
  });

  it("returns an explicit absolute path as-is", () => {
    const e = env({});
    assert.strictEqual(resolveBinary("/opt/agy", e), "/opt/agy");
  });

  it("finds a bare command on PATH", () => {
    const e = env({
      vars: { PATH: "/usr/bin:/usr/local/bin" },
      existing: ["/usr/local/bin/agy"]
    });
    assert.strictEqual(resolveBinary("agy", e), "/usr/local/bin/agy");
  });

  it("falls back to the installer's well-known location", () => {
    const e = env({
      vars: { PATH: "/usr/bin", HOME: "/home/me" },
      existing: ["/home/me/.local/bin/agy"]
    });
    assert.strictEqual(resolveBinary("agy", e), "/home/me/.local/bin/agy");
  });

  it("returns the bare name when nothing is found (OS gets a chance)", () => {
    const e = env({ vars: { PATH: "/usr/bin", HOME: "/home/me" } });
    assert.strictEqual(resolveBinary("agy", e), "agy");
  });

  it("honors PATHEXT when probing on Windows", () => {
    const e = env({
      platform: "win32",
      vars: { Path: "C:\\bin", PATHEXT: ".EXE;.CMD" },
      existing: ["C:\\bin/agy.exe"]
    });
    // join is posix here, so the candidate uses a forward slash; the assertion
    // simply checks the .exe extension was tried and matched.
    assert.strictEqual(resolveBinary("agy", e), "C:\\bin/agy.exe");
  });
});
