// Plain config types — no external dependencies

export interface DmworkAccountConfig {
  name?: string;
  enabled?: boolean;
  botToken?: string;
  apiUrl?: string;
  wsUrl?: string;
  cdnUrl?: string;  // CDN base URL for media files (e.g. https://cdn.example.com/bucket)
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  requireMention?: boolean;
  botUid?: string;
  historyLimit?: number;  // 群聊历史消息条数限制（默认20）
  historyPromptTemplate?: string;  // Template for group history context injection
}

export interface DmworkConfig {
  name?: string;
  enabled?: boolean;
  botToken?: string;
  apiUrl?: string;
  wsUrl?: string;
  cdnUrl?: string;  // CDN base URL for media files (e.g. https://cdn.example.com/bucket)
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  requireMention?: boolean;
  botUid?: string;
  historyLimit?: number;  // 群聊历史消息条数限制（默认20）
  historyPromptTemplate?: string;  // Template for group history context injection
  accounts?: Record<string, DmworkAccountConfig | undefined>;
}

// Default English template for history prompt (supports {messages}, {count} placeholders)
export const DEFAULT_HISTORY_PROMPT_TEMPLATE =
  "[Group Chat History] Below are messages from others since your last reply (sender is user ID, body is message content):\n```json\n{messages}\n```\nPlease respond to the current @mention based on this context.\n\n";

// JSON Schema for OpenClaw plugin config validation
export const DmworkConfigJsonSchema = {
  schema: {
    type: "object" as const,
    properties: {
      name: { type: "string" },
      enabled: { type: "boolean" },
      botToken: { type: "string" },
      apiUrl: { type: "string" },
      wsUrl: { type: "string" },
      cdnUrl: { type: "string" },
      pollIntervalMs: { type: "number", minimum: 500 },
      heartbeatIntervalMs: { type: "number", minimum: 5000 },
      requireMention: { type: "boolean" },
      botUid: { type: "string" },
      historyLimit: { type: "number", minimum: 1, maximum: 100 },
      historyPromptTemplate: { type: "string" },
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            name: { type: "string" },
            enabled: { type: "boolean" },
            botToken: { type: "string" },
            apiUrl: { type: "string" },
            wsUrl: { type: "string" },
            cdnUrl: { type: "string" },
            pollIntervalMs: { type: "number", minimum: 500 },
            heartbeatIntervalMs: { type: "number", minimum: 5000 },
            requireMention: { type: "boolean" },
            botUid: { type: "string" },
            historyLimit: { type: "number", minimum: 1, maximum: 100 },
            historyPromptTemplate: { type: "string" },
          },
        },
      },
    },
  },
};
