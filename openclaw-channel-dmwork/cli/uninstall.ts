/**
 * uninstall command: delegate to openclaw plugins uninstall + config preservation.
 *
 * IMPORTANT: openclaw plugins uninstall deletes channels.dmwork along with the
 * plugin. We save the config by reading the JSON file directly before uninstall,
 * then write it back afterwards. We cannot use openclaw config get/set because:
 * - get redacts secrets (botToken becomes __OPENCLAW_REDACTED__)
 * - set rejects channels.dmwork after uninstall ("unknown channel id")
 */

import {
  gatewayRestart,
  pluginsUninstall,
  saveChannelConfigFromFile,
  restoreChannelConfigToFile,
} from "./openclaw-cli.js";
import { PLUGIN_ID, confirm, ensureOpenClawCompat } from "./utils.js";

export interface UninstallOptions {
  removeConfig?: boolean;
  yes?: boolean;
}

export async function runUninstall(opts: UninstallOptions): Promise<void> {
  ensureOpenClawCompat();

  if (!opts.yes) {
    const ok = await confirm(
      "Uninstall DMWork plugin? All bots will stop working.",
    );
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

  // Save channels.dmwork config BEFORE uninstall (reading file directly to preserve secrets)
  const savedConfig = opts.removeConfig
    ? null
    : saveChannelConfigFromFile();

  try {
    console.log("Uninstalling DMWork plugin...");
    pluginsUninstall(PLUGIN_ID, opts.yes);
  } finally {
    // Always restore config, even if uninstall fails partway through
    if (!opts.removeConfig && savedConfig) {
      restoreChannelConfigToFile(savedConfig);
      console.log("Restored channels.dmwork config.");
    }
  }

  if (opts.removeConfig) {
    console.log("Removed channels.dmwork config.");
  }

  console.log("Restarting gateway...");
  if (!gatewayRestart()) {
    console.log(
      "Warning: Gateway restart failed. Run 'openclaw gateway restart' manually.",
    );
  }

  console.log("DMWork plugin uninstalled.");
}
