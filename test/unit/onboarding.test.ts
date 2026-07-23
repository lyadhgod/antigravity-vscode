import * as assert from "node:assert";

import { ScreenView } from "../../src/core/agyScreen";
import { decideOnboarding, looksLikeLoginError, parseVersion, screenNeedsLogin } from "../../src/core/onboarding";

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

describe("onboarding.screenNeedsLogin", () => {
  const view = (v: Partial<ScreenView>): ScreenView => ({ state: "starting", turns: [], ...v });
  const selector = (title: string, labels: string[]) => ({
    title,
    context: "",
    options: labels.map((label) => ({ label, checked: false, writeIn: false })),
    selectedIndex: 0,
    layout: "vertical" as const,
    multi: false
  });

  it("needs login on the sign-in screen", () => {
    assert.ok(screenNeedsLogin(view({ state: "signin" })));
  });

  it("needs login on the first-run auth-method selector", () => {
    const prompt = selector("How would you like to authenticate?", ["Google OAuth", "API key"]);
    assert.ok(screenNeedsLogin(view({ state: "prompt", prompt })));
  });

  it("does not need login at the ready input prompt", () => {
    assert.ok(!screenNeedsLogin(view({ state: "idle", ready: true })));
  });

  it("does not need login for an unrelated selector", () => {
    const prompt = selector("Choose a color scheme", ["Dark", "Light"]);
    assert.ok(!screenNeedsLogin(view({ state: "prompt", prompt })));
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
