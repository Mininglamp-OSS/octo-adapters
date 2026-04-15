/**
 * install command: install plugin via official CLI + interactive config setup.
 *
 * Only manages channels.dmwork account config. Agent creation (binding,
 * workspace, agent.md) is left to the user via `openclaw agents add`.
 */

import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  cleanupLegacyPlugin,
  cleanupStalePluginDir,
  configGet,
  configGetJson,
  configSet,
  configUnset,
  gatewayRestart,
  pluginsInspect,
  pluginsInstall,
  readConfigFromFile,
  removeChannelConfigFromFile,
  restoreChannelConfigToFile,
  saveChannelConfigFromFile,
  getConfigFilePathSafe,
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
  // 1. Pre-check
  ensureOpenClawCompat();

  // 2. Safe install (handles legacy cleanup, deadlock, stale dirs)
  const inspect = pluginsInspect(PLUGIN_ID);
  if (inspect?.plugin && !opts.force) {
    console.log(
      `DMWork plugin is already installed (v${inspect.plugin.version}). Skipping install.`,
    );
  } else {
    const spec = opts.dev ? `${PLUGIN_ID}@dev` : PLUGIN_ID;
    runSafeInstall(spec, opts.force);
  }

  // 3. Legacy config migration + 4. DMWork config (unless --skip-config)
  if (!opts.skipConfig) {
    await migrateLegacyConfig();
    await configureDmworkAccount(opts);
  }

  // 5. Gateway restart
  console.log("Restarting gateway...");
  if (!gatewayRestart()) {
    console.log(
      "Warning: Gateway restart failed. Run 'openclaw gateway restart' manually.",
    );
  }

  // 6. Success
  console.log("\nDMWork plugin setup complete!");
}

// ---------------------------------------------------------------------------
// Safe install: handles legacy cleanup, config deadlock, stale dirs
// ---------------------------------------------------------------------------

/**
 * Shared install logic used by both install and update commands.
 * Handles: legacy plugin cleanup, stale directory cleanup,
 * config deadlock (chicken-egg problem), and --force retry.
 */
export function runSafeInstall(spec: string, force?: boolean, quiet?: boolean): void {
  const log = quiet ? (() => {}) : console.log.bind(console);
  // 1. Clean up legacy "dmwork" plugin
  const legacyActions = cleanupLegacyPlugin();
  if (legacyActions.length > 0) {
    log("Cleaned up legacy DMWork plugin:");
    legacyActions.forEach((a) => log(`  ${a}`));
  }

  // 2. Clean up stale openclaw-channel-dmwork directory
  const staleActions = cleanupStalePluginDir();
  if (staleActions.length > 0) {
    log("Cleaned up stale plugin directory:");
    staleActions.forEach((a) => log(`  ${a}`));
  }

  // 3. Handle config deadlock (chicken-egg problem):
  //    channels.dmwork exists but plugin not installed → config validation blocks install
  const cfg = readConfigFromFile();
  const hasDmworkChannel = Boolean(cfg?.channels?.dmwork);
  const hasStaleEntries = Boolean(cfg?.plugins?.entries?.["openclaw-channel-dmwork"]);
  const hasStaleInstalls = Boolean(cfg?.plugins?.installs?.["openclaw-channel-dmwork"]);

  // Only enter deadlock fix if plugin is genuinely not present:
  // - inspect returns null AND plugin directory doesn't exist on disk
  // This prevents treating "inspect anomaly + plugin still running" as deadlock
  const inspectResult = pluginsInspect(PLUGIN_ID);
  const extensionsDir = getConfigFilePathSafe().replace(/openclaw\.json$/, "extensions");
  const pluginDirExists = existsSync(resolve(extensionsDir, "openclaw-channel-dmwork"));
  const pluginGenuinelyMissing = !inspectResult?.plugin && !pluginDirExists;
  const needsDeadlockFix = hasDmworkChannel && pluginGenuinelyMissing;

  if (needsDeadlockFix) {
    log("Detected config deadlock (channels.dmwork exists but plugin not installed).");
    log("Temporarily removing stale config to allow installation...");

    // Backup full config file for disaster recovery
    const configPath = getConfigFilePathSafe();
    const backupPath = configPath + ".dmwork-upgrade-backup";
    copyFileSync(configPath, backupPath);

    // Save channels.dmwork for restore after install
    const savedDmwork = saveChannelConfigFromFile();

    // Temporarily remove stale config entries
    removeChannelConfigFromFile();
    if (hasStaleEntries) {
      try {
        const c = readConfigFromFile();
        if (c?.plugins?.entries?.["openclaw-channel-dmwork"]) {
          delete c.plugins.entries["openclaw-channel-dmwork"];
          copyFileSync(configPath, configPath + ".bak");
          writeFileSync(configPath, JSON.stringify(c, null, 2), "utf-8");
        }
      } catch { /* best effort */ }
    }
    if (hasStaleInstalls) {
      try {
        const c = readConfigFromFile();
        if (c?.plugins?.installs?.["openclaw-channel-dmwork"]) {
          delete c.plugins.installs["openclaw-channel-dmwork"];
          writeFileSync(configPath, JSON.stringify(c, null, 2), "utf-8");
        }
      } catch { /* best effort */ }
    }

    try {
      log(`Installing DMWork plugin...`);
      pluginsInstall(spec, quiet, force);
      log("Plugin installed successfully.");
      // Success: patch channels.dmwork back (preserves new entries/installs from plugins install)
      if (savedDmwork) {
        restoreChannelConfigToFile(savedDmwork);
        log("Restored channels.dmwork config.");
      }
    } catch (installErr) {
      // Install failed: restore full config from backup to avoid leaving user worse off
      console.error("Plugin install failed. Restoring original config...");
      try {
        copyFileSync(backupPath, configPath);
        log("Original config restored from backup.");
      } catch {
        console.error(`Warning: Could not restore backup. Manual restore: cp ${backupPath} ${configPath}`);
      }
      throw installErr;
    }
  } else {
    // Normal install path (no deadlock)
    try {
      log(`Installing DMWork plugin...`);
      pluginsInstall(spec, quiet, force);
      log("Plugin installed successfully.");
    } catch (err) {
      // If "already exists" → retry with --force
      const msg = String(err);
      if (msg.includes("already exists") && !force) {
        log("Plugin directory exists, retrying with --force...");
        pluginsInstall(spec, quiet, true);
        log("Plugin installed successfully (forced).");
      } else {
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy config migration
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
    console.error(
      `Error: Invalid account ID "${accountId}". Only letters, digits, and underscores are allowed.`,
    );
    process.exit(1);
  }

  const existingToken = configGet(
    `channels.dmwork.accounts.${accountId}.botToken`,
  );
  if (existingToken) {
    if (!isInteractive()) {
      if (opts.botToken && opts.apiUrl) {
        console.log(`Overwriting existing account "${accountId}".`);
      } else if (opts.botToken || opts.apiUrl) {
        console.error(
          `Error: Account "${accountId}" already exists. Provide both --bot-token and --api-url to overwrite.`,
        );
        process.exit(1);
      } else {
        console.log(`Account "${accountId}" already configured. Keeping existing config.`);
        ensureDmScope();
        printAgentHint(accountId);
        return;
      }
    } else {
      const keep = await confirm(
        `Bot account "${accountId}" is already configured. Keep current config?`,
        true,
      );
      if (keep) {
        console.log("Keeping existing config.");
        ensureDmScope();
        printAgentHint(accountId);
        return;
      }
    }
  }

  let botToken = opts.botToken;
  if (!botToken) {
    botToken = await prompt("Enter bot token (bf_...):");
  }
  if (!botToken?.startsWith("bf_")) {
    console.error("Error: Bot token must start with 'bf_'.");
    process.exit(1);
  }

  let apiUrl = opts.apiUrl;
  if (!apiUrl) {
    apiUrl = await prompt("Enter API server URL:");
  }
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

// ---------------------------------------------------------------------------
// session.dmScope
// ---------------------------------------------------------------------------

function ensureDmScope(): void {
  const current = configGet("session.dmScope");
  if (!current) {
    configSet("session.dmScope", RECOMMENDED_DM_SCOPE);
  } else if (current !== RECOMMENDED_DM_SCOPE) {
    console.log(
      `Warning: session.dmScope is "${current}" (recommended: ${RECOMMENDED_DM_SCOPE})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Agent hint
// ---------------------------------------------------------------------------

function printAgentHint(accountId: string): void {
  const agentName = accountId.replace(/_bot$/, "");
  console.log(`
To create an independent agent for this bot (optional):
  openclaw agents add ${agentName}
  openclaw agents bind ${agentName} dmwork ${accountId}`);
}
