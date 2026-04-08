/**
 * Permission checking for cross-session message queries.
 *
 * Rules:
 * - Owner → full access (all DMs and groups)
 * - DM: requester can only query their own DM with the bot
 * - Group: requester must be a member of the group
 * - Unknown requester → denied
 */

import { isOwner } from "./owner-registry.js";
import { getGroupMembersFromCache } from "./member-cache.js";
import { ChannelType } from "./types.js";
import type { LogSink } from "./types.js";

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

export async function checkPermission(params: {
  requesterSenderId: string | undefined;
  channelId: string;
  channelType: number;
  accountId: string | undefined;
  apiUrl: string;
  botToken: string;
  log?: LogSink;
}): Promise<PermissionResult> {
  const { requesterSenderId, channelId, channelType, accountId } = params;

  if (!requesterSenderId) {
    return { allowed: false, reason: "无法识别调用者身份" };
  }

  // Owner gets full access
  if (accountId && isOwner(accountId, requesterSenderId)) {
    return { allowed: true };
  }

  if (channelType === ChannelType.DM) {
    // DM: only allow querying your own conversation with the bot
    if (channelId !== requesterSenderId) {
      return { allowed: false, reason: "无权查询他人与Bot的私信" };
    }
    return { allowed: true };
  }

  if (channelType === ChannelType.Group) {
    // Group: requester must be a current member
    const members = await getGroupMembersFromCache({
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      groupNo: channelId,
      log: params.log,
    });
    const memberUids = members.map((m) => m.uid).filter(Boolean);
    if (!memberUids.includes(requesterSenderId)) {
      return { allowed: false, reason: "你不在该群中，无权查询" };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: `不支持的频道类型: ${channelType}` };
}
