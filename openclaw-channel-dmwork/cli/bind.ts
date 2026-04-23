/**
 * bind command: configure a single bot account and bind it to an agent.
 * Writes config atomically (no multiple `openclaw config set` calls).
 * Does NOT restart gateway — relies on channel hot-reload.
 */

import {
  isHealthyInstall,
  readConfigFromFile,
  writeConfigAtomic,
} from "./openclaw-cli.js";
import {
  RECOMMENDED_DM_SCOPE,
  ensureOpenClawCompat,
  validateAccountId,
} from "./utils.js";

export interface BindOptions {
  botToken: string;
  apiUrl: string;
  accountId: string;
  agent: string;
}

export async function runBind(opts: BindOptions): Promise<void> {
  ensureOpenClawCompat();

  // 1. Pre-flight: plugin must be healthy
  if (!isHealthyInstall()) {
    console.error("DMWork plugin is not installed or in an unhealthy state.");
    console.error("Please run first: npx -y openclaw-channel-dmwork install");
    process.exit(1);
  }

  // 2. Validate params
  if (!opts.botToken.startsWith("bf_")) {
    console.error("Error: Bot token must start with 'bf_'.");
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

  // 3. Read existing config
  const cfg: Record<string, any> = readConfigFromFile() || {};
  if (!cfg.channels) cfg.channels = {};
  if (!cfg.channels.dmwork) cfg.channels.dmwork = {};
  if (!cfg.channels.dmwork.accounts) cfg.channels.dmwork.accounts = {};

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
  const accountConfig: Record<string, string> = {
    botToken: opts.botToken,
    apiUrl: opts.apiUrl,
  };
  if (botName) accountConfig.name = botName;
  cfg.channels.dmwork.accounts[opts.accountId] = accountConfig;

  // 6. Set dmScope (multi-bot isolation)
  if (!cfg.session) cfg.session = {};
  if (!cfg.session.dmScope) {
    cfg.session.dmScope = RECOMMENDED_DM_SCOPE;
  }

  // 7. Add or update binding
  if (!cfg.bindings) cfg.bindings = [];
  const existingIdx = (cfg.bindings as any[]).findIndex(
    (b: any) => b.match?.channel === "dmwork" && b.match?.accountId === opts.accountId,
  );
  if (existingIdx >= 0) {
    cfg.bindings[existingIdx].agentId = opts.agent;
  } else {
    cfg.bindings.push({
      agentId: opts.agent,
      match: { channel: "dmwork", accountId: opts.accountId },
    });
  }

  // 8. Atomic write
  writeConfigAtomic(cfg);
  const displayLabel = botName || opts.accountId;
  console.log(`Bot "${displayLabel}" (${opts.accountId}) configured and bound to agent "${opts.agent}".`);

  // 9. Wait for channel hot-reload
  console.log("Waiting for DMWork channel to reload...");
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
      console.log("Could not send greeting. Please test connectivity by sending a message to the bot in DMWork.");
    }
  }

  console.log("\nBind complete! Please send a message to the bot in DMWork to verify the connection.");
}
