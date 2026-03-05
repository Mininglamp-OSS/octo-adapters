import type { ChannelLogSink, OpenClawConfig } from "openclaw/plugin-sdk";
import { sendMessage, sendReadReceipt, sendTyping, getChannelMessages, getGroupMembers } from "./api-fetch.js";
import type { ResolvedDmworkAccount } from "./accounts.js";
import type { BotMessage } from "./types.js";
import { ChannelType, MessageType } from "./types.js";
import { getDmworkRuntime } from "./runtime.js";
import { DEFAULT_HISTORY_PROMPT_TEMPLATE } from "./config-schema.js";
import { extractMentionMatches } from "./mention-utils.js";

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

interface ResolvedContent {
  text: string;
  mediaUrl?: string;
  mediaType?: string;
}

function resolveContent(payload: BotMessage["payload"]): ResolvedContent {
  if (!payload) return { text: "" };
  switch (payload.type) {
    case MessageType.Text:
      return { text: payload.content ?? "" };
    case MessageType.Image:
      return { text: "[图片]", mediaUrl: payload.url, mediaType: "image" };
    case MessageType.GIF:
      return { text: "[GIF]", mediaUrl: payload.url, mediaType: "image" };
    case MessageType.Voice:
      return { text: "[语音消息]" };
    case MessageType.Video:
      return { text: "[视频]", mediaUrl: payload.url, mediaType: "video" };
    case MessageType.File:
      return { text: `[文件: ${payload.name ?? "未知文件"}]`, mediaUrl: payload.url };
    case MessageType.Location:
      return { text: "[位置信息]" };
    case MessageType.Card:
      return { text: "[名片]" };
    default:
      return { text: payload.content ?? payload.url ?? "" };
  }
}

/** Extract text-only content for history/quotes (no mediaUrl) */
function resolveContentText(payload: BotMessage["payload"]): string {
  return resolveContent(payload).text;
}

/** Placeholder text for non-text API history messages */
function resolveApiMessagePlaceholder(type?: number, name?: string): string {
  switch (type) {
    case MessageType.Image: return "[图片]";
    case MessageType.GIF: return "[GIF]";
    case MessageType.Voice: return "[语音消息]";
    case MessageType.Video: return "[视频]";
    case MessageType.File: return `[文件: ${name ?? "未知文件"}]`;
    case MessageType.Location: return "[位置信息]";
    case MessageType.Card: return "[名片]";
    default: return "[消息]";
  }
}

/**
 * Strip emoji from string for fuzzy matching.
 * Removes most emoji using Unicode ranges.
 */
function stripEmoji(str: string): string {
  return str
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // Most emoji (faces, symbols, etc.)
    .replace(/[\u{2600}-\u{26FF}]/gu, '')   // Misc symbols
    .replace(/[\u{2700}-\u{27BF}]/gu, '')   // Dingbats
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')   // Variation selectors
    .replace(/[\u{1F000}-\u{1F02F}]/gu, '') // Mahjong, dominos
    .replace(/[\u{1F0A0}-\u{1F0FF}]/gu, '') // Playing cards
    .trim();
}

/**
 * Find uid by displayName with emoji-tolerant matching.
 * First tries exact match, then falls back to matching with emoji stripped.
 */
function findUidByName(name: string, memberMap: Map<string, string>): string | undefined {
  // First try exact match
  const exact = memberMap.get(name);
  if (exact) return exact;
  
  // Then try matching by stripping emoji from both sides
  const strippedName = stripEmoji(name);
  if (!strippedName) return undefined;
  
  for (const [displayName, uid] of memberMap.entries()) {
    if (stripEmoji(displayName) === strippedName) {
      return uid;
    }
  }
  return undefined;
}

// Cache expiry time: 1 hour
const GROUP_CACHE_EXPIRY_MS = 60 * 60 * 1000;


/**
 * Refresh group member cache at module level to avoid closure recreation per message.
 * Extracted from handleInboundMessage (fixes #25).
 */
async function refreshGroupMemberCache(opts: {
  sessionId: string;
  memberMap: Map<string, string>;
  uidToNameMap: Map<string, string>;
  groupCacheTimestamps: Map<string, number>;
  apiUrl: string;
  botToken: string;
  forceRefresh?: boolean;
  log?: ChannelLogSink;
}): Promise<boolean> {
  const { sessionId, memberMap, uidToNameMap, groupCacheTimestamps, apiUrl, botToken, log } = opts;
  const forceRefresh = opts.forceRefresh ?? false;

  const lastFetched = groupCacheTimestamps.get(sessionId) ?? 0;
  const now = Date.now();
  const isExpired = (now - lastFetched) > GROUP_CACHE_EXPIRY_MS;

  if (!forceRefresh && !isExpired && lastFetched > 0) {
    return false;
  }

  log?.info?.(`dmwork: [CACHE] ${forceRefresh ? 'Force refreshing' : 'Refreshing expired'} group member cache for ${sessionId}`);

  try {
    const members = await getGroupMembers({
      apiUrl,
      botToken,
      groupNo: sessionId,
    });

    if (members.length > 0) {
      for (const m of members) {
        if (m.name && m.uid) {
          memberMap.set(m.name, m.uid);
          uidToNameMap.set(m.uid, m.name);

          const nameWithoutEmoji = stripEmoji(m.name);
          if (nameWithoutEmoji && nameWithoutEmoji !== m.name && !memberMap.has(nameWithoutEmoji)) {
            memberMap.set(nameWithoutEmoji, m.uid);
            log?.debug?.(`dmwork: [CACHE] Added emoji alias: "${nameWithoutEmoji}" -> "${m.uid}"`);
          }
        }
      }
      groupCacheTimestamps.set(sessionId, now);
      log?.info?.(`dmwork: [CACHE] Loaded ${members.length} members, memberMap size: ${memberMap.size}`);
      return true;
    } else {
      groupCacheTimestamps.set(sessionId, now - GROUP_CACHE_EXPIRY_MS + 30000);
      log?.warn?.(`dmwork: [CACHE] No members returned for group ${sessionId}, backoff 30s`);
      return false;
    }
  } catch (err) {
    groupCacheTimestamps.set(sessionId, now - GROUP_CACHE_EXPIRY_MS + 30000);
    log?.error?.(`dmwork: [CACHE] Failed to fetch group members: ${err}, backoff 30s`);
    return false;
  }
}

export async function handleInboundMessage(params: {
  account: ResolvedDmworkAccount;
  message: BotMessage;
  botUid: string;
  groupHistories: Map<string, any[]>;
  memberMap: Map<string, string>;  // displayName -> uid mapping
  uidToNameMap: Map<string, string>;  // uid -> displayName mapping (reverse)
  groupCacheTimestamps: Map<string, number>;  // groupId -> lastFetchedAt
  log?: ChannelLogSink;
  statusSink?: DmworkStatusSink;
}) {
  const { account, message, botUid, groupHistories, memberMap, uidToNameMap, groupCacheTimestamps, log, statusSink } = params;

  await ensureSdkLoaded();

  const isGroup =
    typeof message.channel_id === "string" &&
    message.channel_id.length > 0 &&
    message.channel_type === ChannelType.Group;

  const sessionId = isGroup
    ? message.channel_id!
    : message.from_uid;

  const resolved = resolveContent(message.payload);
  const rawBody = resolved.text;
  const inboundMediaUrl = resolved.mediaUrl;
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
    const replyContent = replyPayload?.content ?? (replyPayload ? resolveContentText(replyPayload) : "");
    const replyFrom = replyData.from_uid ?? replyData.from_name ?? "unknown";
    if (replyContent) {
      quotePrefix = `[Quoted message from ${replyFrom}]: ${replyContent}\n---\n`;
      log?.info?.(`dmwork: message quotes a reply (${quotePrefix.length} chars)`);
    }
  }

  // --- Mention gating for group messages ---
  const requireMention = account.config.requireMention !== false;
  let historyPrefix = "";
  
  // Save original mention uids for reply (exclude bot itself)
  const originalMentionUids: string[] = (message.payload?.mention?.uids ?? []).filter((uid: string) => uid !== botUid);

    // Refresh group member cache if needed (on first message or after expiry)
  if (isGroup) {
    await refreshGroupMemberCache({ sessionId, memberMap, uidToNameMap, groupCacheTimestamps, apiUrl: account.config.apiUrl, botToken: account.config.botToken ?? "", log });
  }

  // Build displayName -> uid mapping from message content + mention.uids
  // When user sends "@陈皮皮 @托马斯.福 xxx", the @ names in content correspond to mention.uids in order
  if (isGroup) {
    const allMentionUids: string[] = message.payload?.mention?.uids ?? [];
    // Match all @xxx patterns (including Chinese characters, dots, hyphens)
    // Uses shared utility for consistent regex across inbound/outbound (fixes #31)
    const contentMentions = extractMentionMatches(rawBody);
    
    if (contentMentions.length > 0 && allMentionUids.length > 0) {
      log?.debug?.(`dmwork: [MAPPING] content @names: ${JSON.stringify(contentMentions)}, mention.uids: ${JSON.stringify(allMentionUids)}`);
      
      // Pair them in order
      const pairCount = Math.min(contentMentions.length, allMentionUids.length);
      for (let i = 0; i < pairCount; i++) {
        const displayName = contentMentions[i].slice(1); // Remove @ prefix
        const uid = allMentionUids[i];
        if (displayName && uid) {
          // Update both mappings
          if (!memberMap.has(displayName)) {
            memberMap.set(displayName, uid);
            log?.debug?.(`dmwork: [MAPPING] learned name->uid mapping`);
          }
          if (!uidToNameMap.has(uid)) {
            uidToNameMap.set(uid, displayName);
            log?.debug?.(`dmwork: [MAPPING] learned uid->name mapping`);
          }
        }
      }
    }
  }

  if (isGroup && requireMention) {
    const mentionUids: string[] = message.payload?.mention?.uids ?? [];
    // mention.all can be boolean `true` or numeric `1` depending on API version
    const mentionAllRaw = message.payload?.mention?.all;
    const mentionAll: boolean = mentionAllRaw === true || mentionAllRaw === 1;
    const isMentioned = mentionAll || mentionUids.includes(botUid);
    
    // Debug: log received mention info
    log?.debug?.(`dmwork: [RECV] mention payload: uidsCount=${mentionUids.length}, all=${mentionAll}, originalCount=${originalMentionUids.length}`);

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
      groupHistories.set(sessionId, entries); // Persist trimmed array to prevent unbounded growth
    }
    const historyCountBefore = entries.length;
    log?.info?.(`dmwork: [MENTION] 收到@消息 | 缓存=${historyCountBefore}条 | historyLimit=${historyLimit}`);

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
          .filter((m: any) => m.from_uid !== botUid && (m.content || m.type !== 1))
          .slice(-historyLimit)
          .map((m: any) => ({
            sender: m.from_uid,
            body: m.content || resolveApiMessagePlaceholder(m.type, m.name),
            timestamp: m.timestamp,  // Already in ms from getChannelMessages
          }));
        log?.info?.(`dmwork: [MENTION] 从API获取到 ${entries.length} 条历史消息`);
      } catch (err) {
        log?.error?.(`dmwork: [MENTION] 从API获取历史失败: ${err}`);
      }
    }

    // Build history context manually (JSON format)
    if (entries.length > 0) {
      const messagesJson = JSON.stringify(entries.map((e: any) => ({
        sender: e.sender,
        body: e.body,
      })), null, 2);
      const template = account.config.historyPromptTemplate || DEFAULT_HISTORY_PROMPT_TEMPLATE;
      historyPrefix = template
        .replace("{messages}", messagesJson)
        .replace("{count}", String(entries.length));
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
    MediaUrl: inboundMediaUrl,
    MediaUrls: inboundMediaUrl ? [inboundMediaUrl] : undefined,
    MediaTypes: resolved.mediaType ? [resolved.mediaType] : undefined,
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

        // Build mentionUids from @mentions in content, using memberMap to resolve displayName -> uid
        // The order of mentionUids MUST match the order of @xxx in content for correct linking!
        let replyMentionUids: string[] = [];
        let finalContent = content;
        
        if (isGroup) {
          // Parse all @mentions from content (support Chinese, English, dots, underscores, hex uids)
          // Uses shared utility for consistent regex across inbound/outbound (fixes #31)
          const contentMentions = extractMentionMatches(content);
          
          log?.debug?.(`dmwork: [REPLY] content @mentions count: ${contentMentions.length}`);
          log?.debug?.(`dmwork: [REPLY] memberMap size: ${memberMap.size}, uidToNameMap size: ${uidToNameMap.size}`);
          
          // Track if we need to retry after cache refresh
          let unresolvedNames: { name: string; index: number }[] = [];
          
          // Helper to resolve a single mention
          const resolveMention = (name: string): { uid: string | null; newContent: string } => {
            // First try memberMap (displayName -> uid)
            let uid = findUidByName(name, memberMap);
            let newContent = finalContent;
            
            if (uid) {
              log?.debug?.(`dmwork: [REPLY] resolved displayName to uid`);
              return { uid, newContent };
            } else if (/^[a-f0-9]{32}$/i.test(name)) {
              // Looks like a hex uid (32 chars) - try to find display name
              const displayName = uidToNameMap.get(name);
              if (displayName) {
                newContent = newContent.replace(`@${name}`, `@${displayName}`);
                log?.debug?.(`dmwork: [REPLY] replaced uid with displayName`);
                return { uid: name, newContent };
              } else {
                log?.warn?.(`dmwork: [REPLY] unknown hex uid, no displayName found`);
                return { uid: name, newContent };
              }
            } else if (/^[a-zA-Z0-9_]+$/.test(name)) {
              // Looks like a uid format (alphanumeric + underscore)
              const displayName = uidToNameMap.get(name);
              if (displayName) {
                newContent = newContent.replace(`@${name}`, `@${displayName}`);
                log?.debug?.(`dmwork: [REPLY] replaced uid with displayName`);
                return { uid: name, newContent };
              } else {
                log?.debug?.(`dmwork: [REPLY] using mention as uid directly`);
                return { uid: name, newContent };
              }
            } else {
              // Chinese name not found - track for retry
              return { uid: null, newContent };
            }
          };
          
          // First pass: try to resolve all mentions, tracking indices for order preservation
          const resolvedUids: (string | null)[] = [];
          for (const mention of contentMentions) {
            const name = mention.slice(1);
            const result = resolveMention(name);
            finalContent = result.newContent;
            resolvedUids.push(result.uid); // null if unresolved
            if (!result.uid) {
              unresolvedNames.push({ name, index: resolvedUids.length - 1 });
            }
          }
          
          // If we have unresolved names, try refreshing the cache and retry
          if (unresolvedNames.length > 0) {
            log?.info?.(`dmwork: [REPLY] ${unresolvedNames.length} unresolved names, force refreshing cache...`);
            const refreshed = await refreshGroupMemberCache({ sessionId, memberMap, uidToNameMap, groupCacheTimestamps, apiUrl: account.config.apiUrl, botToken: account.config.botToken ?? "", forceRefresh: true, log });
            
            if (refreshed) {
              // Retry unresolved names and insert at original positions
              for (const { name, index } of unresolvedNames) {
                const uid = findUidByName(name, memberMap);
                if (uid) {
                  resolvedUids[index] = uid; // Insert at original position
                  log?.debug?.(`dmwork: [REPLY] after refresh: resolved @${name}`);
                } else {
                  log?.warn?.(`dmwork: [REPLY] after refresh: still cannot resolve @${name}`);
                }
              }
            }
          }
          
          // Build final mention UIDs array preserving original order
          replyMentionUids = resolvedUids.filter((uid): uid is string => uid !== null);
          
          
          if (replyMentionUids.length > 0) {
            log?.debug?.(`dmwork: [REPLY] final mentionUids count: ${replyMentionUids.length}`);
            log?.debug?.(`dmwork: [REPLY] final content length: ${finalContent.length}`);
          }
        }

        await sendMessage({
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken ?? "",
          channelId: replyChannelId,
          channelType: replyChannelType,
          content: finalContent,
          ...(replyMentionUids.length > 0 ? { mentionUids: replyMentionUids } : {}),
        });

        statusSink?.({ lastOutboundAt: Date.now(), lastError: null });
      },
      onError: (err, info) => {
        log?.error?.(`dmwork ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}
