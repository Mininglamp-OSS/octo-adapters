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
import { registerBot, sendMessage, sendHeartbeat, fetchEvents, ackEvent } from "./api-fetch.js";
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

      // 1. Register bot
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
        // Clear existing heartbeat to prevent duplicates on reconnect
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

      // 5. Connect WebSocket
      const socket = new WKSocket({
        wsUrl,
        uid: credentials.robot_id,
        token: credentials.im_token,

        onMessage: (msg: BotMessage) => {
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

          // No greeting on connect — bot stays silent until user sends a message
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

      // 6. Events polling fallback for reliable message delivery
      let lastEventId = 0;
      const seenMessageIds = new Set<string>();
      let pollTimer: NodeJS.Timeout | null = null;
      let pollInFlight = false;

      const pollEvents = async () => {
        if (stopped || pollInFlight) return;
        pollInFlight = true;
        try {
          const resp = await fetchEvents({
            apiUrl: account.config.apiUrl,
            botToken: account.config.botToken!,
            lastEventId,
            limit: 50,
          });
          for (const event of resp.results ?? []) {
            if (event.event_id > lastEventId) {
              lastEventId = event.event_id;
            }
            const msg = event.message;
            if (!msg) continue;
            // Always ack the event regardless of dedup
            ackEvent({
              apiUrl: account.config.apiUrl,
              botToken: account.config.botToken!,
              eventId: event.event_id,
            }).catch((err) => {
              log?.error?.(`dmwork: ack event ${event.event_id} failed: ${String(err)}`);
            });
            // Dedup by message_id
            if (seenMessageIds.has(msg.message_id)) continue;
            seenMessageIds.add(msg.message_id);
            if (seenMessageIds.size > 1000) {
              const oldest = seenMessageIds.values().next().value!;
              seenMessageIds.delete(oldest);
            }
            // Skip self and non-text
            if (msg.from_uid === credentials.robot_id) continue;
            if (!msg.payload || msg.payload.type !== MessageType.Text) continue;
            // DM events may omit channel_id — default to sender uid
            const normalizedMsg: BotMessage = {
              ...msg,
              channel_id: msg.channel_id ?? msg.from_uid,
              channel_type: msg.channel_type ?? ChannelType.DM,
            };
            log?.info?.(
              `dmwork: poll recv message_id=${msg.message_id} from=${msg.from_uid} channel=${normalizedMsg.channel_id} type=${normalizedMsg.channel_type}`,
            );
            handleInboundMessage({
              account,
              message: normalizedMsg,
              botUid: credentials.robot_id,
              groupHistories,
              log,
              statusSink,
            }).catch((err) => {
              log?.error?.(`dmwork: poll inbound handler failed: ${String(err)}`);
            });
          }
        } catch (err) {
          if (!stopped) {
            log?.warn?.(`dmwork: events poll failed: ${String(err)}`);
          }
        } finally {
          pollInFlight = false;
        }
      };

      pollTimer = setInterval(() => { pollEvents(); }, 2000);

      // Handle abort signal
      const onAbort = () => {
        stopped = true;
        socket.disconnect();
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
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
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
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
