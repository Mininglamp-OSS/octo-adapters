/**
 * update command:
 * - Detects scenario and routes accordingly
 * - For healthy installs: compare versions, update if different
 * - For legacy/broken/deadlock: delegate to install's safe paths
 */

import {
  cleanupBrokenInstall,
  detectScenario,
  gatewayRestart,
  pluginsInspect,
  pluginsUpdateCompat,
} from "./openclaw-cli.js";
import {
  runLegacyMigrationForUpdate,
  runDeadlockRepairForUpdate,
} from "./install.js";
import { PLUGIN_ID, ensureOpenClawCompat } from "./utils.js";
import { execFileSync } from "node:child_process";

export interface UpdateOptions {
  json?: boolean;
  dev?: boolean;
}

function getLatestNpmVersion(tag: string): string | null {
  try {
    return execFileSync("npm", ["view", `${PLUGIN_ID}@${tag}`, "version"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export async function runUpdate(opts: UpdateOptions): Promise<void> {
  ensureOpenClawCompat();

  const scenario = detectScenario();
  const tag = opts.dev ? "dev" : "latest";
  const spec = `${PLUGIN_ID}@${tag}`;
  const quiet = Boolean(opts.json);

  // Non-healthy scenarios: delegate to install's safe paths
  if (scenario === "legacy") {
    if (!quiet) console.log("Detected legacy DMWork plugin. Running migration...");
    runLegacyMigrationForUpdate(spec, quiet);
    if (!quiet) console.log("Restarting gateway...");
    gatewayRestart(quiet);
    if (opts.json) {
      const after = pluginsInspect(PLUGIN_ID);
      console.log(JSON.stringify({ success: true, previousVersion: null, currentVersion: after?.plugin?.version ?? "unknown" }));
    }
    return;
  }

  if (scenario === "broken") {
    if (!quiet) console.log("Detected broken plugin install. Cleaning up and reinstalling...");
    cleanupBrokenInstall();
    // After cleanup, fall through to fresh install via pluginsInstall
    const { pluginsInstall } = await import("./openclaw-cli.js");
    pluginsInstall(spec, quiet);
    if (!quiet) console.log("Restarting gateway...");
    gatewayRestart(quiet);
    if (opts.json) {
      const after = pluginsInspect(PLUGIN_ID);
      console.log(JSON.stringify({ success: true, previousVersion: null, currentVersion: after?.plugin?.version ?? "unknown" }));
    }
    return;
  }

  if (scenario === "deadlock") {
    if (!quiet) console.log("Detected config deadlock. Repairing...");
    runDeadlockRepairForUpdate(spec, quiet);
    if (!quiet) console.log("Restarting gateway...");
    gatewayRestart(quiet);
    if (opts.json) {
      const after = pluginsInspect(PLUGIN_ID);
      console.log(JSON.stringify({ success: true, previousVersion: null, currentVersion: after?.plugin?.version ?? "unknown" }));
    }
    return;
  }

  if (scenario === "fresh") {
    if (!quiet) console.log("DMWork plugin not found. Installing...");
    const { pluginsInstall } = await import("./openclaw-cli.js");
    pluginsInstall(spec, quiet);
    if (!quiet) console.log("Restarting gateway...");
    gatewayRestart(quiet);
    if (opts.json) {
      const after = pluginsInspect(PLUGIN_ID);
      console.log(JSON.stringify({ success: true, previousVersion: null, currentVersion: after?.plugin?.version ?? "unknown" }));
    }
    return;
  }

  // Scenario: update (healthy install)
  const inspect = pluginsInspect(PLUGIN_ID);
  const currentVersion = inspect?.plugin?.version ?? "unknown";
  const targetVersion = getLatestNpmVersion(tag);

  if (!targetVersion) {
    if (opts.json) {
      console.log(JSON.stringify({ success: false, error: "registry_unavailable" }));
    } else {
      console.error(`Error: Cannot reach npm registry to check ${tag} version.`);
    }
    process.exit(1);
  }

  if (currentVersion === targetVersion) {
    if (opts.json) {
      console.log(JSON.stringify({ success: true, previousVersion: currentVersion, currentVersion: targetVersion }));
    } else {
      console.log(`Already up to date (v${currentVersion}).`);
    }
    return;
  }

  if (!quiet) {
    console.log(`Updating DMWork plugin: v${currentVersion} -> v${targetVersion}${opts.dev ? " (dev)" : ""}...`);
  }

  pluginsUpdateCompat(PLUGIN_ID, tag, quiet);

  if (!quiet) console.log("Restarting gateway...");
  if (!gatewayRestart(quiet)) {
    if (!quiet) console.log("Warning: Gateway restart failed. Run 'openclaw gateway restart' manually.");
  }

  if (opts.json) {
    console.log(JSON.stringify({ success: true, previousVersion: currentVersion, currentVersion: targetVersion }));
  } else {
    console.log(`Updated: v${currentVersion} -> v${targetVersion}`);
  }
}
