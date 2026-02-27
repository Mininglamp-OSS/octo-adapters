import { z } from "zod";

export const DmworkConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    botToken: z.string().optional(),
    apiUrl: z.string().optional(),
    wsUrl: z.string().optional(),
    pollIntervalMs: z.number().int().min(500).optional(),
    heartbeatIntervalMs: z.number().int().min(5000).optional(),
    accounts: z
      .record(
        z.string(),
        z
          .object({
            name: z.string().optional(),
            enabled: z.boolean().optional(),
            botToken: z.string().optional(),
            apiUrl: z.string().optional(),
            wsUrl: z.string().optional(),
            pollIntervalMs: z.number().int().min(500).optional(),
            heartbeatIntervalMs: z.number().int().min(5000).optional(),
          })
          .strict()
          .optional(),
      )
      .optional(),
  })
  .strict();

export type DmworkConfig = z.infer<typeof DmworkConfigSchema>;
