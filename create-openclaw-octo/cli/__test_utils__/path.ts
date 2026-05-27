import path from "node:path";

/**
 * The POSIX-style fake config file path that test mocks return for
 * `runOpenclaw(["config", "file"])`. Use this in mock implementations
 * (the value is fed into production code, which then normalises it via
 * `getConfigFilePathSafe` → `path.resolve`).
 */
export const FAKE_CFG_PATH = "/home/user/.openclaw/openclaw.json";

/**
 * The OS-resolved form of FAKE_CFG_PATH after `path.resolve`. Use this
 * when asserting against arguments passed to spies (copyFileSync,
 * writeFileSync, etc.) — production code normalises every incoming
 * config path via `getConfigFilePathSafe`, so spies see the resolved
 * form, not the POSIX input.
 *
 *   Linux/macOS:  /home/user/.openclaw/openclaw.json
 *   Windows:      C:\home\user\.openclaw\openclaw.json
 */
export const RESOLVED_CFG_PATH = path.resolve(FAKE_CFG_PATH);

/**
 * Path-separator-agnostic suffix matcher. Use in `existsSync` / `rmSync`
 * mocks instead of `String(p).endsWith("/some/suffix")` — `path.resolve`
 * upstream produces native separators, so a literal POSIX `endsWith`
 * silently misses on Windows.
 */
export function pathEndsWith(p: unknown, suffix: string): boolean {
  return String(p).replace(/\\/g, "/").endsWith(suffix);
}

/**
 * Path-separator-agnostic substring check. Counterpart of
 * `pathEndsWith` for `String(p).includes("/some/segment/")` patterns.
 */
export function pathIncludes(p: unknown, segment: string): boolean {
  return String(p).replace(/\\/g, "/").includes(segment);
}

/**
 * Path-separator-agnostic regex match. Returns the first match (with
 * any capture groups) or null. Use when extracting a path segment from
 * native-separator paths via a POSIX-style regex.
 */
export function pathMatch(p: unknown, regex: RegExp): RegExpMatchArray | null {
  return String(p).replace(/\\/g, "/").match(regex);
}
