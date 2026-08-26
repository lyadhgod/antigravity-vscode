/**
 * Pure decision logic that turns a {@link DetectionResult} into a concrete
 * recommendation (sign in -> ready), plus helpers for reading sign-in state off
 * a live CLI screen and classifying auth failures. Separated from the VS Code
 * layer so the branching is exhaustively unit-testable.
 */
import { ScreenView } from "./agyScreen";
import { DetectionResult, OnboardingDecision } from "./types";

/** Heuristics that classify CLI output as an authentication problem. */
const LOGIN_HINTS = [
  "not logged in",
  "not authenticated",
  "sign in",
  "signed out",
  "please log in",
  "authentication required",
  "no credentials",
  "unauthorized",
  "401"
];

/**
 * True when a live `agy` screen is asking the user to sign in: either the
 * explicit sign-in screen, or the first-run selector offering an auth method.
 *
 * This is the ONLY auth signal we trust — what the CLI does when invoked. The
 * old on-disk OAuth token check was a false negative for anyone whose
 * credential lives in the OS keychain or was created in a terminal (#3, #5).
 */
export function screenNeedsLogin(view: ScreenView): boolean {
  return view.state === "signin" || offersSignIn(view);
}

/**
 * The CLI is *conclusively* asking to authenticate — it is offering auth
 * methods to pick from.
 *
 * Kept apart from {@link screenNeedsLogin} because that predicate's other half,
 * the "You are currently not signed in" banner, is **not** conclusive: the CLI
 * prints it at startup while it is still loading credentials, and then signs in
 * by itself. Observed against a real, fully-authenticated CLI: that banner is
 * on screen for the first ~4 seconds of every launch before the session becomes
 * ready. Treating it as an answer makes an authenticated user look signed out,
 * which sends the gate round the sign-in loop forever. So a caller wanting a
 * verdict from a single frame must use this; the banner only counts once it has
 * persisted, or on a session that had already reached its prompt.
 */
export function offersSignIn(view: ScreenView): boolean {
  return !!view.prompt?.options.some((o) => /oauth|sign in|sign-in|log in|login/i.test(o.label));
}

/**
 * Index of the "Yes, I trust this folder" row on the CLI's workspace-trust
 * selector ("Do you trust the contents of this project?"), or -1 when the
 * screen isn't that selector. Matched on the affirmative option rather than the
 * title, so a reworded heading doesn't break it; "No, exit" carries no "trust".
 *
 * Two callers need this, for different reasons. The sign-in flow answers it, so
 * a first run in a new folder doesn't stall behind a selector nothing drives.
 * The auth probe only needs to *recognise* it: being asked about the folder at
 * all means the CLI is past authentication, which lets the probe settle
 * immediately instead of sitting out its full timeout.
 */
export function trustPromptIndex(view: ScreenView): number {
  return view.prompt?.options.findIndex((o) => /\btrust\b/i.test(o.label)) ?? -1;
}

/**
 * Decides what to surface to the user.
 *
 * @param detection Result of locating + version-checking + auth-checking.
 */
export function decideOnboarding(detection: DetectionResult): OnboardingDecision {
  if (!detection.found) {
    return {
      action: "notfound",
      message: "agy not found. Set antigravity.cliPath if it is not on your PATH, then reload.",
      canRun: false
    };
  }
  if (!detection.authenticated) {
    return {
      action: "login",
      message: "Sign in with your Google account to start using Antigravity.",
      canRun: false
    };
  }
  return {
    action: "none",
    message: detection.version ? `Antigravity CLI ${detection.version} is ready.` : "Antigravity CLI is ready.",
    canRun: true
  };
}

/**
 * Classifies a chunk of CLI output as indicating a missing/expired login, so a
 * failed prompt can offer "Sign In" instead of a raw error.
 */
export function looksLikeLoginError(output: string): boolean {
  const haystack = output.toLowerCase();
  return LOGIN_HINTS.some((hint) => haystack.includes(hint));
}

/**
 * Extracts a semantic version (e.g. `1.0.4`) from arbitrary `agy --version`
 * output. Returns `undefined` when no version-like token is present.
 */
export function parseVersion(output: string): string | undefined {
  const match = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : undefined;
}
