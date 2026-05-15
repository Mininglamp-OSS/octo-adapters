/**
 * Lightweight fetch-based API helpers for use inside OpenClaw plugin context.
 * These are used by inbound/outbound where the full OctoAPI class is not available.
 */

import { ChannelType, MessageType, type MentionEntity, type SendMessageResult } from "./types.js";
import path from "path";
import { open } from "node:fs/promises";
// @ts-ignore — cos-nodejs-sdk-v5 has incomplete TypeScript definitions
import COS from "cos-nodejs-sdk-v5";

const DEFAULT_TIMEOUT_MS = 30_000;

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
};

export async function postJson<T>(
  apiUrl: string,
  botToken: string,
  path: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const url = `${apiUrl.replace(/\/+$/, "")}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${response.status}): ${text || response.statusText}`);
  }

  const text = await response.text();
  if (!text) return undefined;
  try {
    // Protect int64 message_id from JSON.parse precision loss.
    // Applied globally in postJson since only "message_id" fields are matched;
    // the regex is conservative (16+ digits) to avoid any precision edge cases.
    const safeText = text.replace(/"message_id"\s*:\s*(\d{16,})/g, '"message_id":"$1"');
    return JSON.parse(safeText) as T;
  } catch {
    throw new Error(`Octo API ${path} returned invalid JSON: ${text.slice(0, 200)}`);
  }
}


/**
 * Send a media message (image or file) to a channel.
 */
export async function sendMediaMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  type: MessageType;
  url: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  signal?: AbortSignal;
}): Promise<void> {
  const payload: Record<string, unknown> = {
    type: params.type,
    url: params.url,
  };

  // Image (type=2) needs width/height/name/size; File (type=8) needs name/size
  if (params.type === MessageType.Image) {
    if (params.width) payload.width = params.width;
    if (params.height) payload.height = params.height;
    if (params.name) payload.name = params.name;
    if (params.size != null) payload.size = params.size;
  } else {
    if (params.name) payload.name = params.name;
    if (params.size != null) payload.size = params.size;
  }

  if (
    (params.mentionUids && params.mentionUids.length > 0) ||
    (params.mentionEntities && params.mentionEntities.length > 0)
  ) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) {
      mention.uids = params.mentionUids;
    }
    if (params.mentionEntities && params.mentionEntities.length > 0) {
      mention.entities = params.mentionEntities;
    }
    payload.mention = mention;
  }
  await postJson(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload,
  }, params.signal);
}

/**
 * Infer MIME type from filename extension. Returns a sensible default if unknown.
 */
export function inferContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".bmp": "image/bmp", ".ico": "image/x-icon",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".pdf": "application/pdf", ".zip": "application/zip",
    ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
    ".csv": "text/csv", ".html": "text/html", ".htm": "text/html",
    ".css": "text/css", ".xml": "text/xml", ".yaml": "text/yaml", ".yml": "text/yaml",
    ".json": "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * Ensure text/* content types include a charset parameter.
 * If the content type starts with "text/" and has no charset, appends "; charset=utf-8".
 */
export function ensureTextCharset(contentType: string): string {
  if (contentType.startsWith("text/") && !contentType.includes("charset")) {
    return contentType + "; charset=utf-8";
  }
  return contentType;
}

/**
 * Parse image dimensions from buffer (PNG/JPEG/GIF/WebP).
 * Lightweight — reads only the header bytes, no external dependencies.
 */
export function parseImageDimensions(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === "image/png" && buf.length > 24) {
      // PNG: width at offset 16 (4 bytes BE), height at offset 20 (4 bytes BE)
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if ((mime === "image/jpeg" || mime === "image/jpg") && buf.length > 2) {
      // JPEG: scan for SOF0/SOF2 marker (0xFF 0xC0 or 0xFF 0xC2)
      let offset = 2;
      while (offset < buf.length - 8) {
        if (buf[offset] !== 0xFF) break;
        const marker = buf[offset + 1];
        if (marker === 0xC0 || marker === 0xC2) {
          return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
        }
        const len = buf.readUInt16BE(offset + 2);
        offset += 2 + len;
      }
    }
    if (mime === "image/gif" && buf.length > 10) {
      // GIF: width at offset 6 (2 bytes LE), height at offset 8 (2 bytes LE)
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === "image/webp" && buf.length > 30) {
      // WebP VP8: width at offset 26, height at offset 28 (both 2 bytes LE)
      if (buf.toString("ascii", 12, 16) === "VP8 " && buf.length > 29) {
        return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
      }
    }
  } catch { /* ignore parse errors */ }
  return null;
}

/**
 * Parse image dimensions from a file path by reading only the first 64KB.
 * Avoids loading the entire file into memory.
 */
export async function parseImageDimensionsFromFile(filePath: string, mime: string): Promise<{ width: number; height: number } | null> {
  const HEADER_SIZE = 65536; // 64KB — enough for PNG/JPEG/GIF/WebP headers
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(filePath, "r");
    const buf = Buffer.alloc(HEADER_SIZE);
    const { bytesRead } = await fh.read(buf, 0, HEADER_SIZE, 0);
    return parseImageDimensions(buf.subarray(0, bytesRead), mime);
  } catch { /* ignore read/parse errors */ }
  finally { await fh?.close(); }
  return null;
}

// SendMessageResult: use the canonical definition from types.ts
// (message_id is string due to int64 protection in postJson)

export async function sendMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  content: string;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  mentionAll?: boolean;
  replyMsgId?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  const payload: Record<string, unknown> = {
    type: MessageType.Text,
    content: params.content,
  };
  // Add mention field if any UIDs specified, entities present, or mentionAll
  if (
    (params.mentionUids && params.mentionUids.length > 0) ||
    (params.mentionEntities && params.mentionEntities.length > 0) ||
    params.mentionAll
  ) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) {
      mention.uids = params.mentionUids;
    }
    if (params.mentionEntities && params.mentionEntities.length > 0) {
      mention.entities = params.mentionEntities;
    }
    if (params.mentionAll) {
      mention.all = 1;
    }
    payload.mention = mention;
  }
  // Add reply field if replyMsgId is provided
  if (params.replyMsgId) {
    payload.reply = { message_id: params.replyMsgId };
  }
  return await postJson<SendMessageResult>(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload,
  }, params.signal);
}

export async function sendTyping(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(params.apiUrl, params.botToken, "/v1/bot/typing", {
    channel_id: params.channelId,
    channel_type: params.channelType,
  }, params.signal);
}

export async function sendReadReceipt(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  messageIds?: string[];
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(params.apiUrl, params.botToken, "/v1/bot/readReceipt", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    ...(params.messageIds && params.messageIds.length > 0 ? { message_ids: params.messageIds } : {}),
  }, params.signal);
}

export async function sendHeartbeat(params: {
  apiUrl: string;
  botToken: string;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(params.apiUrl, params.botToken, "/v1/bot/heartbeat", {}, params.signal);
}



export async function registerBot(params: {
  apiUrl: string;
  botToken: string;
  forceRefresh?: boolean;
  agentPlatform?: string;
  agentVersion?: string;
  pluginVersion?: string;
  signal?: AbortSignal;
}): Promise<{
  robot_id: string;
  im_token: string;
  ws_url: string;
  api_url: string;
  owner_uid: string;
  owner_channel_id: string;
}> {
  const path = params.forceRefresh
    ? "/v1/bot/register?force_refresh=true"
    : "/v1/bot/register";
  const body: Record<string, string> = {};
  if (params.agentPlatform) body.agent_platform = params.agentPlatform;
  if (params.agentVersion) body.agent_version = params.agentVersion;
  if (params.pluginVersion) body.plugin_version = params.pluginVersion;
  const result = await postJson<{
    robot_id: string;
    im_token: string;
    ws_url: string;
    api_url: string;
    owner_uid: string;
    owner_channel_id: string;
  }>(params.apiUrl, params.botToken, path, body, params.signal);
  if (!result) throw new Error("Octo bot registration returned empty response");
  return result;
}

// Fetch the groups the bot belongs to
export async function fetchBotGroups(params: {
  apiUrl: string;
  botToken: string;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<Array<{ group_no: string; name: string }>> {
  const url = `${params.apiUrl}/v1/bot/groups`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${params.botToken}`,
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    params.log?.error?.(`octo: fetchBotGroups failed: ${resp.status}`);
    return [];
  }
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

/**
 * 获取群成员列表
 */
export interface GroupMember {
  uid: string;
  name: string;
  role?: string;    // admin/member
  robot?: boolean;  // 是否是机器人
}

export async function getGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;  // 群 ID (channel_id)
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<GroupMember[]> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${params.groupNo}/members`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${params.botToken}`,
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const msg = `getGroupMembers failed: ${resp.status}`;
    params.log?.error?.(`octo: ${msg}`);
    throw new Error(msg);
  }
  const data = await resp.json();
  // Normalize to strict array to prevent silent failures
  const members = Array.isArray(data?.members)
    ? data.members
    : Array.isArray(data)
      ? data
      : [];
  return members as GroupMember[];
}

/**
 * 获取群信息
 */
export async function getGroupInfo(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<{ group_no: string; name: string; [key: string]: unknown }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${params.groupNo}`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.botToken}`,
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!resp.ok) {
      params.log?.error?.(`octo: getGroupInfo failed: ${resp.status}`);
      throw new Error(`getGroupInfo failed: ${resp.status}`);
    }
    return await resp.json();
  } catch (err) {
    params.log?.error?.(`octo: getGroupInfo error: ${err}`);
    throw err;
  }
}

// Fetch GROUP.md content for a group
export async function getGroupMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<{ content: string; version: number; updated_at: string | null; updated_by: string }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${params.groupNo}/md`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${params.botToken}`,
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`getGroupMd failed (${resp.status}): ${text || resp.statusText}`);
  }
  return await resp.json();
}

/**
 * Get thread THREAD.md content (throws on non-2xx — used by agent-tools).
 * GET /v1/bot/groups/{groupNo}/threads/{shortId}/md
 *
 * See also: group-md.ts `fetchThreadMdFromApi()` which returns null on error
 * and is used for background cache refresh where failures are non-fatal.
 */
export async function getThreadMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<{ content: string; version: number; updated_at: string | null; updated_by: string }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/md`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`getThreadMd failed (${resp.status}): ${text || resp.statusText}`);
  }
  return await resp.json();
}

/**
 * Update thread THREAD.md content (requires bot_admin permission).
 * PUT /v1/bot/groups/{groupNo}/threads/{shortId}/md
 *
 * Content size limit: 10,240 bytes (server-side GetGroupMdMaxSize()).
 */
export async function updateThreadMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  content: string;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<{ version: number }> {
  const contentSize = new TextEncoder().encode(params.content).byteLength;
  if (contentSize > 10240) {
    throw new Error(`updateThreadMd: content size (${contentSize} bytes) exceeds maximum 10,240 bytes`);
  }

  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/md`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${params.botToken}`,
    },
    body: JSON.stringify({ content: params.content }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`updateThreadMd failed (${resp.status}): ${text || resp.statusText}`);
  }
  return await resp.json();
}

// Update GROUP.md content for a group (requires bot_admin permission)
export async function updateGroupMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  content: string;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<{ version: number }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${params.groupNo}/md`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${params.botToken}`,
    },
    body: JSON.stringify({ content: params.content }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`updateGroupMd failed (${resp.status}): ${text || resp.statusText}`);
  }
  return await resp.json();
}

// ---- Bot JSON Request Helper ----

/**
 * Generic helper for bot JSON API requests (GET / PUT / DELETE).
 * Centralizes URL construction, auth headers, timeout, and error handling.
 *
 * @throws Error on non-2xx responses with status code and response body.
 */
async function botFetchJson<T = void>(params: {
  apiUrl: string;
  botToken: string;
  path: string;
  method: "GET" | "PUT" | "DELETE";
  body?: Record<string, unknown>;
}): Promise<T> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}${params.path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.botToken}`,
  };
  if (params.body) {
    Object.assign(headers, DEFAULT_HEADERS);
  }
  const resp = await fetch(url, {
    method: params.method,
    headers,
    body: params.body ? JSON.stringify(params.body) : undefined,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Bot API ${params.method} ${params.path} failed (${resp.status}): ${text || resp.statusText}`,
    );
  }
  if (params.method === "GET") {
    return (await resp.json()) as T;
  }
  return undefined as T;
}

// ---- Voice Context API ----

/**
 * Query the owner's personal voice correction context.
 * GET /v1/bot/voice/context
 *
 * Returns normalized response with defensive defaults:
 * - has_context defaults to false if missing from backend response
 * - context defaults to empty string if missing
 * - updated_at defaults to empty string if missing
 */
export async function getVoiceContext(params: {
  apiUrl: string;
  botToken: string;
}): Promise<{ has_context: boolean; context: string; updated_at: string }> {
  const raw = await botFetchJson<Record<string, unknown>>({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    path: "/v1/bot/voice/context",
    method: "GET",
  });

  // Defensive normalization — do not blindly pass-through.
  // If backend omits has_context, treat as false.
  return {
    has_context: raw.has_context === true,
    context: typeof raw.context === "string" ? raw.context : "",
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : "",
  };
}

/**
 * Set the owner's personal voice correction context (PUT upsert).
 * PUT /v1/bot/voice/context
 *
 * Content must not be empty — empty strings are rejected at the adapter
 * validation layer (agent-tools.ts) before this function is called.
 * Backend also rejects empty context with 400.
 */
export async function updateVoiceContext(params: {
  apiUrl: string;
  botToken: string;
  content: string;
}): Promise<void> {
  await botFetchJson({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    path: "/v1/bot/voice/context",
    method: "PUT",
    body: { context: params.content },
  });
}

/**
 * Delete the owner's personal voice correction context.
 * DELETE /v1/bot/voice/context
 *
 * Idempotent — deleting a non-existent record returns 200.
 */
export async function deleteVoiceContext(params: {
  apiUrl: string;
  botToken: string;
}): Promise<void> {
  await botFetchJson({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    path: "/v1/bot/voice/context",
    method: "DELETE",
  });
}

/**
 * 获取频道历史消息（用于注入上下文）
 * @param params.log - Optional logger for consistent logging with OpenClaw log system
 */
export async function getChannelMessages(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  limit?: number;
  startMessageSeq?: number;
  endMessageSeq?: number;
  signal?: AbortSignal;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<Array<{ from_uid: string; content: string; timestamp: number; type?: number; url?: string; name?: string }>> {
  try {
    const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/messages/sync`;
    const limit = params.limit ?? 20;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.botToken}`,
      },
      body: JSON.stringify({
        channel_id: params.channelId,
        channel_type: params.channelType,
        limit,
        start_message_seq: params.startMessageSeq ?? 0,
        end_message_seq: params.endMessageSeq ?? 0,
        pull_mode: 1,  // 1 = pull up (newer messages)
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      params.log?.info?.(`octo: getChannelMessages failed: ${response.status}`);
      return [];
    }

    const data = await response.json();
    const messages = data.messages ?? [];
    return messages.map((m: any) => {
      // payload is base64-encoded JSON string
      let payload: any = {};
      if (m.payload) {
        try {
          const decoded = Buffer.from(m.payload, "base64").toString("utf-8");
          payload = JSON.parse(decoded);
        } catch (decodeErr) {
          params.log?.info?.(`octo: payload decode failed for msg ${m.message_id ?? "unknown"}: ${decodeErr}`);
          // If decoding fails, try treating payload as already-parsed object
          payload = typeof m.payload === "object" ? m.payload : {};
        }
      }
      return {
        from_uid: m.from_uid ?? "unknown",
        type: payload.type ?? undefined,
        url: payload.url ?? undefined,
        name: payload.name ?? undefined,
        content: payload.content ?? "",
        payload,  // preserve full payload for types that need nested data (e.g. MultipleForward)
        // Convert seconds to milliseconds (API returns seconds, internal standard is ms)
        timestamp: (m.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
      };
    });
  } catch (err) {
    params.log?.error?.(`octo: getChannelMessages error: ${err}`);
    return [];
  }
}

/**
 * Get STS temporary credentials for direct COS upload.
 */
export async function getUploadCredentials(params: {
  apiUrl: string;
  botToken: string;
  filename: string;
  signal?: AbortSignal;
}): Promise<{
  bucket: string;
  region: string;
  key: string;
  credentials: {
    tmpSecretId: string;
    tmpSecretKey: string;
    sessionToken: string;
  };
  startTime: number;
  expiredTime: number;
  cdnBaseUrl?: string;
}> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/upload/credentials?filename=${encodeURIComponent(params.filename)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${params.botToken}`,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Octo API /v1/bot/upload/credentials failed (${response.status}): ${text || response.statusText}`);
  }
  const data = await response.json() as any;
  // Validate required fields to catch backend API changes early
  if (!data.bucket || !data.region || !data.key || !data.credentials) {
    throw new Error(`Octo API /v1/bot/upload/credentials returned incomplete response: missing ${
      ['bucket', 'region', 'key', 'credentials'].filter(k => !data[k]).join(', ')
    }`);
  }
  if (!data.credentials.tmpSecretId || !data.credentials.tmpSecretKey || !data.credentials.sessionToken) {
    throw new Error("Octo API /v1/bot/upload/credentials returned incomplete credentials");
  }
  return data;
}

/** Characters unsafe in a Content-Disposition filename="..." value. */
const CD_UNSAFE_RE = /["\\\x00-\x1F\x7F;]/;

export function rfc5987Encode(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

export function buildContentDisposition(
  filename: string,
  type: 'attachment' | 'inline' = 'attachment',
): string {
  const isAsciiSafe = /^[\x20-\x7E]+$/.test(filename) && !CD_UNSAFE_RE.test(filename);
  if (isAsciiSafe) {
    return `${type}; filename="${filename}"`;
  }
  const ext = filename.includes('.') ? '.' + filename.split('.').pop() : '';
  return `${type}; filename="download${ext}"; filename*=UTF-8''${rfc5987Encode(filename)}`;
}

/**
 * Upload a file directly to COS using STS temporary credentials.
 */
export async function uploadFileToCOS(params: {
  credentials: {
    tmpSecretId: string;
    tmpSecretKey: string;
    sessionToken: string;
  };
  startTime: number;
  expiredTime: number;
  bucket: string;
  region: string;
  key: string;
  fileBody: Buffer | NodeJS.ReadableStream;
  fileSize?: number;
  contentType: string;
  cdnBaseUrl?: string;
  filename?: string;
}): Promise<{ url: string }> {
  const cos = new COS({
    SecretId: params.credentials.tmpSecretId,
    SecretKey: params.credentials.tmpSecretKey,
    SecurityToken: params.credentials.sessionToken,
    StartTime: params.startTime,
    ExpiredTime: params.expiredTime,
  } as any);

  let contentDisposition: string | undefined;
  if (params.filename) {
    const ct = params.contentType;
    if (ct.startsWith('video/') || ct.startsWith('audio/')) {
      contentDisposition = buildContentDisposition(params.filename, 'inline');
    } else if (!ct.startsWith('image/')) {
      contentDisposition = buildContentDisposition(params.filename, 'attachment');
    }
  }

  const putParams: Record<string, unknown> = {
    Bucket: params.bucket,
    Region: params.region,
    Key: params.key,
    Body: params.fileBody,
    ContentType: params.contentType,
    ...(contentDisposition && { ContentDisposition: contentDisposition }),
  };
  if (params.fileSize != null) {
    putParams.ContentLength = params.fileSize;
  }

  return new Promise((resolve, reject) => {
    cos.putObject(putParams as any, (err: any, data: any) => {
      if (err) {
        reject(new Error(`COS upload failed: ${err.message || JSON.stringify(err)}`));
      } else {
        // Prefer CDN base URL (e.g. https://cdn.example.com) over raw COS URL
        let url: string;
        if (params.cdnBaseUrl) {
          const base = params.cdnBaseUrl.replace(/\/+$/, "");
          // Re-encode each path segment: COS keys may contain percent-encoded
          // characters (e.g. Chinese filenames). Without double-encoding, the
          // IM client decodes the URL once and requests a key with raw UTF-8
          // characters that doesn't exist in COS (NoSuchKey / 404).
          const reEncodedKey = params.key
            .split("/")
            .map((seg) => encodeURIComponent(seg))
            .join("/");
          url = `${base}/${reEncodedKey}`;
        } else {
          url = data.Location ? `https://${data.Location}` : "";
        }
        if (!url) {
          reject(new Error("COS upload succeeded but returned no Location URL"));
          return;
        }
        resolve({ url });
      }
    });
  });
}



/**
 * Fetch user info by UID. Requires backend `/v1/bot/user/info` endpoint.
 * Returns null if the endpoint is unavailable (404) or returns an error,
 * so callers can gracefully degrade.
 */
export async function fetchUserInfo(params: {
  apiUrl: string;
  botToken: string;
  uid: string;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<{ uid: string; name: string; avatar?: string } | null> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/user/info?uid=${encodeURIComponent(params.uid)}`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${params.botToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.status === 404) {
      // Endpoint not implemented yet — silent degrade
      return null;
    }
    if (!resp.ok) {
      params.log?.error?.(`octo: fetchUserInfo(${params.uid}) failed: ${resp.status}`);
      return null;
    }
    const data = await resp.json() as { uid?: string; name?: string; avatar?: string };
    if (data?.name) {
      return { uid: data.uid ?? params.uid, name: data.name, avatar: data.avatar };
    }
    return null;
  } catch (err) {
    params.log?.error?.(`octo: fetchUserInfo(${params.uid}) error: ${String(err)}`);
    return null;
  }
}

// ========== Space Members API ==========

export async function searchSpaceMembers(params: {
  apiUrl: string;
  botToken: string;
  keyword?: string;
  spaceId?: string;
  limit?: number;
}): Promise<Array<{ uid: string; name: string; robot: number }>> {
  const query = new URLSearchParams();
  if (params.keyword) query.set("keyword", params.keyword);
  if (params.spaceId) query.set("space_id", params.spaceId);
  if (params.limit) query.set("limit", String(params.limit));
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/space/members?${query}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`searchSpaceMembers failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as Array<{ uid: string; name: string; robot: number }>;
}

// ========== Bot Group Management APIs ==========

export async function createGroup(params: {
  apiUrl: string;
  botToken: string;
  name?: string;
  members: string[];
  creator: string;
  spaceId?: string;
}): Promise<{ group_no: string; name: string }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/createGroup`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${params.botToken}` },
    body: JSON.stringify({
      name: params.name,
      members: params.members,
      creator: params.creator,
      ...(params.spaceId ? { space_id: params.spaceId } : {}),
    }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`createGroup failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as { group_no: string; name: string };
}

export async function updateGroup(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  name?: string;
  notice?: string;
}): Promise<void> {
  const body: Record<string, string> = {};
  if (params.name != null) body.name = params.name;
  if (params.notice != null) body.notice = params.notice;
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/info`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${params.botToken}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`updateGroup failed (${resp.status}): ${text || resp.statusText}`);
  }
}

export async function addGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  members: string[];
}): Promise<{ ok: boolean; added: number }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/members/add`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${params.botToken}` },
    body: JSON.stringify({ members: params.members }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`addGroupMembers failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as { ok: boolean; added: number };
}

export async function removeGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  members: string[];
}): Promise<{ ok: boolean; removed: number }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/members/remove`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${params.botToken}` },
    body: JSON.stringify({ members: params.members }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`removeGroupMembers failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as { ok: boolean; removed: number };
}

// ========== Bot Thread APIs ==========

export async function createThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  name: string;
  sourceMessageId?: number;
}): Promise<{ short_id: string; name: string; creator_uid: string }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads`;
  const body: Record<string, unknown> = { name: params.name };
  if (params.sourceMessageId != null) body.source_message_id = params.sourceMessageId;
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${params.botToken}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`createThread failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as { short_id: string; name: string; creator_uid: string };
}

export async function listThreads(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
}): Promise<Array<{ short_id: string; name: string; creator_uid: string; status: number }>> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`listThreads failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as Array<{ short_id: string; name: string; creator_uid: string; status: number }>;
}

export async function getThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
}): Promise<{ short_id: string; name: string; creator_uid: string; status: number; member_count: number }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`getThread failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as { short_id: string; name: string; creator_uid: string; status: number; member_count: number };
}

export async function deleteThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
}): Promise<void> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}`;
  const resp = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`deleteThread failed (${resp.status}): ${text || resp.statusText}`);
  }
}

export async function listThreadMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
}): Promise<Array<{ uid: string; role: number }>> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/members`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`listThreadMembers failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as Array<{ uid: string; role: number }>;
}

export async function joinThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
}): Promise<void> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/join`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`joinThread failed (${resp.status}): ${text || resp.statusText}`);
  }
}

export async function leaveThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
}): Promise<void> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/leave`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`leaveThread failed (${resp.status}): ${text || resp.statusText}`);
  }
}
