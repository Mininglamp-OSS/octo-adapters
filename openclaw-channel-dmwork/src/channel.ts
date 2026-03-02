import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  type ChannelOutboundContext,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DmworkConfigSchema } from "./config-schema.js";
import {
  listDmworkAccountIds,
  resolveDefaultDmworkAccountId,
  resolveDmworkAccount,
  type ResolvedDmworkAccount,
} from "./accounts.js";
import { registerBot, sendMessage, sendHeartbeat } from "./api-fetch.js";
import { WKSocket } from "./socket.js";
import { handleInboundMessage, type DmworkStatusSink } from "./inbound.js";
import { ChannelType, MessageType, type BotMessage, type MessagePayload } from "./types.js";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "openclaw/plugin-sdk";

const meta = {
  id: "dmwork",
  label: "DMWork",
  selectionLabel: "DMWork (WuKongIM)",
  docsPath: "/channels/dmwork",
  docsLabel: "dmwork",
  blurb: "WuKongIM gateway for DMWork",
  order: 90,
};

/**
 * Token refresh delay — if no WS message (including CMD) is received within
 * this window after connect, we assume the cached IM token is stale and
 * re-register with force_refresh=true to obtain a fresh token from WuKongIM.
 */
const TOKEN_REFRESH_TIMEOUT_MS = 10_000;

export const dmworkPlugin: ChannelPlugin<ResolvedDmworkAccount> = {
  id: "dmwork",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false,
    reactions: false,
    threads: false,
  },
  reload: { configPrefixes: ["channels.dmwork"] },
  configSchema: buildChannelConfigSchema(DmworkConfigSchema),
  config: {
    listAccountIds: (cfg) => listDmworkAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveDmworkAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultDmworkAccountId(cfg),
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      apiUrl: account.config.apiUrl,
      botToken: account.config.botToken ? "[set]" : "[missing]",
      wsUrl: account.config.wsUrl ?? "[auto-detect]",
    }),
  },
  messaging: {
    normalizeTarget: (target) => target.trim(),
    targetResolver: {
      looksLikeId: (input) => Boolean(input.trim()),
      hint: "<userId or channelId>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async (ctx) => {
      const account = resolveDmworkAccount({
        cfg: ctx.cfg as OpenClawConfig,
        accountId: ctx.accountId ?? DEFAULT_ACCOUNT_ID,
      });
      if (!account.config.botToken) {
        throw new Error("DMWork botToken is not configured");
      }
      const content = ctx.text?.trim();
      if (!content) {
        return { channel: "dmwork", to: ctx.to, messageId: "" };
      }

      await sendMessage({
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken,
        channelId: ctx.to,
        channelType: ChannelType.DM,
        content,
      });

      return { channel: "dmwork", to: ctx.to, messageId: "" };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      apiUrl: account.config.apiUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.configured || !account.config.botToken) {
        throw new Error(
          `DMWork not configured for account "${account.accountId}" (missing botToken)`,
        );
      }

      const log = ctx.log;
      const statusSink: DmworkStatusSink = (patch) =>
        ctx.setStatus({ accountId: account.accountId, ...patch });

      log?.info?.(`[${account.accountId}] registering DMWork bot...`);

      // 1. Register bot (first attempt uses cached token)
      let credentials: {
        robot_id: string;
        im_token: string;
        ws_url: string;
        owner_uid: string;
      };
      try {
        credentials = await registerBot({
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log?.error?.(`dmwork: bot registration failed: ${message}`);
        statusSink({ lastError: message });
        throw err;
      }

      log?.info?.(
        `[${account.accountId}] bot registered as ${credentials.robot_id}`,
      );

      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });

      // 2. Resolve WebSocket URL
      const wsUrl = account.config.wsUrl || credentials.ws_url;

      // 3. Start heartbeat timer
      let heartbeatTimer: NodeJS.Timeout | null = null;
      let stopped = false;

      const startHeartbeat = () => {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        heartbeatTimer = setInterval(() => {
          if (stopped) return;
          sendHeartbeat({
            apiUrl: account.config.apiUrl,
            botToken: account.config.botToken!,
          }).catch((err) => {
            log?.error?.(`dmwork: heartbeat failed: ${String(err)}`);
          });
        }, account.config.heartbeatIntervalMs);
      };

      // 4. Group history map for mention gating context
      const groupHistories = new Map<string, HistoryEntry[]>();

      // 5. Token refresh state — detect stale cached token
      let receivedAnyWsMessage = false;
      let tokenRefreshTimer: NodeJS.Timeout | null = null;
      let hasRefreshedToken = false;

      // 6. Connect WebSocket — pure real-time via WuKongIM SDK
      const socket = new WKSocket({
        wsUrl,
        uid: credentials.robot_id,
        token: credentials.im_token,

        onMessage: (msg: BotMessage) => {
          receivedAnyWsMessage = true;

          // Skip self messages
          if (msg.from_uid === credentials.robot_id) return;
          // Skip non-text for now
          if (!msg.payload || msg.payload.type !== MessageType.Text) return;

          log?.info?.(
            `dmwork: recv message from=${msg.from_uid} channel=${msg.channel_id ?? "DM"} type=${msg.channel_type ?? 1}`,
          );

          handleInboundMessage({
            account,
            message: msg,
            botUid: credentials.robot_id,
            groupHistories,
            log,
            statusSink,
          }).catch((err) => {
            log?.error?.(`dmwork: inbound handler failed: ${String(err)}`);
          });
        },

        onConnected: () => {
          log?.info?.(`dmwork: WebSocket connected to ${wsUrl}`);
          statusSink({ lastError: null });
          startHeartbeat();

          // Start token freshness check — if no WS messages arrive within
          // TOKEN_REFRESH_TIMEOUT_MS, the cached IM token is likely stale
          // (e.g. after WuKongIM restart). Re-register with force_refresh
          // to get a new token and reconnect.
          if (!hasRefreshedToken) {
            tokenRefreshTimer = setTimeout(async () => {
              if (stopped || receivedAnyWsMessage || hasRefreshedToken) return;
              log?.warn?.(
                "dmwork: no WS messages received — cached IM token may be stale, refreshing...",
              );
              hasRefreshedToken = true;
              try {
                const fresh = await registerBot({
                  apiUrl: account.config.apiUrl,
                  botToken: account.config.botToken!,
                  forceRefresh: true,
                });
                credentials = fresh;
                log?.info?.(
                  `dmwork: got fresh IM token, reconnecting WS...`,
                );
                socket.disconnect();
                socket.updateCredentials(fresh.robot_id, fresh.im_token);
                socket.connect();
              } catch (err) {
                log?.error?.(
                  `dmwork: token refresh failed: ${String(err)}`,
                );
              }
            }, TOKEN_REFRESH_TIMEOUT_MS);
          }
        },

        onDisconnected: () => {
          log?.warn?.("dmwork: WebSocket disconnected, will reconnect...");
          statusSink({ lastError: "disconnected" });
        },

        onError: (err: Error) => {
          log?.error?.(`dmwork: WebSocket error: ${err.message}`);
          statusSink({ lastError: err.message });
        },
      });

      socket.connect();

      // Handle abort signal
      const onAbort = () => {
        stopped = true;
        socket.disconnect();
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        if (tokenRefreshTimer) { clearTimeout(tokenRefreshTimer); tokenRefreshTimer = null; }
      };

      if (ctx.abortSignal.aborted) {
        onAbort();
      } else {
        ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      return {
        stop: () => {
          stopped = true;
          socket.disconnect();
          if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
          if (tokenRefreshTimer) { clearTimeout(tokenRefreshTimer); tokenRefreshTimer = null; }
          ctx.abortSignal.removeEventListener("abort", onAbort);
          ctx.setStatus({
            accountId: account.accountId,
            running: false,
            lastStopAt: Date.now(),
          });
        },
      };
    },
  },
};
