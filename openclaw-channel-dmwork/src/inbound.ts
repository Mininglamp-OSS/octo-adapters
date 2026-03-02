import type { ChannelLogSink, OpenClawConfig } from "openclaw/plugin-sdk";
import { sendMessage, sendReadReceipt, sendTyping } from "./api-fetch.js";
import type { ResolvedDmworkAccount } from "./accounts.js";
import type { BotMessage } from "./types.js";
import { ChannelType, MessageType } from "./types.js";
import { getDmworkRuntime } from "./runtime.js";

// Defensive imports — these may not exist in older OpenClaw versions
let recordPendingHistoryEntryIfEnabled: any;
let buildPendingHistoryContextFromMap: any;
let clearHistoryEntriesIfEnabled: any;
let DEFAULT_GROUP_HISTORY_LIMIT = 20;
let _sdkLoaded = false;

async function ensureSdkLoaded() {
  if (_sdkLoaded) return;
  _sdkLoaded = true;
  try {
    const sdk = await import("openclaw/plugin-sdk");
    if (typeof sdk.recordPendingHistoryEntryIfEnabled === "function") {
      recordPendingHistoryEntryIfEnabled = sdk.recordPendingHistoryEntryIfEnabled;
    }
    if (typeof sdk.buildPendingHistoryContextFromMap === "function") {
      buildPendingHistoryContextFromMap = sdk.buildPendingHistoryContextFromMap;
    }
    if (typeof sdk.clearHistoryEntriesIfEnabled === "function") {
      clearHistoryEntriesIfEnabled = sdk.clearHistoryEntriesIfEnabled;
    }
    if (sdk.DEFAULT_GROUP_HISTORY_LIMIT) {
      DEFAULT_GROUP_HISTORY_LIMIT = sdk.DEFAULT_GROUP_HISTORY_LIMIT;
    }
  } catch {
    // Older OpenClaw versions may not export these — fallback implementations used
  }
}



// Re-export a minimal HistoryEntry type for when SDK doesn't have it
export interface HistoryEntryCompat {
  sender: string;
  body: string;
  timestamp: number;
}

export type DmworkStatusSink = (patch: {
  lastInboundAt?: number;
  lastOutboundAt?: number;
  lastError?: string | null;
}) => void;

function resolveContent(payload: BotMessage["payload"]): string {
  if (!payload) return "";
  if (typeof payload.content === "string") return payload.content;
  if (typeof payload.url === "string") return payload.url;
  return "";
}

export async function handleInboundMessage(params: {
  account: ResolvedDmworkAccount;
  message: BotMessage;
  botUid: string;
  groupHistories: Map<string, any[]>;
  log?: ChannelLogSink;
  statusSink?: DmworkStatusSink;
}) {
  const { account, message, botUid, groupHistories, log, statusSink } = params;

  await ensureSdkLoaded();

  const isGroup =
    typeof message.channel_id === "string" &&
    message.channel_id.length > 0 &&
    message.channel_type === ChannelType.Group;

  const sessionId = isGroup
    ? message.channel_id!
    : message.from_uid;

  const rawBody = resolveContent(message.payload);
  if (!rawBody) {
    log?.info?.(
      `dmwork: inbound dropped session=${sessionId} reason=empty-content`,
    );
    return;
  }

  // --- Mention gating for group messages ---
  const requireMention = account.config.requireMention !== false;
  let historyPrefix = "";

  if (isGroup && requireMention) {
    const mentionUids: string[] = message.payload?.mention?.uids ?? [];
    const mentionAll: boolean = message.payload?.mention?.all === true;
    const isMentioned = mentionAll || mentionUids.includes(botUid);

    if (!isMentioned) {
      // Record as pending history — with fallback for older SDK
      if (typeof recordPendingHistoryEntryIfEnabled === "function") {
        recordPendingHistoryEntryIfEnabled({
          historyMap: groupHistories,
          historyKey: sessionId,
          entry: {
            sender: message.from_uid,
            body: rawBody,
            timestamp: message.timestamp ? message.timestamp * 1000 : Date.now(),
          },
          limit: DEFAULT_GROUP_HISTORY_LIMIT,
        });
      } else {
        // Manual fallback: store history in the map directly
        if (!groupHistories.has(sessionId)) {
          groupHistories.set(sessionId, []);
        }
        const entries = groupHistories.get(sessionId)!;
        entries.push({
          sender: message.from_uid,
          body: rawBody,
          timestamp: message.timestamp ? message.timestamp * 1000 : Date.now(),
        });
        // Trim to limit
        while (entries.length > DEFAULT_GROUP_HISTORY_LIMIT) {
          entries.shift();
        }
      }
      log?.info?.(
        `dmwork: group message not mentioning bot, recorded as history context`,
      );
      return;
    }

    // Bot IS mentioned — prepend history context
    if (typeof buildPendingHistoryContextFromMap === "function") {
      const enrichedBody = buildPendingHistoryContextFromMap({
        historyMap: groupHistories,
        historyKey: sessionId,
        currentMessage: rawBody,
        limit: DEFAULT_GROUP_HISTORY_LIMIT,
      });
      if (enrichedBody !== rawBody) {
        historyPrefix = enrichedBody.slice(0, enrichedBody.length - rawBody.length);
        log?.info?.(`dmwork: prepending history context (${historyPrefix.length} chars)`);
      }
    } else {
      // Manual fallback: build history prefix
      const entries = groupHistories.get(sessionId) ?? [];
      if (entries.length > 0) {
        historyPrefix = entries
          .map((e: any) => `[${e.sender}]: ${e.body}`)
          .join("\n") + "\n---\n";
        log?.info?.(`dmwork: prepending history context (${historyPrefix.length} chars, fallback)`);
      }
    }

    // Clear history after consuming
    if (typeof clearHistoryEntriesIfEnabled === "function") {
      clearHistoryEntriesIfEnabled({
        historyMap: groupHistories,
        historyKey: sessionId,
        limit: DEFAULT_GROUP_HISTORY_LIMIT,
      });
    } else {
      groupHistories.delete(sessionId);
    }
  }

  const core = getDmworkRuntime();
  if (!core?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    log?.error?.(`dmwork: OpenClaw runtime missing required functions. Available: config=${!!core?.config}, channel=${!!core?.channel}, reply=${!!core?.channel?.reply}, routing=${!!core?.channel?.routing}, session=${!!core?.channel?.session}`);
    log?.error?.(`dmwork: reply methods: ${core?.channel?.reply ? Object.keys(core.channel.reply).join(",") : "N/A"}`);
    log?.error?.(`dmwork: session methods: ${core?.channel?.session ? Object.keys(core.channel.session).join(",") : "N/A"}`);
    log?.error?.(`dmwork: routing methods: ${core?.channel?.routing ? Object.keys(core.channel.routing).join(",") : "N/A"}`);
    return;
  }
  
  // Log available SDK functions for debugging version compatibility
  log?.info?.(`dmwork: SDK check - resolveEnvelopeFormatOptions=${typeof core.channel.reply.resolveEnvelopeFormatOptions}, formatAgentEnvelope=${typeof core.channel.reply.formatAgentEnvelope}, finalizeInboundContext=${typeof core.channel.reply.finalizeInboundContext}`);
  log?.info?.(`dmwork: SDK check - resolveStorePath=${typeof core.channel.session.resolveStorePath}, readSessionUpdatedAt=${typeof core.channel.session.readSessionUpdatedAt}, recordInboundSession=${typeof core.channel.session.recordInboundSession}`);
  
  const config = core.config.loadConfig() as OpenClawConfig;

  let route;
  try {
    route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "dmwork",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: sessionId,
    },
  });

  } catch (routeErr) {
    log?.error?.(`dmwork: resolveAgentRoute failed: ${String(routeErr)}`);
    return;
  }

  const fromLabel = isGroup
    ? `group:${message.channel_id}`
    : `user:${message.from_uid}`;

  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const finalBody = historyPrefix ? historyPrefix + rawBody : rawBody;

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "DMWork",
    from: fromLabel,
    timestamp: message.timestamp ? message.timestamp * 1000 : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: finalBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `dmwork:${message.from_uid}`,
    To: `dmwork:${sessionId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderId: message.from_uid,
    MessageSid: String(message.message_id),
    Timestamp: message.timestamp ? message.timestamp * 1000 : undefined,
    GroupSubject: isGroup ? message.channel_id : undefined,
    Provider: "dmwork",
    Surface: "dmwork",
    OriginatingChannel: "dmwork",
    OriginatingTo: `dmwork:${sessionId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      log?.error?.(`dmwork: failed updating session meta: ${String(err)}`);
    },
  });

  statusSink?.({ lastInboundAt: Date.now(), lastError: null });

  const replyChannelId = isGroup ? message.channel_id! : message.from_uid;
  const replyChannelType = isGroup ? ChannelType.Group : ChannelType.DM;

  // 已读回执 + 正在输入 — fire-and-forget
  log?.info?.(`dmwork: sending readReceipt+typing to channel=${replyChannelId} type=${replyChannelType} apiUrl=${account.config.apiUrl}`);
  const messageIds = message.message_id ? [message.message_id] : [];
  sendReadReceipt({ apiUrl: account.config.apiUrl, botToken: account.config.botToken ?? "", channelId: replyChannelId, channelType: replyChannelType, messageIds })
    .then(() => log?.info?.("dmwork: readReceipt sent OK"))
    .catch((err) => log?.error?.(`dmwork: readReceipt failed: ${String(err)}`));
  sendTyping({ apiUrl: account.config.apiUrl, botToken: account.config.botToken ?? "", channelId: replyChannelId, channelType: replyChannelType })
    .then(() => log?.info?.("dmwork: typing sent OK"))
    .catch((err) => log?.error?.(`dmwork: typing failed: ${String(err)}`));

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload: {
        text?: string;
        mediaUrls?: string[];
        mediaUrl?: string;
        replyToId?: string | null;
      }) => {
        const contentParts: string[] = [];
        if (payload.text) contentParts.push(payload.text);
        const mediaUrls = [
          ...(payload.mediaUrls ?? []),
          ...(payload.mediaUrl ? [payload.mediaUrl] : []),
        ].filter(Boolean);
        if (mediaUrls.length > 0) contentParts.push(...mediaUrls);
        const content = contentParts.join("\n").trim();
        if (!content) return;

        await sendMessage({
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken ?? "",
          channelId: replyChannelId,
          channelType: replyChannelType,
          content,
          // In group replies, @mention the original sender
          ...(isGroup ? { mentionUids: [message.from_uid] } : {}),
        });

        statusSink?.({ lastOutboundAt: Date.now(), lastError: null });
      },
      onError: (err, info) => {
        log?.error?.(`dmwork ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}
