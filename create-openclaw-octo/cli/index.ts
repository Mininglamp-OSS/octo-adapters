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
import { PLUGIN_ID, renderInstallStatusBanner } from "./utils.js";
import { getOpenClawVersionStrict, resolvePluginState } from "./openclaw-cli.js";
import { PLUGIN_VERSION } from "./version.js";

const program = new Command();

program
  .name("create-openclaw-octo")
  .description("Octo channel plugin CLI for OpenClaw")
  .version(PLUGIN_VERSION);

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

    console.log(`${b}create-openclaw-octo:${r} ${g}${PLUGIN_VERSION}${r}`);
    console.log(`${b}openclaw:${r} ${g}${openclawVersion}${r}`);
    console.log(`${b}installed plugin id:${r} ${g}${PLUGIN_ID}${r} (ClawHub)`);
    console.log(`${b}installed plugin version:${r} ${g}${installedVersion}${r}`);
    console.log();
    console.log(`${b}Environment:${r}`);
    console.log(`${b}OS:${r} ${g}${process.platform} ${process.arch}${r}`);
    console.log(`${b}Node.js:${r} ${g}${process.version}${r}`);
    console.log(`${b}Shell:${r} ${g}${process.env.SHELL ?? "unknown"}${r}`);
  });

// --- install ---
program
  .command("install")
  .description("Install or update the Octo plugin")
  .option("--force", "Force reinstall", false)
  .option(
    "--next",
    "[v2.0.0+ no-op] Previously selected npm @next dist-tag. ClawHub installs use a single channel; use --from <tarball> for pre-release testing.",
    false,
  )
  .option(
    "--from <spec>",
    "Override install spec (tarball path or alternate `openclaw plugins install` spec). Pre-publish local testing.",
  )
  .addOption(new Option("--dev").hideHelp().default(false))
  .action(async (opts) => {
    await runInstall({
      force: opts.force,
      dev: opts.dev,
      next: opts.next,
      from: opts.from,
    });
  });

// --- update (alias for install) ---
program
  .command("update")
  .description("Update the Octo plugin (alias for install)")
  .option(
    "--next",
    "[v2.0.0+ no-op] Previously selected npm @next dist-tag. ClawHub installs use a single channel; use `install --from <tarball>` for pre-release testing.",
    false,
  )
  .addOption(new Option("--dev").hideHelp().default(false))
  .action(async (opts) => {
    await runUpdate({ dev: opts.dev, next: opts.next });
  });

// --- bind ---
program
  .command("bind")
  .description("Configure a bot account and bind it to an agent")
  .requiredOption("--bot-token <token>", "Bot token (starts with bf_ or app_)")
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
  .description("Diagnose Octo plugin health")
  .option("--account-id <id>", "Check a specific account only")
  .option("--fix", "Attempt to automatically fix issues", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const result = await runDoctorChecks({
      reader: cliConfigReader,
      accountId: opts.accountId,
      fix: opts.fix,
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      // Render upgrade-status banner first (only when there's actually an
      // issue to surface — null on the healthy path).
      const banner = renderInstallStatusBanner();
      if (banner) {
        console.error(banner);
        console.error("");
      }
      console.log(formatDoctorResult(result));
    }
  });

// --- uninstall ---
program
  .command("uninstall")
  .description("Uninstall the Octo plugin and remove all bot configs")
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

export function main(argv?: readonly string[]): void {
  // parseAsync + top-level catch so unhandled errors from any sub-command
  // surface as a clean message instead of a Node stack trace. Two side
  // benefits:
  //   (a) `pluginsInstall()` rewraps ClawHub timeouts with friendly text
  //       (issue #90) and stashes the raw error in `Error.cause`. Without
  //       a top-level handler, Node's default unhandled-rejection printer
  //       walks the cause chain and re-emits the raw upstream stderr —
  //       which can carry sensitive content. Logging only `err.message`
  //       keeps `cause` available to programmatic callers / debug runs
  //       without leaking it to terminal output.
  //   (b) Plain `Error` thrown from sub-commands no longer prints stack
  //       frames in normal use; set `OPENCLAW_OCTO_DEBUG=1` to see the
  //       full chain when debugging.
  program.parseAsync(argv as string[] | undefined).catch((err: unknown) => {
    // Defensively handle non-Error rejections (e.g. `Promise.reject(null)`,
    // `Promise.reject("string")`). Without this guard, reading `err.message`
    // / `err.cause` on a primitive would throw inside the handler.
    if (err instanceof Error) {
      const e = err as Error & { cause?: unknown };
      if (process.env.OPENCLAW_OCTO_DEBUG) {
        console.error(e.stack ?? e.message);
        if (e.cause !== undefined) console.error("Caused by:", e.cause);
      } else {
        console.error(e.message);
      }
    } else {
      console.error(String(err));
    }
    process.exit(1);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
