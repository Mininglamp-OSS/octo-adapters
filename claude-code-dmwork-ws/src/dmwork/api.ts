/** DMWork REST API client — extracted from openclaw-channel-dmwork */

import { ChannelType, MessageType } from "./types.js";
import type { BotRegisterResp } from "./types.js";

const DEFAULT_HEADERS = { "Content-Type": "application/json" };

async function postJson<T>(
  apiUrl: string,
  botToken: string,
  path: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const url = `${apiUrl.replace(/\/+$/, "")}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${botToken}` },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`DMWork API ${path} failed (${response.status}): ${text || response.statusText}`);
  }
  const text = await response.text();
  if (!text) return undefined;
  return JSON.parse(text) as T;
}

export async function registerBot(params: {
  apiUrl: string;
  botToken: string;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}): Promise<BotRegisterResp> {
  const path = params.forceRefresh ? "/v1/bot/register?force_refresh=true" : "/v1/bot/register";
  const result = await postJson<BotRegisterResp>(params.apiUrl, params.botToken, path, {}, params.signal);
  if (!result) throw new Error("DMWork bot registration returned empty response");
  return result;
}

export async function sendMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  content: string;
  mentionUids?: string[];
  replyMsgId?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const payload: Record<string, unknown> = {
    type: MessageType.Text,
    content: params.content,
  };
  if (params.mentionUids?.length) {
    payload.mention = { uids: params.mentionUids };
  }
  if (params.replyMsgId) {
    payload.reply = { message_id: params.replyMsgId };
  }
  await postJson(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
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
  }, params.signal).catch(() => {});
}

export async function sendHeartbeat(params: {
  apiUrl: string;
  botToken: string;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(params.apiUrl, params.botToken, "/v1/bot/heartbeat", {}, params.signal).catch(() => {});
}

export async function getChannelMessages(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  limit?: number;
  signal?: AbortSignal;
}): Promise<Array<{ from_uid: string; content: string; timestamp: number }>> {
  try {
    const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/messages/sync`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${params.botToken}` },
      body: JSON.stringify({
        channel_id: params.channelId,
        channel_type: params.channelType,
        limit: params.limit ?? 20,
        start_message_seq: 0,
        end_message_seq: 0,
        pull_mode: 1,
      }),
      signal: params.signal,
    });
    if (!response.ok) return [];
    const data = await response.json();
    const messages = data.messages ?? [];
    return messages.map((m: any) => {
      let payload: any = {};
      if (m.payload) {
        try {
          payload = JSON.parse(Buffer.from(m.payload, "base64").toString("utf-8"));
        } catch {
          payload = typeof m.payload === "object" ? m.payload : {};
        }
      }
      return {
        from_uid: m.from_uid ?? "unknown",
        content: payload.content ?? "",
        timestamp: (m.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
      };
    });
  } catch {
    return [];
  }
}

// ─── Streaming API ──────────────────────────────────────────────────────────

export async function streamStart(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
}): Promise<string> {
  const payload = Buffer.from(JSON.stringify({ type: MessageType.Text, content: "" })).toString("base64");
  const result = await postJson<{ stream_no: string }>(params.apiUrl, params.botToken, "/v1/bot/stream/start", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload,
  });
  return result?.stream_no ?? "";
}

/**
 * Send accumulated text to an active stream.
 * IMPORTANT: content must be the FULL accumulated text so far, not incremental.
 * The client replaces previous content with each update.
 */
export async function streamSend(params: {
  apiUrl: string;
  botToken: string;
  streamNo: string;
  channelId: string;
  channelType: ChannelType;
  content: string;
}): Promise<void> {
  await postJson(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    stream_no: params.streamNo,
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload: { type: MessageType.Text, content: params.content },
  });
}

export async function streamEnd(params: {
  apiUrl: string;
  botToken: string;
  streamNo: string;
  channelId: string;
  channelType: ChannelType;
}): Promise<void> {
  await postJson(params.apiUrl, params.botToken, "/v1/bot/stream/end", {
    stream_no: params.streamNo,
    channel_id: params.channelId,
    channel_type: params.channelType,
  });
}

// ─── Group Members ──────────────────────────────────────────────────────────

export async function getGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
}): Promise<Array<{ uid: string; name: string; robot?: boolean }>> {
  try {
    const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${params.groupNo}/members`;
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${params.botToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data?.members) ? data.members : Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}