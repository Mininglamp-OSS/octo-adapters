/**
 * Structured audit logging for cross-session query operations.
 */

import type { LogSink } from "./types.js";

export interface AuditEntry {
  action: string;
  requester: string | undefined;
  target: string;
  channelType: number;
  result: "allowed" | "denied";
  reason?: string;
  count?: number;
}

export function emitAuditLog(log: LogSink | undefined, entry: AuditEntry): void {
  const json = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  log?.info?.(`[AUDIT] dmwork-query ${json}`);
}
