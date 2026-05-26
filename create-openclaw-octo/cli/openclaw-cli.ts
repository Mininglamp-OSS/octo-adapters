/**
 * openclaw CLI wrapper.
 * All openclaw invocations go through this module using execFileSync with
 * argument arrays to avoid shell-quoting issues.
 */

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, readdirSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { CHANNEL_ID, PLUGIN_ID, NPM_PACKAGE_NAME, LEGACY_PLUGIN_ID, LEGACY_CHANNEL_ID, VERY_LEGACY_PLUGIN_ID } from "./constants.js";

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
        prefix = execFileSync(comspec, ["/d", "/v:off", "/c", "call", npmResolved, "config", "get", "prefix"], {
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
function escapeCmdArg(a: string): string {
  let s = a.replace(/%/g, "%%");
  if (/[&|<>^()"\s]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function escapeCmdArgs(args: string[]): string[] {
  return args.map(escapeCmdArg);
}

export function runCmd(command: string, args: string[], opts: Record<string, unknown> = {}): string {
  const resolved = resolveCommand(command);
  if (IS_WINDOWS && /\.cmd$/i.test(resolved)) {
    const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
    return execFileSync(comspec, ["/d", "/v:off", "/c", "call", resolved, ...escapeCmdArgs(args)], { encoding: "utf-8", ...opts } as any) as unknown as string;
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
    return execFileSync(comspec, ["/d", "/v:off", "/c", "call", OPENCLAW, ...escapeCmdArgs(args)], { encoding: "utf-8", ...opts } as any) as unknown as string;
  }
  return execFileSync(OPENCLAW, args, { encoding: "utf-8", ...opts } as any) as unknown as string;
}

/** Get the resolved openclaw binary path */
export function getOpenClawBin(): string {
  return OPENCLAW;
}

/** Execute openclaw command (exported for quickstart.ts etc.) */
export { runOpenclaw };

/** Normalize config path: expand ~ and resolve Windows relative paths */
function normalizeConfigPath(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p.startsWith("~\\")) return resolve(homedir(), p.slice(2));
  // Windows relative path like .\.openclaw\openclaw.json → resolve to home
  if (/^\.[\\/]\.openclaw[\\/]/.test(p)) return resolve(homedir(), p.slice(2));
  // Already absolute → use as-is
  if (resolve(p) === p) return p;
  // Other relative paths → resolve from home (safest assumption for config)
  return resolve(homedir(), p);
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
      // Plugin log: [plugins] ..., [octo] ...
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
  // Always pipe stdio: with `inherit`, Node doesn't attach the child's
  // stderr to the error object, so isUnknownCommandError() may fail to
  // detect "unknown command" on environments where the openclaw CLI
  // writes the message there. Pipe + manual replay matches the pattern
  // used by pluginsInstall.
  try {
    const result = runOpenclaw(args, {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
    if (result) process.stdout.write(result);
    return;
  } catch (err) {
    // 4.20 (and earlier) lacks `plugins uninstall`. Without a fallback the
    // legacy plugin's entries/installs/dir survive, detectScenario keeps
    // returning `rebrand` on every install run, and the user sees an endless
    // "Detected rebrand. Starting migration..." loop.
    if (!isUnknownCommandError(err)) {
      // Replay captured output for visibility, then propagate.
      const stdout = (err as any)?.stdout?.toString?.();
      const stderr = (err as any)?.stderr?.toString?.();
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      throw err;
    }
  }
  // 4.20 fallback: tear down config records + extension dir manually.
  try {
    const cfg = readConfigFromFile();
    let cfgChanged = false;
    if (cfg) {
      if (cfg.plugins?.entries?.[id]) {
        delete cfg.plugins.entries[id];
        cfgChanged = true;
      }
      if (cfg.plugins?.installs?.[id]) {
        delete cfg.plugins.installs[id];
        cfgChanged = true;
      }
      if (Array.isArray(cfg.plugins?.allow)) {
        const idx = cfg.plugins.allow.indexOf(id);
        if (idx >= 0) {
          cfg.plugins.allow.splice(idx, 1);
          cfgChanged = true;
        }
      }
      if (cfgChanged) writeConfigAtomic(cfg);
    }
    const extDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");
    const pluginDir = resolve(extDir, id);
    if (existsSync(pluginDir)) {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
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
// `openclaw plugins list --json` enumeration
// ---------------------------------------------------------------------------
//
// `plugins list --json` is OpenClaw's authoritative report of "which plugin
// ids the runtime currently knows about". Compared to the older signal
// combination (cfg.plugins.entries + cfg.plugins.installs + extensions
// directory + per-id `plugins inspect`):
//
//   - `cfg.plugins.installs` has been observed null on current OpenClaw
//     schemas — install metadata moved into `plugins inspect <id>`.
//   - `extensions/<id>` directory probe misses npm-installed plugins
//     (npm-layout legacy plugins live under `npm/node_modules/<id>`).
//   - `plugins inspect <id>` requires a known id, can't enumerate.
//
// `plugins list --json` returns each registered id with its rootDir
// resolved by OpenClaw itself, so it covers both layouts uniformly and
// is independent of any client-side path assumption (including custom
// OPENCLAW_HOME on Windows / Linux).
//
// Old OpenClaw runtimes that don't recognise `plugins list --json` still
// exist; in that case `listLoadedPlugins()` reports `supported: false`
// and callers fall back to cfg.plugins.entries.
// ---------------------------------------------------------------------------

export interface PluginListEntry {
  id: string;
  status: string;
  enabled: boolean;
  source: string | null;
  origin: string | null;
  rootDir: string | null;
}

export interface PluginListResult {
  /** True if OpenClaw produced parseable `plugins list --json` output. */
  supported: boolean;
  plugins: PluginListEntry[];
}

export function listLoadedPlugins(): PluginListResult {
  let raw: string;
  try {
    raw = runOpenclaw(["plugins", "list", "--json"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return { supported: false, plugins: [] };
  }
  const cleaned = stripStdoutNoise(raw);
  const jsonStart = cleaned.indexOf("{");
  if (jsonStart < 0) return { supported: false, plugins: [] };
  let data: any;
  try {
    data = JSON.parse(cleaned.slice(jsonStart));
  } catch {
    return { supported: false, plugins: [] };
  }
  if (!Array.isArray(data?.plugins)) {
    return { supported: false, plugins: [] };
  }
  const plugins: PluginListEntry[] = data.plugins
    .map((p: any) => ({
      id: typeof p?.id === "string" ? p.id : "",
      status: typeof p?.status === "string" ? p.status : "",
      enabled: Boolean(p?.enabled),
      source: typeof p?.source === "string" ? p.source : null,
      origin: typeof p?.origin === "string" ? p.origin : null,
      rootDir: typeof p?.rootDir === "string" ? p.rootDir : null,
    }))
    .filter((p: PluginListEntry) => p.id.length > 0);
  return { supported: true, plugins };
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
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return null;
    }
    console.error(`Failed to execute openclaw --version: ${err?.message ?? err}`);
    return null;
  }
}

export function getOpenClawVersionStrict(): string | null {
  try {
    const out = runOpenclaw(["--version"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const match = out.match(/(\d{4}\.\d+\.\d+)/);
    return match?.[1] ?? null;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed to execute openclaw: ${err?.message ?? err}`);
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
 * Save the channels.<channelId> section from openclaw.json by reading the file
 * directly (preserving secrets that `openclaw config get` would redact).
 *
 * @param channelId Defaults to current channel ({@link CHANNEL_ID}).
 */
export function saveChannelConfigFromFile(channelId: string = CHANNEL_ID): Record<string, unknown> | null {
  try {
    const configPath = getConfigFilePathSafe();
    const raw = readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw);
    return cfg?.channels?.[channelId] ?? null;
  } catch {
    return null;
  }
}

/**
 * Restore the channels.<channelId> section into openclaw.json by writing the file
 * directly (bypassing validation that would reject unknown channel ids).
 * Creates a .bak backup before writing.
 *
 * @param channelConfig Channel sub-config object to write.
 * @param channelId    Defaults to current channel ({@link CHANNEL_ID}).
 */
export function restoreChannelConfigToFile(
  channelConfig: Record<string, unknown>,
  channelId: string = CHANNEL_ID,
): void {
  const configPath = getConfigFilePathSafe();
  // Backup
  copyFileSync(configPath, configPath + ".bak");
  // Read, merge, write
  const raw = readFileSync(configPath, "utf-8");
  const cfg = JSON.parse(raw);
  if (!cfg.channels) cfg.channels = {};
  cfg.channels[channelId] = channelConfig;
  writeConfigAtomic(cfg);
}

/**
 * Remove channels.<channelId> directly from the JSON file.
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
    return normalizeConfigPath(getConfigFilePath());
  } catch {
    return resolve(homedir(), ".openclaw", "openclaw.json");
  }
}

export function removeChannelConfigFromFile(channelId: string = CHANNEL_ID): void {
  try {
    const configPath = getConfigFilePathSafe();
    copyFileSync(configPath, configPath + ".bak");
    const cfg = readConfigFromFile();
    if (cfg?.channels?.[channelId]) {
      delete cfg.channels[channelId];
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
 * Remove orphaned bindings (matching the given channel) from the config file.
 * If validAccountIds is provided, only removes bindings referencing accounts
 * not in that list. Otherwise removes all bindings for that channel.
 *
 * Caller passes the channel id explicitly (CHANNEL_ID for current octo,
 * LEGACY_CHANNEL_ID for legacy dmwork cleanup in Phase B).
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
      if (b.match?.channel !== channel) return true; // keep bindings on other channels
      if (!validAccountIds) return false; // remove every binding on this channel
      // Keep only if accountId is in valid list (or no accountId specified)
      return !b.match.accountId || validAccountIds.includes(b.match.accountId);
    });
    writeConfigAtomic(cfg);
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Legacy plugin cleanup (very-legacy: plugin id = "dmwork", predecessor of
// openclaw-channel-dmwork and openclaw-channel-octo)
// ---------------------------------------------------------------------------

// LEGACY-COMPAT: kept the local name `VERY_LEGACY_ID` (was `LEGACY_PLUGIN_ID`)
// to avoid colliding with the imported `LEGACY_PLUGIN_ID` (= openclaw-channel-dmwork).
// The very-legacy plugin id is "dmwork" (predecessor of openclaw-channel-dmwork).

/**
 * Detect and clean up legacy installations (very-legacy "dmwork" plugin id) that conflict
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
    VERY_LEGACY_PLUGIN_ID,
  );

  if (existsSync(legacyDir)) {
    // Try to uninstall via openclaw CLI first (removes entries/installs/allow)
    try {
      runOpenclaw(["plugins", "uninstall", VERY_LEGACY_PLUGIN_ID, "--force", "--keep-files"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      actions.push(`Unregistered legacy plugin "${VERY_LEGACY_PLUGIN_ID}"`);
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
    if (cfg?.plugins?.entries?.[VERY_LEGACY_PLUGIN_ID]) {
      const configPath = getConfigFilePathSafe();
      copyFileSync(configPath, configPath + ".bak");
      delete cfg.plugins.entries[VERY_LEGACY_PLUGIN_ID];
      // Also clean installs and allow
      if (cfg.plugins?.installs?.[VERY_LEGACY_PLUGIN_ID]) {
        delete cfg.plugins.installs[VERY_LEGACY_PLUGIN_ID];
      }
      if (Array.isArray(cfg.plugins?.allow)) {
        cfg.plugins.allow = cfg.plugins.allow.filter((id: string) => id !== VERY_LEGACY_PLUGIN_ID);
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
  const pluginDir = resolve(extensionsDir, PLUGIN_ID);

  if (!existsSync(pluginDir)) return actions;

  // Check if openclaw recognizes it
  const inspect = pluginsInspect(PLUGIN_ID);
  if (inspect?.plugin) return actions; // recognized, don't touch

  // Check if it's in installs registry
  try {
    const cfg = readConfigFromFile();
    if (cfg?.plugins?.installs?.[PLUGIN_ID]) {
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
 * Clean up stale openclaw-install-stage directories that belong to Octo.
 * Only removes directories that:
 * 1. Match .openclaw-install-stage-* pattern
 * 2. Are older than 10 minutes (not a current installation)
 * 3. Contain a package.json with name PLUGIN_ID
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

        // Check if it's Octo's stage directory
        const pkgPath = resolve(stagePath, "package", "package.json");
        const altPkgPath = resolve(stagePath, "package.json");
        let isDmwork = false;
        for (const p of [pkgPath, altPkgPath]) {
          try {
            const pkg = JSON.parse(readFileSync(p, "utf-8"));
            // Match either the npm package name or the ClawHub plugin id —
            // staged dirs may use either depending on install source
            // (P2, PR #37 review: PLUGIN_ID semantic shift made the previous
            // single-comparison check dead code for staged npm installs).
            if (pkg.name === NPM_PACKAGE_NAME || pkg.name === PLUGIN_ID) {
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

export type UpgradeScenario =
  | "legacy-to-octo"  // Phase B: very-legacy plugin id "dmwork" present
  | "rebrand"         // Phase B: openclaw-channel-dmwork or channels.dmwork residue
  | "legacy"          // Deprecated alias for legacy-to-octo (kept for backward compat)
  | "legacy-warn"     // Deprecated alias for rebrand (kept for tests / backward compat)
  | "update"          // octo healthy installed
  | "fresh"           // nothing relevant present
  | "deadlock"        // channels.octo exists but plugin missing
  | "broken";         // octo partial install

export function detectScenario(): UpgradeScenario {
  const cfg = readConfigFromFile();
  const extDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");

  // Priority 1: very-legacy plugin id "dmwork" (predates openclaw-channel-dmwork).
  // Phase B routes to runLegacyToOctoMigration().
  if (hasVeryLegacyPluginArtifacts(cfg)) return "legacy-to-octo";

  // Priority 2: openclaw-channel-dmwork OR channels.dmwork OR bindings(channel=dmwork).
  // Triggers even when octo is also present — handles half-completed migrations
  // (e.g., crashed after channels.octo but before bindings rewrite).
  // Phase B routes to runRebrandMigration().
  if (hasLegacyPluginArtifacts(cfg)) return "rebrand";

  // Current octo plugin presence
  const hasNewDir = existsSync(resolve(extDir, PLUGIN_ID));
  const hasNewEntries = Boolean(cfg?.plugins?.entries?.[PLUGIN_ID]);
  const hasNewInstalls = Boolean(cfg?.plugins?.installs?.[PLUGIN_ID]);
  const inspectOk = Boolean(pluginsInspect(PLUGIN_ID)?.plugin);
  const isHealthy = inspectOk || (hasNewDir && hasNewEntries && hasNewInstalls);
  const hasNewPartial = (hasNewDir || hasNewEntries || hasNewInstalls) && !isHealthy;

  if (isHealthy) return "update";
  if (hasNewPartial) return "broken";

  // Priority: channels.octo without plugin → deadlock (config exists but no plugin)
  if (cfg?.channels?.[CHANNEL_ID]) return "deadlock";

  return "fresh";
}

export function isHealthyInstall(pluginId: string = PLUGIN_ID): boolean {
  const inspectOk = Boolean(pluginsInspect(pluginId)?.plugin);
  if (inspectOk) return true;
  // Fallback for OpenClaw runtimes without `plugins inspect`. Kept aligned
  // with the 3-artifact healthy definition used by detectScenario() and
  // cleanupBrokenInstall() so the pre-flight, install-time, and cleanup
  // paths agree on what counts as healthy. The `cfg.plugins.installs[id]`
  // term has been observed null on current OpenClaw schemas (install
  // metadata moved into `plugins inspect <id>`), but the inspect short-
  // circuit above already covers those runtimes — so the apparent
  // dead-code on modern OpenClaw is the cost of staying consistent with
  // the other classifiers. Tightening that across all classifiers in one
  // shot is tracked as a follow-up to #82 ("3-artifact → 2-artifact" move
  // requires updating detectScenario / cleanupBrokenInstall / etc.).
  // Note: this fallback is still extensions-layout only — npm-installed
  // legacy plugins (LEGACY_PLUGIN_ID, NPM_PACKAGE_NAME) will return false
  // here. detectInstallState catches that via listLoadedPlugins() +
  // cfg.plugins.entries instead, so isHealthyInstall remains the source
  // of truth only for ClawHub/extensions-layout ids.
  const cfg = readConfigFromFile();
  const extDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");
  const hasDir = existsSync(resolve(extDir, pluginId));
  const hasEntries = Boolean(cfg?.plugins?.entries?.[pluginId]);
  const hasInstalls = Boolean(cfg?.plugins?.installs?.[pluginId]);
  return hasDir && hasEntries && hasInstalls;
}

// ---------------------------------------------------------------------------
// Plan A: install state + OpenClaw state detection (PR3)
// ---------------------------------------------------------------------------

/**
 * Aggregated install state across the three known plugin ids:
 *   - PLUGIN_ID            ("octo")              — current ClawHub install
 *   - NPM_PACKAGE_NAME     ("openclaw-channel-octo") — legacy npm 1.0.0 install
 *   - VERY_LEGACY_PLUGIN_ID ("dmwork")           — legacy dmwork 0.6.x install
 *
 * `octo-clawhub` additionally carries `npmResidue` indicating whether the
 * deprecated `~/.openclaw/npm/node_modules/openclaw-channel-octo` directory
 * is still present alongside a healthy ClawHub install (a partial-cleanup
 * state we surface as a warn but don't block on).
 */
export type InstallState =
  | {
      kind: "octo-clawhub";
      version: string | null;
      npmResidue: boolean;
      legacyNpmActive: boolean;
      legacyDmworkResidue: boolean;
    }
  | { kind: "octo-npm-legacy"; version: string | null }
  | { kind: "dmwork-legacy"; version: string | null }
  | { kind: "broken"; details: string }
  | { kind: "none" };

const LEGACY_NPM_RESIDUE_DIR = "npm/node_modules/openclaw-channel-octo";

function hasLegacyNpmResidue(): boolean {
  // Derive the OpenClaw root from the live config-file path so users with
  // a non-default install root (custom OPENCLAW_HOME, npm --prefix, Windows
  // custom layout, etc.) are covered. Cosmetic-only signal — drives the
  // residue warn line but never the block decision.
  const root = getConfigFilePathSafe().replace(/openclaw\.json$/, "");
  return existsSync(resolve(root, LEGACY_NPM_RESIDUE_DIR));
}

/**
 * Whether a legacy plugin id is still registered with OpenClaw. Two signals
 * in priority order:
 *
 *   1. `plugins list --json` (preferred, when supported by the runtime) —
 *      OpenClaw's own report of "which plugin ids I'm trying to load".
 *      Independent of cfg schema and client-side path assumptions.
 *   2. `cfg.plugins.entries[id]` (fallback) — for older OpenClaw versions
 *      that don't support `plugins list --json`. cfg.plugins.installs is
 *      not used because it has been observed null on current schemas.
 *
 * Used by `detectInstallState` to detect dual-active states (ClawHub octo
 * healthy AND a legacy id still registered) — both register channel "octo"
 * (or, for dmwork-era ids, the dmwork channel), so any subsequent config
 * write would land in a duplicated/half-migrated state.
 */
function isPluginRegistered(
  id: string,
  list: PluginListResult,
  cfg: Record<string, any> | null,
): boolean {
  if (list.supported) {
    return list.plugins.some((p) => p.id === id);
  }
  return Boolean(cfg?.plugins?.entries?.[id]);
}

export function detectInstallState(): InstallState {
  const list = listLoadedPlugins();
  const cfg = readConfigFromFile();

  // Priority order: ClawHub (target) → npm-legacy → dmwork-legacy → broken → none
  if (isHealthyInstall(PLUGIN_ID)) {
    const state = resolvePluginState(PLUGIN_ID);
    return {
      kind: "octo-clawhub",
      version: state.version,
      npmResidue: hasLegacyNpmResidue(),
      legacyNpmActive: isPluginRegistered(NPM_PACKAGE_NAME, list, cfg),
      // Mirror install.ts detectScenario priority: very-legacy `dmwork`
      // artefacts (highest priority → `legacy-to-octo` migration) AND
      // intermediate `openclaw-channel-dmwork` rebrand artefacts (next
      // priority → `rebrand` migration) both require install to finish
      // the migration even when octo is otherwise healthy. Block the
      // pre-flight in either state so the user is prompted to run install
      // before bind/quickstart/remove-account write fresh channels.octo
      // data over an unfinished migration.
      legacyDmworkResidue:
        hasVeryLegacyPluginArtifacts(cfg) ||
        hasLegacyPluginArtifacts(cfg) ||
        isPluginRegistered(VERY_LEGACY_PLUGIN_ID, list, cfg) ||
        isPluginRegistered(LEGACY_PLUGIN_ID, list, cfg),
    };
  }
  if (isHealthyInstall(NPM_PACKAGE_NAME)) {
    return {
      kind: "octo-npm-legacy",
      version: resolvePluginState(NPM_PACKAGE_NAME).version,
    };
  }
  // Belt-and-suspenders for the npm 1.0.0 case. Two paths classify the
  // install as octo-npm-legacy:
  //   (a) `plugins list --json` reports the id (modern OpenClaw) — the
  //       runtime registry is authoritative; no extra disk probe needed.
  //   (b) cfg.plugins.entries[id] AND the npm-layout install directory
  //       exists (old OpenClaw without `plugins list --json`). Both
  //       artefacts are required: a stale entry with no dir on disk is
  //       residue (broken classifier territory), not an active install.
  // We don't gate on cfg.plugins.installs[id] because that field has
  // been observed null on current OpenClaw schemas.
  const npmLegacyActiveViaList =
    list.supported && list.plugins.some((p) => p.id === NPM_PACKAGE_NAME);
  const npmLegacyActiveViaCfgFallback =
    !list.supported &&
    Boolean(cfg?.plugins?.entries?.[NPM_PACKAGE_NAME]) &&
    hasLegacyNpmResidue();
  if (npmLegacyActiveViaList || npmLegacyActiveViaCfgFallback) {
    return {
      kind: "octo-npm-legacy",
      version: cfg?.plugins?.installs?.[NPM_PACKAGE_NAME]?.version ?? null,
    };
  }
  // Dmwork-era: check BOTH the intermediate id (LEGACY_PLUGIN_ID =
  // "openclaw-channel-dmwork") AND the very-legacy id (VERY_LEGACY_PLUGIN_ID
  // = "dmwork"). Use the unified `isPluginRegistered` so npm-installed
  // dmwork (which lives under `npm/node_modules/<id>`, not `extensions/<id>`)
  // is also caught — `plugins list --json` reports it directly, and the
  // cfg.entries fallback also covers it without relying on the
  // extensions-only directory probe in isHealthyInstall.
  if (
    isHealthyInstall(LEGACY_PLUGIN_ID) ||
    isPluginRegistered(LEGACY_PLUGIN_ID, list, cfg)
  ) {
    return {
      kind: "dmwork-legacy",
      version:
        resolvePluginState(LEGACY_PLUGIN_ID).version ??
        cfg?.plugins?.installs?.[LEGACY_PLUGIN_ID]?.version ??
        null,
    };
  }
  if (
    isHealthyInstall(VERY_LEGACY_PLUGIN_ID) ||
    isPluginRegistered(VERY_LEGACY_PLUGIN_ID, list, cfg)
  ) {
    return {
      kind: "dmwork-legacy",
      version:
        resolvePluginState(VERY_LEGACY_PLUGIN_ID).version ??
        cfg?.plugins?.installs?.[VERY_LEGACY_PLUGIN_ID]?.version ??
        null,
    };
  }

  // None of the three plugin ids are healthy or registered. Surface "broken"
  // only when there are leftover config entries pointing to one of them —
  // otherwise it's a clean "not installed" state.
  const entries = cfg?.plugins?.entries ?? {};
  const installs = cfg?.plugins?.installs ?? {};
  const knownIds = [PLUGIN_ID, NPM_PACKAGE_NAME, LEGACY_PLUGIN_ID, VERY_LEGACY_PLUGIN_ID];
  const leftovers = knownIds.filter((id) => entries[id] || installs[id]);
  if (leftovers.length > 0) {
    return {
      kind: "broken",
      details: `config references ${leftovers.join(", ")} but install is unhealthy`,
    };
  }
  return { kind: "none" };
}

/**
 * OpenClaw runtime version state.
 *
 *   block — `openclaw` not on PATH OR version < OPENCLAW_PEER_MIN
 *   warn  — version is below recommended (still works but missing fixes)
 *   ok    — version meets the recommended floor
 */
export type OpenClawState =
  | { kind: "ok"; version: string }
  | { kind: "warn"; version: string; reason: string }
  | { kind: "block"; version: string | null; reason: string };

/**
 * Lower bound from package.json peerDependency. Below this the plugin
 * literally cannot register — block.
 */
export const OPENCLAW_PEER_MIN = "2026.4.15";

/**
 * Recommended floor — version we test against, includes runtime fixes for
 * issue #56 race conditions etc. Below this we warn but allow.
 */
export const OPENCLAW_RECOMMENDED = "2026.5.18";

/**
 * Compare two YYYY.M.PATCH-style versions per integer-segment ordering.
 *
 * NOT semver-compatible by design: OpenClaw's version scheme is date-based
 * (`2026.4.15` is year.month.patch, not major.minor.patch in the SemVer
 * sense), and a SemVer parser would mis-order things like `2026.10.0` vs
 * `2026.9.0` (where `10 > 9` numerically but SemVer compares chunks
 * differently with prereleases). Plain integer-by-segment is correct here.
 *
 * Returns -1 / 0 / 1.
 */
export function compareOpenClawVersion(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

export function detectOpenClawState(): OpenClawState {
  const v = getOpenClawVersion();
  if (!v) {
    return {
      kind: "block",
      version: null,
      reason: "OpenClaw is not installed or not on PATH",
    };
  }
  if (compareOpenClawVersion(v, OPENCLAW_PEER_MIN) < 0) {
    return {
      kind: "block",
      version: v,
      reason: `OpenClaw ${v} is too old (need >= ${OPENCLAW_PEER_MIN})`,
    };
  }
  if (compareOpenClawVersion(v, OPENCLAW_RECOMMENDED) < 0) {
    return {
      kind: "warn",
      version: v,
      reason: `OpenClaw ${v} is older than recommended ${OPENCLAW_RECOMMENDED}`,
    };
  }
  return { kind: "ok", version: v };
}

/**
 * Ensure `plugins.allow` exists and contains `pluginId`.
 *
 * On OpenClaw 4.20 the default config has no `plugins.allow` field at all —
 * gateway falls back to "auto-load anything in extensions/" but logs a
 * hardening warning every restart. We create the array if missing so the
 * recommendation is satisfied for users we migrate.
 *
 * Idempotent: returns silently if the plugin is already in allow.
 */
export function ensurePluginsAllow(pluginId: string = PLUGIN_ID): void {
  try {
    const cfg = readConfigFromFile();
    if (!cfg) return;
    cfg.plugins ??= {};
    if (!Array.isArray(cfg.plugins.allow)) cfg.plugins.allow = [];
    if (cfg.plugins.allow.includes(pluginId)) return;
    cfg.plugins.allow.push(pluginId);
    writeConfigAtomic(cfg);
  } catch { /* best effort */ }
}

/**
 * Ensure plugins.entries.<pluginId>.enabled === true.
 *
 * Why: OpenClaw 4.x → 5.x major upgrades have been observed to reset
 * `plugins.entries.<id>.enabled` for third-party plugins, leaving the
 * plugin installed but inactive. install calls this to self-heal so users
 * don't have to manually run `openclaw plugins enable ...`.
 *
 * (doctor surfaces the same issue but uses its own `openclaw config set` path
 * via --fix, so it does not call this helper directly.)
 *
 * Idempotent and best-effort: returns true if entry is now (or was already)
 * enabled, false on any I/O error.
 */
export function ensurePluginEnabled(pluginId: string = PLUGIN_ID): boolean {
  try {
    const cfg = readConfigFromFile();
    if (!cfg) return false;
    const plugins = (cfg.plugins ??= {});
    const entries = (plugins.entries ??= {});
    const entry = (entries[pluginId] ??= {});
    if (entry.enabled === true) return true;
    entry.enabled = true;
    writeConfigAtomic(cfg);
    return true;
  } catch {
    return false;
  }
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
  // LEGACY-MIGRATION: backup folder for the very-legacy "dmwork" plugin install.
  // Used only by Phase B's legacy-to-octo migration path (dead code in Phase A).
  const extDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");
  const backupDir = resolve(extDir, ".dmwork-backup");
  if (existsSync(backupDir)) {
    try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// LEGACY-MIGRATION: removes the very-legacy "dmwork" plugin id and its
// channels.dmwork residue from openclaw.json. Used by Phase B legacy-to-octo;
// Phase A install never calls this (legacy-warn scenario only logs a warning).
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

// LEGACY-MIGRATION: persists channels.dmwork to a sidecar backup so the
// legacy migration can restore it after re-installing under the new plugin id.
// Phase A install never calls this; reserved for Phase B.
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

// LEGACY-MIGRATION: restores channels.dmwork from the sidecar backup.
// Phase A install never calls this; reserved for Phase B.
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

export function cleanupBrokenInstall(pluginId: string = PLUGIN_ID): string[] {
  const actions: string[] = [];
  const cfg = readConfigFromFile();
  const extDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");
  const pluginDir = resolve(extDir, pluginId);

  const hasDir = existsSync(pluginDir);
  const hasEntries = Boolean(cfg?.plugins?.entries?.[pluginId]);
  const hasInstalls = Boolean(cfg?.plugins?.installs?.[pluginId]);

  // Use same healthy definition as detectScenario(): inspect OK OR all 3 artifacts present
  const inspectOk = Boolean(pluginsInspect(pluginId)?.plugin);
  const isHealthy = inspectOk || (hasDir && hasEntries && hasInstalls);
  if (isHealthy) return actions; // Actually healthy, nothing to clean

  // Remove directory if it exists (orphan or partial)
  if (hasDir) {
    try {
      rmSync(pluginDir, { recursive: true, force: true });
      actions.push(`Removed broken/orphan plugin directory (${pluginId})`);
    } catch { /* best effort */ }
  }

  // Remove stale config entries
  if (cfg && (hasEntries || hasInstalls)) {
    let changed = false;
    if (hasEntries) {
      delete cfg.plugins!.entries![pluginId];
      changed = true;
    }
    if (hasInstalls) {
      delete cfg.plugins!.installs![pluginId];
      changed = true;
    }
    if (changed) {
      writeConfigAtomic(cfg);
      actions.push(`Cleaned stale config entries (${pluginId})`);
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Phase B: command-style plugin lifecycle with 4.20 fallback
//
// rebrand / legacy-to-octo migration prefers the explicit `openclaw plugins
// disable|enable|uninstall` commands so OpenClaw's own state machine handles
// each transition. Older OpenClaw versions (4.20 era) lack these subcommands;
// we fall back to direct config edits.
// ---------------------------------------------------------------------------

function isUnknownCommandError(err: unknown): boolean {
  const sources = [
    (err as any)?.stderr?.toString?.(),
    (err as any)?.stdout?.toString?.(),
    (err as any)?.message,
    String(err),
  ];
  return sources.some(
    (s) => s && /unknown command|unrecognized command|invalid command/i.test(s),
  );
}

/**
 * Disable a plugin via `openclaw plugins disable <id>` with a 4.20 fallback
 * to setting `plugins.entries.<id>.enabled = false` directly.
 *
 * Idempotent: returns silently if the plugin is already disabled or not present.
 */
export function pluginsDisable(id: string): void {
  try {
    runOpenclaw(["plugins", "disable", id], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return;
  } catch (err) {
    if (!isUnknownCommandError(err)) {
      // Plugin may already be disabled or not installed — both are OK
      if (isPluginNotInstalledError(err)) return;
      throw err;
    }
  }
  // 4.20 fallback: edit cfg directly
  try {
    const cfg = readConfigFromFile();
    if (!cfg) return;
    const entry = cfg.plugins?.entries?.[id];
    if (!entry) return;
    if (entry.enabled === false) return;
    entry.enabled = false;
    writeConfigAtomic(cfg);
  } catch { /* best effort */ }
}

/**
 * Enable a plugin via `openclaw plugins enable <id>` with a 4.20 fallback
 * to setting `plugins.entries.<id>.enabled = true` directly.
 *
 * Distinct from {@link ensurePluginEnabled} which is the post-install self-heal
 * for 4.x→5.x upgrade-induced resets. This helper is used by migration paths
 * that explicitly toggle plugin state.
 */
export function pluginsEnable(id: string): void {
  try {
    runOpenclaw(["plugins", "enable", id], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return;
  } catch (err) {
    if (!isUnknownCommandError(err)) {
      if (isPluginNotInstalledError(err)) return;
      throw err;
    }
  }
  // 4.20 fallback
  ensurePluginEnabled(id);
}

/**
 * Snapshot a plugin's install state for rollback.
 * `installed` is the OR-set across pluginsInspect, plugins.entries,
 * plugins.installs, plugins.allow — matches the broadest possible signal so
 * rollback knows whether to re-enable, re-add to allow, or simply do nothing.
 */
export interface PluginSnapshot {
  id: string;
  installed: boolean;
  enabled: boolean | null;
  version: string | null;
  installPath: string | null;
  inAllow: boolean;
}

export function capturePluginState(id: string): PluginSnapshot {
  const state = resolvePluginState(id);
  const cfg = readConfigFromFile();
  const inAllow = Array.isArray(cfg?.plugins?.allow)
    ? cfg!.plugins!.allow.includes(id)
    : false;

  // Broaden installed beyond resolvePluginState's strict criteria — for rollback
  // we want to capture even partial residue so re-enable can put things back.
  const hasEntry = Boolean(cfg?.plugins?.entries?.[id]);
  const hasInstall = Boolean(cfg?.plugins?.installs?.[id]);
  const broadInstalled = state.installed || hasEntry || hasInstall || inAllow;

  return {
    id,
    installed: broadInstalled,
    enabled: state.enabled ?? (cfg?.plugins?.entries?.[id]?.enabled ?? null),
    version: state.version,
    installPath: state.installPath,
    inAllow,
  };
}

// ---------------------------------------------------------------------------
// Phase B: bindings save/restore with channel rewrite + dedupe
// ---------------------------------------------------------------------------

/**
 * Read all bindings on a given channel from the config file.
 * Returns a fresh array snapshot (not a reference into cfg).
 */
export function saveBindingsFromFile(channelId: string): any[] {
  const cfg = readConfigFromFile();
  if (!Array.isArray(cfg?.bindings)) return [];
  return cfg.bindings
    .filter((b: any) => b?.match?.channel === channelId)
    .map((b: any) => structuredClone(b));
}

/**
 * Drop all bindings on a given channel from the config file.
 * Idempotent. Creates a .bak before writing.
 */
export function removeBindingsFromFile(channelId: string): void {
  try {
    const configPath = getConfigFilePathSafe();
    copyFileSync(configPath, configPath + ".bak");
    const cfg = readConfigFromFile();
    if (!Array.isArray(cfg?.bindings)) return;
    const before = cfg.bindings.length;
    cfg.bindings = cfg.bindings.filter((b: any) => b?.match?.channel !== channelId);
    if (cfg.bindings.length !== before) {
      writeConfigAtomic(cfg);
    }
  } catch { /* best effort */ }
}

/**
 * Append the saved bindings back to cfg.bindings, rewriting `match.channel`
 * from `fromCh` to `toCh`. Dedupes by (agentId, accountId) — if cfg already has
 * a binding with the same key, the saved one is dropped (existing wins).
 *
 * Returns the count of bindings actually appended (after dedupe).
 */
export function restoreBindingsToFile(
  saved: any[],
  fromCh: string,
  toCh: string,
): number {
  if (!saved.length) return 0;
  const cfg = readConfigFromFile();
  if (!cfg) return 0;
  if (!Array.isArray(cfg.bindings)) cfg.bindings = [];

  // Bindings shape: agentId is top-level; match holds {channel, accountId}.
  const keyOf = (b: any) =>
    `${b?.agentId ?? ""}:${b?.match?.accountId ?? ""}`;
  const existingKeys = new Set<string>(
    cfg.bindings
      .filter((b: any) => b?.match?.channel === toCh)
      .map(keyOf),
  );

  let appended = 0;
  for (const b of saved) {
    if (b?.match?.channel !== fromCh) continue; // safety
    const rewritten = structuredClone(b);
    rewritten.match.channel = toCh;
    if (existingKeys.has(keyOf(rewritten))) continue;
    cfg.bindings.push(rewritten);
    existingKeys.add(keyOf(rewritten));
    appended++;
  }

  if (appended > 0) {
    const configPath = getConfigFilePathSafe();
    copyFileSync(configPath, configPath + ".bak");
    writeConfigAtomic(cfg);
  }
  return appended;
}

// ---------------------------------------------------------------------------
// Phase B: workspace dir migration
//
// Move ~/.openclaw/workspace/<fromChannel>/ → ~/.openclaw/workspace/<toChannel>/.
// Best-effort: called as a post-step after install verification succeeds.
// Failure here only means the user loses cached workspace artifacts
// (regenerable), not bot config.
// ---------------------------------------------------------------------------

/**
 * Outcome of a workspace migration attempt. The caller logs distinct messages
 * per case so users aren't told "migrated" when nothing actually moved.
 */
export type WorkspaceMigrateOutcome =
  | "renamed"                    // src existed, moved successfully
  | "skipped-no-source"          // src didn't exist (e.g. 4.20 doesn't use channel subdirs)
  | "skipped-destination-exists" // both src and dst exist; left intact for manual merge
  | "failed";                    // rename threw

export function migrateWorkspaceDir(
  fromChannel: string,
  toChannel: string,
): WorkspaceMigrateOutcome {
  const wsRoot = getConfigFilePathSafe().replace(/openclaw\.json$/, "workspace");
  const fromDir = resolve(wsRoot, fromChannel);
  const toDir = resolve(wsRoot, toChannel);

  if (!existsSync(fromDir)) return "skipped-no-source";
  if (existsSync(toDir)) {
    // Destination already populated (e.g. by a fresh octo install or a prior
    // partial migration). Leave both intact; the caller surfaces a warning so
    // the user can manually inspect / merge.
    return "skipped-destination-exists";
  }

  try {
    // wsRoot necessarily exists when fromDir does (it's a parent), so no
    // mkdirSync needed before rename.
    renameSync(fromDir, toDir);
    return "renamed";
  } catch {
    return "failed";
  }
}

/**
 * Remove ~/.openclaw/workspace/<channelId>/ if it's empty.
 * Used after a successful migration to tidy up the legacy workspace root.
 */
export function cleanupStaleWorkspaceIfEmpty(channelId: string): void {
  const wsRoot = getConfigFilePathSafe().replace(/openclaw\.json$/, "workspace");
  const dir = resolve(wsRoot, channelId);
  if (!existsSync(dir)) return;
  try {
    const entries = readdirSync(dir);
    if (entries.length === 0) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Phase B: legacy artifact predicates
// ---------------------------------------------------------------------------

/**
 * True if the very-legacy plugin id "dmwork" has any presence —
 * extension dir, plugins.entries, plugins.installs, or plugins.allow.
 *
 * Predates `openclaw-channel-dmwork`. Detection takes priority over rebrand.
 */
export function hasVeryLegacyPluginArtifacts(cfg: Record<string, any> | null): boolean {
  const extDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");
  const hasDir = existsSync(resolve(extDir, VERY_LEGACY_PLUGIN_ID));
  const hasEntry = Boolean(cfg?.plugins?.entries?.[VERY_LEGACY_PLUGIN_ID]);
  const hasInstall = Boolean(cfg?.plugins?.installs?.[VERY_LEGACY_PLUGIN_ID]);
  const inAllow = Array.isArray(cfg?.plugins?.allow) &&
    cfg.plugins.allow.includes(VERY_LEGACY_PLUGIN_ID);
  return hasDir || hasEntry || hasInstall || inAllow;
}

/**
 * True if the intermediate plugin id "openclaw-channel-dmwork" has any
 * presence — covers full installs as well as residual config-only state.
 *
 * Triggers the rebrand migration path.
 */
export function hasLegacyPluginArtifacts(cfg: Record<string, any> | null): boolean {
  const extDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");
  const hasDir = existsSync(resolve(extDir, LEGACY_PLUGIN_ID));
  const hasEntry = Boolean(cfg?.plugins?.entries?.[LEGACY_PLUGIN_ID]);
  const hasInstall = Boolean(cfg?.plugins?.installs?.[LEGACY_PLUGIN_ID]);
  const inAllow = Array.isArray(cfg?.plugins?.allow) &&
    cfg.plugins.allow.includes(LEGACY_PLUGIN_ID);
  const hasChannel = Boolean(cfg?.channels?.[LEGACY_CHANNEL_ID]);
  const hasBindings = Array.isArray(cfg?.bindings) &&
    (cfg.bindings as any[]).some((b: any) => b?.match?.channel === LEGACY_CHANNEL_ID);
  return hasDir || hasEntry || hasInstall || inAllow || hasChannel || hasBindings;
}
