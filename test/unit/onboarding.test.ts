import * as assert from "node:assert";
import * as path from "node:path";

import { decideOnboarding, looksLikeLoginError, oauthTokenPath, parseVersion } from "../../src/core/onboarding";

describe("onboarding.decideOnboarding", () => {
  it("returns notfound when the binary is missing", () => {
    const d = decideOnboarding({ command: "agy", found: false, authenticated: false });
    assert.strictEqual(d.action, "notfound");
    assert.strictEqual(d.canRun, false);
  });

  it("recommends login when found but not authenticated", () => {
    const d = decideOnboarding({ command: "agy", found: true, authenticated: false });
    assert.strictEqual(d.action, "login");
    assert.strictEqual(d.canRun, false);
  });

  it("is ready when found and authenticated", () => {
    const d = decideOnboarding({ command: "agy", found: true, authenticated: true, version: "1.0.4" });
    assert.strictEqual(d.action, "none");
    assert.strictEqual(d.canRun, true);
    assert.ok(d.message.includes("1.0.4"));
  });
});

describe("onboarding.oauthTokenPath", () => {
  it("builds the path under ~/.gemini/antigravity-cli", () => {
    assert.strictEqual(
      oauthTokenPath("/home/me", path.posix.join),
      "/home/me/.gemini/antigravity-cli/antigravity-oauth-token"
    );
  });
});

describe("onboarding.looksLikeLoginError", () => {
  it("detects common auth failure phrasings", () => {
    assert.ok(looksLikeLoginError("Error: not logged in"));
    assert.ok(looksLikeLoginError("HTTP 401 Unauthorized"));
    assert.ok(!looksLikeLoginError("Wrote 3 files successfully"));
  });
});

describe("onboarding.parseVersion", () => {
  it("extracts a semver from noisy version output", () => {
    assert.strictEqual(parseVersion("agy version 1.0.4 (go1.22.0)"), "1.0.4");
    assert.strictEqual(parseVersion("no numbers here"), undefined);
  });
});
