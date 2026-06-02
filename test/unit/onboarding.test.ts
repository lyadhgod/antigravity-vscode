import * as assert from "node:assert";

import { decideOnboarding, looksLikeLoginError, parseVersion } from "../../src/core/onboarding";

describe("onboarding.decideOnboarding", () => {
  it("recommends install when the binary is missing", () => {
    const d = decideOnboarding({ command: "agy", found: false });
    assert.strictEqual(d.action, "install");
    assert.strictEqual(d.canRun, false);
  });

  it("recommends login when found but explicitly signed out", () => {
    const d = decideOnboarding({ command: "agy", found: true, loggedIn: false });
    assert.strictEqual(d.action, "login");
    assert.strictEqual(d.canRun, false);
  });

  it("is ready when found and login state is unknown", () => {
    const d = decideOnboarding({ command: "agy", found: true, version: "1.4.2" });
    assert.strictEqual(d.action, "none");
    assert.strictEqual(d.canRun, true);
    assert.ok(d.message.includes("1.4.2"));
  });
});

describe("onboarding.looksLikeLoginError", () => {
  it("detects common auth failure phrasings", () => {
    assert.ok(looksLikeLoginError("Error: not logged in"));
    assert.ok(looksLikeLoginError("HTTP 401 Unauthorized"));
    assert.ok(looksLikeLoginError("Please log in to continue"));
  });

  it("does not flag ordinary output", () => {
    assert.ok(!looksLikeLoginError("Wrote 3 files successfully"));
  });
});

describe("onboarding.parseVersion", () => {
  it("extracts a semver from noisy version output", () => {
    assert.strictEqual(parseVersion("agy version 1.4.2 (go1.22.0)"), "1.4.2");
    assert.strictEqual(parseVersion("v2.0.0-beta.1"), "2.0.0-beta.1");
  });

  it("returns undefined when no version is present", () => {
    assert.strictEqual(parseVersion("no numbers here"), undefined);
  });
});
