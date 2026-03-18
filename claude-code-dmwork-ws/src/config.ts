import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ─── Config Schema ───────────────────────────────────────────────────────────

export interface BotConfig {
  /** DMWork bot token (from BotFather) */
  botToken: string;
  /** DMWork API base URL */
  apiUrl: string;

  /** Working directory for Claude Code (loads CLAUDE.md, .claude/settings, skills) */
  cwd: string;
  /** Data directory for sessions/memory */
  dataDir: string;

  /** Claude Agent SDK options */
  sdk: {
    /** Which settings to load: "user" = ~/.claude, "project" = cwd/.claude, "local" = cwd/.claude/local */
    settingSources: Array<"user" | "project" | "local">;
    /** Tools the agent can use */
    allowedTools: string[];
    /** Permission mode: "bypassPermissions" for headless, "acceptEdits" for semi-auto */
    permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
    /** Max conversation turns (undefined = unlimited) */
    maxTurns?: number;
    /** Custom system prompt (undefined = use built-in default) */
    systemPrompt?: string;
  };
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CWD = path.resolve(__dirname, "..");

const DEFAULT_SDK: BotConfig["sdk"] = {
  settingSources: ["user", "project"],
  allowedTools: [
    "Read", "Write", "Edit", "Bash",
    "Glob", "Grep", "Skill",
    "WebFetch", "WebSearch",
  ],
  permissionMode: "acceptEdits",
};

// ─── Loader ──────────────────────────────────────────────────────────────────

export function loadConfig(): BotConfig {
  // Priority: env vars (DMWork connection only) > config file > defaults

  // Try config file first
  const configPaths = [
    path.join(DEFAULT_CWD, "config.json"),
    path.join(process.env.HOME || process.env.USERPROFILE || "", ".claude-code-dmwork.json"),
  ];

  let raw: Record<string, any> = {};
  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      console.log(`[config] Loaded from ${configPath}`);
      break;
    }
  }

  // Env vars override config file for connection settings
  const botToken = process.env.OCTO_BOT_TOKEN || raw.botToken;
  const apiUrl = process.env.OCTO_API_URL || raw.apiUrl;

  if (!botToken || !apiUrl) {
    console.error("Missing config. Set botToken + apiUrl in config.json, or OCTO_BOT_TOKEN + OCTO_API_URL env vars.");
    process.exit(1);
  }

  const cwd = process.env.DMWORK_CWD || raw.cwd || DEFAULT_CWD;
  const sdkRaw = raw.sdk || {};

  return {
    botToken,
    apiUrl,
    cwd,
    dataDir: raw.dataDir || path.join(DEFAULT_CWD, "data"),
    sdk: {
      settingSources: sdkRaw.settingSources || DEFAULT_SDK.settingSources,
      allowedTools: sdkRaw.allowedTools || DEFAULT_SDK.allowedTools,
      permissionMode: sdkRaw.permissionMode || DEFAULT_SDK.permissionMode,
      maxTurns: sdkRaw.maxTurns,
      systemPrompt: sdkRaw.systemPrompt,
    },
  };
}
