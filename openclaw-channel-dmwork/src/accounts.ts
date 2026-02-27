import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { DmworkConfig } from "./config-schema.js";

export type DmworkAccountConfig = DmworkConfig & {
  accounts?: Record<string, DmworkConfig | undefined>;
};

export type ResolvedDmworkAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  config: {
    botToken?: string;
    apiUrl: string;
    wsUrl?: string;
    pollIntervalMs: number;
    heartbeatIntervalMs: number;
  };
};

const DEFAULT_API_URL = "http://localhost:8090";
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;

export function listDmworkAccountIds(cfg: OpenClawConfig): string[] {
  const channel = (cfg.channels?.dmwork ?? {}) as DmworkAccountConfig;
  const accountIds = Object.keys(channel.accounts ?? {});
  if (accountIds.length > 0) {
    return accountIds;
  }
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultDmworkAccountId(_cfg: OpenClawConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

export function resolveDmworkAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedDmworkAccount {
  const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const channel = (params.cfg.channels?.dmwork ?? {}) as DmworkAccountConfig;
  const accountConfig = channel.accounts?.[accountId] ?? channel;

  const botToken = accountConfig.botToken ?? channel.botToken;
  const apiUrl = accountConfig.apiUrl ?? channel.apiUrl ?? DEFAULT_API_URL;
  const wsUrl = accountConfig.wsUrl ?? channel.wsUrl;
  const pollIntervalMs =
    accountConfig.pollIntervalMs ??
    channel.pollIntervalMs ??
    DEFAULT_POLL_INTERVAL_MS;
  const heartbeatIntervalMs =
    accountConfig.heartbeatIntervalMs ??
    channel.heartbeatIntervalMs ??
    DEFAULT_HEARTBEAT_INTERVAL_MS;

  const enabled = accountConfig.enabled ?? channel.enabled ?? true;
  const configured = Boolean(botToken?.trim());

  return {
    accountId,
    name: accountConfig.name ?? channel.name,
    enabled,
    configured,
    config: {
      botToken,
      apiUrl,
      wsUrl,
      pollIntervalMs,
      heartbeatIntervalMs,
    },
  };
}
