/**
 * uninstall command: delegate to openclaw plugins uninstall.
 * Removes plugin + all channels.<CHANNEL_ID> config (openclaw CLI does this
 * automatically). Phase A boundary: legacy channels.dmwork is left intact.
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
      "Uninstall Octo plugin? All bot configs will be removed.",
    );
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

  // Remove the current channel config (channels.<CHANNEL_ID>) directly from file
  // before uninstall to avoid config validation errors ("unknown channel id"
  // residue would block future installs). Defaults to CHANNEL_ID — legacy
  // channels.dmwork (if any) is intentionally untouched (Phase A boundary).
  removeChannelConfigFromFile();

  console.log("Uninstalling Octo plugin...");
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

  console.log("Octo plugin uninstalled.");
}
