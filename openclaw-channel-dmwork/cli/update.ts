/**
 * update command:
 * - Without --dev: always target latest (stable) version
 * - With --dev: always target @dev tag version
 * - Skip if the target version is already installed
 */

import {
  cleanupLegacyPlugin,
  gatewayRestart,
  pluginsInspect,
  pluginsInstall,
} from "./openclaw-cli.js";
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
    if (opts.json) {
      console.log(JSON.stringify({ success: false, error: "not_installed" }));
    } else {
      console.error("DMWork plugin is not installed. Use 'install' first.");
    }
    process.exit(1);
  }

  // Clean up legacy "dmwork" plugin AFTER confirming new version exists
  const legacyActions = cleanupLegacyPlugin();
  if (legacyActions.length > 0) {
    if (!opts.json) {
      console.log("Cleaned up legacy DMWork plugin:");
      legacyActions.forEach((a) => console.log(`  ${a}`));
    }
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
