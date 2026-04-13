/**
 * update command: delegate to openclaw plugins update + gateway restart.
 */

import {
  gatewayRestart,
  pluginsInspect,
  pluginsUpdate,
} from "./openclaw-cli.js";
import { PLUGIN_ID, ensureOpenClawCompat } from "./utils.js";

export interface UpdateOptions {
  json?: boolean;
}

export async function runUpdate(opts: UpdateOptions): Promise<void> {
  ensureOpenClawCompat();

  const inspect = pluginsInspect(PLUGIN_ID);
  if (!inspect?.plugin) {
    if (opts.json) {
      console.log(JSON.stringify({ success: false, error: "not_installed" }));
    } else {
      console.error("DMWork plugin is not installed. Use 'install' first.");
    }
    process.exit(1);
  }

  const previousVersion = inspect.plugin.version;

  if (opts.json) {
    // JSON mode: suppress text output, capture everything
    pluginsUpdate(PLUGIN_ID, true);
    gatewayRestart(true);
    const updated = pluginsInspect(PLUGIN_ID);
    console.log(
      JSON.stringify({
        success: true,
        previousVersion,
        currentVersion: updated?.plugin?.version ?? previousVersion,
      }),
    );
  } else {
    console.log("Updating DMWork plugin...");
    pluginsUpdate(PLUGIN_ID);

    console.log("Restarting gateway...");
    if (!gatewayRestart()) {
      console.log(
        "Warning: Gateway restart failed. Run 'openclaw gateway restart' manually.",
      );
    }

    const updated = pluginsInspect(PLUGIN_ID);
    const newVersion = updated?.plugin?.version ?? "unknown";
    if (newVersion === previousVersion) {
      console.log(`Already up to date (v${previousVersion}).`);
    } else {
      console.log(`Updated: v${previousVersion} -> v${newVersion}`);
    }
  }
}
