import type { ChannelLogSink, OpenClawConfig } from "openclaw/plugin-sdk";
import { sendMessage, sendReadReceipt, sendTyping, getChannelMessages, getGroupMembers, postJson } from "./api-fetch.js";
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

/** Extract media URLs from deliver payload */
function resolveOutboundMediaUrls(payload: { mediaUrl?: string; mediaUrls?: string[] }): string[] {
  return [
    ...(payload.mediaUrls ?? []),
    ...(payload.mediaUrl ? [payload.mediaUrl] : []),
  ].filter(Boolean);
}

/** Extract filename from a URL path */
function extractFilename(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/");
    return parts[parts.length - 1] || "file";
  } catch {
    return "file";
  }
}

/** Upload media to MinIO and send as image/file message */
async function uploadAndSendMedia(params: {
  mediaUrl: string;
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  log?: ChannelLogSink;
}): Promise<void> {
  const { mediaUrl, apiUrl, botToken, channelId, channelType, log } = params;

  // Fetch the media content
  const resp = await fetch(mediaUrl);
  if (!resp.ok) throw new Error(`Failed to fetch media: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const contentType = resp.headers.get("content-type") || "application/octet-stream";
  const filename = extractFilename(mediaUrl);

  // Upload to MinIO via multipart
  const boundary = `----FormBoundary${Date.now()}`;
  const bodyParts: Buffer[] = [];
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  bodyParts.push(Buffer.from(header, "utf-8"));
  bodyParts.push(buffer);
  bodyParts.push(Buffer.from(footer, "utf-8"));
  const body = Buffer.concat(bodyParts);

  const uploadUrl = `${apiUrl.replace(/\/+$/, "")}/v1/bot/upload?type=chat`;
  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  if (!uploadResp.ok) {
    const text = await uploadResp.text().catch(() => "");
    throw new Error(`Upload failed (${uploadResp.status}): ${text}`);
  }
  const uploadResult = await uploadResp.json() as { path?: string; url?: string };
  const fileUrl = uploadResult.path ?? uploadResult.url ?? "";

  // Determine message type from MIME
  const msgType = contentType.startsWith("image/") ? MessageType.Image : MessageType.File;

  log?.info?.(`dmwork: uploaded media as ${msgType === MessageType.Image ? "image" : "file"}: ${filename}`);

  // Send via sendMessage payload
  await postJson(apiUrl, botToken, "/v1/bot/sendMessage", {
    channel_id: channelId,
    channel_type: channelType,
    payload: {
      type: msgType,
      url: fileUrl,
      name: filename,
    },
  });
}

/** Guess MIME type from file extension */
function guessMime(pathOrName?: string, fallback = "application/octet-stream"): string {
  if (!pathOrName) return fallback;
  const ext = pathOrName.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", opus: "audio/opus",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", avi: "video/x-msvideo", mkv: "video/x-matroska",
    pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
    txt: "text/plain", json: "application/json", csv: "text/csv", md: "text/markdown",
    py: "text/x-python", js: "text/javascript", ts: "text/typescript", go: "text/x-go", java: "text/x-java",
    html: "text/html", css: "text/css", xml: "text/xml", yaml: "text/yaml", yml: "text/yaml",
  };
  return map[ext] ?? fallback;
}

interface ResolvedContent {
  text: string;
  mediaUrl?: string;
  mediaType?: string;
}

function resolveContent(payload: BotMessage["payload"], apiUrl?: string, log?: ChannelLogSink, cdnUrl?: string): ResolvedContent {
  if (!payload) return { text: "" };

  const makeFullUrl = (relUrl?: string) => {
    if (!relUrl) return undefined;
    if (relUrl.startsWith("http")) return relUrl;
    // Strip common path prefixes to get the raw storage path
    let storagePath = relUrl;
    // Remove "file/preview/" or "file/" prefix
    if (storagePath.startsWith("file/preview/")) {
      storagePath = storagePath.substring("file/preview/".length);
    } else if (storagePath.startsWith("file/")) {
      storagePath = storagePath.substring("file/".length);
    }
    if (cdnUrl) {
      // CDN direct: public-read, no auth needed, LLM can access directly
      const base = cdnUrl.replace(/\/+$/, "");
      return `${base}/${storagePath}`;
    }
    // Fallback: Nginx public /file/ path (no auth)
    const baseUrl = apiUrl?.replace(/\/+$/, "") ?? "";
    return `${baseUrl}/file/${storagePath}`;
  };

  switch (payload.type) {
    case MessageType.Text:
      return { text: payload.content ?? "" };
    case MessageType.Image: {
      log?.debug?.(`dmwork: [resolveContent] Image payload.url=${payload.url}`);
      const imgUrl = makeFullUrl(payload.url);
      const imgMime = guessMime(payload.url, "image/jpeg");
      return { text: `[图片]\n${imgUrl ?? ""}`.trim(), mediaUrl: imgUrl, mediaType: imgMime };
    }
    case MessageType.GIF: {
      const gifUrl = makeFullUrl(payload.url);
      return { text: `[GIF]\n${gifUrl ?? ""}`.trim(), mediaUrl: gifUrl, mediaType: "image/gif" };
    }
    case MessageType.Voice: {
      const voiceUrl = makeFullUrl(payload.url);
      const voiceMime = guessMime(payload.url, "audio/mpeg");
      return { text: `[语音消息]\n${voiceUrl ?? ""}`.trim(), mediaUrl: voiceUrl, mediaType: voiceMime };
    }
    case MessageType.Video: {
      const videoUrl = makeFullUrl(payload.url);
      const videoMime = guessMime(payload.url, "video/mp4");
      return { text: `[视频]\n${videoUrl ?? ""}`.trim(), mediaUrl: videoUrl, mediaType: videoMime };
    }
    case MessageType.File: {
      log?.debug?.(`dmwork: [resolveContent] File payload.url=${payload.url}`);
      const fileUrl = makeFullUrl(payload.url);
      const fileMime = guessMime(payload.url, payload.name ? guessMime(payload.name, "application/octet-stream") : "application/octet-stream");
      return { text: `[文件: ${payload.name ?? "未知文件"}]\n${fileUrl ?? ""}`.trim(), mediaUrl: fileUrl, mediaType: fileMime };
    }
    case MessageType.Location: {
      const lat = payload.latitude ?? payload.lat;
      const lng = payload.longitude ?? payload.lng ?? payload.lon;
      const locText = lat != null && lng != null ? `[位置信息: ${lat},${lng}]` : "[位置信息]";
      return { text: locText };
    }
    case MessageType.Card: {
      const cardName = payload.name ?? "未知";
      const cardUid = payload.uid ?? "";
      const cardText = cardUid ? `[名片: ${cardName} (${cardUid})]` : `[名片: ${cardName}]`;
      return { text: cardText };
    }
    default:
      return { text: payload.content ?? payload.url ?? "" };
  }
}

/** Extract text-only content for history/quotes (no mediaUrl) */
function resolveContentText(payload: BotMessage["payload"], apiUrl?: string): string {
  return resolveContent(payload, apiUrl).text;
}

const TEXT_FILE_EXTENSIONS = new Set([
  "txt", "html", "htm", "md", "csv", "json", "xml", "yaml", "yml",
  "log", "py", "js", "ts", "go", "java",
]);

/** Fetch an authenticated URL and return a base64 data URL */
async function fetchAsDataUrl(
  url: string,
  botToken: string,
  log?: { warn?: (msg: string) => void },
): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      log?.warn?.(`dmwork: fetchAsDataUrl failed: status=${resp.status} url=${url}`);
      return null;
    }
    const contentType = resp.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await resp.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  } catch (err) {
    log?.warn?.(`dmwork: fetchAsDataUrl error: ${String(err)} url=${url}`);
    return null;
  }
}

async function resolveFileContent(
  url: string,
  botToken: string,
  maxBytes = 5 * 1024 * 1024,
): Promise<string | null> {
  try {
    const ext = url.split(".").pop()?.toLowerCase() ?? "";
    if (!TEXT_FILE_EXTENSIONS.has(ext)) return null;

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok || !resp.body) return null;

    const contentLength = resp.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > maxBytes) return null;

    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > maxBytes) return null;
    return new TextDecoder().decode(buffer);
  } catch {
    return null;
  }
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
      log: log ? { info: (...args) => log.info?.(String(args[0])), error: (...args) => log.error?.(String(args[0])) } : undefined,
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

  // Parse space_id from channel_id (format: s{spaceId}_{peerId})
  // For DM, channel_id is a fake channel: s{spaceId}_{uid1}@s{spaceId}_{uid2}
  // Use LastIndex approach: spaceId is everything between 's' and the last '_' before peerId
  let spaceId = "";
  const effectiveChannelId = isGroup ? message.channel_id! : message.from_uid;
  if (effectiveChannelId.startsWith("s")) {
    const lastUnderscore = effectiveChannelId.lastIndexOf("_");
    if (lastUnderscore > 0) {
      spaceId = effectiveChannelId.substring(1, lastUnderscore);
    }
  }
  // Also try to extract spaceId from the WS channel_id (compound DM format)
  if (!spaceId && message.channel_id && message.channel_id.startsWith("s")) {
    // DM compound: s{spaceId}_{uid1}@s{spaceId}_{uid2}
    const atIdx = message.channel_id.indexOf("@");
    const firstPart = atIdx > 0 ? message.channel_id.substring(0, atIdx) : message.channel_id;
    if (firstPart.startsWith("s")) {
      const lastUnderscore = firstPart.lastIndexOf("_");
      if (lastUnderscore > 0) {
        spaceId = firstPart.substring(1, lastUnderscore);
      }
    }
  }

  // Session ID: include spaceId for Space isolation (same user in different Spaces = different sessions)
  const sessionId = isGroup
    ? message.channel_id!
    : spaceId ? `${spaceId}:${message.from_uid}` : message.from_uid;

  const resolved = resolveContent(message.payload, account.config.apiUrl, log, account.config.cdnUrl);
  let rawBody = resolved.text;
  let inboundMediaUrl = resolved.mediaUrl;
  // Inline text file content if possible
  const isFileMessage = message.payload?.type === MessageType.File;
  if (isFileMessage && resolved.mediaUrl) {
    const fileContent = await resolveFileContent(resolved.mediaUrl, account.config.botToken ?? "");
    if (fileContent) {
      rawBody = `[文件: ${message.payload.name ?? "未知文件"}]\n\n--- 文件内容 ---\n${fileContent}\n--- 文件结束 ---`;
      inboundMediaUrl = undefined;
    }
  }

  // Media URLs are passed directly to the Agent (storage is public-read, no auth needed)

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
    const replyContent = replyPayload?.content ?? (replyPayload ? resolveContentText(replyPayload, account.config.apiUrl) : "");
    const replyFrom = replyData.from_uid ?? replyData.from_name ?? "unknown";
    if (replyContent) {
      quotePrefix = `[Quoted message from ${replyFrom}]: ${replyContent}\n---\n`;
      log?.info?.(`dmwork: message quotes a reply (${quotePrefix.length} chars)`);
    }
  }

  // --- Mention gating for group messages ---
  const requireMention = account.config.requireMention !== false;
  let historyPrefix = "";
  let historyMediaUrls: string[] = [];
  
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
        mediaUrl: inboundMediaUrl,
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

    // If memory cache is empty or insufficient, try fetching from API
    const cacheInsufficient = entries.length < Math.ceil(historyLimit / 2);
    if (cacheInsufficient && account.config.botToken) {
      log?.info?.(`dmwork: [MENTION] 缓存不足(${entries.length}/${historyLimit})，从API补充历史...`);
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
        const filteredApiMsgs = apiMessages
          .filter((m: any) => m.from_uid !== botUid && (m.content || m.type !== 1))
          .slice(-historyLimit);
        entries = filteredApiMsgs.map((m: any) => {
          const entry: any = {
            sender: m.from_uid,
            body: m.content || resolveApiMessagePlaceholder(m.type, m.name),
            timestamp: m.timestamp,
          };
          // For media message types, resolve the URL directly (storage is public-read)
          const mediaTypes = [MessageType.Image, MessageType.File, MessageType.Voice, MessageType.Video];
          if (mediaTypes.includes(m.type) && !m.content) {
            const apiResolved = resolveContent({ type: m.type, url: m.url, name: m.name } as any, account.config.apiUrl, log, account.config.cdnUrl);
            if (apiResolved.mediaUrl) {
              entry.mediaUrl = apiResolved.mediaUrl;
              entry.body = apiResolved.text;
            }
          }
          return entry;
        });
        log?.info?.(`dmwork: [MENTION] 从API获取到 ${entries.length} 条历史消息`);
      } catch (err) {
        log?.error?.(`dmwork: [MENTION] 从API获取历史失败: ${err}`);
      }
    }

    // Build history context manually (JSON format)
    // Collect media URLs from history entries for attachment to the inbound context
    historyMediaUrls = entries
      .map((e: any) => e.mediaUrl)
      .filter((url: string | undefined): url is string => Boolean(url));

    if (entries.length > 0) {
      const messagesJson = JSON.stringify(entries.map((e: any) => ({
        sender: e.sender,
        body: e.body,
        ...(e.mediaUrl ? { hasMedia: true } : {}),
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
    : spaceId ? `space:${spaceId}:user:${message.from_uid}` : `user:${message.from_uid}`;

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
    MediaUrls: (() => {
      const urls = [...(inboundMediaUrl ? [inboundMediaUrl] : []), ...historyMediaUrls];
      return urls.length > 0 ? urls : undefined;
    })(),
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

  const apiUrl = account.config.apiUrl;
  const botToken = account.config.botToken ?? "";

  // Keep sending typing indicator while AI is processing
  const typingInterval = setInterval(() => {
    sendTyping({ apiUrl, botToken, channelId: replyChannelId, channelType: replyChannelType }).catch(() => {});
  }, 5000);

  // Streaming state
  let streamNo: string | undefined;
  let streamFailed = false;

  try {
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    replyOptions: {
      onPartialReply: async (partial: { text?: string; mediaUrls?: string[] }) => {
        if (streamFailed) return;
        const text = partial.text?.trim();
        if (!text) return;
        try {
          if (!streamNo) {
            // Start stream
            const payloadB64 = Buffer.from(JSON.stringify({ type: 1, content: text })).toString("base64");
            const result = await postJson<{ stream_no: string }>(apiUrl, botToken, "/v1/bot/stream/start", {
              channel_id: replyChannelId,
              channel_type: replyChannelType,
              payload: payloadB64,
            });
            streamNo = result?.stream_no;
            log?.info?.(`dmwork: stream started: ${streamNo}`);
          } else {
            // Continue stream
            await sendMessage({
              apiUrl,
              botToken,
              channelId: replyChannelId,
              channelType: replyChannelType,
              content: text,
              streamNo,
            });
          }
        } catch (err) {
          log?.error?.(`dmwork: stream partial failed, falling back to deliver: ${String(err)}`);
          streamFailed = true;
        }
      },
    },
    dispatcherOptions: {
      deliver: async (payload: {
        text?: string;
        mediaUrls?: string[];
        mediaUrl?: string;
        replyToId?: string | null;
      }) => {
        // Resolve outbound media URLs
        const outboundMediaUrls = resolveOutboundMediaUrls(payload);

        // Upload and send each media file
        for (const mediaUrl of outboundMediaUrls) {
          try {
            await uploadAndSendMedia({
              mediaUrl,
              apiUrl: account.config.apiUrl,
              botToken: account.config.botToken ?? "",
              channelId: replyChannelId,
              channelType: replyChannelType,
              log,
            });
          } catch (err) {
            log?.error?.(`dmwork: media send failed for ${mediaUrl}: ${String(err)}`);
          }
        }

        // If there are no media URLs, fall through to text logic; if there are, only send text if caption exists
        const content = payload.text?.trim() ?? "";
        if (!content && outboundMediaUrls.length > 0) {
          statusSink?.({ lastOutboundAt: Date.now(), lastError: null });
          return;
        }
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
      onError: async (err: unknown, info: { kind: string }) => {
        clearInterval(typingInterval);
        log?.error?.(`dmwork ${info.kind} reply failed: ${String(err)}`);
        try {
          await sendMessage({
            apiUrl,
            botToken,
            channelId: replyChannelId,
            channelType: replyChannelType,
            content: "⚠️ 抱歉，处理您的消息时遇到了问题，请稍后重试。",
          });
        } catch (sendErr) {
          log?.error?.(`dmwork: failed to send error message: ${String(sendErr)}`);
        }
      },
    },
  });
  } finally {
    clearInterval(typingInterval);
    // End stream if one was started (skip if stream failed — deliver handles final message)
    if (streamNo && !streamFailed) {
      try {
        await postJson(apiUrl, botToken, "/v1/bot/stream/end", {
          stream_no: streamNo,
          channel_id: replyChannelId,
          channel_type: replyChannelType,
        });
        log?.info?.(`dmwork: stream ended: ${streamNo}`);
      } catch (err) {
        log?.error?.(`dmwork: stream end failed: ${String(err)}`);
      }
    }
  }
}
