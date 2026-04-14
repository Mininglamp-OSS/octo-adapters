/**
 * openclaw CLI wrapper.
 * All openclaw invocations go through this module using execFileSync with
 * argument arrays to avoid shell-quoting issues.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const OPENCLAW = "openclaw";

/** Expand ~ to home directory */
function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function getConfigFilePath(): string {
  return execFileSync(OPENCLAW, ["config", "file"], { encoding: "utf-8" }).trim();
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

export function pluginsInstall(spec: string, quiet?: boolean, force?: boolean): void {
  const args = ["plugins", "install", spec, "--dangerously-force-unsafe-install"];
  if (force) args.push("--force");
  execFileSync(OPENCLAW, args, {
    stdio: quiet ? ["pipe", "pipe", "pipe"] : "inherit",
  });
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
    const configPath = expandHome(getConfigFilePath());
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
  const configPath = expandHome(getConfigFilePath());
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
function getConfigFilePathSafe(): string {
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
