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
import { dmworkPlugin } from "./src/channel.js";
import { setDmworkRuntime } from "./src/runtime.js";
import { getGroupMdForPrompt } from "./src/group-md.js";
import { pendingInboundContext, sessionAccountMap, buildSessionAccountKey } from "./src/inbound.js";
import { resolvePersonaHintForSession } from "./src/persona-prompt.js";
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
  CLAWHUB_INSTALL_SPEC,
  NPM_PACKAGE_NAME,
  LEGACY_CHANNEL_ID,
  RECOMMENDED_DM_SCOPE,
  validateAccountId,
  channelConfigPath,
} from "./cli/utils.js";
import { getLatestClawHubVersion } from "./cli/install.js";

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
      `installed plugin id: ${PLUGIN_ID} (ClawHub)`,
      `installed plugin version: ${installedVersion}`,
      `openclaw: ${openclawVersion}`,
      `npm package: ${NPM_PACKAGE_NAME}`,
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
    // v2.0.0+: install via ClawHub (plugin id "octo") rather than npm name.
    pluginsInstall(CLAWHUB_INSTALL_SPEC, true, force);
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
    // v2.0.0+: query ClawHub registry (not npmjs) for latest. PLUGIN_ID is the
    // ClawHub plugin id "octo", NOT an npm package name.
    const targetVersion = getLatestClawHubVersion();
    if (!targetVersion) {
      return { text: `Cannot reach ClawHub registry to check latest version. Current: v${currentVersion}.`, isError: true };
    }
    if (currentVersion === targetVersion) {
      return { text: `Already up to date (v${currentVersion}).` };
    }
    pluginsInstall(CLAWHUB_INSTALL_SPEC, true, true);
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
      // Sections destined for the user-prompt context block (group MD,
      // member list, inbound history). These belong to the conversation
      // surface, not the LLM's system identity.
      const contextSections: string[] = [];
      // Sections destined for the LLM system prompt (persona identity).
      // System-level identity instructions must NOT live in the user-prompt
      // prefix or the model can treat them as quotable content.
      const systemSections: string[] = [];

      // 1. Group/Thread MD — wrapped in [GROUP CONTEXT] block
      const groupMdContent = getGroupMdForPrompt(ctx);
      if (groupMdContent) {
        contextSections.push(`[GROUP CONTEXT]\n${groupMdContent}\n[/GROUP CONTEXT]`);
      }

      // 2. Inbound context (member list + history) — outside [GROUP CONTEXT], keeps original format
      const sessionKey = ctx.sessionKey;
      if (sessionKey) {
        const pending = pendingInboundContext.get(sessionKey);
        if (pending) {
          pendingInboundContext.delete(sessionKey);
          if (pending.memberListPrefix) contextSections.push(pending.memberListPrefix);
          if (pending.historyPrefix) contextSections.push(pending.historyPrefix);
        }
      }

      // 3. Persona prompt (GH octo-adapters#68) — for persona-clone bots
      // (account.config.onBehalfOf set), pull the active persona_prompt
      // from the per-account cache and prepend it to the SYSTEM prompt.
      // The cache is hydrated by initPersonaPromptCache() in channel.ts;
      // when this bot is not a persona clone, the lookup returns undefined
      // and we skip.
      //
      // The hook ctx does not expose accountId, so we cannot key the
      // persona cache by sessionKey alone — two persona-clone bots
      // running on the same node can legitimately share a sessionKey
      // (OpenClaw routes per-account but session keys can collide).
      // Keying sessionAccountMap only by sessionKey lets a later inbound
      // overwrite an earlier one and the hook then attaches the WRONG
      // account's persona prompt — a cross-account identity leak called
      // out in PR#69 R3 (Jerry-Xin).
      //
      // Fix: sessionAccountMap is composite-keyed by
      // `${accountId}:${sessionKey}` (see inbound.ts). The resolver
      // iterates every registered persona account and asks
      // sessionAccountMap whether it has been seen on this sessionKey.
      // On 0 / >1 matches we fail safe to "no persona injection".
      const personaHint = sessionKey
        ? resolvePersonaHintForSession({
            sessionKey,
            hasAccountSession: (accountId, sk) =>
              sessionAccountMap.has(buildSessionAccountKey(accountId, sk)),
          })
        : undefined;
      if (personaHint) systemSections.push(personaHint);

      if (contextSections.length === 0 && systemSections.length === 0) return;
      return {
        ...(contextSections.length > 0 ? { prependContext: contextSections.join('\n\n') } : {}),
        ...(systemSections.length > 0 ? { prependSystemContext: systemSections.join('\n\n') } : {}),
      };
    });
  },
};

export default plugin;
