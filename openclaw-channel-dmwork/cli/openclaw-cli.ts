/**
 * openclaw CLI wrapper.
 * All openclaw invocations go through this module using execFileSync with
 * argument arrays to avoid shell-quoting issues.
 */

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, readdirSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Find the user's globally installed openclaw, skipping the npx environment.
 *
 * npx installs openclaw as a peerDependency, which may be a newer version
 * than the user's server. Using the npx version to write openclaw.json
 * causes version incompatibility crashes on older OpenClaw servers.
 */
function findGlobalOpenclaw(): string {
  const isWindows = process.platform === "win32";

  // Strategy 1: use "which -a" (Unix) or "where" (Windows) to find all openclaw paths
  // Skip: _npx (npx cache), npx-cache, node_modules (project-local devDependency)
  for (const cmd of ["which -a openclaw", "where openclaw"]) {
    try {
      const output = execSync(cmd, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const paths = output
        .split(/\r?\n/)
        .map((p) => p.trim())
        .filter((p) =>
          p.length > 0 &&
          !p.includes("_npx") &&
          !p.includes("npx-cache") &&
          !p.includes("node_modules"),
        );
      if (paths.length > 0) {
        // On Windows, `where openclaw` may return both the extensionless shim
        // and `openclaw.cmd`. Prefer `.cmd`, otherwise execFileSync may hit
        // ENOENT for the extensionless path.
        if (isWindows) {
          const cmdShim = paths.find((p) => /\.cmd$/i.test(p));
          if (cmdShim) return cmdShim;
        }
        return paths[0];
      }
    } catch {
      // command not available on this platform
    }
  }

  // Strategy 2 (Windows): npm global prefix + openclaw.cmd
  // npm i -g openclaw 在 Windows 上生成 .ps1 和 .cmd，但 npx 子进程的 PATH
  // 可能不包含 npm 全局目录，导致 where 找不到。通过 npm prefix 定位。
  // 注意：npm 本身也是 .cmd，必须通过 resolveCommand 找到再用 cmd.exe 执行。
  if (isWindows) {
    try {
      const npmResolved = resolveCommand("npm");
      let prefix: string;
      if (/\.cmd$/i.test(npmResolved)) {
        const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
        prefix = execFileSync(comspec, ["/d", "/s", "/v:off", "/c", `"${npmResolved}" config get prefix`], {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      } else {
        prefix = execSync("npm config get prefix", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      }
      if (prefix) {
        const cmdPath = resolve(prefix, "openclaw.cmd");
        if (existsSync(cmdPath)) return cmdPath;
      }
    } catch {
      // npm not available
    }
  }

  // Strategy 3: check common global install paths
  const candidates = [
    "/opt/homebrew/bin/openclaw",
    "/usr/local/bin/openclaw",
    "/usr/bin/openclaw",
    resolve(homedir(), ".npm-global", "bin", "openclaw"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // Last resort: use PATH (may still be npx version)
  return "openclaw";
}

const IS_WINDOWS = process.platform === "win32";

/**
 * Resolve a command name to its .cmd shim on Windows.
 * On Windows, `where.exe <cmd>` may return both a bare file and a .cmd;
 * execFileSync cannot execute the bare file (ENOENT), so we prefer .cmd.
 */
function resolveCommand(name: string): string {
  if (IS_WINDOWS) {
    try {
      const output = execSync(`where.exe ${name}`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const paths = output.split(/\r?\n/).map((p) => p.trim()).filter((p) => p.length > 0);
      const cmdShim = paths.find((p) => /\.cmd$/i.test(p));
      if (cmdShim) return cmdShim;
      if (paths.length > 0) return paths[0];
    } catch { /* not found via where */ }
  }
  return name;
}

/**
 * Execute an external command, compatible with Windows .cmd shims.
 * On Windows, .cmd files are executed via cmd.exe /d /s /c explicitly.
 * All external command invocations (openclaw, npm, etc.) should use this.
 */
export function runCmd(command: string, args: string[], opts: Record<string, unknown> = {}): string {
  const resolved = resolveCommand(command);
  if (IS_WINDOWS && /\.cmd$/i.test(resolved)) {
    const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
    const escaped = args.map((a) => {
      if (!/[\s"&|<>^%!]/.test(a)) return a;
      return `"${a.replace(/%/g, "%%").replace(/"/g, '""')}"`;
    });
    const cmdline = `"${resolved}" ${escaped.join(" ")}`;
    return execFileSync(comspec, ["/d", "/s", "/v:off", "/c", cmdline], { encoding: "utf-8", ...opts } as any) as unknown as string;
  }
  return execFileSync(resolved, args, { encoding: "utf-8", ...opts } as any) as unknown as string;
}

const OPENCLAW = findGlobalOpenclaw();
const NEEDS_SHELL = IS_WINDOWS && /\.cmd$/i.test(OPENCLAW);

/**
 * Execute openclaw CLI command. Wrapper with pre-resolved path.
 */
function runOpenclaw(args: string[], opts: Record<string, unknown> = {}): string {
  if (NEEDS_SHELL) {
    const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
    const escaped = args.map((a) => {
      if (!/[\s"&|<>^%!]/.test(a)) return a;
      return `"${a.replace(/%/g, "%%").replace(/"/g, '""')}"`;
    });
    const cmdline = `"${OPENCLAW}" ${escaped.join(" ")}`;
    return execFileSync(comspec, ["/d", "/s", "/v:off", "/c", cmdline], { encoding: "utf-8", ...opts } as any) as unknown as string;
  }
  return execFileSync(OPENCLAW, args, { encoding: "utf-8", ...opts } as any) as unknown as string;
}

/** Get the resolved openclaw binary path */
export function getOpenClawBin(): string {
  return OPENCLAW;
}

/** Execute openclaw command (exported for quickstart.ts etc.) */
export { runOpenclaw };

/** Expand ~ to home directory */
function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function getConfigFilePath(): string {
  const out = runOpenclaw(["config", "file"]);
  // openclaw may prepend warnings/box-drawing to stdout; extract the actual path
  // The path is typically the last non-empty line containing openclaw.json
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const pathLine = lines.find((l) => l.endsWith("openclaw.json")) ?? lines[lines.length - 1];
  return pathLine ?? out.trim();
}

/**
 * Strip OpenClaw stdout noise (banner, plugin log lines, timestamps).
 * Old OpenClaw versions mix these into stdout alongside the actual value.
 */
function stripStdoutNoise(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      // Banner: 🦞 OpenClaw ...
      if (/^[\u{1F980}\u{1F600}-\u{1FAFF}]/u.test(t)) return false;
      // Plugin log: [plugins] ..., [dmwork] ...
      if (/^\[[\w-]+\]/.test(t)) return false;
      // Timestamped log: 17:37:26 [plugins] ...
      if (/^\d{1,2}:\d{2}(:\d{2})?\s*\[/.test(t)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

export function configGet(path: string): string | null {
  try {
    const raw = runOpenclaw(["config", "get", path], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const val = stripStdoutNoise(raw);
    return val === "" ? null : val;
  } catch {
    return null;
  }
}

export function configGetJson(path: string): any {
  try {
    const out = runOpenclaw(["config", "get", path, "--json"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const jsonStart = out.indexOf("{");
    const arrStart = out.indexOf("[");
    const start = jsonStart >= 0 && arrStart >= 0
      ? Math.min(jsonStart, arrStart)
      : Math.max(jsonStart, arrStart);
    if (start < 0) return null;
    // Find matching end bracket to avoid trailing log noise breaking JSON.parse
    const openChar = out[start];
    const closeChar = openChar === "{" ? "}" : "]";
    let depth = 0;
    let end = -1;
    for (let i = start; i < out.length; i++) {
      if (out[i] === openChar) depth++;
      else if (out[i] === closeChar) { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return null;
    return JSON.parse(out.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function configSet(path: string, value: string): void {
  runOpenclaw(["config", "set", path, value], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function configSetBatch(
  operations: Array<{ path: string; value: unknown }>,
): void {
  const batchJson = JSON.stringify(
    operations.map((op) => ({ path: op.path, value: op.value })),
  );
  runOpenclaw(["config", "set", "--batch-json", batchJson], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function configSetJson(path: string, value: unknown): void {
  runOpenclaw(["config", "set", path, JSON.stringify(value), "--strict-json"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function configUnset(path: string): void {
  runOpenclaw(["config", "unset", path], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// ---------------------------------------------------------------------------
// Plugin helpers
// ---------------------------------------------------------------------------

/**
 * Check if an error indicates an unsupported CLI option.
 * Checks stderr/stdout/message across different Node versions and shells.
 */
function isUnsupportedOptionError(err: unknown): boolean {
  const sources = [
    (err as any)?.stderr?.toString?.(),
    (err as any)?.stdout?.toString?.(),
    (err as any)?.message,
    String(err),
  ];
  return sources.some(
    (s) => s && (/unknown option|unrecognized option/i.test(s)),
  );
}

function isPluginNotInstalledError(err: unknown): boolean {
  const sources = [
    (err as any)?.stderr?.toString?.(),
    (err as any)?.stdout?.toString?.(),
    (err as any)?.message,
    String(err),
  ];
  return sources.some(
    (s) => s && (/not installed|no such plugin|plugin not found/i.test(s)),
  );
}

export function pluginsInstall(spec: string, quiet?: boolean, force?: boolean): void {
  const baseArgs = ["plugins", "install", spec];

  // 3-layer degradation for old openclaw versions:
  //   1. --force --dangerously-force-unsafe-install  (newest openclaw)
  //   2. --force                                     (mid-age openclaw)
  //   3. bare install                                (oldest openclaw)
  const attempts: string[][] = force
    ? [
        [...baseArgs, "--force", "--dangerously-force-unsafe-install"],
        [...baseArgs, "--force"],
        baseArgs,
      ]
    : [
        [...baseArgs, "--dangerously-force-unsafe-install"],
        baseArgs,
      ];

  // Always pipe to capture stderr for degradation detection.
  // stdio: "inherit" causes Node to omit stderr from the error object,
  // making isUnsupportedOptionError() unable to detect "unknown option".
  for (let i = 0; i < attempts.length; i++) {
    try {
      const result = runOpenclaw(attempts[i], {
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
      });
      if (!quiet && result) process.stdout.write(result);
      return;
    } catch (err) {
      if (isUnsupportedOptionError(err) && i < attempts.length - 1) {
        continue; // try next degradation level
      }
      // Final attempt failed: replay captured output, then throw
      if (!quiet) {
        const stdout = (err as any)?.stdout?.toString?.();
        const stderr = (err as any)?.stderr?.toString?.();
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
      }
      throw err;
    }
  }
}

export function pluginsUpdate(id: string, quiet?: boolean): void {
  const result = runOpenclaw(["plugins", "update", id], {
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (!quiet && result) process.stdout.write(result);
}

export function pluginsUninstall(id: string, yes?: boolean): void {
  const args = ["plugins", "uninstall", id];
  if (yes) args.push("--force");
  runOpenclaw(args, { stdio: "inherit" });
}

export interface PluginInspectResult {
  plugin?: {
    id: string;
    version: string;
    enabled: boolean;
  };
  install?: {
    source: string;
    version: string;
    installPath: string;
  };
}

export type InspectFailReason = "unsupported" | "not_found" | "error";

export interface PluginsInspectOutcome {
  ok: boolean;
  data: PluginInspectResult | null;
  failReason: InspectFailReason | null;
}

/**
 * Inspect a plugin. Returns structured outcome distinguishing:
 * - ok + data: inspect succeeded
 * - unsupported: old OpenClaw without `plugins inspect`
 * - not_found: plugin genuinely not found
 * - error: other failure (config corruption, plugin load crash, etc.)
 */
export function pluginsInspectDetailed(id: string): PluginsInspectOutcome {
  try {
    const out = runOpenclaw(["plugins", "inspect", id, "--json"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const jsonStart = out.indexOf("{");
    if (jsonStart < 0) return { ok: false, data: null, failReason: "error" };
    const data = JSON.parse(out.slice(jsonStart));
    return { ok: true, data, failReason: null };
  } catch (err) {
    const sources = [
      (err as any)?.stderr?.toString?.(),
      (err as any)?.stdout?.toString?.(),
      (err as any)?.message,
      String(err),
    ];
    const text = sources.filter(Boolean).join(" ");
    if (/unknown command|unrecognized command/i.test(text)) {
      return { ok: false, data: null, failReason: "unsupported" };
    }
    if (/not found|not installed|no such plugin/i.test(text)) {
      return { ok: false, data: null, failReason: "not_found" };
    }
    return { ok: false, data: null, failReason: "error" };
  }
}

/** Backward-compatible wrapper: returns data or null. */
export function pluginsInspect(id: string): PluginInspectResult | null {
  const outcome = pluginsInspectDetailed(id);
  return outcome.ok ? outcome.data : null;
}

// ---------------------------------------------------------------------------
// Unified plugin state detection (inspect + fallback)
// ---------------------------------------------------------------------------

export interface PluginResolvedState {
  installed: boolean;
  enabled: boolean | null;
  version: string | null;
  installPath: string | null;
  source: "inspect" | "fallback";
  /** Why inspect failed. null when source === "inspect". */
  inspectFailReason: InspectFailReason | null;
}

/**
 * Resolve plugin install state. Uses `plugins inspect` when available,
 * falls back to config entries + directory + package.json for old OpenClaw
 * versions that don't support `plugins inspect`.
 *
 * Fallback installed = all 3 artifacts present (entries + installs + dir),
 * matching detectScenario()'s healthy definition. Partial presence is NOT
 * considered installed — that's a broken state for doctor --fix to handle.
 */
export function resolvePluginState(id: string): PluginResolvedState {
  // Try inspect first
  const outcome = pluginsInspectDetailed(id);
  if (outcome.ok && outcome.data?.plugin) {
    return {
      installed: true,
      enabled: outcome.data.plugin.enabled,
      version: outcome.data.plugin.version,
      installPath: outcome.data.install?.installPath ?? null,
      source: "inspect",
      inspectFailReason: null,
    };
  }

  // Fallback: check config + filesystem
  const cfg = readConfigFromFile();
  const extDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");
  const pluginDir = resolve(extDir, id);

  const hasDir = existsSync(pluginDir);
  const entries = cfg?.plugins?.entries?.[id];
  const installs = cfg?.plugins?.installs?.[id];
  const hasEntry = Boolean(entries);
  const hasInstall = Boolean(installs);

  // Healthy install requires all 3 artifacts, same as detectScenario().
  // Partial presence (e.g. dir exists but no entries/installs) is broken, not installed.
  const installed = hasDir && hasEntry && hasInstall;

  if (!installed) {
    return {
      installed: false, enabled: null, version: null, installPath: null,
      source: "fallback", inspectFailReason: outcome.failReason,
    };
  }

  // Resolve version: installs record > package.json on disk
  let version: string | null = installs?.version ?? null;
  if (!version && hasDir) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(pluginDir, "package.json"), "utf-8"));
      version = pkg.version ?? null;
    } catch { /* no package.json */ }
  }

  const enabled = entries?.enabled ?? null;
  const installPath = installs?.installPath ?? (hasDir ? `~/.openclaw/extensions/${id}` : null);

  return { installed, enabled, version, installPath, source: "fallback", inspectFailReason: outcome.failReason };
}

// ---------------------------------------------------------------------------
// Gateway helpers
// ---------------------------------------------------------------------------

export function gatewayStatus(): { running: boolean } {
  try {
    const out = runOpenclaw(["gateway", "status", "--json"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const jsonStart = out.indexOf("{");
    if (jsonStart < 0) return { running: false };
    // Find matching } to avoid trailing log noise
    let depth = 0;
    let end = -1;
    for (let i = jsonStart; i < out.length; i++) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return { running: false };
    const data = JSON.parse(out.slice(jsonStart, end + 1));
    const runtimeRunning = data.service?.runtime?.status === "running";
    const healthy = data.health?.healthy === true;
    // Fallback: port is busy with an openclaw-gateway process = gateway is running
    const portBusy = data.port?.status === "busy";
    return { running: runtimeRunning || healthy || portBusy };
  } catch {
    return { running: false };
  }
}

export function gatewayRestart(quiet?: boolean): boolean {
  try {
    runOpenclaw(["gateway", "restart"], {
      stdio: quiet ? ["pipe", "pipe", "pipe"] : "inherit",
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

export function getOpenClawVersion(): string | null {
  try {
    const out = runOpenclaw(["--version"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const match = out.match(/(\d{4}\.\d+\.\d+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Direct JSON file access (for config backup/restore around uninstall)
//
// openclaw plugins uninstall deletes channels.dmwork from the config file.
// We cannot use `openclaw config get` to back up because it redacts secrets,
// and we cannot use `openclaw config set` to restore because after uninstall
// the channel id is unknown and validation rejects it.
// So we read/write the JSON file directly for this specific operation.
// ---------------------------------------------------------------------------

/**
 * Save the channels.dmwork section from openclaw.json by reading the file
 * directly (preserving secrets that `openclaw config get` would redact).
 */
export function saveChannelConfigFromFile(): Record<string, unknown> | null {
  try {
    const configPath = getConfigFilePathSafe();
    const raw = readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw);
    return cfg?.channels?.dmwork ?? null;
  } catch {
    return null;
  }
}

/**
 * Restore the channels.dmwork section into openclaw.json by writing the file
 * directly (bypassing validation that would reject unknown channel ids).
 * Creates a .bak backup before writing.
 */
export function restoreChannelConfigToFile(
  dmworkConfig: Record<string, unknown>,
): void {
  const configPath = getConfigFilePathSafe();
  // Backup
  copyFileSync(configPath, configPath + ".bak");
  // Read, merge, write
  const raw = readFileSync(configPath, "utf-8");
  const cfg = JSON.parse(raw);
  if (!cfg.channels) cfg.channels = {};
  cfg.channels.dmwork = dmworkConfig;
  writeConfigAtomic(cfg);
}

/**
 * Remove channels.dmwork directly from the JSON file.
 * Used before uninstall to avoid config validation errors
 * (openclaw config unset also fails when the channel id is unknown).
 */
/**
 * Get the openclaw config file path without calling the CLI.
 * Falls back to the standard default when CLI is unavailable
 * (e.g. during uninstall when config validation fails).
 */
export function getConfigFilePathSafe(): string {
  try {
    return expandHome(getConfigFilePath());
  } catch {
    return resolve(homedir(), ".openclaw", "openclaw.json");
  }
}

export function removeChannelConfigFromFile(): void {
  try {
    const configPath = getConfigFilePathSafe();
    copyFileSync(configPath, configPath + ".bak");
    const cfg = readConfigFromFile();
    if (cfg?.channels?.dmwork) {
      delete cfg.channels.dmwork;
      writeConfigAtomic(cfg);
    }
  } catch {
    // best effort
  }
}

/**
 * Read the full config object directly from file (for doctor phase-1 checks).
 */
export function readConfigFromFile(): Record<string, any> | null {
  try {
    const configPath = getConfigFilePathSafe();
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Remove orphaned dmwork bindings from the config file.
 * If validAccountIds is provided, only removes bindings referencing accounts
 * not in that list. Otherwise removes all dmwork bindings.
 */
export function removeOrphanedBindingsFromFile(
  channel: string,
  validAccountIds?: string[],
): void {
  try {
    const configPath = getConfigFilePathSafe();
    copyFileSync(configPath, configPath + ".bak");
    const raw = readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw);
    if (!Array.isArray(cfg.bindings)) return;
    cfg.bindings = cfg.bindings.filter((b: any) => {
      if (b.match?.channel !== channel) return true; // keep non-dmwork
      if (!validAccountIds) return false; // remove all dmwork bindings
      // Keep only if accountId is in valid list (or no accountId specified)
      return !b.match.accountId || validAccountIds.includes(b.match.accountId);
    });
    writeConfigAtomic(cfg);
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Legacy plugin cleanup
// ---------------------------------------------------------------------------

const LEGACY_PLUGIN_ID = "dmwork";

/**
 * Detect and clean up legacy DMWork plugin installations that conflict
 * with the current openclaw-channel-dmwork plugin.
 *
 * Known legacy artifacts:
 * - ~/.openclaw/extensions/dmwork/ (old plugin directory, id="dmwork")
 * - plugins.entries.dmwork in openclaw.json
 *
 * Returns a list of actions taken (for logging).
 */
export function cleanupLegacyPlugin(): string[] {
  const actions: string[] = [];

  // 1. Check if legacy plugin directory exists
  const legacyDir = resolve(
    getConfigFilePathSafe().replace(/openclaw\.json$/, ""),
    "extensions",
    LEGACY_PLUGIN_ID,
  );

  if (existsSync(legacyDir)) {
    // Try to uninstall via openclaw CLI first (removes entries/installs/allow)
    try {
      runOpenclaw(["plugins", "uninstall", LEGACY_PLUGIN_ID, "--force", "--keep-files"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      actions.push(`Unregistered legacy plugin "${LEGACY_PLUGIN_ID}"`);
    } catch {
      // May fail if plugin not in registry, clean up config manually
    }

    // Remove legacy directory
    try {
      rmSync(legacyDir, { recursive: true, force: true });
      actions.push(`Removed legacy directory: ${legacyDir}`);
    } catch {
      actions.push(`Warning: could not remove ${legacyDir}`);
    }
  }

  // 2. Check for stale config entries (in case uninstall didn't clean them)
  try {
    const cfg = readConfigFromFile();
    if (cfg?.plugins?.entries?.[LEGACY_PLUGIN_ID]) {
      const configPath = getConfigFilePathSafe();
      copyFileSync(configPath, configPath + ".bak");
      delete cfg.plugins.entries[LEGACY_PLUGIN_ID];
      // Also clean installs and allow
      if (cfg.plugins?.installs?.[LEGACY_PLUGIN_ID]) {
        delete cfg.plugins.installs[LEGACY_PLUGIN_ID];
      }
      if (Array.isArray(cfg.plugins?.allow)) {
        cfg.plugins.allow = cfg.plugins.allow.filter((id: string) => id !== LEGACY_PLUGIN_ID);
      }
      writeConfigAtomic(cfg);
      actions.push(`Cleaned legacy entries from openclaw.json`);
    }
  } catch {
    // best effort
  }

  return actions;
}

/**
 * Clean up stale openclaw-channel-dmwork directory that is not registered
 * in plugins.installs (orphaned from a failed previous install).
 *
 * Only removes the directory if ALL of these are true:
 * 1. The directory exists
 * 2. pluginsInspect returns null (openclaw doesn't recognize it)
 * 3. plugins.installs has no record for openclaw-channel-dmwork
 */
export function cleanupStalePluginDir(): string[] {
  const actions: string[] = [];
  const extensionsDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");
  const pluginDir = resolve(extensionsDir, "openclaw-channel-dmwork");

  if (!existsSync(pluginDir)) return actions;

  // Check if openclaw recognizes it
  const inspect = pluginsInspect("openclaw-channel-dmwork");
  if (inspect?.plugin) return actions; // recognized, don't touch

  // Check if it's in installs registry
  try {
    const cfg = readConfigFromFile();
    if (cfg?.plugins?.installs?.["openclaw-channel-dmwork"]) {
      return actions; // has install record, might just be inspect anomaly
    }
  } catch { /* proceed with cleanup */ }

  // All three conditions met: exists + not recognized + not in registry → stale
  try {
    rmSync(pluginDir, { recursive: true, force: true });
    actions.push(`Removed stale plugin directory: ${pluginDir}`);
  } catch {
    actions.push(`Warning: could not remove stale directory: ${pluginDir}`);
  }

  return actions;
}

/**
 * Clean up stale openclaw-install-stage directories that belong to DMWork.
 * Only removes directories that:
 * 1. Match .openclaw-install-stage-* pattern
 * 2. Are older than 10 minutes (not a current installation)
 * 3. Contain a package.json with name "openclaw-channel-dmwork"
 */
export function cleanupStaleStageDirectories(): string[] {
  const actions: string[] = [];
  const extensionsDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");

  try {
    const entries = readdirSync(extensionsDir);
    const now = Date.now();
    const TEN_MINUTES = 10 * 60 * 1000;

    for (const entry of entries) {
      if (!entry.startsWith(".openclaw-install-stage-")) continue;
      const stagePath = resolve(extensionsDir, entry);
      try {
        const stat = statSync(stagePath);
        if (!stat.isDirectory()) continue;
        if (now - stat.mtimeMs < TEN_MINUTES) continue; // too recent, skip

        // Check if it's DMWork's stage directory
        const pkgPath = resolve(stagePath, "package", "package.json");
        const altPkgPath = resolve(stagePath, "package.json");
        let isDmwork = false;
        for (const p of [pkgPath, altPkgPath]) {
          try {
            const pkg = JSON.parse(readFileSync(p, "utf-8"));
            if (pkg.name === "openclaw-channel-dmwork") {
              isDmwork = true;
              break;
            }
          } catch { /* try next */ }
        }

        if (!isDmwork) continue; // not ours, don't touch

        rmSync(stagePath, { recursive: true, force: true });
        actions.push(`Removed stale stage directory: ${entry}`);
      } catch { /* skip this entry */ }
    }
  } catch { /* best effort */ }

  return actions;
}

// ---------------------------------------------------------------------------
// Atomic config write
// ---------------------------------------------------------------------------

/**
 * Write openclaw.json atomically: write to .tmp then rename.
 * Prevents gateway watcher from reading half-written/truncated JSON.
 */
export function writeConfigAtomic(cfg: Record<string, any>): void {
  const configPath = getConfigFilePathSafe();
  const tmpPath = configPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), "utf-8");
  renameSync(tmpPath, configPath);
}

// ---------------------------------------------------------------------------
// Scenario detection
// ---------------------------------------------------------------------------

export type UpgradeScenario = "legacy" | "update" | "fresh" | "deadlock" | "broken";

export function detectScenario(): UpgradeScenario {
  const cfg = readConfigFromFile();
  const extDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");

  const hasLegacyDir = existsSync(resolve(extDir, "dmwork"));
  const hasLegacyEntries = Boolean(cfg?.plugins?.entries?.["dmwork"]);
  const hasLegacyInstalls = Boolean(cfg?.plugins?.installs?.["dmwork"]);
  const hasLegacy = hasLegacyDir || hasLegacyEntries || hasLegacyInstalls;

  const hasNewDir = existsSync(resolve(extDir, "openclaw-channel-dmwork"));
  const hasNewEntries = Boolean(cfg?.plugins?.entries?.["openclaw-channel-dmwork"]);
  const hasNewInstalls = Boolean(cfg?.plugins?.installs?.["openclaw-channel-dmwork"]);
  const inspectOk = Boolean(pluginsInspect("openclaw-channel-dmwork")?.plugin);
  const isHealthy = inspectOk || (hasNewDir && hasNewEntries && hasNewInstalls);
  const hasNewPartial = (hasNewDir || hasNewEntries || hasNewInstalls) && !isHealthy;

  const hasDmworkChannel = Boolean(cfg?.channels?.dmwork);

  if (hasLegacy) return "legacy";
  if (isHealthy) return "update";
  if (hasNewPartial) return "broken";
  if (hasDmworkChannel) return "deadlock";
  return "fresh";
}

export function isHealthyInstall(): boolean {
  const cfg = readConfigFromFile();
  const extDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");
  const hasNewDir = existsSync(resolve(extDir, "openclaw-channel-dmwork"));
  const hasNewEntries = Boolean(cfg?.plugins?.entries?.["openclaw-channel-dmwork"]);
  const hasNewInstalls = Boolean(cfg?.plugins?.installs?.["openclaw-channel-dmwork"]);
  const inspectOk = Boolean(pluginsInspect("openclaw-channel-dmwork")?.plugin);
  return inspectOk || (hasNewDir && hasNewEntries && hasNewInstalls);
}

export function ensurePluginsAllow(): void {
  try {
    const cfg = readConfigFromFile();
    if (!cfg?.plugins?.allow || !Array.isArray(cfg.plugins.allow)) return;
    if (cfg.plugins.allow.includes("openclaw-channel-dmwork")) return;
    cfg.plugins.allow.push("openclaw-channel-dmwork");
    writeConfigAtomic(cfg);
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// pluginsUpdateCompat
// ---------------------------------------------------------------------------

export function pluginsUpdateCompat(id: string, tag: string, quiet?: boolean): void {
  try {
    const result = runOpenclaw(["plugins", "update", id], {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
    if (!quiet && result) process.stdout.write(result);
  } catch (err) {
    // Only fallback to install when update is unsupported or plugin not installed.
    // Other errors (network, permissions, etc.) should propagate.
    if (isUnsupportedOptionError(err) || isPluginNotInstalledError(err)) {
      pluginsInstall(`${id}@${tag}`, quiet, true);
      return;
    }
    if (!quiet) {
      const stdout = (err as any)?.stdout?.toString?.();
      const stderr = (err as any)?.stderr?.toString?.();
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Legacy migration helpers
// ---------------------------------------------------------------------------

export function renameLegacyDir(): boolean {
  const extDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");
  const legacyDir = resolve(extDir, "dmwork");
  const backupDir = resolve(extDir, ".dmwork-backup");
  if (!existsSync(legacyDir)) return false;
  try {
    if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true });
    renameSync(legacyDir, backupDir);
    return true;
  } catch { return false; }
}

export function restoreLegacyDir(): void {
  const extDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");
  const legacyDir = resolve(extDir, "dmwork");
  const backupDir = resolve(extDir, ".dmwork-backup");
  if (!existsSync(backupDir)) return;
  try {
    if (existsSync(legacyDir)) rmSync(legacyDir, { recursive: true, force: true });
    renameSync(backupDir, legacyDir);
  } catch { /* best effort */ }
}

export function deleteLegacyBackup(): void {
  const extDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");
  const backupDir = resolve(extDir, ".dmwork-backup");
  if (existsSync(backupDir)) {
    try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export function removeLegacyFromConfig(): void {
  try {
    const cfg = readConfigFromFile();
    if (!cfg) return;
    if (cfg.plugins?.entries?.["dmwork"]) delete cfg.plugins.entries["dmwork"];
    if (cfg.plugins?.installs?.["dmwork"]) delete cfg.plugins.installs["dmwork"];
    if (Array.isArray(cfg.plugins?.allow)) {
      cfg.plugins.allow = cfg.plugins.allow.filter((id: string) => id !== "dmwork");
    }
    if (cfg.channels?.dmwork) delete cfg.channels.dmwork;
    writeConfigAtomic(cfg);
  } catch { /* best effort */ }
}

export function saveChannelConfigToDisk(): void {
  try {
    const backupPath = getConfigFilePathSafe().replace(/openclaw\.json$/, "channels-dmwork-backup.json");
    const cfg = readConfigFromFile();
    const dmwork = cfg?.channels?.dmwork;
    if (dmwork) {
      writeFileSync(backupPath, JSON.stringify(dmwork, null, 2), "utf-8");
    } else {
      // No channels.dmwork — remove stale backup to prevent wrong restore
      if (existsSync(backupPath)) rmSync(backupPath, { force: true });
    }
  } catch { /* best effort */ }
}

export function restoreChannelConfigFromDisk(): void {
  try {
    const backupPath = getConfigFilePathSafe().replace(/openclaw\.json$/, "channels-dmwork-backup.json");
    if (!existsSync(backupPath)) return;
    let dmwork = JSON.parse(readFileSync(backupPath, "utf-8"));

    // Migrate flat config → accounts.default
    if (dmwork.botToken && !dmwork.accounts) {
      dmwork = {
        ...dmwork,
        accounts: { default: { botToken: dmwork.botToken, apiUrl: dmwork.apiUrl } },
      };
      delete dmwork.botToken;
    }

    const cfg = readConfigFromFile();
    if (!cfg) return;
    if (!cfg.channels) cfg.channels = {};
    cfg.channels.dmwork = dmwork;
    writeConfigAtomic(cfg);
    rmSync(backupPath, { force: true });
  } catch { /* best effort */ }
}

export function cleanupBrokenInstall(): string[] {
  const actions: string[] = [];
  const cfg = readConfigFromFile();
  const extDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");
  const pluginDir = resolve(extDir, "openclaw-channel-dmwork");

  const hasDir = existsSync(pluginDir);
  const hasEntries = Boolean(cfg?.plugins?.entries?.["openclaw-channel-dmwork"]);
  const hasInstalls = Boolean(cfg?.plugins?.installs?.["openclaw-channel-dmwork"]);

  // Use same healthy definition as detectScenario(): inspect OK OR all 3 artifacts present
  const inspectOk = Boolean(pluginsInspect("openclaw-channel-dmwork")?.plugin);
  const isHealthy = inspectOk || (hasDir && hasEntries && hasInstalls);
  if (isHealthy) return actions; // Actually healthy, nothing to clean

  // Remove directory if it exists (orphan or partial)
  if (hasDir) {
    try {
      rmSync(pluginDir, { recursive: true, force: true });
      actions.push("Removed broken/orphan plugin directory");
    } catch { /* best effort */ }
  }

  // Remove stale config entries
  if (cfg && (hasEntries || hasInstalls)) {
    let changed = false;
    if (hasEntries) {
      delete cfg.plugins!.entries!["openclaw-channel-dmwork"];
      changed = true;
    }
    if (hasInstalls) {
      delete cfg.plugins!.installs!["openclaw-channel-dmwork"];
      changed = true;
    }
    if (changed) {
      writeConfigAtomic(cfg);
      actions.push("Cleaned stale config entries");
    }
  }

  return actions;
}
