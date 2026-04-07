/**
 * Message tool action handlers for the DMWork channel plugin.
 *
 * Implements: send, read, member-info, channel-list, channel-info
 * Each handler is stateless — maps and config are passed in via params.
 */

import { ChannelType } from "./types.js";
import {
  sendMessage,
  getChannelMessages,
  getGroupMembers,
  fetchBotGroups,
  getGroupInfo,
  getGroupMd,
  updateGroupMd,
} from "./api-fetch.js";
import { uploadAndSendMedia } from "./inbound.js";
import { buildEntitiesFromFallback, parseStructuredMentions, convertStructuredMentions } from "./mention-utils.js";
import type { MentionEntity } from "./types.js";
import { getKnownGroupIds } from "./group-md.js";

export interface MessageActionResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

type LogSink = {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
};

/**
 * Parse a target string into channelId + channelType.
 *
 * Explicit prefixes (`group:` / `user:`) always win.
 * For bare IDs, we check `knownGroupIds` to determine the channel type.
 */
export function parseTarget(
  target: string,
  currentChannelId?: string,
  knownGroupIds?: Set<string>,
): { channelId: string; channelType: ChannelType } {
  // Explicit prefixes always win
  if (target.startsWith("group:"))
    return { channelId: target.slice(6), channelType: ChannelType.Group };
  if (target.startsWith("user:"))
    return { channelId: target.slice(5), channelType: ChannelType.DM };

  // Strip dmwork: prefix if present
  let bareId = target;
  if (bareId.startsWith("dmwork:")) bareId = bareId.slice(7);

  // Bare ID: check knownGroupIds
  const isGroup = knownGroupIds?.has(bareId) ?? false;
  return { channelId: bareId, channelType: isGroup ? ChannelType.Group : ChannelType.DM };
}

/** Strip common prefixes to get the raw group_no */
function stripChannelPrefix(raw: string): string {
  if (raw.startsWith("group:")) return raw.slice(6);
  if (raw.startsWith("g-")) return raw.slice(2);
  if (raw.startsWith("dmwork:")) return raw.slice(7);
  return raw;
}

/**
 * Resolve the group ID from args, falling back to currentChannelId.
 * Accepts: args.groupId, args.target (with group: prefix), or bare currentChannelId.
 */
function resolveGroupId(
  args: Record<string, unknown>,
  currentChannelId?: string,
): string | undefined {
  // Explicit groupId, target, or to param
  const groupId = (args.groupId ?? args.target ?? args.to) as string | undefined;
  if (groupId?.trim()) {
    const raw = groupId.trim();
    return stripChannelPrefix(raw);
  }

  // Fallback to currentChannelId from session context
  if (currentChannelId?.trim()) {
    return stripChannelPrefix(currentChannelId.trim());
  }

  return undefined;
}

export async function handleDmworkMessageAction(params: {
  action: string;
  args: Record<string, unknown>;
  apiUrl: string;
  botToken: string;
  memberMap?: Map<string, string>;
  uidToNameMap?: Map<string, string>;
  groupMdCache?: Map<string, { content: string; version: number }>;
  currentChannelId?: string;
  log?: LogSink;
}): Promise<MessageActionResult> {
  const { action, args, apiUrl, botToken, memberMap, uidToNameMap, groupMdCache, currentChannelId, log } =
    params;

  if (!botToken) {
    return { ok: false, error: "DMWork botToken is not configured" };
  }

  switch (action) {
    case "send":
      return handleSend({ args, apiUrl, botToken, memberMap, uidToNameMap, currentChannelId, log });
    case "read":
      return handleRead({ args, apiUrl, botToken, uidToNameMap, currentChannelId, log });
    case "member-info":
      return handleMemberInfo({ args, apiUrl, botToken, log });
    case "channel-list":
      return handleChannelList({ apiUrl, botToken, log });
    case "channel-info":
      return handleChannelInfo({ args, apiUrl, botToken, log });
    case "group-md-read":
      return handleGroupMdRead({ args, apiUrl, botToken, groupMdCache, currentChannelId, log });
    case "group-md-update":
      return handleGroupMdUpdate({ args, apiUrl, botToken, groupMdCache, currentChannelId, log });
    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

async function handleSend(params: {
  args: Record<string, unknown>;
  apiUrl: string;
  botToken: string;
  memberMap?: Map<string, string>;
  uidToNameMap?: Map<string, string>;
  currentChannelId?: string;
  log?: LogSink;
}): Promise<MessageActionResult> {
  const { args, apiUrl, botToken, memberMap, uidToNameMap, currentChannelId, log } = params;

  const target = args.target as string | undefined;
  if (!target) {
    return { ok: false, error: "Missing required parameter: target" };
  }

  const message = (args.message as string | undefined)?.trim();
  const mediaUrl =
    (args.media as string | undefined) ??
    (args.mediaUrl as string | undefined) ??
    (args.filePath as string | undefined);

  if (!message && !mediaUrl) {
    return {
      ok: false,
      error: "At least one of message or media/mediaUrl/filePath is required",
    };
  }

  const { channelId, channelType } = parseTarget(target, currentChannelId, getKnownGroupIds());

  // Send text message
  if (message) {
    let mentionUids: string[] = [];
    let mentionEntities: MentionEntity[] = [];
    let finalMessage = message;

    if (channelType === ChannelType.Group) {
      // v2 path: convert @[uid:name] → @name + entities
      if (uidToNameMap) {
        const structuredMentions = parseStructuredMentions(finalMessage);
        if (structuredMentions.length > 0) {
          const validUids = new Set(uidToNameMap.keys());
          const converted = convertStructuredMentions(finalMessage, structuredMentions, validUids);
          finalMessage = converted.content;
          mentionEntities = [...converted.entities];
          mentionUids = [...converted.uids];
        }
      }

      // v1 fallback: resolve remaining @name via memberMap
      if (memberMap) {
        const { entities, uids } = buildEntitiesFromFallback(finalMessage, memberMap);
        const existingOffsets = new Set(mentionEntities.map(e => e.offset));
        for (const entity of entities) {
          if (!existingOffsets.has(entity.offset)) {
            mentionEntities.push(entity);
          }
        }
        for (const uid of uids) {
          if (!mentionUids.includes(uid)) {
            mentionUids.push(uid);
          }
        }
      }

      // Sort entities by offset and rebuild uids from sorted entities
      if (mentionEntities.length > 0) {
        mentionEntities.sort((a, b) => a.offset - b.offset);
        mentionUids = mentionEntities.map(e => e.uid);
      }
    }

    // Detect @all/@所有人 in final content
    const hasAtAll = /(?:^|(?<=\s))@(?:all|所有人)(?=\s|[^\w]|$)/i.test(finalMessage);

    await sendMessage({
      apiUrl,
      botToken,
      channelId,
      channelType,
      content: finalMessage,
      ...(mentionUids.length > 0 ? { mentionUids } : {}),
      ...(mentionEntities.length > 0 ? { mentionEntities } : {}),
      mentionAll: hasAtAll || undefined,
    });
  }

  // Send media
  if (mediaUrl) {
    await uploadAndSendMedia({
      mediaUrl,
      apiUrl,
      botToken,
      channelId,
      channelType,
      log: log as any,
    });
  }

  return { ok: true, data: { sent: true, target, channelId, channelType } };
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

async function handleRead(params: {
  args: Record<string, unknown>;
  apiUrl: string;
  botToken: string;
  uidToNameMap?: Map<string, string>;
  currentChannelId?: string;
  log?: LogSink;
}): Promise<MessageActionResult> {
  const { args, apiUrl, botToken, uidToNameMap, currentChannelId, log } = params;

  const target = args.target as string | undefined;
  if (!target) {
    return { ok: false, error: "Missing required parameter: target" };
  }

  const rawLimit = Number(args.limit) || 20;
  const limit = Math.min(Math.max(rawLimit, 1), 100);

  // after/before map to start_message_seq/end_message_seq (message sequence numbers)
  const after = args.after != null ? Number(args.after) : undefined;
  const before = args.before != null ? Number(args.before) : undefined;

  const { channelId, channelType } = parseTarget(target, currentChannelId, getKnownGroupIds());

  const messages = await getChannelMessages({
    apiUrl,
    botToken,
    channelId,
    channelType,
    limit,
    ...(after != null && !isNaN(after) ? { startMessageSeq: after } : {}),
    ...(before != null && !isNaN(before) ? { endMessageSeq: before } : {}),
    log: log
      ? {
          info: (...a: unknown[]) => log.info?.(String(a[0])),
          error: (...a: unknown[]) => log.error?.(String(a[0])),
        }
      : undefined,
  });

  // Resolve from_uid to display names when available
  const resolved = messages.map((m) => ({
    from: uidToNameMap?.get(m.from_uid) ?? m.from_uid,
    from_uid: m.from_uid,
    content: m.content,
    timestamp: m.timestamp,
  }));

  return { ok: true, data: { messages: resolved, count: resolved.length } };
}

// ---------------------------------------------------------------------------
// member-info
// ---------------------------------------------------------------------------

async function handleMemberInfo(params: {
  args: Record<string, unknown>;
  apiUrl: string;
  botToken: string;
  log?: LogSink;
}): Promise<MessageActionResult> {
  const { args, apiUrl, botToken, log } = params;

  const target = args.target as string | undefined;
  if (!target) {
    return { ok: false, error: "Missing required parameter: target" };
  }

  const { channelId } = parseTarget(target);

  const members = await getGroupMembers({
    apiUrl,
    botToken,
    groupNo: channelId,
    log: log
      ? {
          info: (...a: unknown[]) => log.info?.(String(a[0])),
          error: (...a: unknown[]) => log.error?.(String(a[0])),
        }
      : undefined,
  });

  return { ok: true, data: { members, count: members.length } };
}

// ---------------------------------------------------------------------------
// channel-list
// ---------------------------------------------------------------------------

async function handleChannelList(params: {
  apiUrl: string;
  botToken: string;
  log?: LogSink;
}): Promise<MessageActionResult> {
  const { apiUrl, botToken, log } = params;

  const groups = await fetchBotGroups({
    apiUrl,
    botToken,
    log: log
      ? {
          info: (...a: unknown[]) => log.info?.(String(a[0])),
          error: (...a: unknown[]) => log.error?.(String(a[0])),
        }
      : undefined,
  });

  return { ok: true, data: { groups, count: groups.length } };
}

// ---------------------------------------------------------------------------
// channel-info
// ---------------------------------------------------------------------------

async function handleChannelInfo(params: {
  args: Record<string, unknown>;
  apiUrl: string;
  botToken: string;
  log?: LogSink;
}): Promise<MessageActionResult> {
  const { args, apiUrl, botToken, log } = params;

  const target = args.target as string | undefined;
  if (!target) {
    return { ok: false, error: "Missing required parameter: target" };
  }

  const { channelId } = parseTarget(target);

  const info = await getGroupInfo({
    apiUrl,
    botToken,
    groupNo: channelId,
    log: log
      ? {
          info: (...a: unknown[]) => log.info?.(String(a[0])),
          error: (...a: unknown[]) => log.error?.(String(a[0])),
        }
      : undefined,
  });

  return { ok: true, data: info };
}

// ---------------------------------------------------------------------------
// group-md-read
// ---------------------------------------------------------------------------

async function handleGroupMdRead(params: {
  args: Record<string, unknown>;
  apiUrl: string;
  botToken: string;
  groupMdCache?: Map<string, { content: string; version: number }>;
  currentChannelId?: string;
  log?: LogSink;
}): Promise<MessageActionResult> {
  const { args, apiUrl, botToken, groupMdCache, currentChannelId, log } = params;

  const channelId = resolveGroupId(args, currentChannelId);
  if (!channelId) {
    return { ok: false, error: "Missing required parameter: groupId (or target the current group chat)" };
  }

  // Try cache first
  const cached = groupMdCache?.get(channelId);
  if (cached) {
    return { ok: true, data: { content: cached.content, version: cached.version, source: "cache" } };
  }

  // Cache miss — fetch from API
  try {
    const md = await getGroupMd({
      apiUrl,
      botToken,
      groupNo: channelId,
      log: log
        ? {
            info: (...a: unknown[]) => log.info?.(String(a[0])),
            error: (...a: unknown[]) => log.error?.(String(a[0])),
          }
        : undefined,
    });
    // Update cache on successful fetch
    if (groupMdCache && md.content) {
      groupMdCache.set(channelId, { content: md.content, version: md.version });
    }
    return { ok: true, data: { content: md.content, version: md.version, updated_at: md.updated_at, updated_by: md.updated_by } };
  } catch (err) {
    return { ok: false, error: `Failed to read GROUP.md: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// group-md-update
// ---------------------------------------------------------------------------

async function handleGroupMdUpdate(params: {
  args: Record<string, unknown>;
  apiUrl: string;
  botToken: string;
  groupMdCache?: Map<string, { content: string; version: number }>;
  currentChannelId?: string;
  log?: LogSink;
}): Promise<MessageActionResult> {
  const { args, apiUrl, botToken, groupMdCache, currentChannelId, log } = params;

  const channelId = resolveGroupId(args, currentChannelId);
  if (!channelId) {
    return { ok: false, error: "Missing required parameter: groupId (or target the current group chat)" };
  }

  const content = (args.content ?? args.message ?? args.topic ?? args.desc) as string | undefined;
  if (content == null) {
    return { ok: false, error: "Missing required parameter: content (or message)" };
  }

  try {
    const result = await updateGroupMd({
      apiUrl,
      botToken,
      groupNo: channelId,
      content,
      log: log
        ? {
            info: (...a: unknown[]) => log.info?.(String(a[0])),
            error: (...a: unknown[]) => log.error?.(String(a[0])),
          }
        : undefined,
    });
    // Update local cache on success
    if (groupMdCache) {
      groupMdCache.set(channelId, { content, version: result.version });
    }
    return { ok: true, data: { version: result.version } };
  } catch (err) {
    return { ok: false, error: `Failed to update GROUP.md: ${err instanceof Error ? err.message : String(err)}` };
  }
}
