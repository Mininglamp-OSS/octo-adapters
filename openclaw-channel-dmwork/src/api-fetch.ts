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
  mentionUids?: string[];
  mentionAll?: boolean;
  streamNo?: string;
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
  return postJson(params.apiUrl, params.botToken, path, {}, params.signal);
}

// Fetch the groups the bot belongs to
export async function fetchBotGroups(params: {
  apiUrl: string;
  botToken: string;
}): Promise<Array<{ group_no: string; name: string }>> {
  const url = `${params.apiUrl}/v1/bot/groups`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${params.botToken}`,
    },
  });
  if (!resp.ok) {
    // Fallback: return empty if API not available
    return [];
  }
  return resp.json();
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
}): Promise<GroupMember[]> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${params.groupNo}/members`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${params.botToken}`,
      },
    });
    if (!resp.ok) {
      console.log(`[dmwork] getGroupMembers failed: ${resp.status}`);
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
    console.log(`[dmwork] getGroupMembers error: ${err}`);
    return [];
  }
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
  log?: { info?: (...args: any[]) => void; error?: (...args: any[]) => void };
}): Promise<Array<{ from_uid: string; content: string; timestamp: number }>> {
  try {
    const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/channel/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.botToken}`,
      },
      body: JSON.stringify({
        channel_id: params.channelId,
        channel_type: params.channelType,
        limit: params.limit ?? 20,
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      params.log?.info?.(`dmwork: getChannelMessages failed: ${response.status}`);
      return [];
    }

    const data = await response.json();
    return (data.messages ?? data ?? []).map((m: any) => ({
      from_uid: m.from_uid ?? m.sender_id ?? "unknown",
      content: m.payload?.content ?? m.content ?? "",
      timestamp: m.timestamp ?? Math.floor(Date.now() / 1000),  // API timestamps are in seconds
    }));
  } catch (err) {
    params.log?.error?.(`dmwork: getChannelMessages error: ${err}`);
    return [];
  }
}
