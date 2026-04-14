/**
 * uninstall command: delegate to openclaw plugins uninstall.
 * Removes plugin + all channels.dmwork config (openclaw CLI does this automatically).
 */

import {
  gatewayRestart,
  pluginsInspect,
  pluginsUninstall,
  removeChannelConfigFromFile,
} from "./openclaw-cli.js";
import { PLUGIN_ID, confirm, ensureOpenClawCompat } from "./utils.js";

export interface UninstallOptions {
  yes?: boolean;
}

export async function runUninstall(opts: UninstallOptions): Promise<void> {
  ensureOpenClawCompat();

  if (!opts.yes) {
    const ok = await confirm(
      "Uninstall DMWork plugin? All bot configs will be removed.",
    );
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

  // Remove channels.dmwork directly from file before uninstall to avoid
  // config validation errors ("unknown channel id: dmwork")
  removeChannelConfigFromFile();

  console.log("Uninstalling DMWork plugin...");
  const inspect = pluginsInspect(PLUGIN_ID);
  if (inspect?.plugin) {
    pluginsUninstall(PLUGIN_ID, opts.yes);
  } else {
    console.log("Plugin not installed. Skipping.");
  }

  console.log("Restarting gateway...");
  if (!gatewayRestart()) {
    console.log(
      "Warning: Gateway restart failed. Run 'openclaw gateway restart' manually.",
    );
  }

  console.log("DMWork plugin uninstalled.");
}
