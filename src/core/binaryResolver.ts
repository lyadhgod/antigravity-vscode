/**
 * Resolves the `agy` binary location without importing `vscode` or touching the
 * filesystem directly. All environment access is injected so the logic is
 * deterministic and unit-testable.
 *
 * Resolution order (first match wins):
 *   1. An explicit, path-like `cliPath` setting (contains a separator or `~`).
 *   2. A bare command name found on `PATH`.
 *   3. Well-known install locations the official installer uses
 *      (`~/.local/bin/agy` on Unix, `%LOCALAPPDATA%\Antigravity\agy.exe` on Win).
 *   4. Fallback: the bare command name, trusting the OS to resolve it at spawn.
 */

/** Minimal, injectable view of the host environment for testability. */
export interface ResolverEnv {
  /** `process.platform` value (`"win32"`, `"darwin"`, `"linux"`, …). */
  platform: NodeJS.Platform;
  /** Relevant environment variables (`PATH`, `HOME`, `USERPROFILE`, …). */
  env: Record<string, string | undefined>;
  /** Returns true when `candidate` exists and is a file we could execute. */
  fileExists: (candidate: string) => boolean;
  /** Path join helper (injected so tests need no `path` import coupling). */
  join: (...parts: string[]) => string;
}

/** The platform-specific PATH entry separator. */
function pathSeparator(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

/** Executable file extensions to try when probing PATH on Windows. */
function executableExtensions(platform: NodeJS.Platform, env: ResolverEnv["env"]): string[] {
  if (platform !== "win32") {
    return [""];
  }
  // PATHEXT defines what counts as executable on Windows; default to common set.
  const pathext = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase());
  return ["", ...pathext];
}

/** Expands a leading `~` to the user's home directory. */
function expandHome(p: string, env: ResolverEnv["env"]): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    const home = env.HOME ?? env.USERPROFILE ?? "";
    return home + p.slice(1);
  }
  return p;
}

/** True when the configured value already looks like a path, not a bare name. */
function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value.startsWith("~");
}

/** Default install locations probed when the binary is not on PATH. */
function wellKnownLocations(env: ResolverEnv): string[] {
  const { platform, env: vars, join } = env;
  if (platform === "win32") {
    const localAppData = vars.LOCALAPPDATA;
    return localAppData ? [join(localAppData, "Antigravity", "agy.exe")] : [];
  }
  const home = vars.HOME ?? "";
  if (!home) {
    return [];
  }
  return [
    join(home, ".local", "bin", "agy"),
    join(home, "bin", "agy"),
    "/usr/local/bin/agy",
    "/opt/homebrew/bin/agy"
  ];
}

/**
 * Computes the command/path the extension should spawn for the CLI.
 *
 * @param cliPath The raw `antigravity.cliPath` setting.
 * @param env Injected environment accessors.
 * @returns An absolute path when one was found on disk, otherwise the bare
 *          command name (so the OS still gets a chance to resolve it).
 */
export function resolveBinary(cliPath: string, env: ResolverEnv): string {
  const configured = (cliPath || "agy").trim();

  // 1. Explicit path-like setting: expand `~` and use as-is.
  if (looksLikePath(configured)) {
    return expandHome(configured, env.env);
  }

  // 2. Probe each PATH entry for the bare command (honoring Windows PATHEXT).
  const pathValue = env.env.PATH ?? env.env.Path ?? "";
  const dirs = pathValue.split(pathSeparator(env.platform)).filter(Boolean);
  const exts = executableExtensions(env.platform, env.env);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = env.join(dir, configured + ext);
      if (env.fileExists(candidate)) {
        return candidate;
      }
    }
  }

  // 3. Probe the installer's well-known locations.
  for (const candidate of wellKnownLocations(env)) {
    if (env.fileExists(candidate)) {
      return candidate;
    }
  }

  // 4. Give up resolving here; trust the OS to find it (or fail loudly).
  return configured;
}
