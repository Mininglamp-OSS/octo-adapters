/**
 * Group chat context — caches recent messages and member mappings.
 * Matches openclaw adapter's group history + member resolution behavior.
 */

import { getGroupMembers } from "./dmwork/api.js";
import { parseMentions } from "./dmwork/mentions.js";

export interface GroupMessage {
  fromUid: string;
  fromName: string;
  content: string;
  timestamp: number;
}

interface GroupCache {
  messages: GroupMessage[];
  /** uid → displayName */
  uidToName: Map<string, string>;
  /** displayName (lowercase) → uid */
  nameToUid: Map<string, string>;
  /** Last time members were fetched */
  membersFetchedAt: number;
}

const GROUP_HISTORY_LIMIT = 20;
const MEMBERS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MEMBERS_EMPTY_RETRY_MS = 30 * 1000; // 30s if fetch returned empty

export class GroupContext {
  private groups = new Map<string, GroupCache>();

  private getOrCreate(channelId: string): GroupCache {
    let g = this.groups.get(channelId);
    if (!g) {
      g = {
        messages: [],
        uidToName: new Map(),
        nameToUid: new Map(),
        membersFetchedAt: 0,
      };
      this.groups.set(channelId, g);
    }
    return g;
  }

  /** Record a message in group history (called for ALL group messages, not just @bot) */
  pushMessage(channelId: string, fromUid: string, content: string, timestamp: number): void {
    const g = this.getOrCreate(channelId);
    const fromName = g.uidToName.get(fromUid) || fromUid;
    g.messages.push({ fromUid, fromName, content, timestamp });
    // Sliding window
    if (g.messages.length > GROUP_HISTORY_LIMIT * 2) {
      g.messages = g.messages.slice(-GROUP_HISTORY_LIMIT);
    }
  }

  /** Learn uid ↔ name mapping from message metadata */
  learnMember(channelId: string, uid: string, name: string): void {
    if (!name || !uid) return;
    const g = this.getOrCreate(channelId);
    g.uidToName.set(uid, name);
    g.nameToUid.set(name.toLowerCase(), uid);
  }

  /** Fetch and cache group members from API */
  async refreshMembers(
    channelId: string,
    apiUrl: string,
    botToken: string,
  ): Promise<void> {
    const g = this.getOrCreate(channelId);
    const now = Date.now();
    const ttl = g.uidToName.size === 0 ? MEMBERS_EMPTY_RETRY_MS : MEMBERS_CACHE_TTL_MS;
    if (now - g.membersFetchedAt < ttl) return;

    g.membersFetchedAt = now;
    const members = await getGroupMembers({ apiUrl, botToken, groupNo: channelId });
    for (const m of members) {
      if (m.uid && m.name) {
        g.uidToName.set(m.uid, m.name);
        g.nameToUid.set(m.name.toLowerCase(), m.uid);
      }
    }
  }

  /** Get display name for a uid */
  getName(channelId: string, uid: string): string {
    return this.getOrCreate(channelId).uidToName.get(uid) || uid;
  }

  /** Build group context string for prompt injection */
  buildContext(channelId: string, limit = GROUP_HISTORY_LIMIT): string {
    const g = this.groups.get(channelId);
    if (!g || g.messages.length === 0) return "";

    const recent = g.messages.slice(-limit);
    const lines = recent.map((m) => `${m.fromName}：${m.content.slice(0, 500)}`);
    return "[Group chat context (recent messages)]\n" + lines.join("\n") + "\n\n";
  }

  /** Resolve @mentions in AI reply text → real uids for DMWork push notification */
  resolveMentions(channelId: string, text: string): string[] {
    const g = this.groups.get(channelId);
    if (!g) return [];

    const names = parseMentions(text);
    const uids: string[] = [];
    for (const name of names) {
      const uid = g.nameToUid.get(name.toLowerCase());
      if (uid) uids.push(uid);
    }
    return uids;
  }
}
