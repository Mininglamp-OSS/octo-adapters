/**
 * CLI entry point: register subcommands with commander.
 */

import { Command, Option } from "commander";
import { runInstall } from "./install.js";
import { runUpdate } from "./update.js";
import { runBind } from "./bind.js";
import { runQuickstart } from "./quickstart.js";
import {
  cliConfigReader,
  formatDoctorResult,
  runDoctorChecks,
} from "./doctor.js";
import { runUninstall } from "./uninstall.js";
import { runRemoveAccount } from "./remove-account.js";
import { ensureOpenClawCompat, PLUGIN_ID } from "./utils.js";
import { getOpenClawVersionStrict, resolvePluginState } from "./openclaw-cli.js";
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
    let openclawVersion: string;
    try {
      openclawVersion = getOpenClawVersionStrict() ?? "not found";
    } catch (err) {
      openclawVersion = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
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
  .description("Install or update the DMWork plugin")
  .option("--force", "Force reinstall", false)
  .addOption(new Option("--dev").hideHelp().default(false))
  .action(async (opts) => {
    await runInstall({
      force: opts.force,
      dev: opts.dev,
    });
  });

// --- update (alias for install) ---
program
  .command("update")
  .description("Update the DMWork plugin (alias for install)")
  .addOption(new Option("--dev").hideHelp().default(false))
  .action(async (opts) => {
    await runUpdate({ dev: opts.dev });
  });

// --- bind ---
program
  .command("bind")
  .description("Configure a bot account and bind it to an agent")
  .requiredOption("--bot-token <token>", "Bot token (starts with bf_)")
  .requiredOption("--api-url <url>", "API server URL")
  .requiredOption("--account-id <id>", "Bot account ID")
  .requiredOption("--agent <agent>", "Agent identifier to bind to")
  .action(async (opts) => {
    await runBind({
      botToken: opts.botToken,
      apiUrl: opts.apiUrl,
      accountId: opts.accountId,
      agent: opts.agent,
    });
  });

// --- quickstart ---
program
  .command("quickstart")
  .description("Create bots for all agents and bind them (one-time setup)")
  .requiredOption("--api-key <key>", "User API key (starts with uk_)")
  .requiredOption("--api-url <url>", "API server URL")
  .action(async (opts) => {
    await runQuickstart({
      apiKey: opts.apiKey,
      apiUrl: opts.apiUrl,
    });
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
