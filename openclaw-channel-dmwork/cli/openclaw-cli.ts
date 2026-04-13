/**
 * openclaw CLI wrapper.
 * All openclaw invocations go through this module using execFileSync with
 * argument arrays to avoid shell-quoting issues.
 */

import { execFileSync } from "node:child_process";

const OPENCLAW = "openclaw";

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

export function configUnset(path: string): void {
  execFileSync(OPENCLAW, ["config", "unset", path], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// ---------------------------------------------------------------------------
// Plugin helpers
// ---------------------------------------------------------------------------

export function pluginsInstall(spec: string, force?: boolean): void {
  const args = ["plugins", "install", spec];
  if (force) args.push("--force");
  execFileSync(OPENCLAW, args, { stdio: "inherit" });
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
