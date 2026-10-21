/**
 * bind command: configure a single bot account and bind it to an agent.
 * Writes config atomically (no multiple `openclaw config set` calls).
 * Refreshes active Gateway connections when MCP is configured.
 */

import {
  readConfigFromFile,
  writeConfigAtomic,
} from "./openclaw-cli.js";
import {
  ensureChannelConfigObject,
  enforceHealthyClawHubInstall,
  validateAccountId,
  isValidBotTokenPrefix,
} from "./utils.js";
import { prepareBotBinding } from './bind-config.js';
import { checkMcpConfig, refreshMcpGateway } from './mcp.js';

export interface BindOptions {
  botToken: string;
  apiUrl: string;
  accountId: string;
  agent: string;
  mcpUrl?: string;
}

export async function runBind(opts: BindOptions): Promise<void> {
  // 1. Pre-flight: enforce healthy ClawHub octo + recent OpenClaw (exits on legacy/missing/broken)
  enforceHealthyClawHubInstall();

  // 2. Validate params
  if (!isValidBotTokenPrefix(opts.botToken)) {
    console.error("Error: Bot token must start with 'bf_' (BotFather /newbot) or 'app_' (Admin App Bot).");
    process.exit(1);
  }
  if (!validateAccountId(opts.accountId)) {
    console.error(`Error: Invalid account ID "${opts.accountId}". Only letters, digits, and underscores are allowed.`);
    process.exit(1);
  }
  if (!opts.agent) {
    console.error("Error: --agent is required. Use /status in OpenClaw to find your agent identifier.");
    process.exit(1);
  }

  // 3. Read existing config + ensure channels.<CHANNEL_ID>.accounts exists
  const source = readConfigFromFile();
  const cfg = prepareBotBinding(source || {}, opts);
  await checkMcpConfig(cfg, opts.accountId);
  const channelConfig = ensureChannelConfigObject(cfg);
  const accountId = Object.keys(channelConfig.accounts).find(key => key.toLowerCase() === opts.accountId.toLowerCase())!;

  // 4. Register once, store full result for config + greeting
  let botName = "";
  let ownerUID = "";
  try {
    const regResp = await fetch(`${opts.apiUrl.replace(/\/+$/, "")}/v1/bot/register`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${opts.botToken}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10000),
    });
    if (regResp.ok) {
      const regData = await regResp.json() as { name?: string; owner_uid?: string };
      botName = regData.name ?? "";
      ownerUID = regData.owner_uid ?? "";
    }
  } catch { /* best-effort */ }

  // 5. Write account config
  if (botName) channelConfig.accounts[accountId].name = botName;

  // 8. Atomic write
  writeConfigAtomic(cfg, source ?? null);

  const displayLabel = botName || opts.accountId;
  console.log(`Bot "${displayLabel}" (${opts.accountId}) configured and bound to agent "${opts.agent}".`);
  try { refreshMcpGateway(cfg); }
  catch (error) { console.warn(error instanceof Error ? error.message : 'Binding saved; verify the intended Gateway and restart it if needed.'); }

  // 9. Wait for channel hot-reload
  console.log("Waiting for Octo channel to reload...");
  await new Promise((r) => setTimeout(r, 2000));

  // 10. Send greeting to bot owner (reuse register data from step 4)
  if (ownerUID) {
    console.log("Sending greeting to bot owner...");
    try {
      const greetName = botName || displayLabel;
      await fetch(`${opts.apiUrl.replace(/\/+$/, "")}/v1/bot/sendMessage`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${opts.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel_id: ownerUID,
          channel_type: 1,
          payload: { type: 1, content: `你好！我是 ${greetName}，已上线 👋` },
        }),
        signal: AbortSignal.timeout(10000),
      });
      console.log(`Greeting sent to owner (${ownerUID}).`);
    } catch {
      console.log("Could not send greeting. Please test connectivity by sending a message to the bot in Octo.");
    }
  }

  console.log("\nBind complete! Please send a message to the bot in Octo to verify the connection.");
}
