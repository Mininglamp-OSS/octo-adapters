/**
 * update command: alias for install.
 * Both install and update do the same thing:
 * not installed → install; installed → check for updates.
 */

import { runInstall, type InstallOptions } from "./install.js";

export interface UpdateOptions {
  json?: boolean;
  dev?: boolean;
}

export async function runUpdate(opts: UpdateOptions): Promise<void> {
  await runInstall({
    dev: opts.dev,
  });
}
