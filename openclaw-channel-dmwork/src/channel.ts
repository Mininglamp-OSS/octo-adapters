import {
  DEFAULT_ACCOUNT_ID,
  type ChannelOutboundContext,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import type { OpenClawConfig, ChannelMessageActionAdapter } from "openclaw/plugin-sdk";
import { DmworkConfigJsonSchema } from "./config-schema.js";
import {
  listDmworkAccountIds,
  resolveDefaultDmworkAccountId,
  resolveDmworkAccount,
  type ResolvedDmworkAccount,
} from "./accounts.js";
import { registerBot, sendMessage, sendHeartbeat, sendMediaMessage, inferContentType, ensureTextCharset, fetchBotGroups, getGroupMd, parseImageDimensions, parseImageDimensionsFromFile, getUploadCredentials, uploadFileToCOS } from "./api-fetch.js";
import { WKSocket } from "./socket.js";
import { handleInboundMessage, type DmworkStatusSink } from "./inbound.js";
import { ChannelType, MessageType, type BotMessage, type MessagePayload } from "./types.js";
import { buildEntitiesFromFallback, parseStructuredMentions, convertStructuredMentions } from "./mention-utils.js";
import type { MentionEntity } from "./types.js";
import { handleDmworkMessageAction, parseTarget } from "./actions.js";
import { createDmworkManagementTools } from "./agent-tools.js";
import { getOrCreateGroupMdCache, registerBotGroupIds, getKnownGroupIds } from "./group-md.js";
import { registerOwnerUid } from "./owner-registry.js";
import { preloadGroupMemberCache, getGroupMembersFromCache } from "./member-cache.js";
import path from "node:path";
import os from "node:os";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
// HistoryEntry type - compatible with any version
type HistoryEntry = { sender: string; body: string; timestamp: number };
const DEFAULT_GROUP_HISTORY_LIMIT = 20;

const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB
const UPLOAD_TEMP_DIR = path.join("/tmp", "dmwork-upload");

/** Download a URL to a temp file with backpressure, return the temp path. */
async function downloadToTempFile(url: string, filename: string, signal?: AbortSignal): Promise<{ tempPath: string; contentType: string | undefined }> {
  await mkdir(UPLOAD_TEMP_DIR, { recursive: true });
  const tempPath = path.join(UPLOAD_TEMP_DIR, `${randomUUID()}-${filename}`);

  // HEAD to check size first
  const head = await fetch(url, { method: "HEAD", signal: signal ?? AbortSignal.timeout(30_000) });
  const contentLength = Number(head.headers.get("content-length") || 0);
  if (contentLength > MAX_UPLOAD_SIZE) {
    throw new Error(`File too large (${contentLength} bytes, max ${MAX_UPLOAD_SIZE})`);
  }

  const resp = await fetch(url, { signal: signal ?? AbortSignal.timeout(300_000) });
  if (!resp.ok) throw new Error(`Failed to download media from ${url}: ${resp.status}`);
  const contentType = resp.headers.get("content-type") ?? undefined;

  const body = resp.body;
  if (!body) throw new Error(`No response body from ${url}`);
  const nodeStream = Readable.fromWeb(body as any);
  const ws = createWriteStream(tempPath);
  try {
    await pipeline(nodeStream, ws);
  } catch (err) {
    // Cleanup partial temp file on download failure
    await unlink(tempPath).catch(() => {});
    throw err;
  }
  return { tempPath, contentType };
}

/** Cleanup old temp upload files (>1h). Called opportunistically. */
async function cleanupOldUploadTempFiles(): Promise<void> {
  try {
    const { readdir, stat, unlink: rm } = await import("node:fs/promises");
    const files = await readdir(UPLOAD_TEMP_DIR);
    const now = Date.now();
    for (const f of files) {
      const fp = path.join(UPLOAD_TEMP_DIR, f);
      const st = await stat(fp).catch(() => null);
      if (st && now - st.mtimeMs > 3600_000) await rm(fp).catch(() => {});
    }
  } catch { /* dir may not exist */ }
}

// Module-level history storage — survives auto-restarts
const _historyMaps = new Map<string, Map<string, any[]>>();
function getOrCreateHistoryMap(accountId: string): Map<string, any[]> {
  let m = _historyMaps.get(accountId);
  if (!m) {
    m = new Map<string, any[]>();
    _historyMaps.set(accountId, m);
  }
  return m;
}

// Module-level member mapping: displayName -> uid
// Used to resolve @mentions in AI replies
const _memberMaps = new Map<string, Map<string, string>>();
export function getOrCreateMemberMap(accountId: string): Map<string, string> {
  let m = _memberMaps.get(accountId);
  if (!m) {
    m = new Map<string, string>();
    _memberMaps.set(accountId, m);
  }
  return m;
}

// Module-level reverse mapping: uid -> displayName
// Used to show display names instead of uids in replies
const _uidToNameMaps = new Map<string, Map<string, string>>();
export function getOrCreateUidToNameMap(accountId: string): Map<string, string> {
  let m = _uidToNameMaps.get(accountId);
  if (!m) {
    m = new Map<string, string>();
    _uidToNameMaps.set(accountId, m);
  }
  return m;
}

// Group member cache timestamps: groupId -> lastFetchedAt (ms)
const _groupCacheTimestamps = new Map<string, Map<string, number>>();
function getOrCreateGroupCacheTimestamps(accountId: string): Map<string, number> {
  let m = _groupCacheTimestamps.get(accountId);
  if (!m) {
    m = new Map<string, number>();
    _groupCacheTimestamps.set(accountId, m);
  }
  return m;
}


// --- Group → Account mapping: tracks which accounts are active in each group ---
// Used by handleAction to resolve the correct account when framework passes wrong accountId
// A group may have multiple bots (1:N), so we store a Set of accountIds per group.
const _groupToAccounts = new Map<string, Set<string>>(); // groupNo → Set of accountIds

export function registerGroupToAccount(groupNo: string, accountId: string): void {
  let s = _groupToAccounts.get(groupNo);
  if (!s) { s = new Set(); _groupToAccounts.set(groupNo, s); }
  s.add(accountId);
}

/**
 * Resolve the correct accountId for a group.
 * - If the group has exactly one registered account → return it (safe to correct).
 * - If the group has multiple accounts (shared group) → return undefined (don't override).
 * - If the group is unknown → return undefined.
 */
export function resolveAccountForGroup(groupNo: string): string | undefined {
  const s = _groupToAccounts.get(groupNo);
  if (!s || s.size !== 1) return undefined;
  return s.values().next().value;
}

/** Check if a specific accountId is registered for a group. */
export function isAccountRegisteredForGroup(groupNo: string, accountId: string): boolean {
  return _groupToAccounts.get(groupNo)?.has(accountId) ?? false;
}

// --- Cache cleanup: evict groups inactive for >4 hours ---
const CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const CACHE_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const _cacheActivity = new Map<string, Map<string, number>>();

function touchCache(accountId: string, groupId: string): void {
  let m = _cacheActivity.get(accountId);
  if (!m) { m = new Map(); _cacheActivity.set(accountId, m); }
  m.set(groupId, Date.now());
}

function cleanupStaleCaches(): void {
  const cutoff = Date.now() - CACHE_MAX_AGE_MS;
  for (const [accountId, activityMap] of _cacheActivity) {
    for (const [groupId, lastAccess] of activityMap) {
      if (lastAccess < cutoff) {
        _historyMaps.get(accountId)?.delete(groupId);
        _memberMaps.get(accountId)?.delete(groupId);
        // Note: uidToNameMap is a flat uid→name map (not keyed by groupId),
        // so we don't delete from it here — names remain valid across groups.
        _groupCacheTimestamps.get(accountId)?.delete(groupId);
        activityMap.delete(groupId);
      }
    }
    if (activityMap.size === 0) _cacheActivity.delete(accountId);
  }
}

// Known bot robot_ids across all accounts — for bot-to-bot loop prevention
const _knownBotUids = new Set<string>();

// Singleton timer to prevent accumulation during hot reload (#54)
let _cleanupTimer: NodeJS.Timeout | null = null;

function ensureCleanupTimer(): void {
  if (_cleanupTimer) return; // Already running
  _cleanupTimer = setInterval(cleanupStaleCaches, CACHE_CLEANUP_INTERVAL_MS);
  if (typeof _cleanupTimer === "object" && _cleanupTimer && "unref" in _cleanupTimer) {
    _cleanupTimer.unref();
  }
}

async function checkForUpdates(
  apiUrl: string,
  log?: { info?: (msg: string) => void; error?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<void> {
  try {
    // Check npm version
    const localVersion = (await import("../package.json", { with: { type: "json" } })).default.version;
    const resp = await fetch("https://registry.npmjs.org/openclaw-channel-dmwork/latest");
    if (resp.ok) {
      const data = await resp.json() as { version?: string };
      if (data.version && data.version !== localVersion) {
        log?.info?.(`dmwork: new version available: ${data.version} (current: ${localVersion}). Run: npm install openclaw-channel-dmwork@latest`);
      }
    }
  } catch (err) {
    log?.error?.(`dmwork: version check failed: ${String(err)}`);
  }

  try {
    // Fetch skill.md
    const skillResp = await fetch(`${apiUrl.replace(/\/+$/, "")}/v1/bot/skill.md`);
    if (skillResp.ok) {
      const skillContent = await skillResp.text();
      const skillDir = path.join(os.homedir(), ".openclaw", "skills", "dmwork");
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, "SKILL.md"), skillContent, "utf-8");
      log?.info?.("dmwork: updated SKILL.md");
    }
  } catch (err) {
    log?.error?.(`dmwork: skill.md fetch failed: ${String(err)}`);
  }
}

/** Resolve correct accountId for outbound context using group→account mapping */
export function resolveOutboundAccountId(ctxTo: string, fallbackAccountId: string): string {
  let targetForParse = ctxTo;
  if (ctxTo.startsWith("group:")) {
    const groupPart = ctxTo.slice(6);
    const atIdx = groupPart.indexOf("@");
    if (atIdx >= 0) targetForParse = "group:" + groupPart.slice(0, atIdx);
  }
  const { channelId, channelType } = parseTarget(targetForParse, undefined, getKnownGroupIds());
  if (channelType === ChannelType.Group) {
    const correctAccountId = resolveAccountForGroup(channelId);
    if (correctAccountId) return correctAccountId;
  }
  return fallbackAccountId;
}

/** Shared check: return available actions if at least one account is configured, else empty. */
function getAvailableActions(cfg: any): string[] {
  try {
    const ids = listDmworkAccountIds(cfg);
    const hasConfigured = ids.some((id) => {
      const acct = resolveDmworkAccount({ cfg, accountId: id });
      return acct.enabled && acct.configured && !!acct.config.botToken;
    });
    if (!hasConfigured) return [];
  } catch {
    return [];
  }
  return ["send", "read", "search"];
}

const meta = {
  id: "dmwork",
  label: "DMWork",
  selectionLabel: "DMWork (WuKongIM)",
  docsPath: "/channels/dmwork",
  docsLabel: "dmwork",
  blurb: "WuKongIM gateway for DMWork",
  order: 90,
};

export const dmworkPlugin: ChannelPlugin<ResolvedDmworkAccount> = {
  id: "dmwork",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: true,
  },
  reload: { configPrefixes: ["channels.dmwork"] },
  actions: {
    listActions: ({ cfg }: { cfg: any }) => {
      const actions = getAvailableActions(cfg);
      return actions as any; // TODO: remove when SDK types support this
    },
    describeMessageTool: ({ cfg }: { cfg: any }) => {
      const actions = getAvailableActions(cfg);
      if (actions.length === 0) return null;
      return { actions, capabilities: [] };
    },
    extractToolSend: ({ args }: { args: Record<string, unknown> }) => {
      const target = args.target as string | undefined;
      return target ? { target } : {};
    },
    handleAction: async (ctx: any) => {
      // Resolve correct accountId: framework may pass wrong one when agent has multiple accounts.
      // Use currentChannelId to look up which account actually owns the group.
      // When multiple bots share the same group, do NOT correct — the caller's accountId is authoritative.
      let accountId = ctx.accountId ?? DEFAULT_ACCOUNT_ID;
      const currentChannelId = ctx.toolContext?.currentChannelId;
      if (currentChannelId) {
        const rawGroupNo = currentChannelId.replace(/^dmwork:/, '');
        // Only correct if current accountId is NOT registered for this group
        // (i.e., framework passed a clearly wrong accountId).
        // For shared groups (multiple bots), don't override — respect framework's choice.
        if (!isAccountRegisteredForGroup(rawGroupNo, accountId)) {
          const correctAccountId = resolveAccountForGroup(rawGroupNo);
          if (correctAccountId) {
            ctx.log?.info?.(`dmwork: handleAction accountId corrected: ${accountId} → ${correctAccountId} (group=${rawGroupNo})`);
            accountId = correctAccountId;
          }
        }
      }
      const account = resolveDmworkAccount({
        cfg: ctx.cfg,
        accountId,
      });
      if (!account.config.botToken) {
        return { ok: false, error: "DMWork botToken is not configured" };
      }
      const memberMap = getOrCreateMemberMap(accountId);
      const uidToNameMap = getOrCreateUidToNameMap(accountId);
      const groupMdCache = getOrCreateGroupMdCache(accountId);
      return handleDmworkMessageAction({
        action: ctx.action,
        args: ctx.params ?? {},
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken,
        memberMap,
        uidToNameMap,
        groupMdCache,
        currentChannelId: ctx.toolContext?.currentChannelId ?? undefined,
        requesterSenderId: ctx.requesterSenderId ?? undefined,
        accountId,
        log: ctx.log,
      });
    },
  } as any, // TODO: remove when SDK types support this
  agentTools: (params: { cfg?: any }) => createDmworkManagementTools(params),
  agentPrompt: {
    messageToolHints: ({ cfg, accountId }: { cfg: any; accountId?: string | null }) => {
      if (!accountId) return [];
      return [
        `IMPORTANT: Your DMWork accountId is "${accountId}". You MUST always pass accountId: "${accountId}" when using the dmwork_management tool. Do NOT use any other accountId.`,
        `For sending messages: if the target is a group, use target="group:<groupId>". If the target is a specific user (1v1 direct message), use target="user:<userId>". If sending to the current conversation, no prefix is needed.`,
        `For reading message history: use action="read" with target="user:<uid>" to read DM history, or target="group:<groupId>" to read group message history. Cross-channel queries require the requester to be a participant of the target channel.`,
        `For searching: use action="search" with query="shared-groups" to find groups that the bot and the current user both belong to.`,
      ];
    },
  },
  configSchema: DmworkConfigJsonSchema,
  config: {
    listAccountIds: (cfg) => listDmworkAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveDmworkAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultDmworkAccountId(cfg) ?? listDmworkAccountIds(cfg)[0] ?? DEFAULT_ACCOUNT_ID,
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      apiUrl: account.config.apiUrl,
      botToken: account.config.botToken ? "[set]" : "[missing]",
      wsUrl: account.config.wsUrl ?? "[auto-detect]",
    }),
  },
  messaging: {
    normalizeTarget: (target) => target.trim(),
    targetResolver: {
      looksLikeId: (input) => Boolean(input.trim()),
      hint: "<userId or channelId>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async (ctx) => {
      // Resolve correct accountId — framework may pass wrong one for multi-bot setups
      const accountId = resolveOutboundAccountId(
        ctx.to,
        ctx.accountId ?? DEFAULT_ACCOUNT_ID,
      );
      const account = resolveDmworkAccount({
        cfg: ctx.cfg as OpenClawConfig,
        accountId,
      });
      if (!account.config.botToken) {
        throw new Error("DMWork botToken is not configured");
      }
      const content = ctx.text?.trim();
      if (!content) {
        return { channel: "dmwork", to: ctx.to, messageId: "" };
      }

      // Parse target using shared parseTarget + knownGroupIds
      let mentionUids: string[] = [];
      let targetForParse = ctx.to;

      // Handle "group:channel_id@uid1,uid2" format — extract inline mention UIDs
      if (ctx.to.startsWith("group:")) {
        const groupPart = ctx.to.slice(6);
        const atIdx = groupPart.indexOf("@");
        if (atIdx >= 0) {
          targetForParse = "group:" + groupPart.slice(0, atIdx);
          mentionUids = groupPart.slice(atIdx + 1).split(",").filter(Boolean);
        }
      }

      const { channelId, channelType } = parseTarget(targetForParse, undefined, getKnownGroupIds());

      let mentionEntities: MentionEntity[] = [];
      let finalContent = content;

      if (channelType === ChannelType.Group) {
        const accountMemberMap = getOrCreateMemberMap(accountId);
        const uidToNameMap = getOrCreateUidToNameMap(accountId);

        // v2 path: convert @[uid:name] → @name + entities
        const structuredMentions = parseStructuredMentions(finalContent);
        if (structuredMentions.length > 0) {
          const validUids = new Set(uidToNameMap.keys());
          const converted = convertStructuredMentions(finalContent, structuredMentions, validUids);
          finalContent = converted.content;
          mentionEntities = [...converted.entities];
          for (const uid of converted.uids) {
            if (!mentionUids.includes(uid)) {
              mentionUids.push(uid);
            }
          }
        }

        // v1 fallback: resolve remaining @name via memberMap
        const { entities, uids } = buildEntitiesFromFallback(finalContent, accountMemberMap);
        const existingOffsets = new Set(mentionEntities.map(e => e.offset));
        for (const entity of entities) {
          if (!existingOffsets.has(entity.offset)) {
            mentionEntities.push(entity);
          }
        }
        for (const uid of uids) {
          if (!mentionUids.includes(uid)) {
            mentionUids.push(uid);
          }
        }
      }

      // Detect @all/@所有人 in content
      const hasAtAll = /(?:^|(?<=\s))@(?:all|所有人)(?=\s|[^\w]|$)/i.test(finalContent);

      await sendMessage({
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken,
        channelId,
        channelType,
        content: finalContent,
        ...(mentionUids.length > 0 ? { mentionUids } : {}),
        ...(mentionEntities.length > 0 ? { mentionEntities } : {}),
        mentionAll: hasAtAll || undefined,
      });

      return { channel: "dmwork", to: ctx.to, messageId: "" };
    },
    sendMedia: async (ctx) => {
      // Resolve correct accountId — framework may pass wrong one for multi-bot setups
      const accountId = resolveOutboundAccountId(
        ctx.to,
        ctx.accountId ?? DEFAULT_ACCOUNT_ID,
      );
      const account = resolveDmworkAccount({
        cfg: ctx.cfg as OpenClawConfig,
        accountId,
      });
      if (!account.config.botToken) {
        throw new Error("DMWork botToken is not configured");
      }

      const mediaUrl = ctx.mediaUrl;
      if (!mediaUrl) {
        throw new Error("sendMedia called without mediaUrl");
      }

      // 1. Resolve file — stream-based for HTTP/file paths, Buffer for data URIs
      let fileBody: Buffer | NodeJS.ReadableStream;
      let fileSize: number;
      let contentType: string | undefined;
      let filename: string;
      let tempPath: string | undefined; // temp file we created (will be cleaned up)
      let localFilePath: string | undefined; // path for parseImageDimensionsFromFile

      // Opportunistic cleanup of stale temp files
      cleanupOldUploadTempFiles().catch(() => {});

      if (mediaUrl.startsWith("data:")) {
        // Parse data URI: data:[<mediatype>][;base64],<data>
        const match = mediaUrl.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/);
        if (!match) {
          throw new Error("Invalid data URI format");
        }
        contentType = match[1] || "application/octet-stream";
        const buf = Buffer.from(match[2], "base64");
        fileBody = buf;
        fileSize = buf.length;
        // Generate a reasonable filename from MIME type
        const extMap: Record<string, string> = {
          "text/markdown": ".md", "text/plain": ".txt", "application/pdf": ".pdf",
          "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
          "application/json": ".json", "application/zip": ".zip",
          "audio/mpeg": ".mp3", "video/mp4": ".mp4",
        };
        const ext = extMap[contentType] || ".bin";
        filename = `file${ext}`;
        // If OpenClaw provides a filename hint via ctx, prefer it
        if ((ctx as Record<string, unknown>).filename) {
          filename = String((ctx as Record<string, unknown>).filename);
        }
      } else if (mediaUrl.startsWith("file://")) {
        const filePath = decodeURIComponent(mediaUrl.slice(7));
        const st = statSync(filePath);
        if (st.size > MAX_UPLOAD_SIZE) {
          throw new Error(`File too large (${st.size} bytes, max ${MAX_UPLOAD_SIZE})`);
        }
        localFilePath = filePath;
        fileBody = createReadStream(filePath);
        fileSize = st.size;
        filename = path.basename(filePath);
        contentType = inferContentType(filename);
      } else {
        // HTTP(S) URL — stream download to temp file to avoid buffering in memory
        const urlPath = new URL(mediaUrl).pathname;
        filename = path.basename(urlPath) || "file";
        const dl = await downloadToTempFile(mediaUrl, filename);
        tempPath = dl.tempPath;
        localFilePath = dl.tempPath;
        contentType = dl.contentType;
        if (!contentType || contentType === "application/octet-stream") contentType = inferContentType(filename);
        const st = statSync(tempPath);
        fileBody = createReadStream(tempPath);
        fileSize = st.size;
      }

      contentType = contentType || "application/octet-stream";

      try {
        // 2. Upload to COS via STS credentials (stream mode)
        const creds = await getUploadCredentials({
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken,
          filename,
        });
        const { url: cdnUrl } = await uploadFileToCOS({
          credentials: creds.credentials,
          startTime: creds.startTime,
          expiredTime: creds.expiredTime,
          bucket: creds.bucket,
          region: creds.region,
          key: creds.key,
          fileBody,
          fileSize,
          contentType: ensureTextCharset(contentType),
          cdnBaseUrl: creds.cdnBaseUrl,
        });

        // 3. Parse target using shared parseTarget + knownGroupIds
        let targetForParse = ctx.to;
        if (ctx.to.startsWith("group:")) {
          const groupPart = ctx.to.slice(6);
          const atIdx = groupPart.indexOf("@");
          if (atIdx >= 0) targetForParse = "group:" + groupPart.slice(0, atIdx);
        }
        const { channelId, channelType } = parseTarget(targetForParse, undefined, getKnownGroupIds());

        // 4. Determine message type and send
        const msgType = contentType.startsWith("image/")
          ? MessageType.Image
          : MessageType.File;

        if (msgType === MessageType.Image) {
          // For images, parse dimensions from file or buffer
          const dims = localFilePath
            ? await parseImageDimensionsFromFile(localFilePath, contentType)
            : Buffer.isBuffer(fileBody)
              ? parseImageDimensions(fileBody, contentType)
              : null;
          await sendMediaMessage({
            apiUrl: account.config.apiUrl,
            botToken: account.config.botToken,
            channelId,
            channelType,
            type: msgType,
            url: cdnUrl,
            width: dims?.width,
            height: dims?.height,
          });
        } else {
          await sendMediaMessage({
            apiUrl: account.config.apiUrl,
            botToken: account.config.botToken,
            channelId,
            channelType,
            type: msgType,
            url: cdnUrl,
            name: filename,
            size: fileSize,
          });
        }
      } finally {
        // Cleanup temp file
        if (tempPath) await unlink(tempPath).catch(() => {});
      }

      return { channel: "dmwork", to: ctx.to, messageId: "" };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      apiUrl: account.config.apiUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      // Ensure cleanup timer is running (singleton pattern for hot reload safety)
      ensureCleanupTimer();

      const account = ctx.account;
      if (!account.configured || !account.config.botToken) {
        throw new Error(
          `DMWork not configured for account "${account.accountId}" (missing botToken)`,
        );
      }

      const log = ctx.log;
      const statusSink: DmworkStatusSink = (patch) =>
        ctx.setStatus({ accountId: account.accountId, ...patch });

      log?.info?.(`[${account.accountId}] registering DMWork bot...`);

      // 1. Register bot (first attempt uses cached token)
      let credentials: {
        robot_id: string;
        im_token: string;
        ws_url: string;
        owner_uid: string;
      };
      try {
        credentials = await registerBot({
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log?.error?.(`dmwork: bot registration failed: ${message}`);
        statusSink({ lastError: message });
        throw err;
      }

      // Track this bot's uid for bot-to-bot loop prevention
      _knownBotUids.add(credentials.robot_id);

      // Register owner_uid for permission checks
      if (credentials.owner_uid) {
        registerOwnerUid(account.accountId, credentials.owner_uid);
      }

      log?.info?.(
        `[${account.accountId}] bot registered as ${credentials.robot_id}`,
      );

      // Check for updates in background (fire-and-forget)
      checkForUpdates(account.config.apiUrl, log).catch(() => {});

      // Preload member cache for cross-session permission checks (fire-and-forget)
      preloadGroupMemberCache({
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken!,
        log,
      }).catch(() => {});

      // Prefetch GROUP.md and group members for all groups (fire-and-forget)
      const groupMdCache = getOrCreateGroupMdCache(account.accountId);
      (async () => {
        try {
          const groups = await fetchBotGroups({ apiUrl: account.config.apiUrl, botToken: account.config.botToken!, log });
          registerBotGroupIds(groups.map(g => g.group_no));
          let mdCount = 0;
          let memberCount = 0;
          for (const g of groups) {
            // Register group → account mapping for outbound accountId resolution
            registerGroupToAccount(g.group_no, account.accountId);

            // Prefetch GROUP.md
            try {
              const md = await getGroupMd({ apiUrl: account.config.apiUrl, botToken: account.config.botToken!, groupNo: g.group_no, log });
              if (md.content) {
                groupMdCache.set(g.group_no, { content: md.content, version: md.version });
                mdCount++;
              }
            } catch {
              // Ignore per-group failures (group may not have GROUP.md)
            }
            // Prefetch group members → fill uidToNameMap for SenderName resolution
            // Uses cache so preloadGroupMemberCache() results are reused
            try {
              const members = await getGroupMembersFromCache({ apiUrl: account.config.apiUrl, botToken: account.config.botToken!, groupNo: g.group_no, log });
              const prefetchMemberMap = getOrCreateMemberMap(account.accountId);
              const prefetchUidMap = getOrCreateUidToNameMap(account.accountId);
              for (const m of members) {
                if (m.uid && m.name) {
                  prefetchMemberMap.set(m.name, m.uid);
                  prefetchUidMap.set(m.uid, m.name);
                  memberCount++;
                }
              }
            } catch {
              // Ignore per-group failures
            }
          }
          if (mdCount > 0) {
            log?.info?.(`dmwork: prefetched GROUP.md for ${mdCount} groups`);
          }
          if (memberCount > 0) {
            log?.info?.(`dmwork: prefetched ${memberCount} member names from ${groups.length} groups`);
          }
        } catch (err) {
          log?.error?.(`dmwork: group prefetch failed: ${String(err)}`);
        }
      })();

      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });

      // 2. Resolve WebSocket URL
      const wsUrl = account.config.wsUrl || credentials.ws_url;

      // 3. Start heartbeat timer
      let heartbeatTimer: NodeJS.Timeout | null = null;
      let stopped = false;

      const startHeartbeat = () => {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        heartbeatTimer = setInterval(() => {
          if (stopped) return;
          sendHeartbeat({
            apiUrl: account.config.apiUrl,
            botToken: account.config.botToken!,
          }).then(() => {
            consecutiveHeartbeatFailures = 0; // Reset on success
          }).catch(async (err) => {
            consecutiveHeartbeatFailures++;
            log?.error?.(`dmwork: [${account.accountId}] heartbeat failed (${consecutiveHeartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): ${String(err)}`);
            if (consecutiveHeartbeatFailures >= MAX_HEARTBEAT_FAILURES && !stopped) {
              log?.warn?.(`dmwork: [${account.accountId}] too many heartbeat failures, triggering reconnect...`);
              consecutiveHeartbeatFailures = 0;
              if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
              const backoffMs = 3000 + Math.floor(Math.random() * 2000);
              await new Promise(r => setTimeout(r, backoffMs));
              if (stopped) return;
              await socket.disconnectAndWait();
              socket.stopReconnectTimer();
              socket.connect();
            }
          });
        }, account.config.heartbeatIntervalMs);
      };

      // 4. Group history map — persists across auto-restarts (module-level)
      const groupHistories = getOrCreateHistoryMap(account.accountId);
      
      // 4b. Member name->uid map — for resolving @mentions in replies
      const memberMap = getOrCreateMemberMap(account.accountId);
      
      // 4c. Reverse map uid->name — for showing display names in replies
      const uidToNameMap = getOrCreateUidToNameMap(account.accountId);
      
      // 4d. Group cache timestamps — track when each group's members were last fetched
      const groupCacheTimestamps = getOrCreateGroupCacheTimestamps(account.accountId);

      // 5. Token refresh state — time-based cooldown to prevent refresh storms
      let lastTokenRefreshAt = 0;
      const TOKEN_REFRESH_COOLDOWN_MS = 60_000; // 60 seconds
      let isRefreshingToken = false; // Guard against concurrent refreshes (#43)

      // 5b. Cooldown reconnect timer — deduplicate to prevent self-kick storms (#139)
      let cooldownReconnectTimer: ReturnType<typeof setTimeout> | null = null;

      // 5c. Heartbeat failure tracking — reconnect after consecutive failures (#42)
      let consecutiveHeartbeatFailures = 0;
      const MAX_HEARTBEAT_FAILURES = 3;

      // 6. Connect WebSocket — pure real-time via WuKongIM SDK
      const socket = new WKSocket({
        wsUrl,
        uid: credentials.robot_id,
        token: credentials.im_token,

        onMessage: (msg: BotMessage) => {
          // Allow structured event messages (e.g. group_md_updated) even from self/bots
          const isEvent = !!(msg.payload as any)?.event?.type; // TODO: remove when SDK types support this
          if (msg.payload?.type === 1 && (msg.payload as any)?.event) { // TODO: remove when SDK types support this
          }
          // Skip self messages (but not events — bot needs to know about its own GROUP.md updates)
          if (msg.from_uid === credentials.robot_id && !isEvent) return;
          // Skip messages from any other bot in this plugin instance (prevent bot-to-bot loops)
          // But allow group messages through — bot-to-bot @mention in groups is legitimate;
          // mention gating in inbound.ts ensures only @-targeted messages trigger AI.
          // Also allow event messages (e.g. group_md_updated) from any source.
          if (_knownBotUids.has(msg.from_uid) && msg.channel_type === ChannelType.DM && !isEvent) return;
          // Skip unsupported message types (Location, Card), but allow event messages through
          const supportedTypes = [MessageType.Text, MessageType.Image, MessageType.GIF, MessageType.Voice, MessageType.Video, MessageType.File, MessageType.MultipleForward];
          if (!msg.payload || (!supportedTypes.includes(msg.payload.type) && !isEvent)) return;

          // Defense-in-depth DM filter (kept for safety, though v0.2.28+ uses independent
          // WebSocket connections per bot so server-side routing is already correct).
          // WuKongIM DM channel_id is typically "uid1@uid2", but may also be a plain uid
          // when channel_type === 1 without '@'. The plain-uid case needs no extra filter
          // since each bot has its own WS connection.
          if (msg.channel_type === ChannelType.DM && msg.channel_id && msg.channel_id.includes("@")) {
            const parts = msg.channel_id.split("@");
            if (!parts.includes(credentials.robot_id)) {
              log?.info?.(
                `dmwork: [${account.accountId}] skipping DM not for this bot: channel=${msg.channel_id} bot=${credentials.robot_id}`,
              );
              return;
            }
          }

          log?.info?.(
            `dmwork: [${account.accountId}] recv message from=${msg.from_uid} channel=${msg.channel_id ?? "DM"} type=${msg.channel_type ?? 1}`,
          );

          // Track cache activity for cleanup
          if (msg.channel_id) {
            touchCache(account.accountId, msg.channel_id);
            if (msg.channel_type === ChannelType.Group) {
              registerGroupToAccount(msg.channel_id, account.accountId);
            }
          }

          handleInboundMessage({
            account,
            message: msg,
            botUid: credentials.robot_id,
            groupHistories,
            memberMap,
            uidToNameMap,
            groupCacheTimestamps,
            groupMdCache,
            log,
            statusSink,
          }).catch((err) => {
            log?.error?.(`dmwork: inbound handler failed: ${err instanceof Error ? err.stack ?? String(err) : String(err)}`);
          });
        },

        onConnected: () => {
          log?.info?.(`dmwork: [${account.accountId}] WebSocket connected to ${wsUrl}`);
          statusSink({ lastError: null });
          consecutiveHeartbeatFailures = 0;
          startHeartbeat();
        },

        onDisconnected: () => {
          log?.warn?.(`dmwork: [${account.accountId}] WebSocket disconnected, will reconnect...`);
          if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
          statusSink({ lastError: "disconnected" });
        },

        onError: async (err: Error) => {
          log?.error?.(`dmwork: [${account.accountId}] WebSocket error: ${err.message}`);
          statusSink({ lastError: err.message });

          // If kicked or connect failed, try refreshing the IM token with a cooldown
          // to prevent refresh storms (e.g. 9000+ refreshes across 11 bots).
          // Use isRefreshingToken to prevent concurrent refresh attempts (#43)
          const cooldownElapsed = Date.now() - lastTokenRefreshAt > TOKEN_REFRESH_COOLDOWN_MS;
          if (cooldownElapsed && !isRefreshingToken && !stopped &&
              (err.message.includes("Kicked") || err.message.includes("Connect failed"))) {
            isRefreshingToken = true;
            lastTokenRefreshAt = Date.now();
            log?.warn?.(`dmwork: [${account.accountId}] connection rejected — refreshing IM token...`);
            try {
              await socket.disconnectAndWait();
              const fresh = await registerBot({
                apiUrl: account.config.apiUrl,
                botToken: account.config.botToken!,
                forceRefresh: true,
              });
              credentials = fresh;
              log?.info?.(`dmwork: [${account.accountId}] got fresh IM token, reconnecting WS...`);
              socket.updateCredentials(fresh.robot_id, fresh.im_token);
              // Stagger reconnect to avoid thundering herd when multiple bots
              // refresh tokens simultaneously after server-wide token expiry
              const staggerMs = Math.floor(Math.random() * 5000);
              log?.info?.(`dmwork: [${account.accountId}] staggering reconnect by ${staggerMs}ms`);
              await new Promise(r => setTimeout(r, staggerMs));
              if (stopped) return; // account was stopped during stagger delay
              socket.connect();
            } catch (refreshErr) {
              log?.error?.(`dmwork: [${account.accountId}] token refresh failed: ${String(refreshErr)}`);
              // Keep cooldown active even on failure to prevent rapid retry hammering
            } finally {
              isRefreshingToken = false;
            }
          } else if (!isRefreshingToken && !stopped &&
              (err.message.includes("Kicked") || err.message.includes("Connect failed"))) {
            // Cooldown active — skip token refresh but still reconnect with current credentials.
            // Deduplicate: clear any pending cooldown reconnect timer to prevent self-kick storms
            // where multiple setTimeout callbacks fire simultaneously, each calling connect(),
            // causing the same bot to have multiple WS connections that kick each other (#139).
            if (cooldownReconnectTimer) {
              clearTimeout(cooldownReconnectTimer);
            }
            log?.warn?.(`dmwork: [${account.accountId}] cooldown active, scheduling reconnect with current credentials...`);
            const backoffMs = 5000 + Math.floor(Math.random() * 5000);
            cooldownReconnectTimer = setTimeout(async () => {
              cooldownReconnectTimer = null;
              if (!stopped) {
                await socket.disconnectAndWait();
                socket.stopReconnectTimer();
                socket.connect();
              }
            }, backoffMs);
          }
        },
      });

      socket.connect();

      // Keep Promise pending until stopped — gateway treats resolve as "account stopped"
      return new Promise((resolve) => {
        const cleanup = () => {
          if (stopped) return;
          stopped = true;
          socket.disconnect();
          if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
          if (cooldownReconnectTimer) { clearTimeout(cooldownReconnectTimer); cooldownReconnectTimer = null; }
          ctx.setStatus({
            accountId: account.accountId,
            running: false,
            lastStopAt: Date.now(),
          });
          resolve({
            stop: () => { /* already cleaned up */ },
          });
        };

        if (ctx.abortSignal.aborted) {
          cleanup();
        } else {
          ctx.abortSignal.addEventListener("abort", cleanup, { once: true });
        }
      });
    },
  },
};
