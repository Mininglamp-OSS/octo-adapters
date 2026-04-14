import type { ChannelLogSink, OpenClawConfig } from "openclaw/plugin-sdk";
import { sendMessage, sendReadReceipt, sendTyping, getChannelMessages, getGroupMembers, getGroupMd, postJson, sendMediaMessage, inferContentType, ensureTextCharset, parseImageDimensions, parseImageDimensionsFromFile, getUploadCredentials, uploadFileToCOS, fetchUserInfo } from "./api-fetch.js";
import type { ResolvedDmworkAccount } from "./accounts.js";
import type { BotMessage } from "./types.js";
import { ChannelType, MessageType } from "./types.js";
import { getDmworkRuntime } from "./runtime.js";
import { DEFAULT_HISTORY_PROMPT_TEMPLATE } from "./config-schema.js";
import {
  extractMentionMatches,
  extractMentionUids,
  convertContentForLLM,
  buildSenderPrefix,
  resolveSenderName,
  parseStructuredMentions,
  convertStructuredMentions,
  buildEntitiesFromFallback,
} from "./mention-utils.js";
import type { MentionPayload, MentionEntity } from "./types.js";
import { registerGroupAccount, ensureGroupMd, handleGroupMdEvent, broadcastGroupMdUpdate, extractParentGroupNo, extractThreadShortId, ensureThreadMd, handleThreadMdEvent } from "./group-md.js";
import { createWriteStream } from "node:fs";
import { mkdir, unlink, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

// Defensive imports — these may not exist in older OpenClaw versions
// History context managed manually for cross-SDK compatibility
let clearHistoryEntriesIfEnabled: any;
let DEFAULT_GROUP_HISTORY_LIMIT = 20;
let _sdkLoaded = false;

async function ensureSdkLoaded() {
  if (_sdkLoaded) return;
  _sdkLoaded = true;
  try {
    const sdk = await import("openclaw/plugin-sdk");
    // History context managed manually (SDK buildPendingHistoryContextFromMap
    // has incompatible entry format expectations across versions)
    if (typeof sdk.clearHistoryEntriesIfEnabled === "function") {
      clearHistoryEntriesIfEnabled = sdk.clearHistoryEntriesIfEnabled;
    }
    if (sdk.DEFAULT_GROUP_HISTORY_LIMIT) {
      DEFAULT_GROUP_HISTORY_LIMIT = sdk.DEFAULT_GROUP_HISTORY_LIMIT;
    }
  } catch {
    // Older OpenClaw versions may not export these — fallback implementations used
  }
}



// Re-export a minimal HistoryEntry type for when SDK doesn't have it
export interface HistoryEntryCompat {
  sender: string;
  body: string;
  timestamp: number;
}

export type DmworkStatusSink = (patch: {
  lastInboundAt?: number;
  lastOutboundAt?: number;
  lastError?: string | null;
}) => void;

/** Extract media URLs from deliver payload */
function resolveOutboundMediaUrls(payload: { mediaUrl?: string; mediaUrls?: string[] }): string[] {
  return [
    ...(payload.mediaUrls ?? []),
    ...(payload.mediaUrl ? [payload.mediaUrl] : []),
  ].filter(Boolean);
}

/** Extract filename from a URL path */
function extractFilename(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/");
    return parts[parts.length - 1] || "file";
  } catch {
    return "file";
  }
}

/** Upload media to MinIO and send as image/file message */
export async function uploadAndSendMedia(params: {
  mediaUrl: string;
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  log?: ChannelLogSink;
}): Promise<void> {
  const { mediaUrl, apiUrl, botToken, channelId, channelType, log } = params;

  const { createReadStream: fsCreateReadStream, statSync: fsStatSync, createWriteStream: fsCreateWriteStream } = await import("node:fs");
  const { basename, join: pathJoin } = await import("node:path");
  const { mkdir: fsMkdir, unlink: fsUnlink } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const { pipeline } = await import("node:stream/promises");
  const { Readable } = await import("node:stream");

  const MAX_UPLOAD = 500 * 1024 * 1024;
  const TEMP_DIR = pathJoin("/tmp", "dmwork-upload");

  let fileBody: Buffer | NodeJS.ReadableStream;
  let fileSize: number;
  let contentType: string;
  let filename: string;
  let tempPath: string | undefined;

  if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
    filename = extractFilename(mediaUrl);
    // Stream download to temp file
    await fsMkdir(TEMP_DIR, { recursive: true });
    tempPath = pathJoin(TEMP_DIR, `${randomUUID()}-${filename}`);

    const head = await fetch(mediaUrl, { method: "HEAD" });
    const cl = Number(head.headers.get("content-length") || 0);
    if (cl > MAX_UPLOAD) throw new Error(`File too large (${cl} bytes, max ${MAX_UPLOAD})`);

    const resp = await fetch(mediaUrl, {
      signal: AbortSignal.timeout(300_000),
    });
    if (!resp.ok) throw new Error(`Failed to fetch media: ${resp.status}`);
    contentType = resp.headers.get("content-type") || "application/octet-stream";

    const body = resp.body;
    if (!body) throw new Error(`No response body from ${mediaUrl}`);
    const nodeStream = Readable.fromWeb(body as any);
    const ws = fsCreateWriteStream(tempPath);
    try {
      await pipeline(nodeStream, ws);
    } catch (err) {
      // Cleanup partial temp file on download failure
      await fsUnlink(tempPath).catch(() => {});
      tempPath = undefined;
      throw err;
    }

    const st = fsStatSync(tempPath);
    fileBody = fsCreateReadStream(tempPath);
    fileSize = st.size;
  } else {
    // Local file path — stream, don't buffer
    const st = fsStatSync(mediaUrl);
    if (st.size > MAX_UPLOAD) throw new Error(`File too large (${st.size} bytes, max ${MAX_UPLOAD})`);
    fileBody = fsCreateReadStream(mediaUrl);
    fileSize = st.size;
    filename = basename(mediaUrl);
    contentType = inferContentType(filename);
  }

  try {
    // Upload to COS via STS credentials (stream mode)
    const creds = await getUploadCredentials({ apiUrl, botToken, filename });
    const { url: uploadedUrl } = await uploadFileToCOS({
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

    // Determine message type from MIME
    const isImage = contentType.startsWith("image/");
    const msgType = isImage ? MessageType.Image : MessageType.File;

    // For images, parse dimensions from file (not full buffer)
    let width: number | undefined;
    let height: number | undefined;
    if (isImage) {
      const fileToParse = tempPath ?? mediaUrl;
      const dims = await parseImageDimensionsFromFile(fileToParse, contentType);
      width = dims?.width;
      height = dims?.height;
    }

    log?.info?.(`dmwork: uploaded media as ${isImage ? "image" : "file"}: ${filename}${width ? ` (${width}x${height})` : ""}`);

    // Send via sendMessage
    await sendMediaMessage({
      apiUrl,
      botToken,
      channelId,
      channelType,
      type: msgType,
      url: uploadedUrl,
      name: isImage ? undefined : filename,
      size: isImage ? undefined : fileSize,
      width,
      height,
    });
  } finally {
    if (tempPath) await fsUnlink(tempPath).catch(() => {});
  }
}

/** Guess MIME type from file extension */
function guessMime(pathOrName?: string, fallback = "application/octet-stream"): string {
  if (!pathOrName) return fallback;
  const ext = pathOrName.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", opus: "audio/opus",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", avi: "video/x-msvideo", mkv: "video/x-matroska",
    pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
    txt: "text/plain", json: "application/json", csv: "text/csv", md: "text/markdown",
    py: "text/x-python", js: "text/javascript", ts: "text/typescript", go: "text/x-go", java: "text/x-java",
    html: "text/html", css: "text/css", xml: "text/xml", yaml: "text/yaml", yml: "text/yaml",
  };
  return map[ext] ?? fallback;
}

export interface ResolvedContent {
  text: string;
  mediaUrl?: string;
  mediaType?: string;
}

export interface ForwardUser {
  uid: string;
  name: string;
}

export interface ForwardMessage {
  message_id?: string;
  from_uid: string;
  timestamp?: number;
  payload: {
    type: number;
    content?: string;
    url?: string;
    name?: string;
    users?: ForwardUser[];
    msgs?: ForwardMessage[];
  };
}

/** Build a full media URL from a relative storage path */
export function buildMediaUrl(relUrl?: string, apiUrl?: string, cdnUrl?: string): string | undefined {
  if (!relUrl) return undefined;
  if (relUrl.startsWith("http")) return relUrl;
  let storagePath = relUrl;
  if (storagePath.startsWith("file/preview/")) {
    storagePath = storagePath.substring("file/preview/".length);
  } else if (storagePath.startsWith("file/")) {
    storagePath = storagePath.substring("file/".length);
  }
  if (cdnUrl) {
    const base = cdnUrl.replace(/\/+$/, "");
    return `${base}/${storagePath}`;
  }
  const baseUrl = apiUrl?.replace(/\/+$/, "") ?? "";
  return `${baseUrl}/file/${storagePath}`;
}

/** Resolve inner message type to display text for MultipleForward */
export function resolveInnerMessageText(
  payload: ForwardMessage["payload"],
  buildUrl?: (url?: string) => string | undefined,
): string {
  if (!payload) return "";
  const fullUrl = buildUrl?.(payload.url);
  switch (payload.type) {
    case MessageType.Text:
      return payload.content ?? "";
    case MessageType.Image:
      return fullUrl ? `[图片]\n${fullUrl}` : "[图片]";
    case MessageType.GIF:
      return fullUrl ? `[GIF]\n${fullUrl}` : "[GIF]";
    case MessageType.Voice:
      return fullUrl ? `[语音]\n${fullUrl}` : "[语音]";
    case MessageType.Video:
      return fullUrl ? `[视频]\n${fullUrl}` : "[视频]";
    case MessageType.Location:
      return "[位置信息]";
    case MessageType.Card:
      return "[名片]";
    case MessageType.File: {
      const label = payload.name ? `[文件: ${payload.name}]` : "[文件]";
      return fullUrl ? `${label}\n${fullUrl}` : label;
    }
    case MessageType.MultipleForward:
      return "[合并转发]";
    default:
      return payload.content ?? "[消息]";
  }
}

/** Resolve MultipleForward payload into readable text */
export function resolveMultipleForwardText(payload: any, apiUrl?: string, cdnUrl?: string): string {
  const users: ForwardUser[] = payload?.users ?? [];
  const msgs: ForwardMessage[] = payload?.msgs ?? [];
  const userMap = new Map<string, string>();
  for (const u of users) {
    if (u.uid && u.name) userMap.set(u.uid, u.name);
  }
  const buildUrl = (apiUrl || cdnUrl)
    ? (url?: string) => buildMediaUrl(url, apiUrl, cdnUrl)
    : undefined;
  const lines: string[] = ["[合并转发: 聊天记录]"];
  for (const m of msgs) {
    const senderName = userMap.get(m.from_uid) ?? m.from_uid;
    if (m.payload?.type === MessageType.MultipleForward) {
      const nested = resolveMultipleForwardText(m.payload, apiUrl, cdnUrl);
      lines.push(`${senderName}: [合并转发]`);
      lines.push(nested);
    } else {
      const content = resolveInnerMessageText(m.payload, buildUrl);
      lines.push(`${senderName}: ${content}`);
    }
  }
  return lines.join("\n");
}

function resolveContent(payload: BotMessage["payload"], apiUrl?: string, log?: ChannelLogSink, cdnUrl?: string): ResolvedContent {
  if (!payload) return { text: "" };

  const makeFullUrl = (relUrl?: string) => buildMediaUrl(relUrl, apiUrl, cdnUrl);

  switch (payload.type) {
    case MessageType.Text:
      return { text: payload.content ?? "" };
    case MessageType.Image: {
      log?.debug?.(`dmwork: [resolveContent] Image payload.url=${payload.url}`);
      const imgUrl = makeFullUrl(payload.url);
      const imgMime = guessMime(payload.url, "image/jpeg");
      return { text: `[图片]\n${imgUrl ?? ""}`.trim(), mediaUrl: imgUrl, mediaType: imgMime };
    }
    case MessageType.GIF: {
      const gifUrl = makeFullUrl(payload.url);
      return { text: `[GIF]\n${gifUrl ?? ""}`.trim(), mediaUrl: gifUrl, mediaType: "image/gif" };
    }
    case MessageType.Voice: {
      const voiceUrl = makeFullUrl(payload.url);
      const voiceMime = guessMime(payload.url, "audio/mpeg");
      return { text: `[语音消息]\n${voiceUrl ?? ""}`.trim(), mediaUrl: voiceUrl, mediaType: voiceMime };
    }
    case MessageType.Video: {
      const videoUrl = makeFullUrl(payload.url);
      const videoMime = guessMime(payload.url, "video/mp4");
      return { text: `[视频]\n${videoUrl ?? ""}`.trim(), mediaUrl: videoUrl, mediaType: videoMime };
    }
    case MessageType.File: {
      log?.debug?.(`dmwork: [resolveContent] File payload.url=${payload.url}`);
      const fileUrl = makeFullUrl(payload.url);
      const fileMime = guessMime(payload.url, payload.name ? guessMime(payload.name, "application/octet-stream") : "application/octet-stream");
      return { text: `[文件: ${payload.name ?? "未知文件"}]\n${fileUrl ?? ""}`.trim(), mediaUrl: fileUrl, mediaType: fileMime };
    }
    case MessageType.Location: {
      const lat = payload.latitude ?? payload.lat;
      const lng = payload.longitude ?? payload.lng ?? payload.lon;
      const locText = lat != null && lng != null ? `[位置信息: ${lat},${lng}]` : "[位置信息]";
      return { text: locText };
    }
    case MessageType.Card: {
      const cardName = payload.name ?? "未知";
      const cardUid = payload.uid ?? "";
      const cardText = cardUid ? `[名片: ${cardName} (${cardUid})]` : `[名片: ${cardName}]`;
      return { text: cardText };
    }
    case MessageType.MultipleForward: {
      return { text: resolveMultipleForwardText(payload, apiUrl, cdnUrl) };
    }
    default:
      return { text: payload.content ?? payload.url ?? "" };
  }
}

/** Extract text-only content for history/quotes (no mediaUrl) */
function resolveContentText(payload: BotMessage["payload"], apiUrl?: string): string {
  return resolveContent(payload, apiUrl).text;
}

const TEXT_FILE_EXTENSIONS = new Set([
  "txt", "html", "htm", "md", "csv", "json", "xml", "yaml", "yml",
  "log", "py", "js", "ts", "go", "java",
]);

/** Fetch an authenticated URL and return a base64 data URL */
async function fetchAsDataUrl(
  url: string,
  botToken: string,
  log?: { warn?: (msg: string) => void },
): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      log?.warn?.(`dmwork: fetchAsDataUrl failed: status=${resp.status} url=${url}`);
      return null;
    }
    const contentType = resp.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await resp.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  } catch (err) {
    log?.warn?.(`dmwork: fetchAsDataUrl error: ${String(err)} url=${url}`);
    return null;
  }
}

/** Format bytes as human-readable size string */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/** Calculate dynamic timeout based on file size (512KB/s baseline, min 5min, max 30min) */
export function calcDownloadTimeout(fileSize?: number): number {
  const MIN_TIMEOUT = 300_000;    // 5 minutes
  const MAX_TIMEOUT = 1_800_000;  // 30 minutes
  const ASSUMED_SIZE = 256 * 1024 * 1024; // 256MB if unknown
  const size = fileSize ?? ASSUMED_SIZE;
  const computed = Math.ceil(size / (512 * 1024)) * 1000; // 512KB/s baseline
  return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, computed));
}

const MEDIA_TEMP_DIR = join("/tmp", "dmwork-media");
const MAX_MEDIA_DOWNLOAD_SIZE = 20 * 1024 * 1024; // 20MB cap for inbound media
const MEDIA_DOWNLOAD_TIMEOUT = 120_000; // 120 seconds

/** Best-effort cleanup of inbound media temp files older than 1 hour */
async function cleanupMediaTempFiles(): Promise<void> {
  try {
    const entries = await readdir(MEDIA_TEMP_DIR);
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const entry of entries) {
      try {
        const filePath = join(MEDIA_TEMP_DIR, entry);
        const info = await stat(filePath);
        if (info.mtimeMs < cutoff) {
          await unlink(filePath);
        }
      } catch {}
    }
  } catch {}
}

/**
 * Download inbound media (Image/GIF/Voice/Video) to a local temp file.
 *
 * Returns the local file path on success, undefined on failure.
 * Failures are logged but never thrown — the agent still sees the URL
 * in the text body, it just won't get native media understanding.
 */
export async function downloadMediaToLocal(
  url: string,
  mime: string | undefined,
  log?: ChannelLogSink,
): Promise<string | undefined> {
  try {
    await mkdir(MEDIA_TEMP_DIR, { recursive: true });
    cleanupMediaTempFiles().catch(() => {});

    // Derive a file extension from mime or URL
    let ext = "";
    if (mime) {
      const parts = mime.split("/");
      if (parts.length === 2) ext = "." + parts[1].split(";")[0];
    }
    if (!ext) {
      const urlPath = url.split("?")[0];
      const dot = urlPath.lastIndexOf(".");
      if (dot !== -1) ext = urlPath.substring(dot);
    }
    // Sanitize extension
    ext = ext.replace(/[^a-zA-Z0-9.]/g, "").substring(0, 10);

    const localPath = join(MEDIA_TEMP_DIR, `${randomUUID()}${ext}`);

    const resp = await fetch(url, {
      signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT),
    });
    if (!resp.ok) {
      log?.warn?.(`dmwork: media download failed HTTP ${resp.status} for ${url}`);
      return undefined;
    }
    if (!resp.body) {
      log?.warn?.(`dmwork: media download returned no body for ${url}`);
      return undefined;
    }

    const ws = createWriteStream(localPath);
    let totalBytes = 0;
    try {
      const reader = (resp.body as any).getReader() as ReadableStreamDefaultReader<Uint8Array>;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_MEDIA_DOWNLOAD_SIZE) {
          reader.cancel();
          ws.destroy();
          try { await unlink(localPath); } catch {}
          log?.warn?.(`dmwork: media too large (>${formatSize(MAX_MEDIA_DOWNLOAD_SIZE)}), skipping: ${url}`);
          return undefined;
        }
        if (!ws.write(value)) {
          await new Promise<void>(r => ws.once("drain", r));
        }
      }
      ws.end();
      await new Promise<void>((resolve, reject) => {
        ws.on("finish", resolve);
        ws.on("error", reject);
      });
    } catch (err) {
      ws.destroy();
      try { await unlink(localPath); } catch {}
      throw err;
    }
    log?.info?.(`dmwork: media downloaded to local: ${localPath} (${formatSize(totalBytes)})`);
    return localPath;
  } catch (err) {
    log?.warn?.(`dmwork: media download failed for ${url}: ${err}`);
    return undefined;
  }
}

const TEMP_DIR = join("/tmp", "dmwork-files");
const MAX_DOWNLOAD_SIZE = 500 * 1024 * 1024; // 500MB hard cap

/** Best-effort cleanup of temp files older than 1 hour */
async function cleanupTempFiles(): Promise<void> {
  try {
    const entries = await readdir(TEMP_DIR);
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const entry of entries) {
      try {
        const filePath = join(TEMP_DIR, entry);
        const info = await stat(filePath);
        if (info.mtimeMs < cutoff) {
          await unlink(filePath);
        }
      } catch {}
    }
  } catch {}
}

/** Download a file to a temp path, streaming to disk with size limit.
 *  Returns the local path on success. */
export async function downloadToTemp(
  url: string,
  botToken: string,
  filename: string,
  opts?: { knownSize?: number; log?: ChannelLogSink },
): Promise<string> {
  await mkdir(TEMP_DIR, { recursive: true });
  // Non-blocking cleanup of old temp files
  cleanupTempFiles().catch(() => {});

  const safeName = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
  const localPath = join(TEMP_DIR, `${randomUUID()}-${safeName}`);
  const timeout = calcDownloadTimeout(opts?.knownSize);
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  if (!resp.body) throw new Error("no response body");

  const ws = createWriteStream(localPath);
  let totalBytes = 0;
  try {
    const reader = (resp.body as any).getReader() as ReadableStreamDefaultReader<Uint8Array>;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_DOWNLOAD_SIZE) {
        reader.cancel();
        throw new Error(`file exceeds max download size (${formatSize(MAX_DOWNLOAD_SIZE)})`);
      }
      if (!ws.write(value)) {
        await new Promise<void>(r => ws.once('drain', r));
      }
    }
    ws.end();
    await new Promise<void>((resolve, reject) => {
      ws.on("finish", resolve);
      ws.on("error", reject);
    });
  } catch (err) {
    ws.destroy();
    // Best-effort cleanup
    try { await unlink(localPath); } catch {}
    throw err;
  }
  opts?.log?.info?.(`dmwork: file downloaded to temp: ${localPath}`);
  return localPath;
}

/**
 * Attempt to resolve file content for inline display.
 *
 * - Only attempts inline for text-like file extensions
 * - Threshold reduced to 20KB to avoid blowing up LLM context
 * - Sends HEAD request first to check size before downloading
 * - Streams the body with a size guard instead of buffering entirely
 * - For files above inline threshold, streams to a temp file on disk
 * - Returns error description string on failure (never silent null)
 *
 * Return value:
 *   { inline: string }             – file content was inlined
 *   { tempPath: string }           – file was saved to temp
 *   { description: string }        – download skipped or failed; embed this in message
 *   null                           – non-text extension, no action needed
 */
export type ResolveFileResult =
  | { inline: string }
  | { tempPath: string }
  | { description: string }
  | null;

export async function resolveFileContentWithRetry(
  url: string,
  botToken: string,
  filename: string,
  opts?: { knownSize?: number; maxRetries?: number; log?: ChannelLogSink },
): Promise<ResolveFileResult> {
  let ext = "";
  try {
    ext = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  } catch {
    ext = url.split(".").pop()?.toLowerCase() ?? "";
  }
  if (!TEXT_FILE_EXTENSIONS.has(ext)) return null;

  const maxBytes = 20 * 1024; // 20KB inline threshold
  const knownSize = opts?.knownSize;
  const maxRetries = opts?.maxRetries ?? 3;
  const log = opts?.log;

  // If we already know the file is too large for inline, stream to temp
  if (knownSize != null && knownSize > maxBytes) {
    log?.info?.(`dmwork: file too large for inline (${formatSize(knownSize)}), streaming to temp`);
    return await downloadLargeFileWithRetry(url, botToken, filename, { knownSize, maxRetries, log });
  }

  // HEAD pre-check to get Content-Length without downloading
  let headSize: number | undefined;
  try {
    const headResp = await fetch(url, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (headResp.ok) {
      const cl = headResp.headers.get("content-length");
      if (cl) headSize = parseInt(cl, 10);
    }
  } catch {
    // HEAD failed — proceed with streaming download
  }

  // Reject files exceeding hard cap before any download attempt
  if (headSize != null && headSize > MAX_DOWNLOAD_SIZE) {
    log?.info?.(`dmwork: HEAD reports ${formatSize(headSize)}, exceeds max download size (${formatSize(MAX_DOWNLOAD_SIZE)}), skipping`);
    return { description: `[文件: ${filename} (${formatSize(headSize)}) - 文件超过最大下载限制(${formatSize(MAX_DOWNLOAD_SIZE)})]` };
  }

  if (headSize != null && headSize > maxBytes) {
    log?.info?.(`dmwork: HEAD reports ${formatSize(headSize)}, exceeds inline threshold, streaming to temp`);
    return await downloadLargeFileWithRetry(url, botToken, filename, { knownSize: headSize, maxRetries, log });
  }

  // Attempt inline download with streaming size guard
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const timeout = calcDownloadTimeout(headSize ?? knownSize);
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${botToken}` },
        signal: AbortSignal.timeout(timeout),
      });
      if (!resp.ok) {
        lastError = `HTTP ${resp.status}`;
        log?.warn?.(`dmwork: resolveFileContent attempt ${attempt}/${maxRetries} failed: ${lastError}`);
        if (resp.status >= 400 && resp.status < 500) break;
        if (attempt < maxRetries) await sleep(1000 * attempt);
        continue;
      }
      if (!resp.body) {
        lastError = "no response body";
        break;
      }

      // Check Content-Length from GET response
      const cl = resp.headers.get("content-length");
      if (cl && parseInt(cl, 10) > maxBytes) {
        log?.info?.(`dmwork: GET Content-Length ${cl} exceeds inline threshold, streaming to temp`);
        // Cancel this response; download to temp instead
        try { resp.body.cancel(); } catch {}
        return await downloadLargeFileWithRetry(url, botToken, filename, { knownSize: parseInt(cl, 10), maxRetries: maxRetries - attempt + 1, log });
      }

      // Stream body with size guard
      const reader = (resp.body as any).getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let exceededInline = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          exceededInline = true;
          reader.cancel();
          break;
        }
        chunks.push(value);
      }

      if (exceededInline) {
        log?.info?.(`dmwork: file exceeded inline threshold during stream (${formatSize(totalBytes)}+), streaming to temp`);
        return await downloadLargeFileWithRetry(url, botToken, filename, { knownSize: totalBytes, maxRetries: maxRetries - attempt + 1, log });
      }

      // Inline the content
      const combined = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder().decode(combined);
      log?.info?.(`dmwork: file inlined (${formatSize(totalBytes)})`);
      return { inline: text };
    } catch (err) {
      const errMsg = String(err);
      lastError = errMsg.includes("TimeoutError") || errMsg.includes("abort") ? "下载超时" : `网络错误`;
      log?.warn?.(`dmwork: resolveFileContent attempt ${attempt}/${maxRetries} error: ${errMsg}`);
      if (attempt < maxRetries) await sleep(1000 * attempt);
    }
  }

  const sizeInfo = knownSize != null ? ` (${formatSize(knownSize)})` : headSize != null ? ` (${formatSize(headSize)})` : "";
  return { description: `[文件: ${filename}${sizeInfo} - 下载失败: ${lastError ?? "未知错误"}]` };
}

/** Download large file to temp with retry + exponential backoff */
async function downloadLargeFileWithRetry(
  url: string,
  botToken: string,
  filename: string,
  opts: { knownSize?: number; maxRetries: number; log?: ChannelLogSink },
): Promise<ResolveFileResult> {
  const { knownSize, maxRetries, log } = opts;

  // Reject files exceeding hard cap before any download attempt
  if (knownSize != null && knownSize > MAX_DOWNLOAD_SIZE) {
    log?.info?.(`dmwork: file size ${formatSize(knownSize)} exceeds max download size (${formatSize(MAX_DOWNLOAD_SIZE)}), skipping`);
    return { description: `[文件: ${filename} (${formatSize(knownSize)}) - 文件超过最大下载限制(${formatSize(MAX_DOWNLOAD_SIZE)})]` };
  }

  let lastError: string | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const start = Date.now();
      const tempPath = await downloadToTemp(url, botToken, filename, { knownSize, log });
      const duration = ((Date.now() - start) / 1000).toFixed(1);
      log?.info?.(`dmwork: large file downloaded in ${duration}s: ${filename}`);
      return { tempPath };
    } catch (err) {
      const errMsg = String(err);
      lastError = errMsg.includes("TimeoutError") || errMsg.includes("abort")
        ? `下载超时，已重试${attempt}次失败`
        : errMsg.includes("HTTP ")
        ? errMsg
        : "网络错误";
      log?.warn?.(`dmwork: downloadToTemp attempt ${attempt}/${maxRetries} failed: ${errMsg}`);
      // 4xx errors are permanent — do not retry
      const httpMatch = errMsg.match(/HTTP (\d+)/);
      if (httpMatch) {
        const status = parseInt(httpMatch[1], 10);
        if (status >= 400 && status < 500) break;
      }
      if (attempt < maxRetries) await sleep(1000 * attempt * 2);
    }
  }
  const sizeInfo = knownSize != null ? ` (${formatSize(knownSize)})` : "";
  return { description: `[文件: ${filename}${sizeInfo} - ${lastError ?? "下载失败"}]` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Placeholder text for non-text API history messages */
export function resolveApiMessagePlaceholder(type?: number, name?: string): string {
  switch (type) {
    case MessageType.Image: return "[图片]";
    case MessageType.GIF: return "[GIF]";
    case MessageType.Voice: return "[语音消息]";
    case MessageType.Video: return "[视频]";
    case MessageType.File: return `[文件: ${name ?? "未知文件"}]`;
    case MessageType.Location: return "[位置信息]";
    case MessageType.Card: return "[名片]";
    case MessageType.MultipleForward: return "[合并转发]";
    default: return "[消息]";
  }
}

/**
 * Strip emoji from string for fuzzy matching.
 * Removes most emoji using Unicode ranges.
 */
function stripEmoji(str: string): string {
  return str
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // Most emoji (faces, symbols, etc.)
    .replace(/[\u{2600}-\u{26FF}]/gu, '')   // Misc symbols
    .replace(/[\u{2700}-\u{27BF}]/gu, '')   // Dingbats
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')   // Variation selectors
    .replace(/[\u{1F000}-\u{1F02F}]/gu, '') // Mahjong, dominos
    .replace(/[\u{1F0A0}-\u{1F0FF}]/gu, '') // Playing cards
    .trim();
}

/**
 * Find uid by displayName with emoji-tolerant matching.
 * First tries exact match, then falls back to matching with emoji stripped.
 */
function findUidByName(name: string, memberMap: Map<string, string>): string | undefined {
  // First try exact match
  const exact = memberMap.get(name);
  if (exact) return exact;
  
  // Then try matching by stripping emoji from both sides
  const strippedName = stripEmoji(name);
  if (!strippedName) return undefined;
  
  for (const [displayName, uid] of memberMap.entries()) {
    if (stripEmoji(displayName) === strippedName) {
      return uid;
    }
  }
  return undefined;
}

// Cache expiry time: 1 hour
const GROUP_CACHE_EXPIRY_MS = 60 * 60 * 1000;


/**
 * Refresh group member cache at module level to avoid closure recreation per message.
 * Extracted from handleInboundMessage (fixes #25).
 */
async function refreshGroupMemberCache(opts: {
  sessionId: string;
  memberMap: Map<string, string>;
  uidToNameMap: Map<string, string>;
  groupCacheTimestamps: Map<string, number>;
  apiUrl: string;
  botToken: string;
  forceRefresh?: boolean;
  log?: ChannelLogSink;
}): Promise<boolean> {
  const { sessionId, memberMap, uidToNameMap, groupCacheTimestamps, apiUrl, botToken, log } = opts;
  const forceRefresh = opts.forceRefresh ?? false;

  const lastFetched = groupCacheTimestamps.get(sessionId) ?? 0;
  const now = Date.now();
  const isExpired = (now - lastFetched) > GROUP_CACHE_EXPIRY_MS;

  if (!forceRefresh && !isExpired && lastFetched > 0) {
    return false;
  }

  log?.info?.(`dmwork: [CACHE] ${forceRefresh ? 'Force refreshing' : 'Refreshing expired'} group member cache for ${sessionId}`);

  try {
    const members = await getGroupMembers({
      apiUrl,
      botToken,
      groupNo: sessionId,
      log: log ? { info: (...args) => log.info?.(String(args[0])), error: (...args) => log.error?.(String(args[0])) } : undefined,
    });

    if (members.length > 0) {
      for (const m of members) {
        if (m.name && m.uid) {
          memberMap.set(m.name, m.uid);
          uidToNameMap.set(m.uid, m.name);

          const nameWithoutEmoji = stripEmoji(m.name);
          if (nameWithoutEmoji && nameWithoutEmoji !== m.name && !memberMap.has(nameWithoutEmoji)) {
            memberMap.set(nameWithoutEmoji, m.uid);
            log?.debug?.(`dmwork: [CACHE] Added emoji alias: "${nameWithoutEmoji}" -> "${m.uid}"`);
          }
        }
      }
      groupCacheTimestamps.set(sessionId, now);
      log?.info?.(`dmwork: [CACHE] Loaded ${members.length} members, memberMap size: ${memberMap.size}`);
      return true;
    } else {
      groupCacheTimestamps.set(sessionId, now - GROUP_CACHE_EXPIRY_MS + 30000);
      log?.warn?.(`dmwork: [CACHE] No members returned for group ${sessionId}, backoff 30s`);
      return false;
    }
  } catch (err) {
    groupCacheTimestamps.set(sessionId, now - GROUP_CACHE_EXPIRY_MS + 30000);
    log?.error?.(`dmwork: [CACHE] Failed to fetch group members: ${err}, backoff 30s`);
    return false;
  }
}

export function buildMemberListPrefix(uidToNameMap: Map<string, string>): string {
  if (uidToNameMap.size === 0) return "";

  if (uidToNameMap.size <= 10) {
    const members = Array.from(uidToNameMap.entries());
    const memberLines = members
      .map(([uid, name]) => `  ${name} (${uid})`)
      .join("\n");
    return `[Group Members]\n${memberLines}\n\nWhen mentioning a group member, use the format @[uid:displayName] (e.g. @[${members[0][0]}:${members[0][1]}]). I will convert it to the correct format before sending.\n\n`;
  }

  return `[Group Info] This group has ${uidToNameMap.size} members. Use the group management tool to look up member info when needed. When mentioning a group member, use the format @[uid:displayName].\n\n`;
}

export async function handleInboundMessage(params: {
  account: ResolvedDmworkAccount;
  message: BotMessage;
  botUid: string;
  groupHistories: Map<string, any[]>;
  memberMap: Map<string, string>;  // displayName -> uid mapping
  uidToNameMap: Map<string, string>;  // uid -> displayName mapping (reverse)
  groupCacheTimestamps: Map<string, number>;  // groupId -> lastFetchedAt
  groupMdCache?: Map<string, { content: string; version: number }>;
  log?: ChannelLogSink;
  statusSink?: DmworkStatusSink;
}) {
  const { account, message, botUid, groupHistories, memberMap, uidToNameMap, groupCacheTimestamps, groupMdCache, log, statusSink } = params;

  await ensureSdkLoaded();

  // Detect GROUP.md update/delete notification — refresh both memory + disk cache, do NOT pass to LLM
  const earlyEventType = (message.payload as any)?.event?.type;
  if ((earlyEventType === "group_md_updated" || earlyEventType === "group_md_deleted") && message.channel_id) {
    const groupNo = extractParentGroupNo(message.channel_id);
    log?.info?.(`dmwork: GROUP.md ${earlyEventType} notification for group ${groupNo}`);

    // Update memory cache
    if (earlyEventType === "group_md_updated" && groupMdCache) {
      try {
        const md = await getGroupMd({
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken ?? "",
          groupNo,
          log,
        });
        if (md.content) {
          groupMdCache.set(groupNo, { content: md.content, version: md.version });
          log?.info?.(`dmwork: GROUP.md memory cache updated for ${groupNo} (v${md.version})`);
        }
      } catch (err) {
        log?.error?.(`dmwork: failed to refresh GROUP.md memory cache: ${String(err)}`);
      }
    } else if (earlyEventType === "group_md_deleted" && groupMdCache) {
      groupMdCache.delete(groupNo);
    }

    // Update disk cache (for before_prompt_build hook)
    if (earlyEventType === "group_md_updated" && groupMdCache) {
      const cached = groupMdCache.get(groupNo);
      if (cached) {
        broadcastGroupMdUpdate({
          accountId: account.accountId,
          groupNo,
          content: cached.content,
          version: cached.version,
        });
      }
    } else if (earlyEventType === "group_md_deleted") {
      // Delete disk cache
      broadcastGroupMdUpdate({
        accountId: account.accountId,
        groupNo,
        content: "",
        version: 0,
      });
    }

    return;
  }

  // Detect thread THREAD.md update/delete notification — refresh disk cache, do NOT pass to LLM
  if ((earlyEventType === "thread_md_updated" || earlyEventType === "thread_md_deleted") && message.channel_id) {
    const event = (message.payload as any)?.event;
    const groupNo = event?.group_no ?? extractParentGroupNo(message.channel_id);
    const shortId = event?.short_id ?? extractThreadShortId(message.channel_id);

    if (!groupNo || !shortId) {
      log?.warn?.(`dmwork: thread_md event missing group_no/short_id`);
      return;
    }

    log?.info?.(`dmwork: THREAD.md ${earlyEventType} notification for ${groupNo}/${shortId}`);

    // Resolve agentId from route/account (same pattern as group events below)
    let threadAgentId = "";
    try {
      const _core = getDmworkRuntime();
      const _cfg = _core.config.loadConfig() as OpenClawConfig;
      const _route = _core.channel.routing.resolveAgentRoute({
        cfg: _cfg, channel: "dmwork", accountId: account.accountId,
        peer: { kind: "group", id: message.channel_id },
      });
      threadAgentId = _route?.agentId ?? "";
    } catch {
      // fallback to empty — handleThreadMdEvent only uses agentId for logging
    }

    handleThreadMdEvent({
      agentId: threadAgentId,
      accountId: account.accountId,
      groupNo,
      shortId,
      eventType: earlyEventType,
      apiUrl: account.config.apiUrl,
      botToken: account.config.botToken ?? "",
      log,
    }).catch((err) => log?.error?.(`dmwork: handleThreadMdEvent failed: ${String(err)}`));

    return;
  }

  const isGroup =
    typeof message.channel_id === "string" &&
    message.channel_id.length > 0 &&
    (message.channel_type === ChannelType.Group || message.channel_type === ChannelType.CommunityTopic);

  // --- GROUP.md: register group→account mapping and handle structured events ---
  if (isGroup && message.channel_id) {
    const parentGroupNo = extractParentGroupNo(message.channel_id);
    // Resolve agentId for the group→account mapping
    try {
      const _core = getDmworkRuntime();
      const _cfg = _core.config.loadConfig() as OpenClawConfig;
      const _route = _core.channel.routing.resolveAgentRoute({
        cfg: _cfg, channel: "dmwork", accountId: account.accountId,
        peer: { kind: "group", id: message.channel_id },
      });
      registerGroupAccount(parentGroupNo, account.accountId, _route?.agentId);
    } catch {
      registerGroupAccount(parentGroupNo, account.accountId);
    }

    // Note: group_md_updated/deleted events are handled by the early handler above (line ~530)
    // and never reach here because early handler returns.
  }

  // Parse space_id from channel_id (format: s{spaceId}_{peerId})
  // For DM, channel_id is a fake channel: s{spaceId}_{uid1}@s{spaceId}_{uid2}
  // Use LastIndex approach: spaceId is everything between 's' and the last '_' before peerId
  let spaceId = "";
  const effectiveChannelId = isGroup ? message.channel_id! : message.from_uid;
  if (effectiveChannelId.startsWith("s")) {
    const lastUnderscore = effectiveChannelId.lastIndexOf("_");
    if (lastUnderscore > 0) {
      spaceId = effectiveChannelId.substring(1, lastUnderscore);
    }
  }
  // Also try to extract spaceId from the WS channel_id (compound DM format)
  if (!spaceId && message.channel_id && message.channel_id.startsWith("s")) {
    // DM compound: s{spaceId}_{uid1}@s{spaceId}_{uid2}
    const atIdx = message.channel_id.indexOf("@");
    const firstPart = atIdx > 0 ? message.channel_id.substring(0, atIdx) : message.channel_id;
    if (firstPart.startsWith("s")) {
      const lastUnderscore = firstPart.lastIndexOf("_");
      if (lastUnderscore > 0) {
        spaceId = firstPart.substring(1, lastUnderscore);
      }
    }
  }

  // Session ID: include spaceId for Space isolation (same user in different Spaces = different sessions)
  const sessionId = isGroup
    ? message.channel_id!
    : spaceId ? `${spaceId}:${message.from_uid}` : message.from_uid;

  const resolved = resolveContent(message.payload, account.config.apiUrl, log, account.config.cdnUrl);
  let rawBody = resolved.text;
  let inboundMediaUrl = resolved.mediaUrl;

  // Opportunistic uid→name cache fill from MultipleForward payloads
  if (message.payload?.type === MessageType.MultipleForward && Array.isArray(message.payload.users)) {
    for (const u of message.payload.users as Array<{ uid?: string; name?: string }>) {
      if (u.uid && u.name) uidToNameMap.set(u.uid, u.name);
    }
  }

  // For Image/GIF/Voice/Video: download media to local temp file so Core reads
  // local files instead of remote URLs (avoids hang on large/slow downloads in Core)
  const mediaDownloadTypes = [MessageType.Image, MessageType.GIF, MessageType.Voice, MessageType.Video];
  if (inboundMediaUrl && message.payload?.type != null && mediaDownloadTypes.includes(message.payload.type)) {
    const localPath = await downloadMediaToLocal(inboundMediaUrl, resolved.mediaType, log);
    inboundMediaUrl = localPath; // undefined on failure — graceful degradation
  }
  // Inline text file content if possible, or stream large files to temp
  const isFileMessage = message.payload?.type === MessageType.File;
  if (isFileMessage && resolved.mediaUrl) {
    const payloadSize = typeof message.payload.size === "number" ? message.payload.size : undefined;
    const fileName = (message.payload.name as string) ?? "未知文件";
    if (payloadSize != null) {
      log?.info?.(`dmwork: file message: ${fileName}, payload.size=${formatSize(payloadSize)}`);
    }
    const fileResult = await resolveFileContentWithRetry(
      resolved.mediaUrl,
      account.config.botToken ?? "",
      fileName,
      { knownSize: payloadSize, log },
    );
    if (fileResult && "inline" in fileResult) {
      rawBody = `[文件: ${fileName}]\n\n--- 文件内容 ---\n${fileResult.inline}\n--- 文件结束 ---`;
      inboundMediaUrl = undefined;
    } else if (fileResult && "tempPath" in fileResult) {
      // tempPath is intentionally included in the message body so the agent can read the file
      const sizeStr = payloadSize != null ? ` (${formatSize(payloadSize)})` : "";
      rawBody = `[文件: ${fileName}${sizeStr} - 已下载到本地: ${fileResult.tempPath}]`;
      inboundMediaUrl = undefined;
    } else if (fileResult && "description" in fileResult) {
      rawBody = fileResult.description;
      inboundMediaUrl = undefined;
    }
    // fileResult === null means non-text extension, keep original resolveContent result
  }

  // Media URLs are passed directly to the Agent (storage is public-read, no auth needed)

  if (!rawBody) {
    log?.info?.(
      `dmwork: inbound dropped session=${sessionId} reason=empty-content`,
    );
    return;
  }

  // Extract quoted/replied message content if present
  let quotePrefix = "";
  const replyData = message.payload?.reply;
  if (replyData) {
    const replyPayload = replyData.payload;
    const replyContent = replyPayload?.content ?? (replyPayload ? resolveContentText(replyPayload, account.config.apiUrl) : "");
    const replyFrom = replyData.from_uid ?? replyData.from_name ?? "unknown";
    if (replyContent) {
      quotePrefix = `[Quoted message from ${replyFrom}]: ${replyContent}\n---\n`;
      log?.info?.(`dmwork: message quotes a reply (${quotePrefix.length} chars)`);
    }
    // Cache reply sender name for uid→name resolution (opportunistic fill)
    if (replyData.from_uid && replyData.from_name) {
      uidToNameMap.set(replyData.from_uid, replyData.from_name);
    }
  }

  // --- Mention gating for group messages ---
  const requireMention = account.config.requireMention !== false;
  let historyPrefix = "";

  // Save original mention uids for reply (exclude bot itself)
  const originalMentionUids: string[] = (message.payload?.mention?.uids ?? []).filter((uid: string) => uid !== botUid);

    // Refresh group member cache if needed (on first message or after expiry)
  // Use parent groupNo for member cache API calls (thread channelIds are compound)
  const memberCacheGroupNo = isGroup
    ? extractParentGroupNo(message.channel_id!)
    : sessionId;
  if (isGroup) {
    await refreshGroupMemberCache({ sessionId: memberCacheGroupNo, memberMap, uidToNameMap, groupCacheTimestamps, apiUrl: account.config.apiUrl, botToken: account.config.botToken ?? "", log });
  }

  // Compute isMentioned at top level so it's available for WasMentioned in finalizeInboundContext
  let isMentioned = false;
  if (isGroup) {
    const mentionUids = extractMentionUids(message.payload?.mention);
    const mentionAllRaw = message.payload?.mention?.all;
    const mentionAll: boolean = mentionAllRaw === true || mentionAllRaw === 1;
    isMentioned = mentionAll || mentionUids.includes(botUid);
  }

  if (isGroup && requireMention) {
    // Debug: log received mention info
    log?.debug?.(`dmwork: [RECV] mention payload: isMentioned=${isMentioned}, originalCount=${originalMentionUids.length}`);

    if (!isMentioned) {
      // Record as pending history context (manual — avoids SDK format incompatibility)
      if (!groupHistories.has(sessionId)) {
        groupHistories.set(sessionId, []);
      }
      const entries = groupHistories.get(sessionId)!;
      entries.push({
        sender: message.from_uid,
        body: rawBody,
        mention: message.payload?.mention,
        mediaUrl: inboundMediaUrl,
        msgType: message.payload?.type,
        timestamp: message.timestamp ? message.timestamp * 1000 : Date.now(),
      });
      const historyLimit = account.config.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT;
      while (entries.length > historyLimit) {
        entries.shift();
      }
      log?.info?.(
        `dmwork: [HISTORY] 非@消息已缓存 | from=${message.from_uid} | session=${sessionId} | 当前缓存=${entries.length}条`,
      );
      return;
    }

    // Bot IS mentioned — prepend history context (manual — avoids SDK format incompatibility)
    // Sliding window: always include the most recent historyLimit messages
    const historyLimit = account.config.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT;
    let entries = groupHistories.get(sessionId) ?? [];
    // Take last N entries (sliding window)
    if (entries.length > historyLimit) {
      entries = entries.slice(-historyLimit);
      groupHistories.set(sessionId, entries); // Persist trimmed array to prevent unbounded growth
    }
    const historyCountBefore = entries.length;
    log?.info?.(`dmwork: [MENTION] 收到@消息 | 缓存=${historyCountBefore}条 | historyLimit=${historyLimit}`);

    // If memory cache is empty or insufficient, try fetching from API
    const cacheInsufficient = entries.length < Math.ceil(historyLimit / 2);
    if (cacheInsufficient && account.config.botToken) {
      log?.info?.(`dmwork: [MENTION] 缓存不足(${entries.length}/${historyLimit})，从API补充历史...`);
      try {
        const fetchLimit = Math.min(historyLimit, 100);  // Cap at 100
        const apiMessages = await getChannelMessages({
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken,
          channelId: message.channel_id!,
          channelType: message.channel_type ?? ChannelType.Group,
          limit: fetchLimit,
          log,
        });
        const filteredApiMsgs = apiMessages
          .filter((m: any) => m.from_uid !== botUid && (m.content || m.type !== 1))
          .slice(-historyLimit);
        entries = filteredApiMsgs.map((m: any) => {
          let body = m.content || resolveApiMessagePlaceholder(m.type, m.name);
          // For MultipleForward, expand the nested messages from full payload
          if (m.type === MessageType.MultipleForward && m.payload) {
            body = resolveMultipleForwardText(m.payload, account.config.apiUrl, account.config.cdnUrl);
          }
          const entry: any = {
            sender: m.from_uid,
            body,
            mention: m.payload?.mention,
            msgType: m.type,
            timestamp: m.timestamp,
          };
          // For media message types, resolve the URL directly (storage is public-read)
          const mediaTypes = [MessageType.Image, MessageType.File, MessageType.Voice, MessageType.Video];
          if (mediaTypes.includes(m.type) && !m.content) {
            const apiResolved = resolveContent({ type: m.type, url: m.url, name: m.name } as any, account.config.apiUrl, log, account.config.cdnUrl);
            if (apiResolved.mediaUrl) {
              entry.mediaUrl = apiResolved.mediaUrl;
              entry.body = apiResolved.text;
            }
          }
          return entry;
        });
        log?.info?.(`dmwork: [MENTION] 从API获取到 ${entries.length} 条历史消息`);
      } catch (err) {
        log?.error?.(`dmwork: [MENTION] 从API获取历史失败: ${err}`);
      }
    }

    // Build history context manually (JSON format)
    // History media URLs are kept in the text body only — not passed as MediaUrls
    // to Core (they are remote URLs; only local paths should go through MediaUrls)
    if (entries.length > 0) {
      const messagesJson = JSON.stringify(entries.map((e: any) => {
        // Convert @name → @[uid:name] for LLM context
        const bodyForLLM = e.mention
          ? convertContentForLLM(e.body, e.mention, memberMap)
          : e.body;
        // sender format: displayName(uid)
        const senderLabel = buildSenderPrefix(e.sender, uidToNameMap);
        return {
          sender: senderLabel,
          body: bodyForLLM,
          ...(e.mediaUrl ? { mediaUrl: e.mediaUrl } : {}),
        };
      }), null, 2);
      const template = account.config.historyPromptTemplate || DEFAULT_HISTORY_PROMPT_TEMPLATE;
      historyPrefix = template
        .replace("{messages}", messagesJson)
        .replace("{count}", String(entries.length));
      log?.info?.(`dmwork: [MENTION] 已注入历史上下文 | ${historyPrefix.length} chars | ${entries.length}条消息`);
    } else {
      log?.info?.(`dmwork: [MENTION] 无历史上下文可注入`);
    }

    // Sliding window: keep history, don't clear
    // (entries stay in queue, limited by historyLimit in the caching logic)
    log?.info?.(`dmwork: [MENTION] 历史滑动窗口 | session=${sessionId} | 队列保留`);
  }

  const core = getDmworkRuntime();
  if (!core?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    log?.error?.(`dmwork: OpenClaw runtime missing required functions. Available: config=${!!core?.config}, channel=${!!core?.channel}, reply=${!!core?.channel?.reply}, routing=${!!core?.channel?.routing}, session=${!!core?.channel?.session}`);
    log?.error?.(`dmwork: reply methods: ${core?.channel?.reply ? Object.keys(core.channel.reply).join(",") : "N/A"}`);
    log?.error?.(`dmwork: session methods: ${core?.channel?.session ? Object.keys(core.channel.session).join(",") : "N/A"}`);
    log?.error?.(`dmwork: routing methods: ${core?.channel?.routing ? Object.keys(core.channel.routing).join(",") : "N/A"}`);
    return;
  }
  
  const config = core.config.loadConfig() as OpenClawConfig;

  let route;
  try {
    route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "dmwork",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: sessionId,
    },
  });

  } catch (routeErr) {
    log?.error?.(`dmwork: resolveAgentRoute failed: ${String(routeErr)}`);
    return;
  }

  // Fire-and-forget: ensure GROUP.md is cached for this group
  if (isGroup && message.channel_id) {
    const _parentGroupNo = extractParentGroupNo(message.channel_id);
    const _threadShortId = extractThreadShortId(message.channel_id);

    // Always ensure group-level GROUP.md is cached
    ensureGroupMd({
      agentId: route.agentId,
      accountId: account.accountId,
      groupNo: _parentGroupNo,
      apiUrl: account.config.apiUrl,
      botToken: account.config.botToken ?? "",
      log,
    }).catch((err) => log?.warn?.(`dmwork: [GROUP.md] ensureGroupMd failed: ${String(err)}`));

    // For thread messages, also ensure thread-level THREAD.md is cached
    if (_threadShortId) {
      ensureThreadMd({
        agentId: route.agentId,
        accountId: account.accountId,
        groupNo: _parentGroupNo,
        shortId: _threadShortId,
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken ?? "",
        log,
      }).catch((err) => log?.warn?.(`dmwork: [THREAD.md] ensureThreadMd failed: ${String(err)}`));
    }
  }

  const fromLabel = isGroup
    ? `group:${message.channel_id}`
    : spaceId ? `space:${spaceId}:user:${message.from_uid}` : `user:${message.from_uid}`;

  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Inject member list for group messages to help LLM learn @[uid:name] format
  const memberListPrefix = isGroup ? buildMemberListPrefix(uidToNameMap) : "";

  const finalBody = (memberListPrefix || historyPrefix || quotePrefix)
    ? (memberListPrefix + historyPrefix + quotePrefix + rawBody)
    : rawBody;

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "DMWork",
    from: fromLabel,
    timestamp: message.timestamp ? message.timestamp * 1000 : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: finalBody,
  });

  // Inject GROUP.md as GroupSystemPrompt for group messages
  const groupSystemPrompt = isGroup && groupMdCache && message.channel_id
    ? groupMdCache.get(extractParentGroupNo(message.channel_id))?.content
    : undefined;

  // Resolve sender display name — async fallback for DM users not in cache
  let senderName = resolveSenderName(message.from_uid, uidToNameMap);
  if (!senderName && !isGroup) {
    // DM user not in any group cache — try backend user info API
    // Skip if we already tried and failed (negative cache sentinel "")
    const cached = uidToNameMap.get(message.from_uid);
    if (cached === undefined) {
      const userInfo = await fetchUserInfo({
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken ?? "",
        uid: message.from_uid,
        log,
      });
      if (userInfo?.name) {
        senderName = userInfo.name;
        uidToNameMap.set(message.from_uid, userInfo.name);
      } else {
        // Negative cache — prevent repeated API calls for unknown UIDs
        uidToNameMap.set(message.from_uid, "");
      }
    }
  }

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: body,  // ← 关键！AI 实际读取的是这个字段！
    RawBody: rawBody,
    CommandBody: rawBody,
    MediaUrl: isFileMessage ? undefined : inboundMediaUrl,
    MediaUrls: (() => {
      // Only pass current message's local media path (no remote history URLs)
      const current = isFileMessage ? undefined : inboundMediaUrl;
      return current ? [current] : undefined;
    })(),
    MediaTypes: resolved.mediaType ? [resolved.mediaType] : undefined,
    From: `dmwork:${message.from_uid}`,
    To: `dmwork:${sessionId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderId: message.from_uid,
    SenderName: senderName,
    SenderUsername: message.from_uid,
    WasMentioned: isGroup ? isMentioned : undefined,
    MessageSid: String(message.message_id),
    Timestamp: message.timestamp ? message.timestamp * 1000 : undefined,
    GroupSubject: isGroup ? message.channel_id : undefined,
    GroupSystemPrompt: groupSystemPrompt,
    Provider: "dmwork",
    Surface: "dmwork",
    OriginatingChannel: "dmwork",
    OriginatingTo: `dmwork:${sessionId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      log?.error?.(`dmwork: failed updating session meta: ${String(err)}`);
    },
  });

  statusSink?.({ lastInboundAt: Date.now(), lastError: null });

  const replyChannelId = isGroup ? message.channel_id! : message.from_uid;
  const replyChannelType = isGroup ? (message.channel_type ?? ChannelType.Group) : ChannelType.DM;

  // 已读回执 + 正在输入 — fire-and-forget
  log?.info?.(`dmwork: sending readReceipt+typing to channel=${replyChannelId} type=${replyChannelType} apiUrl=${account.config.apiUrl}`);
  const messageIds = message.message_id ? [message.message_id] : [];
  sendReadReceipt({ apiUrl: account.config.apiUrl, botToken: account.config.botToken ?? "", channelId: replyChannelId, channelType: replyChannelType, messageIds })
    .then(() => log?.info?.("dmwork: readReceipt sent OK"))
    .catch((err) => log?.error?.(`dmwork: readReceipt failed: ${String(err)}`));
  sendTyping({ apiUrl: account.config.apiUrl, botToken: account.config.botToken ?? "", channelId: replyChannelId, channelType: replyChannelType })
    .then(() => log?.info?.("dmwork: typing sent OK"))
    .catch((err) => log?.error?.(`dmwork: typing failed: ${String(err)}`));

  const apiUrl = account.config.apiUrl;
  const botToken = account.config.botToken ?? "";

  // Keep sending typing indicator while AI is processing
  const typingInterval = setInterval(() => {
    sendTyping({ apiUrl, botToken, channelId: replyChannelId, channelType: replyChannelType }).catch(() => {});
  }, 5000);

  // Streaming state
  let streamNo: string | undefined;
  let streamFailed = false;

  try {
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    replyOptions: {
      onPartialReply: async (partial: { text?: string; mediaUrls?: string[] }) => {
        if (streamFailed) return;
        let text = partial.text?.trim();
        if (!text) return;
        // Convert @[uid:name] → @name for display (no entities — streaming should not trigger notifications)
        if (isGroup) {
          const structuredMentions = parseStructuredMentions(text);
          if (structuredMentions.length > 0) {
            const validUids = new Set(uidToNameMap.keys());
            const converted = convertStructuredMentions(text, structuredMentions, validUids);
            text = converted.content;
          }
        }
        try {
          if (!streamNo) {
            // Start stream
            const payloadB64 = Buffer.from(JSON.stringify({ type: 1, content: text })).toString("base64");
            const result = await postJson<{ stream_no: string }>(apiUrl, botToken, "/v1/bot/stream/start", {
              channel_id: replyChannelId,
              channel_type: replyChannelType,
              payload: payloadB64,
            });
            streamNo = result?.stream_no;
            log?.info?.(`dmwork: stream started: ${streamNo}`);
          } else {
            // Continue stream
            await sendMessage({
              apiUrl,
              botToken,
              channelId: replyChannelId,
              channelType: replyChannelType,
              content: text,
              streamNo,
            });
          }
        } catch (err) {
          log?.error?.(`dmwork: stream partial failed, falling back to deliver: ${String(err)}`);
          streamFailed = true;
        }
      },
    },
    dispatcherOptions: {
      deliver: async (payload: {
        text?: string;
        mediaUrls?: string[];
        mediaUrl?: string;
        replyToId?: string | null;
      }) => {
        // Resolve outbound media URLs
        const outboundMediaUrls = resolveOutboundMediaUrls(payload);

        // Upload and send each media file
        for (const mediaUrl of outboundMediaUrls) {
          try {
            await uploadAndSendMedia({
              mediaUrl,
              apiUrl: account.config.apiUrl,
              botToken: account.config.botToken ?? "",
              channelId: replyChannelId,
              channelType: replyChannelType,
              log,
            });
          } catch (err) {
            log?.error?.(`dmwork: media send failed for ${mediaUrl}: ${String(err)}`);
          }
        }

        // If there are no media URLs, fall through to text logic; if there are, only send text if caption exists
        const content = payload.text?.trim() ?? "";
        if (!content && outboundMediaUrls.length > 0) {
          statusSink?.({ lastOutboundAt: Date.now(), lastError: null });
          return;
        }
        if (!content) return;

        // Build mentionUids + entities from @mentions in content
        // Supports both @[uid:name] (v2 structured) and @name (v1 fallback)
        let replyMentionUids: string[] = [];
        let replyMentionEntities: MentionEntity[] = [];
        let finalContent = content;

        if (isGroup) {
          const structuredMentions = parseStructuredMentions(content);

          if (structuredMentions.length > 0) {
            // v2 path: LLM used @[uid:name] format
            const validUids = new Set(uidToNameMap.keys());
            const converted = convertStructuredMentions(
              content,
              structuredMentions,
              validUids,
            );
            finalContent = converted.content;
            replyMentionEntities = [...converted.entities];

            // Mixed scenario: check for remaining @name in converted content
            const remaining = buildEntitiesFromFallback(finalContent, memberMap);
            const existingOffsets = new Set(replyMentionEntities.map((e) => e.offset));
            for (const rm of remaining.entities) {
              if (!existingOffsets.has(rm.offset)) {
                replyMentionEntities.push(rm);
              }
            }

            log?.debug?.(
              `dmwork: [REPLY] structured mentions: ${structuredMentions.length}, fallback: ${remaining.entities.length}`,
            );
          } else {
            // v1 fallback path: LLM used @name format
            // Keep existing resolveMention logic for hex uid / uid-format handling
            const contentMentions = extractMentionMatches(content);

            let unresolvedNames: { name: string; index: number }[] = [];

            const resolveMention = (name: string): { uid: string | null; newContent: string } => {
              let uid = findUidByName(name, memberMap);
              let newContent = finalContent;

              if (uid) {
                return { uid, newContent };
              } else if (/^[a-f0-9]{32}$/i.test(name)) {
                const displayName = uidToNameMap.get(name);
                if (displayName) {
                  newContent = newContent.replace(`@${name}`, `@${displayName}`);
                  return { uid: name, newContent };
                }
                return { uid: name, newContent };
              } else if (/^[a-zA-Z0-9_]+$/.test(name)) {
                const displayName = uidToNameMap.get(name);
                if (displayName) {
                  newContent = newContent.replace(`@${name}`, `@${displayName}`);
                  return { uid: name, newContent };
                }
                return { uid: name, newContent };
              }
              return { uid: null, newContent };
            };

            const resolvedUids: (string | null)[] = [];
            for (const mention of contentMentions) {
              const name = mention.slice(1);
              const result = resolveMention(name);
              finalContent = result.newContent;
              resolvedUids.push(result.uid);
              if (!result.uid) {
                unresolvedNames.push({ name, index: resolvedUids.length - 1 });
              }
            }

            if (unresolvedNames.length > 0) {
              log?.info?.(`dmwork: [REPLY] ${unresolvedNames.length} unresolved names, force refreshing cache...`);
              const refreshed = await refreshGroupMemberCache({ sessionId: memberCacheGroupNo, memberMap, uidToNameMap, groupCacheTimestamps, apiUrl: account.config.apiUrl, botToken: account.config.botToken ?? "", forceRefresh: true, log });
              if (refreshed) {
                for (const { name, index } of unresolvedNames) {
                  const uid = findUidByName(name, memberMap);
                  if (uid) {
                    resolvedUids[index] = uid;
                  }
                }
              }
            }

            replyMentionUids = resolvedUids.filter((uid): uid is string => uid !== null);
            // Build entities from fallback for the final content
            const fallbackResult = buildEntitiesFromFallback(finalContent, memberMap);
            replyMentionEntities = fallbackResult.entities;
          }

          // Sort entities by offset and rebuild uids from sorted entities
          if (replyMentionEntities.length > 0) {
            replyMentionEntities.sort((a, b) => a.offset - b.offset);
            replyMentionUids = replyMentionEntities.map((e) => e.uid);
          }
        }

        // Detect @all/@所有人 in final content
        const hasAtAll = /(?:^|(?<=\s))@(?:all|所有人)(?=\s|[^\w]|$)/i.test(finalContent);

        await sendMessage({
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken ?? "",
          channelId: replyChannelId,
          channelType: replyChannelType,
          content: finalContent,
          ...(replyMentionUids.length > 0 ? { mentionUids: replyMentionUids } : {}),
          ...(replyMentionEntities.length > 0 ? { mentionEntities: replyMentionEntities } : {}),
          mentionAll: hasAtAll || undefined,
        });

        statusSink?.({ lastOutboundAt: Date.now(), lastError: null });
      },
      onError: async (err: unknown, info: { kind: string }) => {
        clearInterval(typingInterval);
        log?.error?.(`dmwork ${info.kind} reply failed: ${String(err)}`);
        try {
          await sendMessage({
            apiUrl,
            botToken,
            channelId: replyChannelId,
            channelType: replyChannelType,
            content: "⚠️ 抱歉，处理您的消息时遇到了问题，请稍后重试。",
          });
        } catch (sendErr) {
          log?.error?.(`dmwork: failed to send error message: ${String(sendErr)}`);
        }
      },
    },
  });
  } finally {
    clearInterval(typingInterval);
    // End stream if one was started (skip if stream failed — deliver handles final message)
    if (streamNo && !streamFailed) {
      try {
        await postJson(apiUrl, botToken, "/v1/bot/stream/end", {
          stream_no: streamNo,
          channel_id: replyChannelId,
          channel_type: replyChannelType,
        });
        log?.info?.(`dmwork: stream ended: ${streamNo}`);
      } catch (err) {
        log?.error?.(`dmwork: stream end failed: ${String(err)}`);
      }
    }
  }
}
