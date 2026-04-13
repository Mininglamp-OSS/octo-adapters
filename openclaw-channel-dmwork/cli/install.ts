/**
 * install command: install plugin via official CLI + interactive config setup.
 */

import {
  configGet,
  configGetJson,
  configSet,
  configUnset,
  gatewayRestart,
  pluginsInspect,
  pluginsInstall,
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
}

export async function runInstall(opts: InstallOptions): Promise<void> {
  // 1. Pre-check
  ensureOpenClawCompat();

  // 2. Plugin install (delegate to official CLI)
  const inspect = pluginsInspect(PLUGIN_ID);
  if (inspect?.plugin && !opts.force) {
    console.log(
      `DMWork plugin is already installed (v${inspect.plugin.version}). Skipping install.`,
    );
  } else {
    console.log("Installing DMWork plugin...");
    pluginsInstall(PLUGIN_ID, opts.force);
    console.log("Plugin installed successfully.");
  }

  // 3. Legacy config migration
  await migrateLegacyConfig();

  // 4. DMWork config (unless --skip-config)
  if (!opts.skipConfig) {
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
// Legacy config migration
// ---------------------------------------------------------------------------

async function migrateLegacyConfig(): Promise<void> {
  const legacyToken = configGet("channels.dmwork.botToken");
  const accounts = configGetJson("channels.dmwork.accounts");

  // Has top-level botToken but no accounts map → legacy flat config
  if (legacyToken && (!accounts || Object.keys(accounts).length === 0)) {
    console.log("Detected legacy flat config. Migrating to accounts model...");

    // Copy token to accounts.default
    configSet("channels.dmwork.accounts.default.botToken", legacyToken);

    // Copy apiUrl if present
    const legacyApiUrl = configGet("channels.dmwork.apiUrl");
    if (legacyApiUrl) {
      configSet("channels.dmwork.accounts.default.apiUrl", legacyApiUrl);
    }

    // Remove top-level botToken (keep apiUrl as shared default)
    configUnset("channels.dmwork.botToken");

    console.log("Migrated legacy config to accounts.default.");
  }
}

// ---------------------------------------------------------------------------
// Account configuration
// ---------------------------------------------------------------------------

async function configureDmworkAccount(opts: InstallOptions): Promise<void> {
  // Collect accountId
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

  // Check if account already exists
  const existingToken = configGet(
    `channels.dmwork.accounts.${accountId}.botToken`,
  );
  if (existingToken) {
    if (!isInteractive()) {
      // Non-interactive: require both botToken and apiUrl to overwrite
      if (opts.botToken && opts.apiUrl) {
        console.log(`Overwriting existing account "${accountId}".`);
      } else if (opts.botToken || opts.apiUrl) {
        console.error(
          `Error: Account "${accountId}" already exists. Provide both --bot-token and --api-url to overwrite.`,
        );
        process.exit(1);
      } else {
        // No credentials provided at all — keep existing
        console.log(`Account "${accountId}" already configured. Keeping existing config.`);
        ensureDmScope();
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
        return;
      }
    }
  }

  // Collect botToken
  let botToken = opts.botToken;
  if (!botToken) {
    botToken = await prompt("Enter bot token (bf_...):");
  }
  if (!botToken?.startsWith("bf_")) {
    console.error("Error: Bot token must start with 'bf_'.");
    process.exit(1);
  }

  // Collect apiUrl
  let apiUrl = opts.apiUrl;
  if (!apiUrl) {
    apiUrl = await prompt("Enter API server URL:");
  }
  if (!apiUrl) {
    console.error("Error: API URL is required.");
    process.exit(1);
  }

  // Write account config
  configSet(`channels.dmwork.accounts.${accountId}.botToken`, botToken);
  configSet(`channels.dmwork.accounts.${accountId}.apiUrl`, apiUrl);
  console.log(`Configured bot account: ${accountId}`);
  console.log(`  API: ${apiUrl}`);

  ensureDmScope();
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
