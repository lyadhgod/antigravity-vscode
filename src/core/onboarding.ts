/**
 * Pure decision logic that turns a {@link DetectionResult} into a concrete
 * recommendation for the user. Separated from the VS Code layer so the
 * branching (install vs. sign-in vs. ready) can be exhaustively unit-tested.
 */
import { DetectionResult, OnboardingDecision } from "./types";

/** Heuristics that classify CLI stderr/stdout as an authentication problem. */
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
 * Decides what to surface to the user given a detection probe.
 *
 * @param detection Result of locating + version-checking the binary.
 * @returns The recommended action, a message, and whether prompts may run.
 */
export function decideOnboarding(detection: DetectionResult): OnboardingDecision {
  if (!detection.found) {
    return {
      action: "install",
      message:
        "The Antigravity CLI (agy) was not found. Install it, then reload — " +
        "run “Antigravity: Install CLI”, or set antigravity.cliPath to its location.",
      canRun: false
    };
  }

  if (detection.loggedIn === false) {
    return {
      action: "login",
      message:
        "Antigravity CLI is installed but you are not signed in. " +
        "Run “Antigravity: Sign In” to start the Google sign-in flow.",
      canRun: false
    };
  }

  return {
    action: "none",
    message: detection.version
      ? `Antigravity CLI ${detection.version} is ready.`
      : "Antigravity CLI is ready.",
    canRun: true
  };
}

/**
 * Classifies a chunk of CLI output as indicating a missing/expired login.
 * Used both during detection and when a prompt fails, so we can offer a
 * "Sign In" affordance instead of a generic error.
 */
export function looksLikeLoginError(output: string): boolean {
  const haystack = output.toLowerCase();
  return LOGIN_HINTS.some((hint) => haystack.includes(hint));
}

/**
 * Extracts a semantic version (e.g. `1.2.3`) from arbitrary `agy --version`
 * output such as `"agy version 1.2.3 (go1.22)"`. Returns `undefined` when no
 * version-like token is present.
 */
export function parseVersion(output: string): string | undefined {
  const match = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : undefined;
}
