/**
 * doctor command: diagnose and optionally fix DMWork plugin health.
 *
 * Exports a pure check function reusable from both CLI mode
 * (using openclaw config get) and in-process mode (using ctx.config).
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  cleanupLegacyPlugin,
  configGet,
  configGetJson,
  configSet,
  gatewayRestart,
  gatewayStatus,
  pluginsInspect,
  pluginsInstall,
  removeChannelConfigFromFile,
  removeOrphanedBindingsFromFile,
  readConfigFromFile,
} from "./openclaw-cli.js";
import { PLUGIN_ID, RECOMMENDED_DM_SCOPE } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = "PASS" | "FAIL" | "WARN" | "FIXED";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorResult {
  checks: CheckResult[];
  errors: number;
  warnings: number;
  fixed: number;
}

// ---------------------------------------------------------------------------
// Config reader abstraction (CLI vs in-process)
// ---------------------------------------------------------------------------

export interface ConfigReader {
  get(path: string): string | null;
  getJson(path: string): any;
}

/** CLI mode: reads via openclaw config get */
export const cliConfigReader: ConfigReader = {
  get: configGet,
  getJson: configGetJson,
};

/** In-process mode: reads from a config object */
export function inProcessConfigReader(config: any): ConfigReader {
  return {
    get(path: string): string | null {
      const parts = path.split(".");
      let cur = config;
      for (const p of parts) {
        if (cur == null || typeof cur !== "object") return null;
        cur = cur[p];
      }
      if (cur == null) return null;
      return String(cur);
    },
    getJson(path: string): any {
      const parts = path.split(".");
      let cur = config;
      for (const p of parts) {
        if (cur == null || typeof cur !== "object") return null;
        cur = cur[p];
      }
      return cur ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Doctor checks (with optional fix)
// ---------------------------------------------------------------------------

export async function runDoctorChecks(params: {
  reader?: ConfigReader;
  accountId?: string;
  inProcess?: boolean;
  fix?: boolean;
}): Promise<DoctorResult> {
  const fix = params.fix ?? false;
  const checks: CheckResult[] = [];

  // =========================================================================
  // Phase 1: Fatal config issues (OpenClaw CLI may not work)
  // =========================================================================
  if (!params.inProcess && fix) {
    // Phase 0: Clean up legacy "dmwork" plugin
    const legacyActions = cleanupLegacyPlugin();
    for (const action of legacyActions) {
      checks.push({
        name: "Legacy plugin cleanup",
        status: "FIXED",
        detail: action,
      });
    }

    const cfg = readConfigFromFile();
    if (cfg) {
      const hasDmworkChannel = Boolean(cfg.channels?.dmwork);
      // Check if plugin actually exists on disk, not just config records
      const installPath = cfg.plugins?.installs?.["openclaw-channel-dmwork"]?.installPath;
      const pluginOnDisk = installPath
        ? existsSync(installPath.replace(/^~/, process.env.HOME ?? ""))
        : false;

      // channels.dmwork exists but plugin not on disk → residual config
      if (hasDmworkChannel && !pluginOnDisk) {
        removeChannelConfigFromFile();
        checks.push({
          name: "Residual channels.dmwork",
          status: "FIXED",
          detail: "Removed orphaned channel config (plugin not installed)",
        });
      }

      // Orphaned dmwork bindings
      const bindings = cfg.bindings as Array<{ agentId: string; match?: { channel?: string; accountId?: string } }> | undefined;
      const dmworkBindings = bindings?.filter((b) => b.match?.channel === "dmwork") ?? [];
      const configuredAccounts = cfg.channels?.dmwork?.accounts
        ? Object.keys(cfg.channels.dmwork.accounts)
        : [];

      if (dmworkBindings.length > 0 && !hasDmworkChannel) {
        // All dmwork bindings are orphaned — no channel config at all
        removeOrphanedBindingsFromFile("dmwork");
        checks.push({
          name: "Orphaned bindings",
          status: "FIXED",
          detail: `Removed ${dmworkBindings.length} orphaned dmwork binding(s)`,
        });
      } else if (dmworkBindings.length > 0 && configuredAccounts.length > 0) {
        // Check for bindings referencing non-existent accounts
        const orphaned = dmworkBindings.filter(
          (b) => b.match?.accountId && !configuredAccounts.includes(b.match.accountId),
        );
        if (orphaned.length > 0) {
          removeOrphanedBindingsFromFile("dmwork", configuredAccounts);
          checks.push({
            name: "Orphaned bindings",
            status: "FIXED",
            detail: `Removed ${orphaned.length} binding(s) for non-existent account(s)`,
          });
        }
      }
    }
  }

  // =========================================================================
  // Phase 2: Standard checks (with fix support)
  // =========================================================================
  const reader = params.reader ?? cliConfigReader;

  // 1. Plugin installed
  if (!params.inProcess) {
    const inspect = pluginsInspect(PLUGIN_ID);
    if (inspect?.plugin) {
      checks.push({
        name: "Plugin installed",
        status: "PASS",
        detail: `v${inspect.plugin.version}`,
      });
    } else if (fix) {
      try {
        pluginsInstall(PLUGIN_ID, true);
        const after = pluginsInspect(PLUGIN_ID);
        checks.push({
          name: "Plugin installed",
          status: "FIXED",
          detail: `Installed v${after?.plugin?.version ?? "unknown"}`,
        });
      } catch {
        checks.push({
          name: "Plugin installed",
          status: "FAIL",
          detail: "Not installed (auto-install failed)",
        });
        return summarize(checks);
      }
    } else {
      checks.push({
        name: "Plugin installed",
        status: "FAIL",
        detail: "Not installed",
      });
      return summarize(checks);
    }
  }

  // 2. Plugin enabled
  if (!params.inProcess) {
    const enabled = reader.get(
      "plugins.entries.openclaw-channel-dmwork.enabled",
    );
    if (enabled === "true") {
      checks.push({ name: "Plugin enabled", status: "PASS", detail: "Yes" });
    } else if (fix) {
      try {
        configSet("plugins.entries.openclaw-channel-dmwork.enabled", "true");
        checks.push({ name: "Plugin enabled", status: "FIXED", detail: "Enabled" });
      } catch {
        checks.push({ name: "Plugin enabled", status: "FAIL", detail: "No (auto-fix failed)" });
      }
    } else {
      checks.push({ name: "Plugin enabled", status: "FAIL", detail: "No" });
    }
  }

  // 3. node_modules check
  if (!params.inProcess) {
    const inspect = pluginsInspect(PLUGIN_ID);
    const installPath = inspect?.install?.installPath;
    if (installPath) {
      const nmPath = installPath.replace(/^~/, process.env.HOME ?? "") + "/node_modules";
      if (existsSync(nmPath)) {
        checks.push({ name: "Dependencies", status: "PASS", detail: "node_modules exists" });
      } else if (fix) {
        try {
          execFileSync("npm", ["install", "--production", "--ignore-scripts"], {
            cwd: installPath.replace(/^~/, process.env.HOME ?? ""),
            stdio: ["pipe", "pipe", "pipe"],
          });
          checks.push({ name: "Dependencies", status: "FIXED", detail: "npm install completed" });
        } catch {
          checks.push({ name: "Dependencies", status: "FAIL", detail: "node_modules missing (npm install failed)" });
        }
      } else {
        checks.push({ name: "Dependencies", status: "FAIL", detail: "node_modules missing" });
      }
    }
  }

  // 4. Accounts configured (with legacy fallback)
  const accounts = reader.getJson("channels.dmwork.accounts");
  const accountIds = accounts ? Object.keys(accounts) : [];
  const legacyToken = reader.get("channels.dmwork.botToken");

  if (accountIds.length > 0) {
    checks.push({
      name: "Accounts configured",
      status: "PASS",
      detail: `${accountIds.join(", ")} (${accountIds.length} total)`,
    });
  } else if (legacyToken) {
    checks.push({
      name: "Accounts configured",
      status: "PASS",
      detail: "Legacy flat config (top-level botToken)",
    });
  } else {
    checks.push({
      name: "Accounts configured",
      status: "FAIL",
      detail: "No accounts configured (run install to add a bot)",
    });
    // Don't return early — continue checking other items
  }

  // 5 & 6. Per-account checks: botToken + API reachability
  const targetAccounts = params.accountId
    ? [params.accountId]
    : accountIds.length > 0
      ? accountIds
      : legacyToken
        ? ["__legacy__"]
        : [];

  for (const acctId of targetAccounts) {
    const isLegacy = acctId === "__legacy__";
    const label = isLegacy ? "default" : acctId;

    const tokenPath = isLegacy
      ? "channels.dmwork.botToken"
      : `channels.dmwork.accounts.${acctId}.botToken`;
    const tokenVal = reader.get(tokenPath);

    if (tokenVal) {
      if (params.inProcess && !tokenVal.startsWith("bf_")) {
        checks.push({
          name: `${label}: botToken format`,
          status: "WARN",
          detail: "Does not start with bf_",
        });
      } else {
        checks.push({
          name: `${label}: botToken`,
          status: "PASS",
          detail: "Configured",
        });
      }
    } else {
      checks.push({
        name: `${label}: botToken`,
        status: "FAIL",
        detail: "Not configured",
      });
      continue;
    }

    const apiUrlPath = isLegacy
      ? "channels.dmwork.apiUrl"
      : `channels.dmwork.accounts.${acctId}.apiUrl`;
    let apiUrl = reader.get(apiUrlPath);
    if (!apiUrl) apiUrl = reader.get("channels.dmwork.apiUrl");
    if (!apiUrl) apiUrl = "http://localhost:8090";

    try {
      const probeUrl = `${apiUrl.replace(/\/+$/, "")}/v1/bot/skill.md`;
      const resp = await fetch(probeUrl, { signal: AbortSignal.timeout(5000) });
      checks.push({
        name: `${label}: API reachable`,
        status: resp.ok ? "PASS" : "FAIL",
        detail: resp.ok ? apiUrl : `HTTP ${resp.status}`,
      });
    } catch (err) {
      checks.push({
        name: `${label}: API reachable`,
        status: "FAIL",
        detail: `${apiUrl} - ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 7. Gateway running
  if (!params.inProcess) {
    const gw = gatewayStatus();
    if (gw.running) {
      checks.push({ name: "Gateway running", status: "PASS", detail: "Yes" });
    } else if (fix) {
      if (gatewayRestart()) {
        checks.push({ name: "Gateway running", status: "FIXED", detail: "Restarted" });
      } else {
        checks.push({ name: "Gateway running", status: "FAIL", detail: "Not running (restart failed)" });
      }
    } else {
      checks.push({ name: "Gateway running", status: "FAIL", detail: "Not running" });
    }
  }

  // 8. session.dmScope
  const dmScope = reader.get("session.dmScope");
  if (dmScope === RECOMMENDED_DM_SCOPE) {
    checks.push({ name: "session.dmScope", status: "PASS", detail: dmScope });
  } else if (!dmScope && fix) {
    try {
      configSet("session.dmScope", RECOMMENDED_DM_SCOPE);
      checks.push({ name: "session.dmScope", status: "FIXED", detail: `Set to ${RECOMMENDED_DM_SCOPE}` });
    } catch {
      checks.push({ name: "session.dmScope", status: "WARN", detail: `Not set (recommended: ${RECOMMENDED_DM_SCOPE})` });
    }
  } else if (!dmScope) {
    checks.push({ name: "session.dmScope", status: "WARN", detail: `Not set (recommended: ${RECOMMENDED_DM_SCOPE})` });
  } else {
    checks.push({ name: "session.dmScope", status: "WARN", detail: `${dmScope} (recommended: ${RECOMMENDED_DM_SCOPE})` });
  }

  return summarize(checks);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function summarize(checks: CheckResult[]): DoctorResult {
  return {
    checks,
    errors: checks.filter((c) => c.status === "FAIL").length,
    warnings: checks.filter((c) => c.status === "WARN").length,
    fixed: checks.filter((c) => c.status === "FIXED").length,
  };
}

export function formatDoctorResult(result: DoctorResult): string {
  const lines = ["DMWork Plugin Doctor"];
  for (const c of result.checks) {
    const tag =
      c.status === "PASS"
        ? "[PASS] "
        : c.status === "WARN"
          ? "[WARN] "
          : c.status === "FIXED"
            ? "[FIXED]"
            : "[FAIL] ";
    lines.push(`  ${tag} ${c.name} (${c.detail})`);
  }
  lines.push("");
  const parts = [`${result.errors} error(s)`, `${result.warnings} warning(s)`];
  if (result.fixed > 0) parts.push(`${result.fixed} fixed`);
  lines.push(parts.join(", ") + ".");
  return lines.join("\n");
}
