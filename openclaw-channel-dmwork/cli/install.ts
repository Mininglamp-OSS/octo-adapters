/**
 * install command: install plugin via official CLI + interactive config setup.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  configGet,
  configGetJson,
  configSet,
  configSetJson,
  configUnset,
  gatewayRestart,
  pluginsInspect,
  pluginsInstall,
} from "./openclaw-cli.js";
import {
  PLUGIN_ID,
  RECOMMENDED_DM_SCOPE,
  confirm,
  ensureOpenClawCompat,
  isInteractive,
  prompt,
  validateAccountId,
} from "./utils.js";

export interface InstallOptions {
  botToken?: string;
  apiUrl?: string;
  accountId?: string;
  skipConfig?: boolean;
  force?: boolean;
  dev?: boolean;
}

export async function runInstall(opts: InstallOptions): Promise<void> {
  // 1. Pre-check
  ensureOpenClawCompat();

  // 2. Plugin install (delegate to official CLI)
  const inspect = pluginsInspect(PLUGIN_ID);
  if (inspect?.plugin && !opts.force) {
    console.log(
      `DMWork plugin is already installed (v${inspect.plugin.version}). Skipping install.`,
    );
  } else {
    const spec = opts.dev ? `${PLUGIN_ID}@dev` : PLUGIN_ID;
    console.log(`Installing DMWork plugin${opts.dev ? " (dev)" : ""}...`);
    pluginsInstall(spec, false, opts.force);
    console.log("Plugin installed successfully.");
  }

  // 3. Legacy config migration
  await migrateLegacyConfig();

  // 4. DMWork config (unless --skip-config)
  if (!opts.skipConfig) {
    await configureDmworkAccount(opts);
  }

  // 5. Gateway restart
  console.log("Restarting gateway...");
  if (!gatewayRestart()) {
    console.log(
      "Warning: Gateway restart failed. Run 'openclaw gateway restart' manually.",
    );
  }

  // 6. Success
  console.log("\nDMWork plugin setup complete!");
}

// ---------------------------------------------------------------------------
// Legacy config migration
// ---------------------------------------------------------------------------

async function migrateLegacyConfig(): Promise<void> {
  const legacyToken = configGet("channels.dmwork.botToken");
  const accounts = configGetJson("channels.dmwork.accounts");

  // Has top-level botToken but no accounts map → legacy flat config
  if (legacyToken && (!accounts || Object.keys(accounts).length === 0)) {
    console.log("Detected legacy flat config. Migrating to accounts model...");

    // Copy token to accounts.default
    configSet("channels.dmwork.accounts.default.botToken", legacyToken);

    // Copy apiUrl if present
    const legacyApiUrl = configGet("channels.dmwork.apiUrl");
    if (legacyApiUrl) {
      configSet("channels.dmwork.accounts.default.apiUrl", legacyApiUrl);
    }

    // Remove top-level botToken (keep apiUrl as shared default)
    configUnset("channels.dmwork.botToken");

    console.log("Migrated legacy config to accounts.default.");
  }
}

// ---------------------------------------------------------------------------
// Account configuration
// ---------------------------------------------------------------------------

async function configureDmworkAccount(opts: InstallOptions): Promise<void> {
  // Collect accountId
  let accountId = opts.accountId;
  if (!accountId) {
    accountId = await prompt("Enter bot account ID (e.g. my_bot):");
    if (!accountId) {
      console.log("No account ID provided. Skipping config.");
      return;
    }
  }

  if (!validateAccountId(accountId)) {
    console.error(
      `Error: Invalid account ID "${accountId}". Only letters, digits, and underscores are allowed.`,
    );
    process.exit(1);
  }

  // Check if account already exists
  const existingToken = configGet(
    `channels.dmwork.accounts.${accountId}.botToken`,
  );
  if (existingToken) {
    if (!isInteractive()) {
      // Non-interactive: require both botToken and apiUrl to overwrite
      if (opts.botToken && opts.apiUrl) {
        console.log(`Overwriting existing account "${accountId}".`);
      } else if (opts.botToken || opts.apiUrl) {
        console.error(
          `Error: Account "${accountId}" already exists. Provide both --bot-token and --api-url to overwrite.`,
        );
        process.exit(1);
      } else {
        // No credentials provided at all — keep existing, but still ensure binding/agent
        console.log(`Account "${accountId}" already configured. Keeping existing config.`);
        const apiUrl = configGet(`channels.dmwork.accounts.${accountId}.apiUrl`)
          ?? configGet("channels.dmwork.apiUrl") ?? "";
        await ensureBindingAndAgent(accountId, apiUrl);
        ensureDmScope();
        return;
      }
    } else {
      const keep = await confirm(
        `Bot account "${accountId}" is already configured. Keep current config?`,
        true,
      );
      if (keep) {
        console.log("Keeping existing config.");
        const apiUrl = configGet(`channels.dmwork.accounts.${accountId}.apiUrl`)
          ?? configGet("channels.dmwork.apiUrl") ?? "";
        await ensureBindingAndAgent(accountId, apiUrl);
        ensureDmScope();
        return;
      }
    }
  }

  // Collect botToken
  let botToken = opts.botToken;
  if (!botToken) {
    botToken = await prompt("Enter bot token (bf_...):");
  }
  if (!botToken?.startsWith("bf_")) {
    console.error("Error: Bot token must start with 'bf_'.");
    process.exit(1);
  }

  // Collect apiUrl
  let apiUrl = opts.apiUrl;
  if (!apiUrl) {
    apiUrl = await prompt("Enter API server URL:");
  }
  if (!apiUrl) {
    console.error("Error: API URL is required.");
    process.exit(1);
  }

  // Write account config
  configSet(`channels.dmwork.accounts.${accountId}.botToken`, botToken);
  configSet(`channels.dmwork.accounts.${accountId}.apiUrl`, apiUrl);
  console.log(`Configured bot account: ${accountId}`);
  console.log(`  API: ${apiUrl}`);

  // Create binding + agent
  await ensureBindingAndAgent(accountId, apiUrl);

  ensureDmScope();
}

// ---------------------------------------------------------------------------
// Binding + Agent (with conflict detection)
// ---------------------------------------------------------------------------

async function ensureBindingAndAgent(accountId: string, apiUrl: string): Promise<void> {
  let agentId = accountId.replace(/_bot$/, "");

  // Check if agent already exists on disk
  const agentMdPath = join(homedir(), ".openclaw", "agents", agentId, "agent", "agent.md");
  if (existsSync(agentMdPath)) {
    // Check if this agent is already bound to this accountId — that's fine
    const bindings: Array<{ agentId: string; match?: { channel?: string; accountId?: string } }> =
      configGetJson("bindings") ?? [];
    const alreadyBound = bindings.some(
      (b) => b.match?.channel === "dmwork" && b.match?.accountId === accountId && b.agentId === agentId,
    );
    if (alreadyBound) {
      console.log(`Binding ${accountId} -> agent "${agentId}" already exists.`);
      return;
    }

    // Agent exists but not bound to this accountId — potential conflict
    if (isInteractive()) {
      const reuse = await confirm(
        `Agent "${agentId}" already exists. Use this agent for ${accountId}?`,
        true,
      );
      if (!reuse) {
        agentId = await prompt(`Enter a different agent ID for ${accountId}:`);
        if (!agentId || !validateAccountId(agentId)) {
          console.log("Invalid or empty agent ID. Skipping binding/agent setup.");
          return;
        }
      }
    } else {
      // Non-interactive: reuse existing agent silently
      console.log(`Using existing agent "${agentId}" for ${accountId}.`);
    }
  }

  ensureBinding(accountId, agentId);
  ensureAgentMd(agentId, accountId, apiUrl);
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

function ensureBinding(accountId: string, agentId: string): void {
  try {
    const bindings: Array<{ agentId: string; match?: { channel?: string; accountId?: string } }> =
      configGetJson("bindings") ?? [];

    // Check if binding already exists for this accountId
    const exists = bindings.some(
      (b) => b.match?.channel === "dmwork" && b.match?.accountId === accountId,
    );
    if (exists) {
      console.log(`Binding for ${accountId} already exists.`);
      return;
    }

    // Append binding at the end using numeric index
    const index = bindings.length;
    configSetJson(`bindings[${index}]`, {
      agentId,
      match: { channel: "dmwork", accountId },
    });
    console.log(`Created binding: ${accountId} -> agent "${agentId}"`);
  } catch {
    console.log(
      `Warning: Could not create binding. Add manually: {"agentId":"${agentId}","match":{"channel":"dmwork","accountId":"${accountId}"}}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Agent.md
// ---------------------------------------------------------------------------

function ensureAgentMd(agentId: string, accountId: string, apiUrl: string): void {
  const agentDir = join(homedir(), ".openclaw", "agents", agentId, "agent");
  const agentMdPath = join(agentDir, "agent.md");

  if (existsSync(agentMdPath)) {
    console.log(`Agent "${agentId}" already exists. Keeping existing agent.md.`);
    return;
  }

  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      agentMdPath,
      `I am ${accountId}, a DMWork bot.

## Credentials

- Account ID: ${accountId}
- API server: ${apiUrl}
- accountId must be passed when using dmwork_management tool

## Capabilities

My full API capabilities are documented at ${apiUrl}/v1/bot/skill.md — read it when I need to perform an action I'm unsure about.

## Rules

- Respond in the user's language
- Be helpful and concise
`,
      "utf-8",
    );
    console.log(`Created agent: ~/.openclaw/agents/${agentId}/agent/agent.md`);
  } catch {
    console.log(
      `Warning: Could not create agent.md at ${agentMdPath}`,
    );
  }
}

// ---------------------------------------------------------------------------
// session.dmScope
// ---------------------------------------------------------------------------

function ensureDmScope(): void {
  const current = configGet("session.dmScope");
  if (!current) {
    configSet("session.dmScope", RECOMMENDED_DM_SCOPE);
  } else if (current !== RECOMMENDED_DM_SCOPE) {
    console.log(
      `Warning: session.dmScope is "${current}" (recommended: ${RECOMMENDED_DM_SCOPE})`,
    );
  }
}
