/**
 * install command: install plugin via official CLI + interactive config setup.
 *
 * Handles 4 upgrade scenarios:
 * 1. Legacy migration (dmwork → openclaw-channel-dmwork)
 * 2. Normal update (openclaw-channel-dmwork → openclaw-channel-dmwork)
 * 3. Fresh install (nothing installed)
 * 4. Deadlock repair (channels.dmwork exists but no plugin)
 * + broken install cleanup
 */

import { copyFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  cleanupBrokenInstall,
  configGet,
  configGetJson,
  configSet,
  configUnset,
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
  saveChannelConfigFromFile,
  restoreChannelConfigToFile,
} from "./openclaw-cli.js";
import {
  PLUGIN_ID,
  RECOMMENDED_DM_SCOPE,
  confirm,
  ensureOpenClawCompat,
  isInteractive,
  prompt,
  validateAccountId,
} from "./utils.js";

export interface InstallOptions {
  botToken?: string;
  apiUrl?: string;
  accountId?: string;
  skipConfig?: boolean;
  force?: boolean;
  dev?: boolean;
}

export async function runInstall(opts: InstallOptions): Promise<void> {
  ensureOpenClawCompat();

  const scenario = detectScenario();
  const spec = opts.dev ? `${PLUGIN_ID}@dev` : PLUGIN_ID;
  const quiet = false;

  switch (scenario) {
    case "legacy":
      runLegacyMigration(spec, quiet, opts.force, opts.skipConfig);
      break;
    case "update": {
      const inspect = pluginsInspect(PLUGIN_ID);
      if (inspect?.plugin && !opts.force) {
        console.log(`DMWork plugin is already installed (v${inspect.plugin.version}). Skipping install.`);
      } else {
        console.log(`Installing DMWork plugin${opts.dev ? " (dev)" : ""}...`);
        pluginsInstall(spec, quiet, opts.force);
        console.log("Plugin installed successfully.");
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
      runDeadlockRepair(spec, quiet, opts.skipConfig);
      break;
    case "fresh":
      console.log(`Installing DMWork plugin${opts.dev ? " (dev)" : ""}...`);
      pluginsInstall(spec, quiet, opts.force);
      console.log("Plugin installed successfully.");
      break;
  }

  // Post-install: config + gateway
  if (!opts.skipConfig) {
    await migrateLegacyConfig();
    await configureDmworkAccount(opts);
  }

  console.log("Restarting gateway...");
  if (!gatewayRestart()) {
    console.log("Warning: Gateway restart failed. Run 'openclaw gateway restart' manually.");
  }

  console.log("\nDMWork plugin setup complete!");
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
  } else {
    console.log("  Warning: channels.dmwork restore may not have succeeded. Keeping backup for safety.");
  }
  console.log("  Deadlock repaired!");
}

// ---------------------------------------------------------------------------
// Exported for update.ts to reuse
// ---------------------------------------------------------------------------

export { runLegacyMigration as runLegacyMigrationForUpdate };
export { runDeadlockRepair as runDeadlockRepairForUpdate };

// ---------------------------------------------------------------------------
// Legacy config migration (flat → accounts)
// ---------------------------------------------------------------------------

async function migrateLegacyConfig(): Promise<void> {
  const legacyToken = configGet("channels.dmwork.botToken");
  const accounts = configGetJson("channels.dmwork.accounts");

  if (legacyToken && (!accounts || Object.keys(accounts).length === 0)) {
    console.log("Detected legacy flat config. Migrating to accounts model...");
    configSet("channels.dmwork.accounts.default.botToken", legacyToken);
    const legacyApiUrl = configGet("channels.dmwork.apiUrl");
    if (legacyApiUrl) {
      configSet("channels.dmwork.accounts.default.apiUrl", legacyApiUrl);
    }
    configUnset("channels.dmwork.botToken");
    console.log("Migrated legacy config to accounts.default.");
  }
}

// ---------------------------------------------------------------------------
// Account configuration
// ---------------------------------------------------------------------------

async function configureDmworkAccount(opts: InstallOptions): Promise<void> {
  let accountId = opts.accountId;
  if (!accountId) {
    accountId = await prompt("Enter bot account ID (e.g. my_bot):");
    if (!accountId) {
      console.log("No account ID provided. Skipping config.");
      return;
    }
  }

  if (!validateAccountId(accountId)) {
    console.error(`Error: Invalid account ID "${accountId}". Only letters, digits, and underscores are allowed.`);
    process.exit(1);
  }

  const existingToken = configGet(`channels.dmwork.accounts.${accountId}.botToken`);
  if (existingToken) {
    if (!isInteractive()) {
      if (opts.botToken && opts.apiUrl) {
        console.log(`Overwriting existing account "${accountId}".`);
      } else if (opts.botToken || opts.apiUrl) {
        console.error(`Error: Account "${accountId}" already exists. Provide both --bot-token and --api-url to overwrite.`);
        process.exit(1);
      } else {
        console.log(`Account "${accountId}" already configured. Keeping existing config.`);
        ensureDmScope();
        printAgentHint(accountId);
        return;
      }
    } else {
      const keep = await confirm(`Bot account "${accountId}" is already configured. Keep current config?`, true);
      if (keep) {
        console.log("Keeping existing config.");
        ensureDmScope();
        printAgentHint(accountId);
        return;
      }
    }
  }

  let botToken = opts.botToken;
  if (!botToken) botToken = await prompt("Enter bot token (bf_...):");
  if (!botToken?.startsWith("bf_")) {
    console.error("Error: Bot token must start with 'bf_'.");
    process.exit(1);
  }

  let apiUrl = opts.apiUrl;
  if (!apiUrl) apiUrl = await prompt("Enter API server URL:");
  if (!apiUrl) {
    console.error("Error: API URL is required.");
    process.exit(1);
  }

  configSet(`channels.dmwork.accounts.${accountId}.botToken`, botToken);
  configSet(`channels.dmwork.accounts.${accountId}.apiUrl`, apiUrl);
  console.log(`Configured bot account: ${accountId}`);
  console.log(`  API: ${apiUrl}`);

  ensureDmScope();
  printAgentHint(accountId);
}

function ensureDmScope(): void {
  const current = configGet("session.dmScope");
  if (!current) {
    configSet("session.dmScope", RECOMMENDED_DM_SCOPE);
  } else if (current !== RECOMMENDED_DM_SCOPE) {
    console.log(`Warning: session.dmScope is "${current}" (recommended: ${RECOMMENDED_DM_SCOPE})`);
  }
}

function printAgentHint(accountId: string): void {
  const agentName = accountId.replace(/_bot$/, "");
  console.log(`\nTo create an independent agent for this bot (optional):\n  openclaw agents add ${agentName}\n  openclaw agents bind ${agentName} dmwork ${accountId}`);
}
