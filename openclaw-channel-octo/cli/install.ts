/**
 * install command: install or update the Octo plugin.
 * Pure plugin management — does NOT configure bots or bindings.
 *
 * Phase A handles 4 active scenarios for the new Octo plugin:
 * 1. fresh — nothing installed
 * 2. update — already on the new plugin, check version
 * 3. broken — partial Octo install, cleanup + reinstall
 * 4. legacy-warn — old openclaw-channel-dmwork or channels.dmwork residue;
 *    Phase A merely warns and falls through to fresh (legacy plugin is left
 *    untouched). Phase B will replace this with full rebrand migration.
 *
 * The `legacy` scenario (very-legacy plugin id "dmwork") is detected for
 * forward-compat but Phase A only warns; Phase B's legacy-to-octo path
 * (runLegacyMigration / runDeadlockRepair below, kept as-is) is not yet
 * wired into the active switch.
 */

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  cleanupBrokenInstall,
  deleteLegacyBackup,
  detectScenario,
  ensurePluginEnabled,
  ensurePluginsAllow,
  gatewayRestart,
  getConfigFilePathSafe,
  isHealthyInstall,
  pluginsInspect,
  pluginsInstall,
  readConfigFromFile,
  removeLegacyFromConfig,
  renameLegacyDir,
  restoreChannelConfigFromDisk,
  restoreLegacyDir,
  saveChannelConfigToDisk,
  removeChannelConfigFromFile,
  runCmd,
} from "./openclaw-cli.js";
import {
  PLUGIN_ID,
  ensureOpenClawCompat,
} from "./utils.js";

function getLatestNpmVersion(tag: string): string | null {
  try {
    return runCmd("npm", ["view", `${PLUGIN_ID}@${tag}`, "version"], {
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

const LEGACY_WARN_MESSAGE =
  "[legacy-warn] legacy dmwork config detected; migration will be handled in a later release. " +
  "Your existing dmwork plugin and bot configs are unaffected.";

/**
 * install command: install or update the Octo plugin.
 * Pure plugin management — does NOT configure bots or bindings.
 * Use `bind` or `quickstart` for bot configuration after install.
 */
export async function runInstall(opts: InstallOptions): Promise<void> {
  ensureOpenClawCompat();

  const scenario = detectScenario();
  const tag = opts.dev ? "dev" : "latest";
  const spec = opts.dev ? `${PLUGIN_ID}@dev` : PLUGIN_ID;
  const quiet = false;
  let didChange = false;

  switch (scenario) {
    case "legacy":
      // LEGACY-DETECT: very-legacy plugin id "dmwork" present. Phase A only warns.
      console.warn(
        "[legacy] very-legacy 'dmwork' plugin detected. Phase A does not migrate; " +
        "your existing legacy plugin is left intact. Continuing with a fresh Octo install...",
      );
      console.log(`Installing Octo plugin${opts.dev ? " (dev)" : ""}...`);
      pluginsInstall(spec, quiet, opts.force);
      console.log("Plugin installed successfully.");
      didChange = true;
      break;
    case "legacy-warn":
      // LEGACY-DETECT: openclaw-channel-dmwork residue present. Phase A only warns.
      console.warn(LEGACY_WARN_MESSAGE);
      console.log(`Installing Octo plugin${opts.dev ? " (dev)" : ""}...`);
      pluginsInstall(spec, quiet, opts.force);
      console.log("Plugin installed successfully.");
      didChange = true;
      break;
    case "update": {
      // Already installed — compare against target version
      const inspect = pluginsInspect(PLUGIN_ID);
      const currentVersion = inspect?.plugin?.version ?? "unknown";

      if (opts.force) {
        console.log(`Force installing Octo plugin${opts.dev ? " (dev)" : ""}...`);
        pluginsInstall(spec, quiet, true);
        console.log("Plugin installed successfully.");
        didChange = true;
        break;
      }

      const targetVersion = getLatestNpmVersion(tag);

      if (!targetVersion) {
        console.log(`Cannot reach npm registry to check ${tag} version.`);
        console.log(`Current version: v${currentVersion}`);
        break;
      }

      if (currentVersion === targetVersion) {
        console.log(`Octo plugin v${currentVersion} is already the target version${opts.dev ? " (dev)" : ""}. No update needed.`);
        break;
      }

      console.log(`Updating Octo plugin: v${currentVersion} → v${targetVersion}${opts.dev ? " (dev)" : ""}...`);
      pluginsInstall(spec, quiet, true);
      console.log(`Octo plugin updated from v${currentVersion} to v${targetVersion}${opts.dev ? " (dev)" : ""}.`);
      didChange = true;
      break;
    }
    case "broken": {
      console.log("Detected broken plugin install. Cleaning up...");
      const actions = cleanupBrokenInstall();
      actions.forEach((a) => console.log(`  ${a}`));
      console.log(`Installing Octo plugin${opts.dev ? " (dev)" : ""}...`);
      pluginsInstall(spec, quiet, opts.force);
      console.log("Plugin installed successfully.");
      didChange = true;
      break;
    }
    case "deadlock":
      // Phase A: detectScenario() folds the old "deadlock" case into
      // "legacy-warn"; this branch is unreachable but kept for type completeness.
      // Phase B will reintroduce a proper deadlock-repair path for octo.
      runDeadlockRepair(spec, quiet);
      didChange = true;
      break;
    case "fresh":
      console.log(`Installing Octo plugin${opts.dev ? " (dev)" : ""}...`);
      pluginsInstall(spec, quiet, opts.force);
      console.log("Plugin installed successfully.");
      didChange = true;
      break;
  }

  // Self-heal config — runs even when no install happened (already-at-target case).
  // After OpenClaw major upgrades (4.x → 5.x), plugins.entries.<id>.enabled has been
  // observed to be reset to false on third-party plugins, leaving the plugin installed
  // but inactive. This restores it without requiring users to run
  // `openclaw plugins enable openclaw-channel-octo` manually.
  ensurePluginsAllow();
  ensurePluginEnabled();

  if (!didChange) return;

  // Gateway restart (plugin lifecycle requires restart)
  console.log("Restarting gateway...");
  if (!gatewayRestart()) {
    console.log("Warning: Gateway restart failed. Run 'openclaw gateway restart' manually.");
  }

  console.log("\nOcto plugin ready! Use BotFather /newbot or /quickstart to configure bots.");
}

// ---------------------------------------------------------------------------
// Legacy scaffolding — kept for Phase B (rebrand migration).
//
// runLegacyMigration() and runDeadlockRepair() below are NOT wired into the
// Phase A install switch. They reference the old dmwork-channel-dmwork
// install layout and channels.dmwork; Phase B will rework them into proper
// rebrand / legacy-to-octo migrations using command-driven helpers.
// ---------------------------------------------------------------------------

// LEGACY-MIGRATION: Phase B will rewrite this. Phase A keeps the body intact
// only so the file still typechecks; the function is dead code in Phase A.
function runLegacyMigration(spec: string, quiet: boolean, force?: boolean): void {
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

  // 4. Rename legacy directory (not delete!)
  const legacyDirExists = existsSync(
    getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions/dmwork"),
  );
  let renamed = false;
  if (legacyDirExists) {
    renamed = renameLegacyDir();
    if (renamed) {
      console.log("  Renamed extensions/dmwork → .dmwork-backup.");
    } else {
      console.error("  Failed to rename extensions/dmwork. Aborting migration.");
      try { copyFileSync(backupPath, configPath); } catch { /* best effort */ }
      throw new Error("Legacy migration aborted: could not rename extensions/dmwork");
    }
  }

  // 5. Install new plugin
  try {
    console.log("  Installing openclaw-channel-octo...");
    pluginsInstall(spec, quiet, force);
  } catch (installErr) {
    console.error("  Install failed! Restoring previous state...");
    if (renamed) restoreLegacyDir();
    try { copyFileSync(backupPath, configPath); } catch { /* best effort */ }
    console.error("  Previous state restored. Legacy plugin should still work.");
    throw installErr;
  }

  // 6. Verify healthy install
  if (!isHealthyInstall()) {
    console.error("  Install completed but verification failed. Restoring...");
    if (renamed) restoreLegacyDir();
    try { copyFileSync(backupPath, configPath); } catch { /* best effort */ }
    console.error("  Previous state restored.");
    throw new Error("Legacy migration failed: post-install verification did not pass");
  }

  // 7. Success: restore channels.dmwork + cleanup
  ensurePluginsAllow();
  restoreChannelConfigFromDisk();

  const restoredCfg = readConfigFromFile();
  if (restoredCfg?.channels?.dmwork) {
    deleteLegacyBackup();
    try { rmSync(backupPath, { force: true }); } catch { /* best effort */ }
  } else {
    console.log("  Warning: channels.dmwork restore may not have succeeded. Keeping backups for safety.");
  }
  console.log("  Legacy migration complete!");
}

// LEGACY-MIGRATION: kept as-is for Phase B reference; not wired into Phase A.
function runDeadlockRepair(spec: string, quiet: boolean): void {
  console.log("Detected config deadlock (channels.dmwork exists but no plugin).");

  const configPath = getConfigFilePathSafe();
  const backupPath = configPath + ".dmwork-upgrade-backup";
  copyFileSync(configPath, backupPath);
  saveChannelConfigToDisk();

  removeChannelConfigFromFile();
  console.log("  Temporarily removed channels.dmwork.");

  try {
    console.log("  Installing openclaw-channel-octo...");
    pluginsInstall(spec, quiet);
  } catch (installErr) {
    console.error("  Install failed! Restoring config...");
    try { copyFileSync(backupPath, configPath); } catch { /* best effort */ }
    throw installErr;
  }

  if (!isHealthyInstall()) {
    console.error("  Install completed but verification failed. Restoring config...");
    try { copyFileSync(backupPath, configPath); } catch { /* best effort */ }
    throw new Error("Deadlock repair failed: post-install verification did not pass");
  }

  ensurePluginsAllow();
  restoreChannelConfigFromDisk();

  const restoredCfg = readConfigFromFile();
  if (restoredCfg?.channels?.dmwork) {
    try { rmSync(backupPath, { force: true }); } catch { /* best effort */ }
    console.log("  Deadlock repaired!");
  } else {
    throw new Error("Deadlock repair incomplete: plugin installed but channels.dmwork could not be restored. Backup kept at " + backupPath);
  }
}

// ---------------------------------------------------------------------------
// Exported for update.ts and doctor.ts to reuse
// ---------------------------------------------------------------------------

export { runLegacyMigration as runLegacyMigrationForUpdate };
export { runDeadlockRepair as runDeadlockRepairForUpdate };
