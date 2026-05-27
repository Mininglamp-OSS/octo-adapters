import path from "node:path";
import { homedir } from "node:os";

/**
 * The POSIX-style fake config file path that test mocks return for
 * `runOpenclaw(["config", "file"])`. Use this in mock implementations
 * (the value is fed into production code, which then normalises it via
 * `getConfigFilePathSafe` → `normalizeConfigPath`).
 */
export const FAKE_CFG_PATH = "/home/user/.openclaw/openclaw.json";

/**
 * The OS-resolved form of FAKE_CFG_PATH after `normalizeConfigPath`.
 * Use this when asserting against arguments passed to spies
 * (copyFileSync, writeFileSync, etc.) — production code normalises
 * every incoming config path, so spies see the resolved form, not the
 * POSIX input.
 *
 * Mirrors `cli/openclaw-cli.ts:170-180 normalizeConfigPath`:
 *   - if `path.resolve(p) === p` it's already absolute → return as-is
 *   - else resolve relative to `os.homedir()` (the production fallback)
 *
 * On POSIX (Linux/macOS) this returns the input unchanged. On Windows
 * `path.resolve("/home/user/...")` does NOT equal the input (Node
 * prepends a drive letter) so the homedir branch fires — yielding e.g.
 * `C:\home\user\.openclaw\openclaw.json` on a runner whose homedir is
 * on the C: drive, regardless of the cwd drive. This is critical on
 * GitHub Actions Windows runners where cwd is on D: but homedir is
 * on C:.
 */
export const RESOLVED_CFG_PATH = (() => {
  if (path.resolve(FAKE_CFG_PATH) === FAKE_CFG_PATH) return FAKE_CFG_PATH;
  return path.resolve(homedir(), FAKE_CFG_PATH);
})();

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
