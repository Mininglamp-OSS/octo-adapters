/**
 * remove-account command: delete a single bot account config without touching the plugin.
 */

import {
  configGet,
  configGetJson,
  configUnset,
  gatewayRestart,
  pluginsUninstall,
} from "./openclaw-cli.js";
import {
  PLUGIN_ID,
  confirm,
  ensureOpenClawCompat,
  validateAccountId,
} from "./utils.js";

export interface RemoveAccountOptions {
  accountId: string;
  yes?: boolean;
}

export async function runRemoveAccount(
  opts: RemoveAccountOptions,
): Promise<void> {
  ensureOpenClawCompat();

  if (!validateAccountId(opts.accountId)) {
    console.error(
      `Error: Invalid account ID "${opts.accountId}". Only letters, digits, and underscores are allowed.`,
    );
    process.exit(1);
  }

  // Check if account exists
  const token = configGet(
    `channels.dmwork.accounts.${opts.accountId}.botToken`,
  );
  if (!token) {
    console.error(`Error: Account "${opts.accountId}" does not exist.`);
    process.exit(1);
  }

  if (!opts.yes) {
    const ok = await confirm(
      `Delete bot account "${opts.accountId}"?`,
    );
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

  // Delete account
  configUnset(`channels.dmwork.accounts.${opts.accountId}`);
  console.log(`Removed account: ${opts.accountId}`);

  // Check remaining accounts
  const remaining = configGetJson("channels.dmwork.accounts");
  const remainingCount = remaining ? Object.keys(remaining).length : 0;

  if (remainingCount === 0) {
    let shouldUninstall = false;
    if (opts.yes) {
      shouldUninstall = true;
    } else {
      shouldUninstall = await confirm(
        "No active bot accounts remaining. Uninstall the plugin?",
      );
    }
    if (shouldUninstall) {
      // Clean up channels.dmwork before uninstall to avoid "unknown channel id"
      // residue that would block future installs
      configUnset("channels.dmwork");
      pluginsUninstall(PLUGIN_ID, true);
      console.log("Plugin uninstalled.");
    }
  }

  console.log("Restarting gateway...");
  if (!gatewayRestart()) {
    console.log(
      "Warning: Gateway restart failed. Run 'openclaw gateway restart' manually.",
    );
  }
}
