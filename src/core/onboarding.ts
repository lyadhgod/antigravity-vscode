/**
 * Pure decision logic that turns a {@link DetectionResult} into a concrete
 * recommendation (sign in -> ready), plus helpers for locating the
 * OAuth token and classifying auth failures. Separated from the VS Code layer
 * so the branching is exhaustively unit-testable.
 */
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
 * Path to the cached OAuth token, relative to the user's home directory. The
 * real CLI writes it to `~/.gemini/antigravity-cli/antigravity-oauth-token`.
 * Pure (caller supplies `home` and a `join`) so it is testable cross-platform.
 */
export function oauthTokenPath(home: string, join: (...parts: string[]) => string): string {
  return join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
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
