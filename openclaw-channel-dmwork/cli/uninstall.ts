/**
 * uninstall command: delegate to openclaw plugins uninstall + optional config cleanup.
 */

import {
  configUnset,
  gatewayRestart,
  pluginsUninstall,
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

  console.log("Uninstalling DMWork plugin...");
  pluginsUninstall(PLUGIN_ID, opts.yes);

  if (opts.removeConfig) {
    console.log("Removing channels.dmwork config...");
    configUnset("channels.dmwork");
  } else {
    console.log("Keeping channels.dmwork config (use --remove-config to delete).");
  }

  console.log("Restarting gateway...");
  if (!gatewayRestart()) {
    console.log(
      "Warning: Gateway restart failed. Run 'openclaw gateway restart' manually.",
    );
  }

  console.log("DMWork plugin uninstalled.");
}
