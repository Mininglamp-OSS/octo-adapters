import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  type ChannelOutboundContext,
  type ChannelPlugin,
  recordPendingHistoryEntryIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
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
 * Check if the bot was mentioned in a group message.
 * Uses the structured mention.uids field from WuKongIM payload.
 */
function checkBotMentioned(payload: MessagePayload | undefined, botUid: string): boolean {
  if (!payload?.mention) return false;
  // @all
  if (payload.mention.all === 1) return true;
  // @specific bot
  if (payload.mention.uids?.includes(botUid)) return true;
  return false;
}

/**
 * Resolve whether mention is required for a group.
 * Checks group-specific config, then global config. Default: true.
 */
function resolveRequireMention(
  dmworkConfig: Record<string, unknown> | undefined,
  groupId: string | undefined,
): boolean {
  const cfg = dmworkConfig as {
    requireMention?: boolean;
    groups?: Record<string, { requireMention?: boolean; enabled?: boolean }>;
  } | undefined;

  // Group-specific override
  if (groupId && cfg?.groups) {
    const groupConfig = cfg.groups[groupId] ?? cfg.groups["*"];
    if (typeof groupConfig?.requireMention === "boolean") {
      return groupConfig.requireMention;
    }
  }

  // Global default
  if (typeof cfg?.requireMention === "boolean") {
    return cfg.requireMention;
  }

  // Default: require mention (same as Telegram/Feishu/Discord)
  return true;
}

/**
 * Check if a group is allowed based on groupPolicy.
 */
function isGroupAllowed(
  dmworkConfig: Record<string, unknown> | undefined,
  groupId: string | undefined,
): boolean {
  const cfg = dmworkConfig as {
    groupPolicy?: string;
    groups?: Record<string, { enabled?: boolean }>;
  } | undefined;

  const policy = cfg?.groupPolicy ?? "open";

  if (policy === "disabled") return false;
  if (policy === "open") return true;

  // allowlist mode
  if (!groupId || !cfg?.groups) return false;
  const groupConfig = cfg.groups[groupId] ?? cfg.groups["*"];
  return groupConfig?.enabled !== false && groupConfig !== undefined;
}

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
  groups: {
    resolveRequireMention: (params) => {
      const dmworkConfig = params.cfg?.channels?.dmwork as Record<string, unknown> | undefined;
      return resolveRequireMention(dmworkConfig, params.groupId ?? undefined);
    },
  },
  mentions: {
    stripPatterns: () => ["@\\S+"],
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

      // Group message history (for context when bot is not mentioned)
      const groupHistories = new Map<string, HistoryEntry[]>();
      const historyLimit = DEFAULT_GROUP_HISTORY_LIMIT;
      const dmworkConfig = (ctx.cfg as OpenClawConfig)?.channels?.dmwork as Record<string, unknown> | undefined;

      // 4. Connect WebSocket
      const socket = new WKSocket({
        wsUrl,
        uid: credentials.robot_id,
        token: credentials.im_token,

        onMessage: (msg: BotMessage) => {
          // Skip self messages
          if (msg.from_uid === credentials.robot_id) return;
          // Skip non-text for now
          if (!msg.payload || msg.payload.type !== MessageType.Text) return;

          const isGroup = msg.channel_type === ChannelType.Group && !!msg.channel_id;

          // --- Group message filtering ---
          if (isGroup) {
            // Check group policy
            if (!isGroupAllowed(dmworkConfig, msg.channel_id)) {
              log?.info?.(
                `dmwork: group ${msg.channel_id} not allowed by groupPolicy, skipping`,
              );
              return;
            }

            // Check mention requirement
            const needsMention = resolveRequireMention(dmworkConfig, msg.channel_id);
            const mentioned = checkBotMentioned(msg.payload, credentials.robot_id);

            if (needsMention && !mentioned) {
              // Not mentioned — record to history for context, don't trigger AI
              log?.info?.(
                `dmwork: group ${msg.channel_id} message from ${msg.from_uid} — no mention, storing as context`,
              );
              recordPendingHistoryEntryIfEnabled({
                historyMap: groupHistories,
                historyKey: msg.channel_id!,
                limit: historyLimit,
                entry: {
                  sender: msg.from_uid,
                  body: `${msg.from_uid}: ${msg.payload.content ?? ""}`,
                  timestamp: Date.now(),
                  messageId: msg.message_id,
                },
              });
              return;
            }

            log?.info?.(
              `dmwork: group ${msg.channel_id} message from ${msg.from_uid} — mentioned=${mentioned}, processing`,
            );
          }

          log?.info?.(
            `dmwork: recv message from=${msg.from_uid} channel=${msg.channel_id ?? "DM"} type=${msg.channel_type ?? 1}`,
          );

          handleInboundMessage({
            account,
            message: msg,
            log,
            statusSink,
            groupHistories,
            historyLimit,
          }).catch((err) => {
            log?.error?.(`dmwork: inbound handler failed: ${String(err)}`);
          });
        },

        onConnected: () => {
          log?.info?.(`dmwork: WebSocket connected to ${wsUrl}`);
          statusSink({ lastError: null });
          startHeartbeat();

          // Send greeting to owner
          sendMessage({
            apiUrl: account.config.apiUrl,
            botToken: account.config.botToken!,
            channelId: credentials.owner_uid,
            channelType: ChannelType.DM,
            content: "I'm online and ready!",
          }).catch((err) => {
            log?.warn?.(`dmwork: failed to send greeting: ${String(err)}`);
          });
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
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
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
