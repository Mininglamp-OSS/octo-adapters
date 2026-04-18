/**
 * quickstart command: V1 one-time initialization.
 * Creates a bot for every agent and binds them all at once.
 *
 * - Reads all agents via `openclaw agents list --json`
 * - Creates a bot for each agent via POST /v1/user/bots
 * - Writes all accounts + bindings + dmScope atomically
 * - Does NOT restart gateway — relies on channel hot-reload
 * - NOT idempotent — designed for first-time setup only
 */

import { execFileSync } from "node:child_process";
import {
  isHealthyInstall,
  readConfigFromFile,
  writeConfigAtomic,
  getOpenClawBin,
} from "./openclaw-cli.js";
import {
  RECOMMENDED_DM_SCOPE,
  ensureOpenClawCompat,
} from "./utils.js";

export interface QuickstartOptions {
  apiKey: string;
  apiUrl: string;
}

interface AgentInfo {
  id: string;
  name: string;
}

interface CreatedBot {
  agentId: string;
  robotId: string;
  botToken: string;
  name: string;
  status: "ok" | "failed";
  error?: string;
}

/** Normalize agent id to a valid bot username */
function normalizeUsername(agentId: string): string {
  let base = agentId.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (base.length > 17) base = base.slice(0, 17); // leave room for _bot suffix
  if (base.endsWith("_bot")) return base;
  return `${base}_bot`;
}

export async function runQuickstart(opts: QuickstartOptions): Promise<void> {
  ensureOpenClawCompat();

  // 1. Pre-flight: plugin must be healthy
  if (!isHealthyInstall()) {
    console.error("DMWork plugin is not installed or in an unhealthy state.");
    console.error("Please run first: npx -y openclaw-channel-dmwork install");
    process.exit(1);
  }

  // 2. Get all agents
  console.log("Fetching agent list...");
  let agents: AgentInfo[];
  try {
    const OPENCLAW = getOpenClawBin();
    const raw = execFileSync(OPENCLAW, ["agents", "list", "--json"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // OpenClaw stdout may contain plugin log noise before JSON (e.g. [dmwork], [plugins]).
    // Use lastIndexOf to skip all log lines and find the actual JSON array.
    const jsonStart = raw.lastIndexOf("\n[");
    if (jsonStart >= 0) {
      agents = JSON.parse(raw.slice(jsonStart + 1));
    } else if (raw.trimStart().startsWith("[")) {
      agents = JSON.parse(raw);
    } else {
      throw new Error("No JSON array in output");
    }
  } catch (err) {
    console.error("Failed to get agent list. Make sure OpenClaw is running.");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (agents.length === 0) {
    console.error("No agents found. Create an agent first.");
    process.exit(1);
  }
  console.log(`Found ${agents.length} agent(s): ${agents.map((a) => a.id).join(", ")}`);

  // 3. Create bots for each agent
  const apiBase = opts.apiUrl.replace(/\/+$/, "");
  const results: CreatedBot[] = [];

  for (const agent of agents) {
    const baseName = normalizeUsername(agent.id);
    let created = false;

    // Try base name, then _2_bot, _3_bot
    const candidates = [baseName];
    const baseWithout = baseName.replace(/_bot$/, "");
    candidates.push(`${baseWithout}_2_bot`, `${baseWithout}_3_bot`);

    for (const username of candidates) {
      try {
        const resp = await fetch(`${apiBase}/v1/user/bots`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            username,
            name: agent.name || agent.id,
          }),
          signal: AbortSignal.timeout(15000),
        });

        if (resp.ok) {
          const data = await resp.json() as { robot_id: string; bot_token: string; name: string };
          results.push({
            agentId: agent.id,
            robotId: data.robot_id,
            botToken: data.bot_token,
            name: data.name,
            status: "ok",
          });
          console.log(`  Created bot: ${data.robot_id} → agent ${agent.id}`);
          created = true;
          break;
        } else if (resp.status === 409) {
          // Username conflict, try next candidate
          continue;
        } else {
          const text = await resp.text().catch(() => "");
          results.push({
            agentId: agent.id,
            robotId: username,
            botToken: "",
            name: agent.name || agent.id,
            status: "failed",
            error: `HTTP ${resp.status}: ${text}`,
          });
          created = true; // don't retry on non-409 errors
          break;
        }
      } catch (err) {
        results.push({
          agentId: agent.id,
          robotId: username,
          botToken: "",
          name: agent.name || agent.id,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
        created = true;
        break;
      }
    }

    if (!created) {
      results.push({
        agentId: agent.id,
        robotId: baseName,
        botToken: "",
        name: agent.name || agent.id,
        status: "failed",
        error: "All username variants conflicted",
      });
    }
  }

  const successful = results.filter((r) => r.status === "ok");
  const failed = results.filter((r) => r.status === "failed");

  if (successful.length === 0) {
    console.error("\nNo bots were created. Please check the errors above.");
    process.exit(1);
  }

  // 4. Write all config at once
  console.log("\nWriting configuration...");
  const cfg: Record<string, any> = readConfigFromFile() || {};
  if (!cfg.channels) cfg.channels = {};
  if (!cfg.channels.dmwork) cfg.channels.dmwork = {};
  if (!cfg.channels.dmwork.accounts) cfg.channels.dmwork.accounts = {};
  if (!cfg.session) cfg.session = {};
  if (!cfg.bindings) cfg.bindings = [];

  for (const bot of successful) {
    // Account config
    cfg.channels.dmwork.accounts[bot.robotId] = {
      botToken: bot.botToken,
      apiUrl: opts.apiUrl,
    };

    // Binding
    const existingIdx = (cfg.bindings as any[]).findIndex(
      (b: any) => b.match?.channel === "dmwork" && b.match?.accountId === bot.robotId,
    );
    if (existingIdx >= 0) {
      cfg.bindings[existingIdx].agentId = bot.agentId;
    } else {
      cfg.bindings.push({
        agentId: bot.agentId,
        match: { channel: "dmwork", accountId: bot.robotId },
      });
    }
  }

  // dmScope
  if (!cfg.session.dmScope) {
    cfg.session.dmScope = RECOMMENDED_DM_SCOPE;
  }

  writeConfigAtomic(cfg);
  console.log("Configuration written.");

  // 5. Wait for hot-reload
  console.log("Waiting for DMWork channel to reload...");
  await new Promise((r) => setTimeout(r, 3000));

  // 6. Send greetings to bot owner (best-effort, not a connectivity proof)
  console.log("Sending greetings to bot owner...");
  for (const bot of successful) {
    try {
      const regResp = await fetch(`${apiBase}/v1/bot/register`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${bot.botToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(10000),
      });
      if (regResp.ok) {
        const data = await regResp.json() as { owner_uid?: string };
        if (data.owner_uid) {
          await fetch(`${apiBase}/v1/bot/sendMessage`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${bot.botToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              channel_id: data.owner_uid,
              channel_type: 1,
              payload: { type: 1, content: `你好！我是 ${bot.name}，已上线 👋` },
            }),
            signal: AbortSignal.timeout(10000),
          });
        }
      }
    } catch {
      // Non-blocking — just skip greeting for this bot
    }
  }

  // 7. Output results
  console.log("\n========================================");
  console.log("Quickstart complete! Send a message to each bot in DMWork to verify.");
  console.log("========================================\n");
  console.log(`  Created: ${successful.length} bot(s)`);
  if (failed.length > 0) {
    console.log(`  Failed:  ${failed.length} bot(s)`);
  }
  console.log();

  for (const bot of successful) {
    console.log(`  ✅ ${bot.agentId} → ${bot.robotId}`);
  }
  for (const bot of failed) {
    console.log(`  ❌ ${bot.agentId} → ${bot.error}`);
  }
  console.log();
}
