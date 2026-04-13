/**
 * doctor command: diagnose DMWork plugin health.
 *
 * Exports a pure check function reusable from both CLI mode
 * (using openclaw config get) and in-process mode (using ctx.config).
 */

import {
  configGet,
  configGetJson,
  gatewayStatus,
  pluginsInspect,
} from "./openclaw-cli.js";
import { PLUGIN_ID, RECOMMENDED_DM_SCOPE } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = "PASS" | "FAIL" | "WARN";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorResult {
  checks: CheckResult[];
  errors: number;
  warnings: number;
}

export interface DoctorOptions {
  accountId?: string;
  json?: boolean;
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
// Doctor checks
// ---------------------------------------------------------------------------

export async function runDoctorChecks(params: {
  reader?: ConfigReader;
  accountId?: string;
  inProcess?: boolean;
}): Promise<DoctorResult> {
  const reader = params.reader ?? cliConfigReader;
  const checks: CheckResult[] = [];

  // 1. Plugin installed (skip in-process — if we're running, it's installed)
  if (!params.inProcess) {
    const inspect = pluginsInspect(PLUGIN_ID);
    if (inspect?.plugin) {
      checks.push({
        name: "Plugin installed",
        status: "PASS",
        detail: `v${inspect.plugin.version}`,
      });
    } else {
      checks.push({
        name: "Plugin installed",
        status: "FAIL",
        detail: "Not installed",
      });
      return summarize(checks);
    }
  }

  // 2. Plugin enabled (skip in-process)
  if (!params.inProcess) {
    const enabled = reader.get(
      `plugins.entries.openclaw-channel-dmwork.enabled`,
    );
    checks.push({
      name: "Plugin enabled",
      status: enabled === "true" ? "PASS" : "FAIL",
      detail: enabled === "true" ? "Yes" : "No",
    });
  }

  // 3. Accounts configured (with legacy fallback)
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
      detail: "No accounts or botToken configured",
    });
    return summarize(checks);
  }

  // 4 & 5. Per-account checks: botToken + API reachability
  const targetAccounts = params.accountId
    ? [params.accountId]
    : accountIds.length > 0
      ? accountIds
      : ["__legacy__"];

  for (const acctId of targetAccounts) {
    const isLegacy = acctId === "__legacy__";
    const label = isLegacy ? "default" : acctId;

    // botToken check
    const tokenPath = isLegacy
      ? "channels.dmwork.botToken"
      : `channels.dmwork.accounts.${acctId}.botToken`;
    const tokenVal = reader.get(tokenPath);

    if (tokenVal) {
      // In-process mode can do bf_ format check
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

    // API reachability
    const apiUrlPath = isLegacy
      ? "channels.dmwork.apiUrl"
      : `channels.dmwork.accounts.${acctId}.apiUrl`;
    let apiUrl = reader.get(apiUrlPath);
    // Fallback to top-level apiUrl
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

  // 6. Gateway running (skip in-process)
  if (!params.inProcess) {
    const gw = gatewayStatus();
    checks.push({
      name: "Gateway running",
      status: gw.running ? "PASS" : "FAIL",
      detail: gw.running ? "Yes" : "Not running",
    });
  }

  // 7. session.dmScope
  const dmScope = reader.get("session.dmScope");
  if (!dmScope) {
    checks.push({
      name: "session.dmScope",
      status: "WARN",
      detail: `Not set (recommended: ${RECOMMENDED_DM_SCOPE})`,
    });
  } else if (dmScope === RECOMMENDED_DM_SCOPE) {
    checks.push({
      name: "session.dmScope",
      status: "PASS",
      detail: dmScope,
    });
  } else {
    checks.push({
      name: "session.dmScope",
      status: "WARN",
      detail: `${dmScope} (recommended: ${RECOMMENDED_DM_SCOPE})`,
    });
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
  };
}

export function formatDoctorResult(result: DoctorResult): string {
  const lines = ["DMWork Plugin Doctor"];
  for (const c of result.checks) {
    const tag =
      c.status === "PASS"
        ? "[PASS]"
        : c.status === "WARN"
          ? "[WARN]"
          : "[FAIL]";
    lines.push(`  ${tag} ${c.name} (${c.detail})`);
  }
  lines.push("");
  lines.push(
    `${result.errors} error(s), ${result.warnings} warning(s).`,
  );
  return lines.join("\n");
}
