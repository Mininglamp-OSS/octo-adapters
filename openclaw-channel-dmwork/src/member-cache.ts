/**
 * Group member cache with reverse index (uid → groups).
 *
 * Used for:
 * - Permission checks: is user X a member of group Y?
 * - Shared group discovery: which groups does user X belong to?
 *
 * Cache entries expire after CACHE_TTL_MS and are rebuilt on demand.
 */

import type { GroupMember } from "./api-fetch.js";
import { getGroupMembers, fetchBotGroups } from "./api-fetch.js";
import type { LogSink } from "./types.js";

export interface SharedGroupInfo {
  groupNo: string;
  groupName: string;
  memberCount: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  members: GroupMember[];
  groupName: string;
  expiry: number;
}

const _memberCache = new Map<string, CacheEntry>();
const _userGroupIndex = new Map<string, Set<string>>(); // uid → Set<groupNo>

// ===== Query =====

export async function getGroupMembersFromCache(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  log?: LogSink;
}): Promise<GroupMember[]> {
  const cached = _memberCache.get(params.groupNo);
  if (cached && cached.expiry > Date.now()) return cached.members;
  return refreshGroupMembers(params);
}

/**
 * Find groups shared between a user and the bot, using the reverse index.
 * Returns null if no cached data is available (caller should fall back to API).
 */
export function findSharedGroupsFromCache(uid: string): SharedGroupInfo[] | null {
  const groups = _userGroupIndex.get(uid);
  if (!groups || groups.size === 0) return null;
  const result: SharedGroupInfo[] = [];
  for (const groupNo of groups) {
    const cached = _memberCache.get(groupNo);
    if (cached && cached.expiry > Date.now()) {
      result.push({
        groupNo,
        groupName: cached.groupName,
        memberCount: cached.members.length,
      });
    }
  }
  return result.length > 0 ? result : null;
}

// ===== Build / Refresh =====

async function refreshGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  groupName?: string;
  log?: LogSink;
}): Promise<GroupMember[]> {
  let members: GroupMember[];
  try {
    members = await getGroupMembers({
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      groupNo: params.groupNo,
      log: params.log
        ? {
            info: (...a: unknown[]) => params.log!.info?.(String(a[0])),
            error: (...a: unknown[]) => params.log!.error?.(String(a[0])),
          }
        : undefined,
    });
  } catch (err) {
    // Don't cache on API failure — preserve stale cache or leave empty
    params.log?.error?.(
      `dmwork: refreshGroupMembers(${params.groupNo}) failed, skipping cache update: ${err}`,
    );
    throw err;
  }
  purgeReverseIndex(params.groupNo);
  _memberCache.set(params.groupNo, {
    members,
    groupName: params.groupName ?? params.groupNo,
    expiry: Date.now() + CACHE_TTL_MS,
  });
  for (const m of members) {
    const uid = m.uid;
    if (!uid) continue;
    let groups = _userGroupIndex.get(uid);
    if (!groups) {
      groups = new Set();
      _userGroupIndex.set(uid, groups);
    }
    groups.add(params.groupNo);
  }
  return members;
}

/**
 * Preload member cache for all bot groups.
 * Called at startup (fire-and-forget). Failures degrade to on-demand loading.
 */
export async function preloadGroupMemberCache(params: {
  apiUrl: string;
  botToken: string;
  log?: LogSink;
}): Promise<void> {
  const groups = await fetchBotGroups({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    log: params.log
      ? {
          info: (...a: unknown[]) => params.log!.info?.(String(a[0])),
          error: (...a: unknown[]) => params.log!.error?.(String(a[0])),
        }
      : undefined,
  });
  let count = 0;
  for (const g of groups) {
    try {
      await refreshGroupMembers({
        apiUrl: params.apiUrl,
        botToken: params.botToken,
        groupNo: g.group_no,
        groupName: g.name,
        log: params.log,
      });
      count++;
    } catch {
      // Ignore per-group failures
    }
  }
  if (count > 0) {
    params.log?.info?.(`dmwork: member-cache preloaded ${count} groups`);
  }
}

// ===== Invalidation =====

function purgeReverseIndex(groupNo: string): void {
  for (const [, groups] of _userGroupIndex) {
    groups.delete(groupNo);
  }
}

export function invalidateGroupCache(groupNo: string): void {
  _memberCache.delete(groupNo);
}

export function evictGroupFromCache(groupNo: string): void {
  purgeReverseIndex(groupNo);
  _memberCache.delete(groupNo);
}

/** Visible for testing — clears all cache data. */
export function _clearMemberCache(): void {
  _memberCache.clear();
  _userGroupIndex.clear();
}

/** Visible for testing — check if a cache entry exists (ignoring expiry). */
export function _hasCacheEntry(groupNo: string): boolean {
  return _memberCache.has(groupNo);
}

/** Visible for testing — directly set cache entry. */
export function _setCacheEntry(
  groupNo: string,
  members: GroupMember[],
  groupName?: string,
  ttlMs?: number,
): void {
  purgeReverseIndex(groupNo);
  _memberCache.set(groupNo, {
    members,
    groupName: groupName ?? groupNo,
    expiry: Date.now() + (ttlMs ?? CACHE_TTL_MS),
  });
  for (const m of members) {
    const uid = m.uid;
    if (!uid) continue;
    let groups = _userGroupIndex.get(uid);
    if (!groups) {
      groups = new Set();
      _userGroupIndex.set(uid, groups);
    }
    groups.add(groupNo);
  }
}
