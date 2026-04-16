/**
 * CLI entry point: register 5 subcommands with commander.
 */

import { Command, Option } from "commander";
import { runInstall } from "./install.js";
import { runUpdate } from "./update.js";
import {
  cliConfigReader,
  formatDoctorResult,
  runDoctorChecks,
} from "./doctor.js";
import { runUninstall } from "./uninstall.js";
import { runRemoveAccount } from "./remove-account.js";
import { ensureOpenClawCompat, PLUGIN_ID } from "./utils.js";
import { getOpenClawVersion, resolvePluginState } from "./openclaw-cli.js";
import { createRequire } from "node:module";

const program = new Command();

const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json");

program
  .name("openclaw-channel-dmwork")
  .description("DMWork channel plugin CLI for OpenClaw")
  .version(_pkg.version);

// --- info ---
program
  .command("info")
  .description("Show CLI and plugin version info")
  .action(() => {
    const openclawVersion = getOpenClawVersion() ?? "not found";
    const state = resolvePluginState(PLUGIN_ID);
    let installedVersion = "not installed";
    if (state.installed && state.version) {
      installedVersion = state.version;
      if (state.source === "fallback" && state.inspectFailReason === "unsupported") {
        installedVersion += " (fallback; plugins inspect unsupported on this OpenClaw version)";
      } else if (state.source === "fallback") {
        installedVersion += " (fallback; plugins inspect failed)";
      }
    } else if (state.installed) {
      installedVersion = "installed (version unknown)";
    }

    const b = "\x1b[1m";
    const g = "\x1b[32m";
    const r = "\x1b[0m";

    console.log(`${b}openclaw-channel-dmwork-cli:${r} ${g}${_pkg.version}${r}`);
    console.log(`${b}openclaw:${r} ${g}${openclawVersion}${r}`);
    console.log(`${b}openclaw-channel-dmwork:${r} ${g}${installedVersion}${r}`);
    console.log(`${b}plugin package:${r} ${g}${PLUGIN_ID}${r}`);
    console.log();
    console.log(`${b}环境信息：${r}`);
    console.log(`${b}OS:${r} ${g}${process.platform} ${process.arch}${r}`);
    console.log(`${b}Node.js:${r} ${g}${process.version}${r}`);
    console.log(`${b}Shell:${r} ${g}${process.env.SHELL ?? "unknown"}${r}`);
  });

// --- install ---
program
  .command("install")
  .description("Install the DMWork plugin and configure a bot account")
  .option("--bot-token <token>", "Bot token (starts with bf_)")
  .option("--api-url <url>", "API server URL")
  .option("--account-id <id>", "Account ID (required in non-interactive mode)")
  .option("--skip-config", "Skip bot configuration", false)
  .option("--force", "Force reinstall", false)
  .addOption(new Option("--dev").hideHelp().default(false))
  .action(async (opts) => {
    await runInstall({
      botToken: opts.botToken,
      apiUrl: opts.apiUrl,
      accountId: opts.accountId,
      skipConfig: opts.skipConfig,
      force: opts.force,
      dev: opts.dev,
    });
  });

// --- update ---
program
  .command("update")
  .description("Update the DMWork plugin to the latest version")
  .option("--json", "Output JSON", false)
  .addOption(new Option("--dev").hideHelp().default(false))
  .action(async (opts) => {
    await runUpdate({ json: opts.json, dev: opts.dev });
  });

// --- doctor ---
program
  .command("doctor")
  .description("Diagnose DMWork plugin health")
  .option("--account-id <id>", "Check a specific account only")
  .option("--fix", "Attempt to automatically fix issues", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    ensureOpenClawCompat();
    const result = await runDoctorChecks({
      reader: cliConfigReader,
      accountId: opts.accountId,
      fix: opts.fix,
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
  .description("Uninstall the DMWork plugin and remove all bot configs")
  .option("--yes", "Skip confirmation", false)
  .action(async (opts) => {
    await runUninstall({ yes: opts.yes });
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
