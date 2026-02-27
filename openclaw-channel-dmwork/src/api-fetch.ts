/**
 * Lightweight fetch-based API helpers for use inside OpenClaw plugin context.
 * These are used by inbound/outbound where the full DMWorkAPI class is not available.
 */

import { ChannelType, MessageType } from "./types.js";

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
};

async function postJson<T>(
  apiUrl: string,
  botToken: string,
  path: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
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
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export async function sendMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  content: string;
  streamNo?: string;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    ...(params.streamNo ? { stream_no: params.streamNo } : {}),
    payload: { type: MessageType.Text, content: params.content },
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
  signal?: AbortSignal;
}): Promise<{
  robot_id: string;
  im_token: string;
  ws_url: string;
  api_url: string;
  owner_uid: string;
  owner_channel_id: string;
}> {
  return postJson(params.apiUrl, params.botToken, "/v1/bot/register", {}, params.signal);
}
