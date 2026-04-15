/**
 * update command:
 * - Without --dev: always target latest (stable) version
 * - With --dev: always target @dev tag version
 * - Skip if the target version is already installed
 */

import {
  gatewayRestart,
  pluginsInspect,
  pluginsInstall,
} from "./openclaw-cli.js";
import { runSafeInstall } from "./install.js";
import { PLUGIN_ID, ensureOpenClawCompat } from "./utils.js";
import { execFileSync } from "node:child_process";

export interface UpdateOptions {
  json?: boolean;
  dev?: boolean;
}

/**
 * Query npm registry for the latest version under a given tag.
 */
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

  const inspect = pluginsInspect(PLUGIN_ID);
  if (!inspect?.plugin) {
    // Plugin not found — use full safe install path (handles deadlock, stale dirs, legacy cleanup)
    if (!opts.json) {
      console.log("DMWork plugin not found. Attempting install...");
    }
    const tag = opts.dev ? "dev" : "latest";
    runSafeInstall(`${PLUGIN_ID}@${tag}`, true, opts.json);

    if (!opts.json) {
      console.log("Restarting gateway...");
    }
    if (!gatewayRestart(opts.json)) {
      if (!opts.json) {
        console.log("Warning: Gateway restart failed. Run 'openclaw gateway restart' manually.");
      }
    }

    const after = pluginsInspect(PLUGIN_ID);
    if (opts.json) {
      console.log(JSON.stringify({ success: true, previousVersion: null, currentVersion: after?.plugin?.version ?? "unknown" }));
    } else {
      console.log(`Installed: v${after?.plugin?.version ?? "unknown"}`);
    }
    return;
  }

  const currentVersion = inspect.plugin.version;
  const tag = opts.dev ? "dev" : "latest";
  const targetVersion = getLatestNpmVersion(tag);

  if (!targetVersion) {
    if (opts.json) {
      console.log(JSON.stringify({ success: false, error: "registry_unavailable" }));
    } else {
      console.error(`Error: Cannot reach npm registry to check ${tag} version.`);
    }
    process.exit(1);
  }

  // Skip if already on the target version
  if (currentVersion === targetVersion) {
    if (opts.json) {
      console.log(JSON.stringify({ success: true, previousVersion: currentVersion, currentVersion: targetVersion }));
    } else {
      console.log(`Already up to date (v${currentVersion}).`);
    }
    return;
  }

  const quiet = Boolean(opts.json);

  if (!quiet) {
    console.log(`Updating DMWork plugin: v${currentVersion} -> v${targetVersion}${opts.dev ? " (dev)" : ""}...`);
  }

  // Use --force to replace existing installation when switching versions
  pluginsInstall(`${PLUGIN_ID}@${tag}`, quiet, true);

  if (!quiet) {
    console.log("Restarting gateway...");
  }
  if (!gatewayRestart(quiet)) {
    if (!quiet) {
      console.log("Warning: Gateway restart failed. Run 'openclaw gateway restart' manually.");
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ success: true, previousVersion: currentVersion, currentVersion: targetVersion }));
  } else {
    console.log(`Updated: v${currentVersion} -> v${targetVersion}`);
  }
}
