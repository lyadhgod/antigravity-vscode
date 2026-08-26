import * as assert from "node:assert";

import { ScreenView } from "../../src/core/agyScreen";
import { decideOnboarding, looksLikeLoginError, offersSignIn, parseVersion, screenNeedsLogin, trustPromptIndex } from "../../src/core/onboarding";

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
  const view = (v: Partial<ScreenView>): ScreenView => ({ state: "starting", turns: [], liveLog: "", ...v });
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

  describe("offersSignIn", () => {
    // The distinction that matters: an authenticated CLI prints the "not signed
    // in" banner for the first ~4s of EVERY launch while it loads credentials.
    // Acting on that made a signed-in user look signed out, and since signing in
    // lands right back here, the gate looped forever.
    it("is false for the transient startup banner that screenNeedsLogin accepts", () => {
      const starting = view({ state: "signin" });
      assert.ok(screenNeedsLogin(starting), "the banner alone still trips the broad check");
      assert.ok(!offersSignIn(starting), "but it is not on its own a verdict");
    });

    it("is true only once the CLI actually offers auth methods", () => {
      const prompt = selector("How would you like to authenticate?", ["Google OAuth", "API key"]);
      assert.ok(offersSignIn(view({ state: "prompt", prompt })));
    });

    it("is false at the ready prompt and for unrelated selectors", () => {
      assert.ok(!offersSignIn(view({ state: "idle", ready: true })));
      assert.ok(!offersSignIn(view({ state: "prompt", prompt: selector("Choose a color scheme", ["Dark", "Light"]) })));
    });
  });

  describe("trustPromptIndex", () => {
    // Verified against agy 1.1.11, which shows this on a first run in a folder:
    //   Do you trust the contents of this project?
    //   > Yes, I trust this folder
    //     No, exit
    const trust = () => selector("Do you trust the contents of this project?", ["Yes, I trust this folder", "No, exit"]);

    it("finds the affirmative row on the workspace-trust selector", () => {
      assert.strictEqual(trustPromptIndex(view({ state: "prompt", prompt: trust() })), 0);
    });

    it("is -1 for any other selector, and for no selector at all", () => {
      assert.strictEqual(trustPromptIndex(view({ state: "prompt", prompt: selector("Choose a color scheme", ["Dark", "Light"]) })), -1);
      assert.strictEqual(trustPromptIndex(view({ state: "idle", ready: true })), -1);
    });

    // The probe treats this screen as proof of being past auth, so it must not
    // collide with the sign-in selector that screenNeedsLogin owns.
    it("does not fire on the auth-method selector", () => {
      const prompt = selector("How would you like to authenticate?", ["Google OAuth", "API key"]);
      assert.strictEqual(trustPromptIndex(view({ state: "prompt", prompt })), -1);
      assert.ok(screenNeedsLogin(view({ state: "prompt", prompt })));
    });
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
