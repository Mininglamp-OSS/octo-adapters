/**
 * install command: install or update the DMWork plugin.
 * Pure plugin management — does NOT configure bots or bindings.
 *
 * Handles 5 scenarios:
 * 1. Legacy migration (dmwork → openclaw-channel-dmwork)
 * 2. Normal update (check version, update if needed)
 * 3. Fresh install (nothing installed)
 * 4. Deadlock repair (channels.dmwork exists but no plugin)
 * 5. Broken install cleanup
 */

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  cleanupBrokenInstall,
  deleteLegacyBackup,
  detectScenario,
  ensurePluginsAllow,
  gatewayRestart,
  getConfigFilePathSafe,
  isHealthyInstall,
  pluginsInspect,
  pluginsInstall,
  pluginsUpdateCompat,
  readConfigFromFile,
  removeLegacyFromConfig,
  renameLegacyDir,
  restoreChannelConfigFromDisk,
  restoreLegacyDir,
  saveChannelConfigToDisk,
  removeChannelConfigFromFile,
} from "./openclaw-cli.js";
import {
  PLUGIN_ID,
  ensureOpenClawCompat,
} from "./utils.js";

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

export interface InstallOptions {
  force?: boolean;
  dev?: boolean;
}

/**
 * install command: install or update the DMWork plugin.
 * Pure plugin management — does NOT configure bots or bindings.
 * Use `bind` or `quickstart` for bot configuration after install.
 */
export async function runInstall(opts: InstallOptions): Promise<void> {
  ensureOpenClawCompat();

  const scenario = detectScenario();
  const tag = opts.dev ? "dev" : "latest";
  const spec = opts.dev ? `${PLUGIN_ID}@dev` : PLUGIN_ID;
  const quiet = false;

  switch (scenario) {
    case "legacy":
      runLegacyMigration(spec, quiet, opts.force);
      break;
    case "update": {
      // Already installed — check for updates
      const inspect = pluginsInspect(PLUGIN_ID);
      const currentVersion = inspect?.plugin?.version ?? "unknown";
      const latestVersion = getLatestNpmVersion(tag);

      if (!latestVersion) {
        console.log(`Cannot reach npm registry to check ${tag} version.`);
        console.log(`Current version: v${currentVersion}`);
        break;
      }

      if (currentVersion === latestVersion && !opts.force) {
        console.log(`DMWork plugin is already up to date (v${currentVersion}).`);
      } else {
        console.log(`Updating DMWork plugin: v${currentVersion} → v${latestVersion}${opts.dev ? " (dev)" : ""}...`);
        pluginsUpdateCompat(PLUGIN_ID, tag, quiet);
        console.log("Plugin updated successfully.");
      }
      break;
    }
    case "broken": {
      console.log("Detected broken plugin install. Cleaning up...");
      const actions = cleanupBrokenInstall();
      actions.forEach((a) => console.log(`  ${a}`));
      console.log(`Installing DMWork plugin${opts.dev ? " (dev)" : ""}...`);
      pluginsInstall(spec, quiet, opts.force);
      console.log("Plugin installed successfully.");
      break;
    }
    case "deadlock":
      runDeadlockRepair(spec, quiet);
      break;
    case "fresh":
      console.log(`Installing DMWork plugin${opts.dev ? " (dev)" : ""}...`);
      pluginsInstall(spec, quiet, opts.force);
      console.log("Plugin installed successfully.");
      break;
  }

  // Gateway restart (plugin lifecycle requires restart)
  console.log("Restarting gateway...");
  if (!gatewayRestart()) {
    console.log("Warning: Gateway restart failed. Run 'openclaw gateway restart' manually.");
  }

  console.log("\nDMWork plugin ready! Use BotFather /newbot or /quickstart to configure bots.");
}

// ---------------------------------------------------------------------------
// Scenario 1: Legacy migration (dmwork → openclaw-channel-dmwork)
// ---------------------------------------------------------------------------

function runLegacyMigration(spec: string, quiet: boolean, force?: boolean, skipConfig?: boolean): void {
  console.log("Detected legacy DMWork plugin (dmwork). Starting migration...");

  // 1. Backup everything to disk
  const configPath = getConfigFilePathSafe();
  const backupPath = configPath + ".dmwork-upgrade-backup";
  copyFileSync(configPath, backupPath);
  saveChannelConfigToDisk();
  console.log("  Backed up config and channels.dmwork to disk.");

  // 2. Clean up any broken new plugin install from a previous failed attempt
  const brokenActions = cleanupBrokenInstall();
  if (brokenActions.length > 0) {
    console.log("  Cleaned up broken previous install:");
    brokenActions.forEach((a) => console.log(`    ${a}`));
  }

  // 3. Remove legacy from config FIRST (breaks deadlock)
  removeLegacyFromConfig();
  console.log("  Removed legacy config entries.");

  // 3. Rename legacy directory (not delete!)
  const legacyDirExists = existsSync(
    getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions/dmwork"),
  );
  let renamed = false;
  if (legacyDirExists) {
    renamed = renameLegacyDir();
    if (renamed) {
      console.log("  Renamed extensions/dmwork → .dmwork-backup.");
    } else {
      // Cannot isolate old directory — abort to prevent conflict
      console.error("  Failed to rename extensions/dmwork. Aborting migration.");
      try { copyFileSync(backupPath, configPath); } catch { /* best effort */ }
      throw new Error("Legacy migration aborted: could not rename extensions/dmwork");
    }
  }

  // 4. Install new plugin
  try {
    console.log("  Installing openclaw-channel-dmwork...");
    pluginsInstall(spec, quiet, force);
  } catch (installErr) {
    // FAIL: restore everything
    console.error("  Install failed! Restoring previous state...");
    if (renamed) restoreLegacyDir();
    try { copyFileSync(backupPath, configPath); } catch { /* best effort */ }
    console.error("  Previous state restored. Legacy plugin should still work.");
    throw installErr;
  }

  // 5. Verify healthy install
  if (!isHealthyInstall()) {
    console.error("  Install completed but verification failed. Restoring...");
    if (renamed) restoreLegacyDir();
    try { copyFileSync(backupPath, configPath); } catch { /* best effort */ }
    console.error("  Previous state restored.");
    throw new Error("Legacy migration failed: post-install verification did not pass");
  }

  // 6. Success: restore channels.dmwork + cleanup
  ensurePluginsAllow();
  restoreChannelConfigFromDisk();

  // Verify config was actually restored before deleting backups
  const restoredCfg = readConfigFromFile();
  if (restoredCfg?.channels?.dmwork) {
    // Config restore succeeded — safe to delete backups
    deleteLegacyBackup();
    try { rmSync(backupPath, { force: true }); } catch { /* best effort */ }
  } else {
    console.log("  Warning: channels.dmwork restore may not have succeeded. Keeping backups for safety.");
  }
  console.log("  Legacy migration complete!");
}

// ---------------------------------------------------------------------------
// Scenario 4: Deadlock repair
// ---------------------------------------------------------------------------

function runDeadlockRepair(spec: string, quiet: boolean, skipConfig?: boolean): void {
  console.log("Detected config deadlock (channels.dmwork exists but no plugin).");

  // 1. Backup
  const configPath = getConfigFilePathSafe();
  const backupPath = configPath + ".dmwork-upgrade-backup";
  copyFileSync(configPath, backupPath);
  saveChannelConfigToDisk();

  // 2. Remove channels.dmwork
  removeChannelConfigFromFile();
  console.log("  Temporarily removed channels.dmwork.");

  // 3. Install
  try {
    console.log("  Installing openclaw-channel-dmwork...");
    pluginsInstall(spec, quiet);
  } catch (installErr) {
    console.error("  Install failed! Restoring config...");
    try { copyFileSync(backupPath, configPath); } catch { /* best effort */ }
    throw installErr;
  }

  // 4. Verify
  if (!isHealthyInstall()) {
    console.error("  Install completed but verification failed. Restoring config...");
    try { copyFileSync(backupPath, configPath); } catch { /* best effort */ }
    throw new Error("Deadlock repair failed: post-install verification did not pass");
  }

  // 5. Success
  ensurePluginsAllow();
  restoreChannelConfigFromDisk();

  // Verify config was restored before deleting backup
  const restoredCfg = readConfigFromFile();
  if (restoredCfg?.channels?.dmwork) {
    try { rmSync(backupPath, { force: true }); } catch { /* best effort */ }
    console.log("  Deadlock repaired!");
  } else {
    // Config restore failed — plugin is installed but bot config is missing
    throw new Error("Deadlock repair incomplete: plugin installed but channels.dmwork could not be restored. Backup kept at " + backupPath);
  }
}

// ---------------------------------------------------------------------------
// Exported for update.ts and doctor.ts to reuse
// ---------------------------------------------------------------------------

export { runLegacyMigration as runLegacyMigrationForUpdate };
export { runDeadlockRepair as runDeadlockRepairForUpdate };
