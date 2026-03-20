/**
 * Lightweight fetch-based API helpers for use inside OpenClaw plugin context.
 * These are used by inbound/outbound where the full DMWorkAPI class is not available.
 */

import { ChannelType, MessageType } from "./types.js";
import path from "path";

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
    throw new Error(`DMWork API ${path} failed (${response.status}): ${text || response.statusText}`);
  }

  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`DMWork API ${path} returned invalid JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Upload a file to DMWork backend via multipart/form-data.
 * Returns the CDN URL of the uploaded file.
 */
export async function uploadFile(params: {
  apiUrl: string;
  botToken: string;
  fileBuffer: Buffer;
  filename: string;
  contentType: string;
  signal?: AbortSignal;
}): Promise<{ url: string }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/file/upload`;
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(params.fileBuffer)], { type: params.contentType });
  formData.append("file", blob, params.filename);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.botToken}`,
    },
    body: formData,
    signal: params.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`DMWork API /v1/bot/upload failed (${response.status}): ${text || response.statusText}`);
  }

  const data = await response.json() as { url?: string };
  if (!data.url) {
    throw new Error("DMWork API /v1/bot/upload returned no url");
  }
  return { url: data.url };
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
  signal?: AbortSignal;
}): Promise<void> {
  const payload: Record<string, unknown> = {
    type: params.type,
    url: params.url,
  };

  // Image (type=2) needs width/height; File (type=8) needs name/size
  if (params.type === MessageType.Image) {
    if (params.width) payload.width = params.width;
    if (params.height) payload.height = params.height;
  } else {
    if (params.name) payload.name = params.name;
    if (params.size != null) payload.size = params.size;
  }

  if (params.mentionUids && params.mentionUids.length > 0) {
    payload.mention = { uids: params.mentionUids };
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
    ".txt": "text/plain", ".json": "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}

export async function sendMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  content: string;
  mentionUids?: string[];
  mentionAll?: boolean;
  streamNo?: string;
  replyMsgId?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const payload: Record<string, unknown> = {
    type: MessageType.Text,
    content: params.content,
  };
  // Add mention field if any UIDs specified or mentionAll
  if ((params.mentionUids && params.mentionUids.length > 0) || params.mentionAll) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) {
      mention.uids = params.mentionUids;
    }
    if (params.mentionAll) {
      mention.all = true;
    }
    payload.mention = mention;
  }
  // Add reply field if replyMsgId is provided
  if (params.replyMsgId) {
    payload.reply = { message_id: params.replyMsgId };
  }
  await postJson(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    ...(params.streamNo ? { stream_no: params.streamNo } : {}),
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
  const result = await postJson<{
    robot_id: string;
    im_token: string;
    ws_url: string;
    api_url: string;
    owner_uid: string;
    owner_channel_id: string;
  }>(params.apiUrl, params.botToken, path, {}, params.signal);
  if (!result) throw new Error("DMWork bot registration returned empty response");
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
    params.log?.error?.(`dmwork: fetchBotGroups failed: ${resp.status}`);
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
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${params.botToken}`,
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!resp.ok) {
      params.log?.error?.(`dmwork: getGroupMembers failed: ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    // Normalize to strict array to prevent silent failures
    const members = Array.isArray(data?.members)
      ? data.members
      : Array.isArray(data)
        ? data
        : [];
    return members as GroupMember[];
  } catch (err) {
    params.log?.error?.(`dmwork: getGroupMembers error: ${err}`);
    return [];
  }
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
      params.log?.error?.(`dmwork: getGroupInfo failed: ${resp.status}`);
      throw new Error(`getGroupInfo failed: ${resp.status}`);
    }
    return await resp.json();
  } catch (err) {
    params.log?.error?.(`dmwork: getGroupInfo error: ${err}`);
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
        start_message_seq: 0,
        end_message_seq: 0,
        pull_mode: 1,  // 1 = pull up (newer messages)
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      params.log?.info?.(`dmwork: getChannelMessages failed: ${response.status}`);
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
          params.log?.info?.(`dmwork: payload decode failed for msg ${m.message_id ?? "unknown"}: ${decodeErr}`);
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
    params.log?.error?.(`dmwork: getChannelMessages error: ${err}`);
    return [];
  }
}
