/**
 * CLI entry point: register 5 subcommands with commander.
 */

import { Command } from "commander";
import { runInstall } from "./install.js";
import { runUpdate } from "./update.js";
import {
  cliConfigReader,
  formatDoctorResult,
  runDoctorChecks,
} from "./doctor.js";
import { runUninstall } from "./uninstall.js";
import { runRemoveAccount } from "./remove-account.js";
import { ensureOpenClawCompat } from "./utils.js";

const program = new Command();

program
  .name("openclaw-channel-dmwork")
  .description("DMWork channel plugin CLI for OpenClaw")
  .version("0.5.19");

// --- install ---
program
  .command("install")
  .description("Install the DMWork plugin and configure a bot account")
  .option("--bot-token <token>", "Bot token (starts with bf_)")
  .option("--api-url <url>", "API server URL")
  .option("--account-id <id>", "Account ID (required in non-interactive mode)")
  .option("--skip-config", "Skip bot configuration", false)
  .option("--force", "Force reinstall", false)
  .action(async (opts) => {
    await runInstall({
      botToken: opts.botToken,
      apiUrl: opts.apiUrl,
      accountId: opts.accountId,
      skipConfig: opts.skipConfig,
      force: opts.force,
    });
  });

// --- update ---
program
  .command("update")
  .description("Update the DMWork plugin to the latest version")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    await runUpdate({ json: opts.json });
  });

// --- doctor ---
program
  .command("doctor")
  .description("Diagnose DMWork plugin health")
  .option("--account-id <id>", "Check a specific account only")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    ensureOpenClawCompat();
    const result = await runDoctorChecks({
      reader: cliConfigReader,
      accountId: opts.accountId,
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatDoctorResult(result));
    }
  });

// --- uninstall ---
program
  .command("uninstall")
  .description("Uninstall the DMWork plugin")
  .option("--remove-config", "Also remove channels.dmwork config", false)
  .option("--yes", "Skip confirmation", false)
  .action(async (opts) => {
    await runUninstall({
      removeConfig: opts.removeConfig,
      yes: opts.yes,
    });
  });

// --- remove-account ---
program
  .command("remove-account")
  .description("Remove a single bot account config")
  .requiredOption("--account-id <id>", "Account ID to remove")
  .option("--yes", "Skip confirmation", false)
  .action(async (opts) => {
    await runRemoveAccount({
      accountId: opts.accountId,
      yes: opts.yes,
    });
  });

program.parse();
