// Plain config types — no external dependencies

export interface DmworkAccountConfig {
  name?: string;
  enabled?: boolean;
  botToken?: string;
  apiUrl?: string;
  wsUrl?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  requireMention?: boolean;
  botUid?: string;
}

export interface DmworkConfig {
  name?: string;
  enabled?: boolean;
  botToken?: string;
  apiUrl?: string;
  wsUrl?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  requireMention?: boolean;
  botUid?: string;
  accounts?: Record<string, DmworkAccountConfig | undefined>;
}

// JSON Schema for OpenClaw plugin config validation
export const DmworkConfigJsonSchema = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    enabled: { type: "boolean" },
    botToken: { type: "string" },
    apiUrl: { type: "string" },
    wsUrl: { type: "string" },
    pollIntervalMs: { type: "number", minimum: 500 },
    heartbeatIntervalMs: { type: "number", minimum: 5000 },
    requireMention: { type: "boolean" },
    botUid: { type: "string" },
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
          requireMention: { type: "boolean" },
          botUid: { type: "string" },
        },
      },
    },
  },
};
