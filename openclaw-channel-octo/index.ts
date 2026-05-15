/**
 * openclaw-channel-octo
 *
 * OpenClaw channel plugin for Octo messaging platform.
 * Connects via WuKongIM WebSocket for real-time messaging.
 *
 * Slash commands are registered under both the new `/octo_*` names and the
 * deprecated `/dmwork_*` aliases (one release cycle for backward compat).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { execFileSync } from "node:child_process";
import { dmworkPlugin } from "./src/channel.js";
import { setDmworkRuntime } from "./src/runtime.js";
import { getGroupMdForPrompt } from "./src/group-md.js";
import { pendingInboundContext } from "./src/inbound.js";
import {
  inProcessConfigReader,
  runDoctorChecks,
  formatDoctorResult,
} from "./cli/doctor.js";
import {
  getOpenClawVersion,
  pluginsInspect,
  configGet,
  configGetJson,
  configSet,
  configUnset,
  gatewayRestart,
  pluginsInstall,
  pluginsUninstall,
  removeChannelConfigFromFile,
} from "./cli/openclaw-cli.js";
import {
  PLUGIN_ID,
  CHANNEL_ID,
  LEGACY_CHANNEL_ID,
  RECOMMENDED_DM_SCOPE,
  validateAccountId,
  channelConfigPath,
} from "./cli/utils.js";

// ---------------------------------------------------------------------------
// Command handlers (reused by /octo_* main and /dmwork_* legacy aliases)
// ---------------------------------------------------------------------------

async function handleDoctor(ctx: any) {
  const reader = inProcessConfigReader(ctx.config);
  const result = await runDoctorChecks({
    reader,
    accountId: ctx.args?.trim() || undefined,
    inProcess: true,
  });
  return { text: formatDoctorResult(result) };
}

async function handleInfo() {
  const openclawVersion = getOpenClawVersion() ?? "not found";
  const inspect = pluginsInspect(PLUGIN_ID);
  const installedVersion = inspect?.plugin?.version ?? "not installed";
  return {
    text: [
      `${PLUGIN_ID}: ${installedVersion}`,
      `openclaw: ${openclawVersion}`,
      `plugin package: ${PLUGIN_ID}`,
    ].join("\n"),
  };
}

async function handleInstall(ctx: any) {
  const args = ctx.args?.trim() ?? "";
  const force = args.includes("--force");
  try {
    const inspect = pluginsInspect(PLUGIN_ID);
    if (inspect?.plugin && !force) {
      return { text: `Octo plugin already installed (v${inspect.plugin.version}). Use --force to reinstall.` };
    }
    pluginsInstall(PLUGIN_ID, true, force);
    gatewayRestart(true);
    const after = pluginsInspect(PLUGIN_ID);
    return { text: `Octo plugin installed (v${after?.plugin?.version ?? "unknown"}). Gateway restarted.` };
  } catch (e) {
    return { text: `Install failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}

async function handleUpdate() {
  try {
    const inspect = pluginsInspect(PLUGIN_ID);
    if (!inspect?.plugin) {
      return { text: "Octo plugin is not installed. Use /octo_install first.", isError: true };
    }
    const currentVersion = inspect.plugin.version;
    const targetVersion = execFileSync("npm", ["view", `${PLUGIN_ID}@latest`, "version"], {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (currentVersion === targetVersion) {
      return { text: `Already up to date (v${currentVersion}).` };
    }
    pluginsInstall(`${PLUGIN_ID}@latest`, true, true);
    gatewayRestart(true);
    return { text: `Updated: v${currentVersion} -> v${targetVersion}. Gateway restarted.` };
  } catch (e) {
    return { text: `Update failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}

async function handleUninstall() {
  try {
    removeChannelConfigFromFile(CHANNEL_ID);
    pluginsUninstall(PLUGIN_ID, true);
    gatewayRestart(true);
    return { text: "Octo plugin uninstalled. All bot configs removed." };
  } catch (e) {
    return { text: `Uninstall failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}

async function handleAddAccount(ctx: any, primaryCommandName: string) {
  const parts = ctx.args?.trim().split(/\s+/) ?? [];
  if (parts.length < 3) {
    return { text: `Usage: /${primaryCommandName} <account_id> <bot_token> <api_url>`, isError: true };
  }
  const [accountId, botToken, apiUrl] = parts;
  if (!validateAccountId(accountId)) {
    return { text: `Invalid account ID "${accountId}". Only letters, digits, and underscores allowed.`, isError: true };
  }
  if (!botToken.startsWith("bf_")) {
    return { text: "Bot token must start with 'bf_'.", isError: true };
  }
  try {
    const existed = Boolean(configGet(channelConfigPath("accounts", accountId, "botToken")));
    configSet(channelConfigPath("accounts", accountId, "botToken"), botToken);
    configSet(channelConfigPath("accounts", accountId, "apiUrl"), apiUrl);
    const dmScope = configGet("session.dmScope");
    if (!dmScope) {
      configSet("session.dmScope", RECOMMENDED_DM_SCOPE);
    }
    gatewayRestart(true);
    return { text: `${existed ? "Updated" : "Added"} bot account: ${accountId} (API: ${apiUrl}). Gateway restarted.` };
  } catch (e) {
    return { text: `Failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}

async function handleRemoveAccount(ctx: any, primaryCommandName: string) {
  const accountId = ctx.args?.trim();
  if (!accountId) {
    return { text: `Usage: /${primaryCommandName} <account_id>`, isError: true };
  }
  if (!validateAccountId(accountId)) {
    return { text: `Invalid account ID "${accountId}". Only letters, digits, and underscores allowed.`, isError: true };
  }
  try {
    const token = configGet(channelConfigPath("accounts", accountId, "botToken"));
    if (!token) {
      return { text: `Account "${accountId}" does not exist.`, isError: true };
    }
    configUnset(channelConfigPath("accounts", accountId));
    gatewayRestart(true);
    const remaining = configGetJson(channelConfigPath("accounts"));
    const count = remaining ? Object.keys(remaining).length : 0;
    return { text: `Removed account: ${accountId}. ${count} account(s) remaining. Gateway restarted.` };
  } catch (e) {
    return { text: `Failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}

const plugin: {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
} = {
  id: "openclaw-channel-octo",
  name: "Octo",
  description: "OpenClaw Octo channel plugin via WuKongIM WebSocket",
  register(api) {
    setDmworkRuntime(api.runtime);
    api.registerChannel({ plugin: dmworkPlugin });

    // -----------------------------------------------------------------------
    // Slash command registration helper: registers /octo_<name> as the primary
    // command and /dmwork_<name> as a deprecated alias sharing the same handler.
    // -----------------------------------------------------------------------
    const registerCommandWithAlias = (
      name: string,
      description: string,
      acceptsArgs: boolean,
      handler: (ctx: any) => Promise<{ text: string; isError?: boolean }>,
    ) => {
      const octoName = `octo_${name}`;
      const dmworkName = `dmwork_${name}`;

      // Primary command
      api.registerCommand({
        name: octoName,
        description,
        acceptsArgs,
        handler,
      });

      // LEGACY-ALIAS: deprecated /dmwork_* alias kept for one release cycle.
      // Logs a deprecation notice on every invocation so we can observe usage
      // frequency before removing in 1.1.0.
      api.registerCommand({
        name: dmworkName,
        description: `[DEPRECATED] Renamed to /${octoName}. ${description}`,
        acceptsArgs,
        async handler(ctx) {
          console.warn(
            `[deprecation] /${dmworkName} has been renamed to /${octoName}. ` +
            `The old name still works but will be removed in 1.1.0.`,
          );
          return handler(ctx);
        },
      });
    };

    registerCommandWithAlias(
      "doctor",
      "Check Octo plugin status and connectivity",
      true,
      handleDoctor,
    );
    registerCommandWithAlias(
      "info",
      "Show Octo plugin version info",
      false,
      handleInfo as any,
    );
    registerCommandWithAlias(
      "install",
      "Install or reinstall the Octo plugin",
      true,
      handleInstall,
    );
    registerCommandWithAlias(
      "update",
      "Update Octo plugin to latest version",
      false,
      handleUpdate as any,
    );
    registerCommandWithAlias(
      "uninstall",
      "Uninstall Octo plugin and remove all bot configs",
      false,
      handleUninstall as any,
    );
    registerCommandWithAlias(
      "add_account",
      "Add or update an Octo bot account. Args: <account_id> <bot_token> <api_url>",
      true,
      (ctx) => handleAddAccount(ctx, "octo_add_account"),
    );
    registerCommandWithAlias(
      "remove_account",
      "Remove an Octo bot account. Args: <account_id>",
      true,
      (ctx) => handleRemoveAccount(ctx, "octo_remove_account"),
    );

    console.log('[octo] registering before_prompt_build hook');
    api.on('before_prompt_build', (_event, ctx) => {
      const sections: string[] = [];

      // 1. Group/Thread MD — wrapped in [GROUP CONTEXT] block
      const groupMdContent = getGroupMdForPrompt(ctx);
      if (groupMdContent) {
        sections.push(`[GROUP CONTEXT]\n${groupMdContent}\n[/GROUP CONTEXT]`);
      }

      // 2. Inbound context (member list + history) — outside [GROUP CONTEXT], keeps original format
      const sessionKey = ctx.sessionKey;
      if (sessionKey) {
        const pending = pendingInboundContext.get(sessionKey);
        if (pending) {
          pendingInboundContext.delete(sessionKey);
          if (pending.memberListPrefix) sections.push(pending.memberListPrefix);
          if (pending.historyPrefix) sections.push(pending.historyPrefix);
        }
      }

      if (sections.length === 0) return;
      return { prependContext: sections.join('\n\n') };
    });
  },
};

export default plugin;
