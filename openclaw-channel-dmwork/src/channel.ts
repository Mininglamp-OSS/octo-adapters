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
import { registerBot, sendMessage, sendHeartbeat, uploadFile, sendMediaMessage, inferContentType, fetchBotGroups, getGroupMd, parseImageDimensions, getUploadCredentials, uploadFileToCOS } from "./api-fetch.js";
import { WKSocket } from "./socket.js";
import { handleInboundMessage, type DmworkStatusSink } from "./inbound.js";
import { ChannelType, MessageType, type BotMessage, type MessagePayload } from "./types.js";
import { parseMentions } from "./mention-utils.js";
import { handleDmworkMessageAction, parseTarget } from "./actions.js";
import { createDmworkManagementTools } from "./agent-tools.js";
import { getOrCreateGroupMdCache, registerBotGroupIds, getKnownGroupIds } from "./group-md.js";
import path from "path";
import os from "os";
import { mkdir, readFile, writeFile } from "fs/promises";
// HistoryEntry type - compatible with any version
type HistoryEntry = { sender: string; body: string; timestamp: number };
const DEFAULT_GROUP_HISTORY_LIMIT = 20;

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


// --- Group → Account mapping: tracks which account each group was received from ---
// Used by handleAction to resolve the correct account when framework passes wrong accountId
const _groupToAccount = new Map<string, string>(); // groupNo → accountId

export function registerGroupToAccount(groupNo: string, accountId: string): void {
  _groupToAccount.set(groupNo, accountId);
}

export function resolveAccountForGroup(groupNo: string): string | undefined {
  return _groupToAccount.get(groupNo);
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
        _uidToNameMaps.get(accountId)?.delete(groupId);
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
    threads: false,
  },
  reload: { configPrefixes: ["channels.dmwork"] },
  actions: {
    listActions: ({ cfg }: { cfg: any }) => {
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
      return ["send", "read"] as any; // TODO: remove when SDK types support this
    },
    extractToolSend: ({ args }: { args: Record<string, unknown> }) => {
      const target = args.target as string | undefined;
      return target ? { target } : {};
    },
    handleAction: async (ctx: any) => {
      // Resolve correct accountId: framework may pass wrong one when agent has multiple accounts.
      // Use currentChannelId to look up which account actually owns the group.
      let accountId = ctx.accountId ?? DEFAULT_ACCOUNT_ID;
      const currentChannelId = ctx.toolContext?.currentChannelId;
      if (currentChannelId) {
        const rawGroupNo = currentChannelId.replace(/^dmwork:/, '');
        const correctAccountId = resolveAccountForGroup(rawGroupNo);
        if (correctAccountId && correctAccountId !== accountId) {
          ctx.log?.info?.(`dmwork: handleAction accountId corrected: ${accountId} → ${correctAccountId} (group=${rawGroupNo})`);
          accountId = correctAccountId;
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
        log: ctx.log,
      });
    },
  } as any, // TODO: remove when SDK types support this
  agentTools: (params: { cfg?: any }) => createDmworkManagementTools(params),
  agentPrompt: {
    messageToolHints: ({ cfg, accountId }: { cfg: any; accountId?: string | null }) => {
      if (!accountId) return [];
      return [
        `When using the dmwork_management tool, pass accountId: "${accountId}".`,
        `For sending messages: if the target is a group, use target="group:<groupId>". If the target is a specific user (1v1 direct message), use target="user:<userId>". If sending to the current conversation, no prefix is needed.`,
      ];
    },
  },
  configSchema: DmworkConfigJsonSchema,
  config: {
    listAccountIds: (cfg) => listDmworkAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveDmworkAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultDmworkAccountId(cfg),
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
      const account = resolveDmworkAccount({
        cfg: ctx.cfg as OpenClawConfig,
        accountId: ctx.accountId ?? DEFAULT_ACCOUNT_ID,
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

      if (channelType === ChannelType.Group) {
        // Parse @mentions from message content (e.g., "@chenpipi_bot", "@陈皮皮")
        const contentMentionNames = parseMentions(content);
        for (const name of contentMentionNames) {
          if (name && !mentionUids.includes(name)) {
            mentionUids.push(name);
            console.log(`[dmwork] parsed @mention from content: ${name}`);
          }
        }
        if (mentionUids.length > 0) {
          console.log(`[dmwork] sending message with mentionUids: ${mentionUids.join(", ")}`);
        }
      }

      await sendMessage({
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken,
        channelId,
        channelType,
        content,
        ...(mentionUids.length > 0 ? { mentionUids } : {}),
      });

      return { channel: "dmwork", to: ctx.to, messageId: "" };
    },
    sendMedia: async (ctx) => {
      const account = resolveDmworkAccount({
        cfg: ctx.cfg as OpenClawConfig,
        accountId: ctx.accountId ?? DEFAULT_ACCOUNT_ID,
      });
      if (!account.config.botToken) {
        throw new Error("DMWork botToken is not configured");
      }

      const mediaUrl = ctx.mediaUrl;
      if (!mediaUrl) {
        throw new Error("sendMedia called without mediaUrl");
      }

      // 1. Download the file
      let fileBuffer: Buffer;
      let contentType: string | undefined;
      let filename: string;

      if (mediaUrl.startsWith("data:")) {
        // Parse data URI: data:[<mediatype>][;base64],<data>
        const match = mediaUrl.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/);
        if (!match) {
          throw new Error("Invalid data URI format");
        }
        contentType = match[1] || "application/octet-stream";
        fileBuffer = Buffer.from(match[2], "base64");
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
        fileBuffer = await readFile(filePath);
        filename = path.basename(filePath);
        contentType = inferContentType(filename);
      } else {
        const resp = await fetch(mediaUrl, { signal: AbortSignal.timeout(300_000) });
        if (!resp.ok) {
          throw new Error(`Failed to download media from ${mediaUrl}: ${resp.status}`);
        }
        fileBuffer = Buffer.from(await resp.arrayBuffer());
        contentType = resp.headers.get("content-type") ?? undefined;
        // Extract filename from URL path
        const urlPath = new URL(mediaUrl).pathname;
        filename = path.basename(urlPath) || "file";
        if (!contentType) {
          contentType = inferContentType(filename);
        }
      }

      contentType = contentType || "application/octet-stream";

      // 2. Get STS credentials from backend
      const creds = await getUploadCredentials({
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken,
        filename,
      });

      // 3. Upload directly to COS with progress
      const { url: cdnUrl } = await uploadFileToCOS({
        credentials: creds.credentials,
        startTime: creds.startTime,
        expiredTime: creds.expiredTime,
        bucket: creds.bucket,
        region: creds.region,
        key: creds.key,
        fileBuffer,
        contentType,
        onProgress: (percent) => {
          if (percent % 20 === 0 || percent === 100) {
            console.log(`[dmwork] COS upload progress: ${percent}%`);
          }
        },
      });

      // 4. Parse target using shared parseTarget + knownGroupIds
      let targetForParse = ctx.to;
      if (ctx.to.startsWith("group:")) {
        const groupPart = ctx.to.slice(6);
        const atIdx = groupPart.indexOf("@");
        if (atIdx >= 0) targetForParse = "group:" + groupPart.slice(0, atIdx);
      }
      const { channelId, channelType } = parseTarget(targetForParse, undefined, getKnownGroupIds());

      // 5. Determine message type and send
      const msgType = contentType.startsWith("image/")
        ? MessageType.Image
        : MessageType.File;

      if (msgType === MessageType.Image) {
        const dims = parseImageDimensions(fileBuffer, contentType);
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
          size: fileBuffer.length,
        });
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

      log?.info?.(
        `[${account.accountId}] bot registered as ${credentials.robot_id}`,
      );

      // Check for updates in background (fire-and-forget)
      checkForUpdates(account.config.apiUrl, log).catch(() => {});

      // Prefetch GROUP.md for all groups (fire-and-forget)
      const groupMdCache = getOrCreateGroupMdCache(account.accountId);
      (async () => {
        try {
          const groups = await fetchBotGroups({ apiUrl: account.config.apiUrl, botToken: account.config.botToken!, log });
          registerBotGroupIds(groups.map(g => g.group_no));
          for (const g of groups) {
            try {
              const md = await getGroupMd({ apiUrl: account.config.apiUrl, botToken: account.config.botToken!, groupNo: g.group_no, log });
              if (md.content) {
                groupMdCache.set(g.group_no, { content: md.content, version: md.version });
              }
            } catch {
              // Ignore per-group failures (group may not have GROUP.md)
            }
          }
          if (groupMdCache.size > 0) {
            log?.info?.(`dmwork: prefetched GROUP.md for ${groupMdCache.size} groups`);
          }
        } catch (err) {
          log?.error?.(`dmwork: GROUP.md prefetch failed: ${String(err)}`);
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
          }).catch((err) => {
            consecutiveHeartbeatFailures++;
            log?.error?.(`dmwork: heartbeat failed (${consecutiveHeartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): ${String(err)}`);
            if (consecutiveHeartbeatFailures >= MAX_HEARTBEAT_FAILURES && !stopped) {
              log?.warn?.("dmwork: too many heartbeat failures, triggering reconnect...");
              consecutiveHeartbeatFailures = 0;
              socket.disconnect();
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

      // 5. Token refresh state — detect stale cached token
      let hasRefreshedToken = false;
      let isRefreshingToken = false; // Guard against concurrent refreshes (#43)

      // 5b. Heartbeat failure tracking — reconnect after consecutive failures (#42)
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
          log?.info?.(`dmwork: WebSocket connected to ${wsUrl}`);
          statusSink({ lastError: null });
          startHeartbeat();
          // WS connected successfully = WuKongIM accepted the token
          // Reset refresh flag so we can refresh again if kicked later (#92)
          hasRefreshedToken = false;
        },

        onDisconnected: () => {
          log?.warn?.("dmwork: WebSocket disconnected, will reconnect...");
          statusSink({ lastError: "disconnected" });
        },

        onError: async (err: Error) => {
          log?.error?.(`dmwork: WebSocket error: ${err.message}`);
          statusSink({ lastError: err.message });

          // If kicked or connect failed, try refreshing the IM token once
          // Use isRefreshingToken to prevent concurrent refresh attempts (#43)
          if (!hasRefreshedToken && !isRefreshingToken && !stopped &&
              (err.message.includes("Kicked") || err.message.includes("Connect failed"))) {
            isRefreshingToken = true;
            hasRefreshedToken = true;
            log?.warn?.("dmwork: connection rejected — refreshing IM token...");
            try {
              const fresh = await registerBot({
                apiUrl: account.config.apiUrl,
                botToken: account.config.botToken!,
                forceRefresh: true,
              });
              credentials = fresh;
              log?.info?.("dmwork: got fresh IM token, reconnecting WS...");
              socket.disconnect();
              socket.updateCredentials(fresh.robot_id, fresh.im_token);
              socket.connect();
            } catch (refreshErr) {
              log?.error?.(`dmwork: token refresh failed: ${String(refreshErr)}`);
              hasRefreshedToken = false; // Allow retry on next error (#43)
            } finally {
              isRefreshingToken = false;
            }
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
