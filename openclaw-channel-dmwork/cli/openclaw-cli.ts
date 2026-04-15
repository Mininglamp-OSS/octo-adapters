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
      if (paths.length > 0) return paths[0];
    } catch {
      // command not available on this platform
    }
  }

  // Strategy 2: check common global install paths
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

const OPENCLAW = findGlobalOpenclaw();

/** Expand ~ to home directory */
function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function getConfigFilePath(): string {
  const out = execFileSync(OPENCLAW, ["config", "file"], { encoding: "utf-8" });
  // openclaw may prepend warnings/box-drawing to stdout; extract the actual path
  // The path is typically the last non-empty line containing openclaw.json
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const pathLine = lines.find((l) => l.endsWith("openclaw.json")) ?? lines[lines.length - 1];
  return pathLine ?? out.trim();
}

export function configGet(path: string): string | null {
  try {
    const val = execFileSync(OPENCLAW, ["config", "get", path], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return val === "" ? null : val;
  } catch {
    return null;
  }
}

export function configGetJson(path: string): any {
  try {
    const out = execFileSync(OPENCLAW, ["config", "get", path, "--json"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const jsonStart = out.indexOf("{");
    const arrStart = out.indexOf("[");
    const start = jsonStart >= 0 && arrStart >= 0
      ? Math.min(jsonStart, arrStart)
      : Math.max(jsonStart, arrStart);
    if (start < 0) return null;
    return JSON.parse(out.slice(start));
  } catch {
    return null;
  }
}

export function configSet(path: string, value: string): void {
  execFileSync(OPENCLAW, ["config", "set", path, value], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function configSetBatch(
  operations: Array<{ path: string; value: unknown }>,
): void {
  const batchJson = JSON.stringify(
    operations.map((op) => ({ path: op.path, value: op.value })),
  );
  execFileSync(OPENCLAW, ["config", "set", "--batch-json", batchJson], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function configSetJson(path: string, value: unknown): void {
  execFileSync(OPENCLAW, ["config", "set", path, JSON.stringify(value), "--strict-json"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function configUnset(path: string): void {
  execFileSync(OPENCLAW, ["config", "unset", path], {
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

export function pluginsInstall(spec: string, quiet?: boolean, force?: boolean): void {
  const args = ["plugins", "install", spec];
  if (force) args.push("--force");
  const stdioOpt: import("node:child_process").StdioOptions = quiet
    ? ["pipe", "pipe", "pipe"]
    : "inherit";

  // Try with --dangerously-force-unsafe-install first; fall back if unsupported
  try {
    execFileSync(OPENCLAW, [...args, "--dangerously-force-unsafe-install"], { stdio: stdioOpt });
  } catch (err) {
    if (isUnsupportedOptionError(err)) {
      execFileSync(OPENCLAW, args, { stdio: stdioOpt });
    } else {
      throw err;
    }
  }
}

export function pluginsUpdate(id: string, quiet?: boolean): void {
  execFileSync(OPENCLAW, ["plugins", "update", id], {
    stdio: quiet ? ["pipe", "pipe", "pipe"] : "inherit",
  });
}

export function pluginsUninstall(id: string, yes?: boolean): void {
  const args = ["plugins", "uninstall", id];
  if (yes) args.push("--force");
  execFileSync(OPENCLAW, args, { stdio: "inherit" });
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

export function pluginsInspect(id: string): PluginInspectResult | null {
  try {
    const out = execFileSync(OPENCLAW, ["plugins", "inspect", id, "--json"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // stdout may contain plugin log noise before JSON — find the JSON object
    const jsonStart = out.indexOf("{");
    if (jsonStart < 0) return null;
    return JSON.parse(out.slice(jsonStart));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gateway helpers
// ---------------------------------------------------------------------------

export function gatewayStatus(): { running: boolean } {
  try {
    const out = execFileSync(OPENCLAW, ["gateway", "status", "--json"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const jsonStart = out.indexOf("{");
    if (jsonStart < 0) return { running: false };
    const data = JSON.parse(out.slice(jsonStart));
    // Real structure: { service.runtime.status: "running", health.healthy: true }
    const runtimeRunning = data.service?.runtime?.status === "running";
    const healthy = data.health?.healthy === true;
    return { running: runtimeRunning || healthy };
  } catch {
    return { running: false };
  }
}

export function gatewayRestart(quiet?: boolean): boolean {
  try {
    execFileSync(OPENCLAW, ["gateway", "restart"], {
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
    const out = execFileSync(OPENCLAW, ["--version"], {
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
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
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
    const raw = readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw);
    if (cfg.channels?.dmwork) {
      delete cfg.channels.dmwork;
      writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
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
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
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
      execFileSync(OPENCLAW, ["plugins", "uninstall", LEGACY_PLUGIN_ID, "--force", "--keep-files"], {
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
      writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
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
  const stdioOpt: import("node:child_process").StdioOptions = quiet
    ? ["pipe", "pipe", "pipe"]
    : "inherit";
  try {
    execFileSync(OPENCLAW, ["plugins", "update", id], { stdio: stdioOpt });
  } catch {
    pluginsInstall(`${id}@${tag}`, quiet, true);
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

  // "Healthy" requires all three (or inspect OK). Anything less is broken.
  const inspectOk = Boolean(pluginsInspect("openclaw-channel-dmwork")?.plugin);
  if (inspectOk) return actions; // Actually healthy, nothing to clean

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
