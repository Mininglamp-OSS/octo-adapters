import { z } from "zod";

const DmworkAccountSchema = z.strictObject({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  botToken: z.string().optional(),
  apiUrl: z.string().optional(),
  wsUrl: z.string().optional(),
  pollIntervalMs: z.number().int().min(500).optional(),
  heartbeatIntervalMs: z.number().int().min(5000).optional(),
});

export const DmworkConfigSchema = z.strictObject({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  botToken: z.string().optional(),
  apiUrl: z.string().optional(),
  wsUrl: z.string().optional(),
  pollIntervalMs: z.number().int().min(500).optional(),
  heartbeatIntervalMs: z.number().int().min(5000).optional(),
  accounts: z.record(z.string(), DmworkAccountSchema.optional()).optional(),
});

export type DmworkConfig = z.infer<typeof DmworkConfigSchema>;
