import type { ChannelLogSink, OpenClawConfig } from "openclaw/plugin-sdk";
import { sendMessage, sendReadReceipt, sendTyping } from "./api-fetch.js";
import type { ResolvedDmworkAccount } from "./accounts.js";
import type { BotMessage } from "./types.js";
import { ChannelType, MessageType } from "./types.js";
import { getDmworkRuntime } from "./runtime.js";
import {
  recordPendingHistoryEntryIfEnabled,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
} from "openclaw/plugin-sdk";

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
  log?: ChannelLogSink;
  statusSink?: DmworkStatusSink;
}) {
  const { account, message, botUid, log, statusSink } = params;

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
  // In groups, only respond when the bot is explicitly @mentioned via
  // payload.mention.uids (structured mention from WuKongIM).
  // Unmentioned messages are recorded as history context for when the bot
  // IS mentioned later.
  // botUid comes from channel.ts credentials.robot_id
  const requireMention = account.config.requireMention !== false; // default true

  if (isGroup && requireMention) {
    const mentionUids: string[] = message.payload?.mention?.uids ?? [];
    const isMentioned = mentionUids.includes(botUid);

    if (!isMentioned) {
      // Record as pending history for future context
      recordPendingHistoryEntryIfEnabled({
        channelId: "dmwork",
        groupId: sessionId,
        entry: {
          from: message.from_uid,
          body: rawBody,
          ts: message.timestamp ? message.timestamp * 1000 : Date.now(),
        },
        limit: DEFAULT_GROUP_HISTORY_LIMIT,
      });
      log?.info?.(
        `dmwork: group message not mentioning bot, recorded as history context`,
      );
      return;
    }

    // Bot IS mentioned — prepend history context
    const historyContext = buildPendingHistoryContextFromMap({
      channelId: "dmwork",
      groupId: sessionId,
    });
    if (historyContext) {
      log?.info?.(`dmwork: prepending ${historyContext.split("\n").length} history entries`);
    }
    // Clear history after consuming
    clearHistoryEntriesIfEnabled({ channelId: "dmwork", groupId: sessionId });
  }

  const core = getDmworkRuntime();
  const config = core.config.loadConfig() as OpenClawConfig;

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "dmwork",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: sessionId,
    },
  });

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

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "DMWork",
    from: fromLabel,
    timestamp: message.timestamp ? message.timestamp * 1000 : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
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

  // 已读回执 + 正在输入 — fire-and-forget，失败不影响主流程
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

        const replyChannelId = isGroup ? message.channel_id! : message.from_uid;
        const replyChannelType = isGroup ? ChannelType.Group : ChannelType.DM;

        await sendMessage({
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken ?? "",
          channelId: replyChannelId,
          channelType: replyChannelType,
          content,
        });

        statusSink?.({ lastOutboundAt: Date.now(), lastError: null });
      },
      onError: (err, info) => {
        log?.error?.(`dmwork ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}
