/**
 * openclaw-channel-dmwork
 *
 * OpenClaw channel plugin for DMWork messaging platform.
 * Connects via WuKongIM WebSocket for real-time messaging.
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
import { PLUGIN_ID, RECOMMENDED_DM_SCOPE, validateAccountId } from "./cli/utils.js";

const plugin: {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
} = {
  id: "openclaw-channel-dmwork",
  name: "DMWork",
  description: "OpenClaw DMWork channel plugin via WuKongIM WebSocket",
  register(api) {
    setDmworkRuntime(api.runtime);
    api.registerChannel({ plugin: dmworkPlugin });

    api.registerCommand({
      name: "dmwork_doctor",
      description: "Check DMWork plugin status and connectivity",
      acceptsArgs: true,
      async handler(ctx) {
        const reader = inProcessConfigReader(ctx.config);
        const result = await runDoctorChecks({
          reader,
          accountId: ctx.args?.trim() || undefined,
          inProcess: true,
        });
        return { text: formatDoctorResult(result) };
      },
    });

    // /dmwork_info
    api.registerCommand({
      name: "dmwork_info",
      description: "Show DMWork plugin version info",
      acceptsArgs: false,
      async handler() {
        const openclawVersion = getOpenClawVersion() ?? "not found";
        const inspect = pluginsInspect(PLUGIN_ID);
        const installedVersion = inspect?.plugin?.version ?? "not installed";
        return {
          text: [
            `openclaw-channel-dmwork: ${installedVersion}`,
            `openclaw: ${openclawVersion}`,
            `plugin package: ${PLUGIN_ID}`,
          ].join("\n"),
        };
      },
    });

    // /dmwork_install
    api.registerCommand({
      name: "dmwork_install",
      description: "Install or reinstall the DMWork plugin",
      acceptsArgs: true,
      async handler(ctx) {
        const args = ctx.args?.trim() ?? "";
        // Parse: --force or empty
        const force = args.includes("--force");
        try {
          const inspect = pluginsInspect(PLUGIN_ID);
          if (inspect?.plugin && !force) {
            return { text: `DMWork plugin already installed (v${inspect.plugin.version}). Use --force to reinstall.` };
          }
          pluginsInstall(PLUGIN_ID, true, force);
          gatewayRestart(true);
          const after = pluginsInspect(PLUGIN_ID);
          return { text: `DMWork plugin installed (v${after?.plugin?.version ?? "unknown"}). Gateway restarted.` };
        } catch (e) {
          return { text: `Install failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
        }
      },
    });

    // /dmwork_update
    api.registerCommand({
      name: "dmwork_update",
      description: "Update DMWork plugin to latest version",
      acceptsArgs: false,
      async handler() {
        try {
          const inspect = pluginsInspect(PLUGIN_ID);
          if (!inspect?.plugin) {
            return { text: "DMWork plugin is not installed. Use /dmwork_install first.", isError: true };
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
      },
    });

    // /dmwork_uninstall
    api.registerCommand({
      name: "dmwork_uninstall",
      description: "Uninstall DMWork plugin and remove all bot configs",
      acceptsArgs: false,
      async handler() {
        try {
          removeChannelConfigFromFile();
          pluginsUninstall(PLUGIN_ID, true);
          gatewayRestart(true);
          return { text: "DMWork plugin uninstalled. All bot configs removed." };
        } catch (e) {
          return { text: `Uninstall failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
        }
      },
    });

    // /dmwork_add_account <account_id> <bot_token> <api_url>
    api.registerCommand({
      name: "dmwork_add_account",
      description: "Add or update a DMWork bot account. Args: <account_id> <bot_token> <api_url>",
      acceptsArgs: true,
      async handler(ctx) {
        const parts = ctx.args?.trim().split(/\s+/) ?? [];
        if (parts.length < 3) {
          return { text: "Usage: /dmwork_add_account <account_id> <bot_token> <api_url>", isError: true };
        }
        const [accountId, botToken, apiUrl] = parts;
        if (!validateAccountId(accountId)) {
          return { text: `Invalid account ID "${accountId}". Only letters, digits, and underscores allowed.`, isError: true };
        }
        if (!botToken.startsWith("bf_")) {
          return { text: "Bot token must start with 'bf_'.", isError: true };
        }
        try {
          const existed = Boolean(configGet(`channels.dmwork.accounts.${accountId}.botToken`));
          configSet(`channels.dmwork.accounts.${accountId}.botToken`, botToken);
          configSet(`channels.dmwork.accounts.${accountId}.apiUrl`, apiUrl);
          const dmScope = configGet("session.dmScope");
          if (!dmScope) {
            configSet("session.dmScope", RECOMMENDED_DM_SCOPE);
          }
          gatewayRestart(true);
          return { text: `${existed ? "Updated" : "Added"} bot account: ${accountId} (API: ${apiUrl}). Gateway restarted.` };
        } catch (e) {
          return { text: `Failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
        }
      },
    });

    // /dmwork_remove_account <account_id>
    api.registerCommand({
      name: "dmwork_remove_account",
      description: "Remove a DMWork bot account. Args: <account_id>",
      acceptsArgs: true,
      async handler(ctx) {
        const accountId = ctx.args?.trim();
        if (!accountId) {
          return { text: "Usage: /dmwork_remove_account <account_id>", isError: true };
        }
        if (!validateAccountId(accountId)) {
          return { text: `Invalid account ID "${accountId}". Only letters, digits, and underscores allowed.`, isError: true };
        }
        try {
          const token = configGet(`channels.dmwork.accounts.${accountId}.botToken`);
          if (!token) {
            return { text: `Account "${accountId}" does not exist.`, isError: true };
          }
          configUnset(`channels.dmwork.accounts.${accountId}`);
          gatewayRestart(true);
          const remaining = configGetJson("channels.dmwork.accounts");
          const count = remaining ? Object.keys(remaining).length : 0;
          return { text: `Removed account: ${accountId}. ${count} account(s) remaining. Gateway restarted.` };
        } catch (e) {
          return { text: `Failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
        }
      },
    });

    console.log('[dmwork] registering before_prompt_build hook');
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
