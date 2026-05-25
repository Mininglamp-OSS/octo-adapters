/**
 * GROUP.md local caching and before_prompt_build hook for Octo groups.
 *
 * Storage layout (CHANNEL_ID = "octo"):
 *   ~/.openclaw/workspace/octo/{accountId}/groups/{groupNo}/GROUP.md
 *   ~/.openclaw/workspace/octo/{accountId}/groups/{groupNo}/GROUP.meta.json
 *
 * Memory maps (rebuilt from inbound messages after restart):
 *   _groupAccountMap: "agentId:groupNo" → accountId
 *   _checkedGroups: Set<"accountId/groupNo"> — tracks groups checked this session
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ChannelLogSink } from "openclaw/plugin-sdk/channel-contract";
import { CHANNEL_ID } from "./constants.js";

// --- Channel ID helpers ---

/**
 * Extract the parent group number from a channelId.
 * Thread channelId format: "groupNo____shortId"
 * Group channelId format: "groupNo"
 */
export function extractParentGroupNo(channelId: string): string {
  const sep = channelId.indexOf("____");
  return sep >= 0 ? channelId.slice(0, sep) : channelId;
}

/**
 * Extract the thread shortId from a channelId.
 * Only thread channelIds contain a shortId; group channelIds return null.
 *
 * Edge case: if channelId ends with "____" (no shortId portion), returns "".
 * Callers that require a non-empty shortId should check for falsy values.
 */
export function extractThreadShortId(channelId: string): string | null {
  const sep = channelId.indexOf("____");
  if (sep < 0) return null;
  const id = channelId.slice(sep + 4);
  return id || null;
}

/**
 * Check if a channelId is a thread (community topic) format.
 */
export function isThreadChannelId(channelId: string): boolean {
  return channelId.includes("____");
}

export interface GroupMdMeta {
  version: number;
  updated_at: string | null;
  updated_by: string;
  fetched_at: string;
  account_id: string;
}

export interface GroupMdApiResponse {
  content: string;
  version: number;
  updated_at: string | null;
  updated_by: string;
}

/** Regex to extract groupNo from OpenClaw sessionKey */
// LEGACY-COMPAT: dual-prefix to also match historical sessions emitted with `dmwork:` namespace
export const OCTO_GROUP_RE = /^agent:[^:]+:(?:octo|dmwork):group:(.+)$/;

// --- In-memory maps ---

/** All bot group IDs registered at startup via fetchBotGroups */
const _allBotGroupIds = new Set<string>();

export function registerBotGroupIds(groupNos: string[]): void {
  for (const g of groupNos) _allBotGroupIds.add(g);
}

/** groupNo → accountId (rebuilt from inbound messages) */
const _groupAccountMap = new Map<string, string>();

/** Set of "accountId/groupNo" that have been checked this session */
const _checkedGroups = new Set<string>();

/** GROUP.md content cache: accountId → (groupNo → { content, version }) */
const _groupMdCache = new Map<string, Map<string, { content: string; version: number }>>();

export function getOrCreateGroupMdCache(accountId: string): Map<string, { content: string; version: number }> {
  let m = _groupMdCache.get(accountId);
  if (!m) {
    m = new Map<string, { content: string; version: number }>();
    _groupMdCache.set(accountId, m);
  }
  return m;
}

// --- Path helpers ---

function workspaceBase(): string {
  return join(homedir(), ".openclaw", "workspace", CHANNEL_ID);
}

function groupDir(accountId: string, groupNo: string): string {
  return join(workspaceBase(), accountId, "groups", groupNo);
}

function groupMdPath(accountId: string, groupNo: string): string {
  return join(groupDir(accountId, groupNo), "GROUP.md");
}

function groupMetaPath(accountId: string, groupNo: string): string {
  return join(groupDir(accountId, groupNo), "GROUP.meta.json");
}

// --- Public API ---

/**
 * Register the mapping from groupNo to accountId.
 * Called by inbound.ts on every group message.
 */
export function registerGroupAccount(groupNo: string, accountId: string, agentId?: string): void {
  if (agentId) {
    _groupAccountMap.set(`${agentId}:${groupNo}`, accountId);
  }
  // Do NOT register bare groupNo key — it causes cross-agent contamination on multi-bot nodes
}

/**
 * Scan disk for accountId when memory map misses.
 * Looks through all accountId directories for a matching groupNo with a meta file.
 */
export function scanForAccountId(agentId: string, groupNo: string): string | null {
  const base = workspaceBase();
  if (!existsSync(base)) return null;

  let accounts: string[];
  try {
    accounts = readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return null;
  }

  for (const acct of accounts) {
    const metaFile = groupMetaPath(acct, groupNo);
    if (existsSync(metaFile)) {
      try {
        const meta = JSON.parse(readFileSync(metaFile, "utf-8")) as GroupMdMeta;
        if (meta.account_id) {
          _groupAccountMap.set(`${agentId}:${groupNo}`, meta.account_id);
          return meta.account_id;
        }
      } catch {
        // corrupted meta, skip
      }
    }
  }
  return null;
}

/**
 * Resolve accountId for a group — memory first, then disk scan.
 */
function resolveAccountId(agentId: string, groupNo: string): string | null {
  // Only use agent-specific key — bare groupNo key may belong to a different agent on the same node
  return _groupAccountMap.get(`${agentId}:${groupNo}`) ?? scanForAccountId(agentId, groupNo);
}

/**
 * Fetch GROUP.md from the API.
 */
async function fetchGroupMdFromApi(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  log?: ChannelLogSink;
}): Promise<GroupMdApiResponse | null> {
  const { apiUrl, botToken, groupNo, log } = params;
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(groupNo)}/md`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.status === 404) {
      log?.debug?.(`octo: [GROUP.md] no GROUP.md for group ${groupNo}`);
      return null;
    }
    if (!resp.ok) {
      log?.warn?.(`octo: [GROUP.md] fetch failed for ${groupNo}: ${resp.status}`);
      return null;
    }
    return (await resp.json()) as GroupMdApiResponse;
  } catch (err) {
    log?.warn?.(`octo: [GROUP.md] fetch error for ${groupNo}: ${String(err)}`);
    return null;
  }
}

/**
 * Write GROUP.md and meta to disk.
 */
export function writeGroupMdToDisk(params: {
  accountId: string;
  groupNo: string;
  content: string;
  meta: GroupMdMeta;
}): void {
  const dir = groupDir(params.accountId, params.groupNo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(groupMdPath(params.accountId, params.groupNo), params.content, "utf-8");
  writeFileSync(groupMetaPath(params.accountId, params.groupNo), JSON.stringify(params.meta, null, 2), "utf-8");
}

/**
 * Read GROUP.md from disk. Returns null if file doesn't exist.
 */
export function readGroupMdFromDisk(accountId: string, groupNo: string): string | null {
  const filePath = groupMdPath(accountId, groupNo);
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read GROUP.meta.json from disk. Returns null if file doesn't exist.
 */
export function readGroupMeta(accountId: string, groupNo: string): GroupMdMeta | null {
  const metaFile = groupMetaPath(accountId, groupNo);
  try {
    return JSON.parse(readFileSync(metaFile, "utf-8")) as GroupMdMeta;
  } catch {
    return null;
  }
}

/**
 * Delete GROUP.md and meta from disk.
 */
export function deleteGroupMdFromDisk(accountId: string, groupNo: string): void {
  try { unlinkSync(groupMdPath(accountId, groupNo)); } catch { /* ok */ }
  try { unlinkSync(groupMetaPath(accountId, groupNo)); } catch { /* ok */ }
}

/**
 * Ensure GROUP.md is fetched and cached for a group.
 * Called by inbound.ts on group messages (fire-and-forget).
 * Only fetches once per session per group (tracked by _checkedGroups).
 */
export async function ensureGroupMd(params: {
  agentId: string;
  accountId: string;
  groupNo: string;
  apiUrl: string;
  botToken: string;
  log?: ChannelLogSink;
}): Promise<void> {
  const { agentId, accountId, groupNo, apiUrl, botToken, log } = params;
  const key = `${accountId}/${groupNo}`;
  if (_checkedGroups.has(key)) return;
  _checkedGroups.add(key);

  // Always fetch from API on startup to ensure cache is fresh
  const apiData = await fetchGroupMdFromApi({ apiUrl, botToken, groupNo, log });
  if (!apiData) {
    return;
  }

  // Compare with local cache — skip disk write if version unchanged
  const existingMeta = readGroupMeta(accountId, groupNo);
  if (existingMeta && existingMeta.version === apiData.version) {
    log?.debug?.(`octo: [GROUP.md] cache up-to-date for ${groupNo} (v${apiData.version})`);
    return;
  }

  const meta: GroupMdMeta = {
    version: apiData.version,
    updated_at: apiData.updated_at,
    updated_by: apiData.updated_by,
    fetched_at: new Date().toISOString(),
    account_id: accountId,
  };

  writeGroupMdToDisk({ accountId, groupNo, content: apiData.content, meta });
  log?.info?.(`octo: [GROUP.md] cached v${apiData.version} for group ${groupNo}`);
}

/**
 * Handle group_md_updated / group_md_deleted events.
 * Called by inbound.ts when a structured event message is received.
 */
export async function handleGroupMdEvent(params: {
  agentId: string;
  accountId: string;
  groupNo: string;
  eventType: string;
  apiUrl: string;
  botToken: string;
  log?: ChannelLogSink;
}): Promise<void> {
  const { agentId, accountId, groupNo, eventType, apiUrl, botToken, log } = params;

  if (eventType === "group_md_deleted") {
    deleteGroupMdFromDisk(accountId, groupNo);
    clearGroupMdChecked(accountId, groupNo);
    log?.info?.(`octo: [GROUP.md] deleted cache for group ${groupNo}`);
    return;
  }

  if (eventType === "group_md_updated") {
    // Force re-fetch
    clearGroupMdChecked(accountId, groupNo);
    const apiData = await fetchGroupMdFromApi({ apiUrl, botToken, groupNo, log });
    if (!apiData) {
      log?.warn?.(`octo: [GROUP.md] update event but fetch returned null for ${groupNo}`);
      return;
    }

    const meta: GroupMdMeta = {
      version: apiData.version,
      updated_at: apiData.updated_at,
      updated_by: apiData.updated_by,
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };

    writeGroupMdToDisk({ accountId, groupNo, content: apiData.content, meta });
    _checkedGroups.add(`${accountId}/${groupNo}`);
    log?.info?.(`octo: [GROUP.md] updated cache to v${apiData.version} for group ${groupNo}`);
  }
}

/**
 * Get GROUP.md content for prompt injection.
 * Called by the before_prompt_build hook.
 * Only does disk reads — no network calls.
 * Thread sessions: only return THREAD.md (no parent GROUP.md fallback).
 * Group sessions: return GROUP.md.
 */
export function getGroupMdForPrompt(ctx: {
  sessionKey?: string;
  agentId?: string;
}): string | null {
  const { sessionKey, agentId } = ctx;
  if (!sessionKey || !agentId) return null;

  const match = OCTO_GROUP_RE.exec(sessionKey);
  if (!match) return null;
  const rawId = match[1];  // may be "groupNo" or "groupNo____shortId"

  const parentGroupNo = extractParentGroupNo(rawId);
  const shortId = extractThreadShortId(rawId);

  const accountId = resolveAccountId(agentId, parentGroupNo);
  if (!accountId) return null;

  // Thread sessions: only return THREAD.md (no parent GROUP.md fallback)
  if (shortId) {
    return readThreadMdFromDisk(accountId, parentGroupNo, shortId);
  }

  // Group sessions: return GROUP.md
  return readGroupMdFromDisk(accountId, parentGroupNo);
}

/**
 * Clear the checked flag for a group, forcing re-fetch on next encounter.
 */
export function clearGroupMdChecked(accountId: string, groupNo: string): void {
  _checkedGroups.delete(`${accountId}/${groupNo}`);
}

/**
 * Update GROUP.md disk cache.
 * Called by agent-tools.ts after a successful API update and by inbound.ts on events.
 */
export function broadcastGroupMdUpdate(params: {
  accountId: string;
  groupNo: string;
  content: string;
  version: number;
}): void {
  const { accountId, groupNo, content, version } = params;
  const meta: GroupMdMeta = {
    version,
    updated_at: new Date().toISOString(),
    updated_by: "event",
    fetched_at: new Date().toISOString(),
    account_id: accountId,
  };
  try {
    writeGroupMdToDisk({ accountId, groupNo, content, meta });
    console.error(`[octo] broadcastGroupMdUpdate: updated disk cache group=${groupNo} v=${version}`);
  } catch (err) {
    console.error(`[octo] broadcastGroupMdUpdate failed for group=${groupNo}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Return the set of all known groupNo values from the in-memory map.
 * Used by parseTarget to distinguish cross-group targets from DM targets.
 */
export function getKnownGroupIds(): Set<string> {
  const ids = new Set<string>();
  for (const key of _groupAccountMap.keys()) {
    const idx = key.indexOf(":");
    if (idx !== -1) {
      ids.add(key.slice(idx + 1));
    }
  }
  // Also include groups from groupMdCache (populated at startup via fetchBotGroups)
  for (const cache of _groupMdCache.values()) {
    for (const groupNo of cache.keys()) {
      ids.add(groupNo);
    }
  }
  // Also include groups registered at startup via registerBotGroupIds
  for (const g of _allBotGroupIds) ids.add(g);
  return ids;
}

// --- Thread (子区) THREAD.md disk cache ---

/** Tracks threads checked this session to avoid redundant API calls */
const _checkedThreads = new Set<string>(); // "accountId/groupNo/shortId"

function threadDir(accountId: string, groupNo: string, shortId: string): string {
  return join(workspaceBase(), accountId, "groups", groupNo, "threads", shortId);
}

function threadMdPath(accountId: string, groupNo: string, shortId: string): string {
  return join(threadDir(accountId, groupNo, shortId), "THREAD.md");
}

function threadMetaPath(accountId: string, groupNo: string, shortId: string): string {
  return join(threadDir(accountId, groupNo, shortId), "THREAD.meta.json");
}

export function writeThreadMdToDisk(params: {
  accountId: string;
  groupNo: string;
  shortId: string;
  content: string;
  meta: GroupMdMeta;
}): void {
  const dir = threadDir(params.accountId, params.groupNo, params.shortId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(threadMdPath(params.accountId, params.groupNo, params.shortId), params.content, "utf-8");
  writeFileSync(threadMetaPath(params.accountId, params.groupNo, params.shortId), JSON.stringify(params.meta, null, 2), "utf-8");
}

export function readThreadMdFromDisk(accountId: string, groupNo: string, shortId: string): string | null {
  try {
    return readFileSync(threadMdPath(accountId, groupNo, shortId), "utf-8");
  } catch {
    return null;
  }
}

function readThreadMeta(accountId: string, groupNo: string, shortId: string): GroupMdMeta | null {
  try {
    return JSON.parse(readFileSync(threadMetaPath(accountId, groupNo, shortId), "utf-8")) as GroupMdMeta;
  } catch {
    return null;
  }
}

export function deleteThreadMdFromDisk(accountId: string, groupNo: string, shortId: string): void {
  try { unlinkSync(threadMdPath(accountId, groupNo, shortId)); } catch { /* ok */ }
  try { unlinkSync(threadMetaPath(accountId, groupNo, shortId)); } catch { /* ok */ }
}

/**
 * Fetch thread THREAD.md from the API (internal, used by ensureThreadMd / handleThreadMdEvent).
 * Returns null on 404 or network error — callers treat missing THREAD.md as normal.
 *
 * Contrast with api-fetch.ts `getThreadMd()` which throws on non-2xx responses
 * and is used by agent-tools where the caller needs explicit error propagation.
 */
async function fetchThreadMdFromApi(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  log?: ChannelLogSink;
}): Promise<GroupMdApiResponse | null> {
  const { apiUrl, botToken, groupNo, shortId, log } = params;
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(groupNo)}/threads/${encodeURIComponent(shortId)}/md`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      log?.warn?.(`octo: [THREAD.md] fetch failed for ${groupNo}/${shortId}: ${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as GroupMdApiResponse;
    // API returns version=0 + content="" for nonexistent thread md
    if (!data.content && data.version === 0) return null;
    return data;
  } catch (err) {
    log?.warn?.(`octo: [THREAD.md] fetch error for ${groupNo}/${shortId}: ${String(err)}`);
    return null;
  }
}

/**
 * Ensure thread THREAD.md is cached on disk.
 * Only checks once per session per thread.
 */
export async function ensureThreadMd(params: {
  agentId: string;
  accountId: string;
  groupNo: string;
  shortId: string;
  apiUrl: string;
  botToken: string;
  log?: ChannelLogSink;
}): Promise<void> {
  const { accountId, groupNo, shortId, apiUrl, botToken, log } = params;
  const key = `${accountId}/${groupNo}/${shortId}`;
  if (_checkedThreads.has(key)) return;
  _checkedThreads.add(key);

  const apiData = await fetchThreadMdFromApi({ apiUrl, botToken, groupNo, shortId, log });
  if (!apiData) return;

  const existingMeta = readThreadMeta(accountId, groupNo, shortId);
  if (existingMeta && existingMeta.version === apiData.version) {
    log?.debug?.(`octo: [THREAD.md] cache up-to-date for ${groupNo}/${shortId} (v${apiData.version})`);
    return;
  }

  const meta: GroupMdMeta = {
    version: apiData.version,
    updated_at: apiData.updated_at,
    updated_by: apiData.updated_by,
    fetched_at: new Date().toISOString(),
    account_id: accountId,
  };

  writeThreadMdToDisk({ accountId, groupNo, shortId, content: apiData.content, meta });
  log?.info?.(`octo: [THREAD.md] cached v${apiData.version} for thread ${groupNo}/${shortId}`);
}

/**
 * Handle thread_md_updated / thread_md_deleted events.
 */
export async function handleThreadMdEvent(params: {
  agentId: string;
  accountId: string;
  groupNo: string;
  shortId: string;
  eventType: string;
  apiUrl: string;
  botToken: string;
  log?: ChannelLogSink;
}): Promise<void> {
  const { accountId, groupNo, shortId, eventType, apiUrl, botToken, log } = params;

  if (eventType === "thread_md_deleted") {
    deleteThreadMdFromDisk(accountId, groupNo, shortId);
    _checkedThreads.delete(`${accountId}/${groupNo}/${shortId}`);
    log?.info?.(`octo: [THREAD.md] deleted cache for thread ${groupNo}/${shortId}`);
    return;
  }

  if (eventType === "thread_md_updated") {
    _checkedThreads.delete(`${accountId}/${groupNo}/${shortId}`);
    const apiData = await fetchThreadMdFromApi({ apiUrl, botToken, groupNo, shortId, log });
    if (!apiData) {
      log?.warn?.(`octo: [THREAD.md] update event but fetch returned null for ${groupNo}/${shortId}`);
      return;
    }

    const meta: GroupMdMeta = {
      version: apiData.version,
      updated_at: apiData.updated_at,
      updated_by: apiData.updated_by,
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };

    writeThreadMdToDisk({ accountId, groupNo, shortId, content: apiData.content, meta });
    _checkedThreads.add(`${accountId}/${groupNo}/${shortId}`);
    log?.info?.(`octo: [THREAD.md] updated cache to v${apiData.version} for thread ${groupNo}/${shortId}`);
  }
}

/**
 * Update thread THREAD.md disk cache (called after tool updates).
 */
export function broadcastThreadMdUpdate(params: {
  accountId: string;
  groupNo: string;
  shortId: string;
  content: string;
  version: number;
}): void {
  const { accountId, groupNo, shortId, content, version } = params;
  const meta: GroupMdMeta = {
    version,
    updated_at: new Date().toISOString(),
    updated_by: "event",
    fetched_at: new Date().toISOString(),
    account_id: accountId,
  };
  try {
    writeThreadMdToDisk({ accountId, groupNo, shortId, content, meta });
    console.error(`[octo] broadcastThreadMdUpdate: updated disk cache thread=${groupNo}/${shortId} v=${version}`);
  } catch (err) {
    console.error(`[octo] broadcastThreadMdUpdate failed for thread=${groupNo}/${shortId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- Test helpers (exported for unit tests) ---

export function _testGetGroupAccountMap(): Map<string, string> {
  return _groupAccountMap;
}

export function _testGetCheckedGroups(): Set<string> {
  return _checkedGroups;
}

export function _testGetCheckedThreads(): Set<string> {
  return _checkedThreads;
}

export function _testReset(): void {
  _groupAccountMap.clear();
  _checkedGroups.clear();
  _groupMdCache.clear();
  _allBotGroupIds.clear();
  _checkedThreads.clear();
}
