import type { ChannelLogSink, OpenClawConfig } from "openclaw/plugin-sdk";
import { sendMessage, sendReadReceipt, sendTyping, getChannelMessages } from "./api-fetch.js";
import type { ResolvedDmworkAccount } from "./accounts.js";
import type { BotMessage } from "./types.js";
import { ChannelType, MessageType } from "./types.js";
import { getDmworkRuntime } from "./runtime.js";

// Defensive imports — these may not exist in older OpenClaw versions
// History context managed manually for cross-SDK compatibility
let clearHistoryEntriesIfEnabled: any;
let DEFAULT_GROUP_HISTORY_LIMIT = 20;
let _sdkLoaded = false;

async function ensureSdkLoaded() {
  if (_sdkLoaded) return;
  _sdkLoaded = true;
  try {
    const sdk = await import("openclaw/plugin-sdk");
    // History context managed manually (SDK buildPendingHistoryContextFromMap
    // has incompatible entry format expectations across versions)
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

  // Extract quoted/replied message content if present
  let quotePrefix = "";
  const replyData = message.payload?.reply;
  if (replyData) {
    const replyPayload = replyData.payload;
    const replyContent = replyPayload?.content ?? resolveContent(replyPayload);
    const replyFrom = replyData.from_uid ?? replyData.from_name ?? "unknown";
    if (replyContent) {
      quotePrefix = `[Quoted message from ${replyFrom}]: ${replyContent}\n---\n`;
      log?.info?.(`dmwork: message quotes a reply (${quotePrefix.length} chars)`);
    }
  }

  // --- Mention gating for group messages ---
  const requireMention = account.config.requireMention !== false;
  let historyPrefix = "";

  if (isGroup && requireMention) {
    const mentionUids: string[] = message.payload?.mention?.uids ?? [];
    const mentionAll: boolean = message.payload?.mention?.all === true;
    const isMentioned = mentionAll || mentionUids.includes(botUid);

    if (!isMentioned) {
      // Record as pending history context (manual — avoids SDK format incompatibility)
      if (!groupHistories.has(sessionId)) {
        groupHistories.set(sessionId, []);
      }
      const entries = groupHistories.get(sessionId)!;
      entries.push({
        sender: message.from_uid,
        body: rawBody,
        timestamp: message.timestamp ? message.timestamp * 1000 : Date.now(),
      });
      const historyLimit = account.config.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT;
      while (entries.length > historyLimit) {
        entries.shift();
      }
      log?.info?.(
        `dmwork: [HISTORY] 非@消息已缓存 | from=${message.from_uid} | session=${sessionId} | 当前缓存=${entries.length}条`,
      );
      return;
    }

    // Bot IS mentioned — prepend history context (manual — avoids SDK format incompatibility)
    // Sliding window: always include the most recent historyLimit messages
    const historyLimit = account.config.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT;
    let entries = groupHistories.get(sessionId) ?? [];
    // Take last N entries (sliding window)
    if (entries.length > historyLimit) {
      entries = entries.slice(-historyLimit);
      groupHistories.set(sessionId, entries);  // Persist trimmed entries
    }
    const historyCountBefore = entries.length;
    log?.info?.(`dmwork: [MENTION] 收到@消息 | from=${message.from_uid} | 缓存=${historyCountBefore}条 | historyLimit=${historyLimit} | session=${sessionId}`);

    // If memory cache is empty, try fetching from API
    if (entries.length === 0 && account.config.botToken) {
      log?.info?.(`dmwork: [MENTION] 内存缓存为空，尝试从API获取历史...`);
      try {
        const fetchLimit = Math.min(historyLimit, 100);  // Cap at 100
        const apiMessages = await getChannelMessages({
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken,
          channelId: message.channel_id!,
          channelType: ChannelType.Group,
          limit: fetchLimit,
          log,
        });
        entries = apiMessages
          .filter((m: any) => m.from_uid !== botUid && m.content && !m.content.includes(`@${botUid}`))
          .slice(-historyLimit)
          .map((m: any) => ({
            sender: m.from_uid,
            body: m.content,
            timestamp: m.timestamp * 1000,
          }));
        groupHistories.set(sessionId, entries);  // Persist API-fetched entries
        log?.info?.(`dmwork: [MENTION] 从API获取到 ${entries.length} 条历史消息`);
      } catch (err) {
        log?.error?.(`dmwork: [MENTION] 从API获取历史失败: ${err}`);
      }
    }

    // Build history context manually (JSON format)
    if (entries.length > 0) {
      historyPrefix = "【群聊历史记录】以下是你上次回复后群里其他人说的话（sender 是用户ID，body 是消息内容）：\n```json\n" +
        JSON.stringify(entries.map((e: any) => ({
          sender: e.sender,
          body: e.body,
        })), null, 2) +
        "\n```\n请根据这些历史上下文来回复当前的@消息。\n\n";
      log?.info?.(`dmwork: [MENTION] 已注入历史上下文 | ${historyPrefix.length} chars | ${entries.length}条消息`);
    } else {
      log?.info?.(`dmwork: [MENTION] 无历史上下文可注入`);
    }

    // Sliding window: keep history, don't clear
    // (entries stay in queue, limited by historyLimit in the caching logic)
    log?.info?.(`dmwork: [MENTION] 历史滑动窗口 | session=${sessionId} | 队列保留`);
  }

  const core = getDmworkRuntime();
  if (!core?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    log?.error?.(`dmwork: OpenClaw runtime missing required functions. Available: config=${!!core?.config}, channel=${!!core?.channel}, reply=${!!core?.channel?.reply}, routing=${!!core?.channel?.routing}, session=${!!core?.channel?.session}`);
    log?.error?.(`dmwork: reply methods: ${core?.channel?.reply ? Object.keys(core.channel.reply).join(",") : "N/A"}`);
    log?.error?.(`dmwork: session methods: ${core?.channel?.session ? Object.keys(core.channel.session).join(",") : "N/A"}`);
    log?.error?.(`dmwork: routing methods: ${core?.channel?.routing ? Object.keys(core.channel.routing).join(",") : "N/A"}`);
    return;
  }
  
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

  const finalBody = (historyPrefix || quotePrefix) ? (historyPrefix + quotePrefix + rawBody) : rawBody;

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
    BodyForAgent: body,  // ← 关键！AI 实际读取的是这个字段！
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
