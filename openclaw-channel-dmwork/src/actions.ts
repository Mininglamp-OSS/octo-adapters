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
import { parseMentions } from "./mention-utils.js";
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
 * For bare IDs, we check `currentChannelId` (from toolContext) to infer
 * the channel type — if the bare ID matches the current group channel,
 * treat it as a group message. Otherwise default to DM.
 */
export function parseTarget(
  target: string,
  currentChannelId?: string,
  knownGroupIds?: Set<string>,
): {
  channelId: string;
  channelType: ChannelType;
} {
  if (target.startsWith("group:"))
    return { channelId: target.slice(6), channelType: ChannelType.Group };
  if (target.startsWith("user:"))
    return { channelId: target.slice(5), channelType: ChannelType.DM };

  // Bare ID: infer from current session context
  if (currentChannelId) {
    // currentChannelId may have prefixes: "dmwork:", "g-", or raw groupNo
    let normalizedCurrent = currentChannelId;
    if (normalizedCurrent.startsWith("dmwork:")) normalizedCurrent = normalizedCurrent.slice(7);
    if (normalizedCurrent.startsWith("g-")) normalizedCurrent = normalizedCurrent.slice(2);
    if (target === normalizedCurrent || target === currentChannelId) {
      return { channelId: target, channelType: ChannelType.Group };
    }
  }

  // Check if bare ID is a known group (cross-group messaging)
  if (knownGroupIds?.has(target)) {
    return { channelId: target, channelType: ChannelType.Group };
  }

  return { channelId: target, channelType: ChannelType.DM };
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
      return handleSend({ args, apiUrl, botToken, memberMap, currentChannelId, log });
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
  currentChannelId?: string;
  log?: LogSink;
}): Promise<MessageActionResult> {
  const { args, apiUrl, botToken, memberMap, currentChannelId, log } = params;

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

    if (channelType === ChannelType.Group && memberMap) {
      const mentionNames = parseMentions(message);
      for (const name of mentionNames) {
        const uid = memberMap.get(name);
        if (uid && !mentionUids.includes(uid)) {
          mentionUids.push(uid);
        }
      }
    }

    await sendMessage({
      apiUrl,
      botToken,
      channelId,
      channelType,
      content: message,
      ...(mentionUids.length > 0 ? { mentionUids } : {}),
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

  const { channelId, channelType } = parseTarget(target, currentChannelId, getKnownGroupIds());

  const messages = await getChannelMessages({
    apiUrl,
    botToken,
    channelId,
    channelType,
    limit,
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
