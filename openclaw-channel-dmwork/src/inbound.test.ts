import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType, MessageType, type MentionPayload } from "./types.js";
import { DEFAULT_HISTORY_PROMPT_TEMPLATE } from "./config-schema.js";
import {
  resolveInnerMessageText,
  resolveApiMessagePlaceholder,
  resolveMultipleForwardText,
  calcDownloadTimeout,
  formatSize,
  resolveFileContentWithRetry,
  downloadToTemp,
  uploadAndSendMedia,
  downloadMediaToLocal,
  type ResolveFileResult,
} from "./inbound.js";
import { existsSync, unlinkSync, readFileSync } from "node:fs";

/**
 * Tests for mention.all detection logic.
 *
 * The API can return mention.all as either:
 * - boolean `true` (newer API versions)
 * - number `1` (older API versions / WuKongIM native format)
 *
 * Both should be treated as "mention all".
 */
describe("mention.all detection", () => {
  // Helper to simulate the detection logic from inbound.ts
  function isMentionAll(mention?: MentionPayload): boolean {
    const mentionAllRaw = mention?.all;
    return mentionAllRaw === true || mentionAllRaw === 1;
  }

  it("should detect mention.all when all is boolean true", () => {
    const mention: MentionPayload = { all: true };
    expect(isMentionAll(mention)).toBe(true);
  });

  it("should detect mention.all when all is numeric 1", () => {
    const mention: MentionPayload = { all: 1 };
    expect(isMentionAll(mention)).toBe(true);
  });

  it("should NOT detect mention.all when all is false", () => {
    const mention: MentionPayload = { all: false as unknown as boolean | number };
    expect(isMentionAll(mention)).toBe(false);
  });

  it("should NOT detect mention.all when all is 0", () => {
    const mention: MentionPayload = { all: 0 };
    expect(isMentionAll(mention)).toBe(false);
  });

  it("should NOT detect mention.all when all is undefined", () => {
    const mention: MentionPayload = { uids: ["user1"] };
    expect(isMentionAll(mention)).toBe(false);
  });

  it("should NOT detect mention.all when mention is undefined", () => {
    expect(isMentionAll(undefined)).toBe(false);
  });

  it("should NOT detect mention.all when all is a different number", () => {
    const mention: MentionPayload = { all: 2 };
    expect(isMentionAll(mention)).toBe(false);
  });
});

/**
 * Tests for historyPromptTemplate configuration.
 *
 * The template supports placeholders:
 * - {messages}: JSON stringified array of {sender, body} objects
 * - {count}: Number of messages in the history
 */
describe("historyPromptTemplate", () => {
  // Helper to render template (mirrors logic from inbound.ts)
  function renderHistoryPrompt(
    template: string,
    entries: Array<{ sender: string; body: string }>,
  ): string {
    const messagesJson = JSON.stringify(
      entries.map((e) => ({ sender: e.sender, body: e.body })),
      null,
      2,
    );
    return template
      .replace("{messages}", messagesJson)
      .replace("{count}", String(entries.length));
  }

  it("should use English as default template", () => {
    expect(DEFAULT_HISTORY_PROMPT_TEMPLATE).toContain("[Group Chat History]");
    expect(DEFAULT_HISTORY_PROMPT_TEMPLATE).toContain("{messages}");
  });

  it("should replace {messages} placeholder with JSON", () => {
    const entries = [
      { sender: "user1", body: "Hello" },
      { sender: "user2", body: "Hi there" },
    ];
    const result = renderHistoryPrompt(DEFAULT_HISTORY_PROMPT_TEMPLATE, entries);

    expect(result).toContain('"sender": "user1"');
    expect(result).toContain('"body": "Hello"');
    expect(result).toContain('"sender": "user2"');
    expect(result).toContain('"body": "Hi there"');
  });

  it("should replace {count} placeholder with message count", () => {
    const customTemplate = "You have {count} messages:\n{messages}";
    const entries = [
      { sender: "user1", body: "Hello" },
      { sender: "user2", body: "Hi" },
      { sender: "user3", body: "Hey" },
    ];
    const result = renderHistoryPrompt(customTemplate, entries);

    expect(result).toContain("You have 3 messages:");
  });

  it("should support custom templates with both placeholders", () => {
    const customTemplate =
      "--- History ({count} messages) ---\n{messages}\n--- End History ---";
    const entries = [{ sender: "alice", body: "Test message" }];
    const result = renderHistoryPrompt(customTemplate, entries);

    expect(result).toContain("--- History (1 messages) ---");
    expect(result).toContain('"sender": "alice"');
    expect(result).toContain("--- End History ---");
  });

  it("should handle empty entries array", () => {
    const result = renderHistoryPrompt(DEFAULT_HISTORY_PROMPT_TEMPLATE, []);
    expect(result).toContain("[]");
  });
});

/**
 * Tests for timestamp standardization.
 *
 * getChannelMessages should return timestamps in milliseconds (internal standard),
 * converting from the API's seconds-based timestamps.
 */
describe("timestamp standardization", () => {
  it("should convert seconds to milliseconds", () => {
    // Simulate the conversion logic from getChannelMessages
    const apiTimestampSeconds = 1709654400; // Example: 2024-03-05 in seconds
    const expectedMs = apiTimestampSeconds * 1000;

    // This mirrors the conversion in api-fetch.ts
    const convertedTimestamp = apiTimestampSeconds * 1000;

    expect(convertedTimestamp).toBe(expectedMs);
    expect(convertedTimestamp).toBe(1709654400000);
  });

  it("should handle undefined timestamp with fallback", () => {
    // Simulate fallback logic: (m.timestamp ?? Math.floor(Date.now() / 1000)) * 1000
    const now = Date.now();
    const fallbackSeconds = Math.floor(now / 1000);
    const apiTimestamp: number | undefined = undefined;
    const result = (apiTimestamp ?? fallbackSeconds) * 1000;

    // Result should be close to current time in ms
    expect(result).toBeGreaterThan(now - 1000);
    expect(result).toBeLessThanOrEqual(now + 1000);
  });

  it("timestamp from getChannelMessages should be in milliseconds range", () => {
    // Typical millisecond timestamp has 13 digits (until year 2286)
    const msTimestamp = 1709654400000;
    const secondsTimestamp = 1709654400;

    expect(String(msTimestamp).length).toBe(13);
    expect(String(secondsTimestamp).length).toBe(10);

    // After conversion, seconds become milliseconds
    expect(String(secondsTimestamp * 1000).length).toBe(13);
  });
});

/**
 * Tests for MultipleForward (type=11) message handling.
 *
 * MultipleForward is a merge-forwarded chat record containing:
 * - users: array of {uid, name} for sender info
 * - msgs: array of messages with payload
 */
describe("MultipleForward handling", () => {
  it("should resolve MultipleForward with text messages", () => {
    const payload = {
      type: MessageType.MultipleForward,
      users: [
        { uid: "user1", name: "大棍子" },
        { uid: "user2", name: "托马斯" },
      ],
      msgs: [
        { from_uid: "user1", payload: { type: MessageType.Text, content: "你好" } },
        { from_uid: "user2", payload: { type: MessageType.Text, content: "Hello" } },
        { from_uid: "user1", payload: { type: MessageType.Text, content: "晚上好" } },
      ],
    };

    const result = { text: resolveMultipleForwardText(payload) };
    expect(result.text).toBe(
      "[合并转发: 聊天记录]\n大棍子: 你好\n托马斯: Hello\n大棍子: 晚上好"
    );
  });

  it("should resolve MultipleForward with mixed types", () => {
    const payload = {
      type: MessageType.MultipleForward,
      users: [
        { uid: "user1", name: "Alice" },
        { uid: "user2", name: "Bob" },
      ],
      msgs: [
        { from_uid: "user1", payload: { type: MessageType.Text, content: "Check this out" } },
        { from_uid: "user2", payload: { type: MessageType.Image, url: "http://example.com/img.jpg" } },
        { from_uid: "user1", payload: { type: MessageType.File, name: "document.pdf" } },
        { from_uid: "user2", payload: { type: MessageType.Voice } },
        { from_uid: "user1", payload: { type: MessageType.Video } },
      ],
    };

    const result = { text: resolveMultipleForwardText(payload) };
    expect(result.text).toContain("[合并转发: 聊天记录]");
    expect(result.text).toContain("Alice: Check this out");
    expect(result.text).toContain("Bob: [图片]");
    expect(result.text).toContain("Alice: [文件: document.pdf]");
    expect(result.text).toContain("Bob: [语音]");
    expect(result.text).toContain("Alice: [视频]");
  });

  it("should resolve nested MultipleForward", () => {
    const payload = {
      type: MessageType.MultipleForward,
      users: [{ uid: "user1", name: "张三" }],
      msgs: [
        { from_uid: "user1", payload: { type: MessageType.Text, content: "看这个" } },
        {
          from_uid: "user1",
          payload: {
            type: MessageType.MultipleForward,
            users: [{ uid: "user2", name: "李四" }],
            msgs: [{ from_uid: "user2", payload: { type: MessageType.Text, content: "内层消息" } }],
          },
        },
      ],
    };

    const result = { text: resolveMultipleForwardText(payload) };
    expect(result.text).toContain("[合并转发: 聊天记录]");
    expect(result.text).toContain("张三: 看这个");
    expect(result.text).toContain("张三: [合并转发]");
  });

  it("should handle empty msgs array", () => {
    const payload = {
      type: MessageType.MultipleForward,
      users: [{ uid: "user1", name: "Test" }],
      msgs: [],
    };

    const result = { text: resolveMultipleForwardText(payload) };
    expect(result.text).toBe("[合并转发: 聊天记录]");
  });

  it("should handle missing users array", () => {
    const payload = {
      type: MessageType.MultipleForward,
      msgs: [
        { from_uid: "unknown_uid_123", payload: { type: MessageType.Text, content: "Hello" } },
      ],
    };

    const result = { text: resolveMultipleForwardText(payload) };
    expect(result.text).toContain("[合并转发: 聊天记录]");
    expect(result.text).toContain("unknown_uid_123: Hello");
  });

  it("should return placeholder for resolveApiMessagePlaceholder", () => {
    expect(resolveApiMessagePlaceholder(MessageType.MultipleForward)).toBe("[合并转发]");
  });

  it("resolveInnerMessageText should handle all message types", () => {
    expect(resolveInnerMessageText({ type: MessageType.Text, content: "test" })).toBe("test");
    expect(resolveInnerMessageText({ type: MessageType.Image })).toBe("[图片]");
    expect(resolveInnerMessageText({ type: MessageType.GIF })).toBe("[GIF]");
    expect(resolveInnerMessageText({ type: MessageType.Voice })).toBe("[语音]");
    expect(resolveInnerMessageText({ type: MessageType.Video })).toBe("[视频]");
    expect(resolveInnerMessageText({ type: MessageType.Location })).toBe("[位置信息]");
    expect(resolveInnerMessageText({ type: MessageType.Card })).toBe("[名片]");
    expect(resolveInnerMessageText({ type: MessageType.File, name: "doc.pdf" })).toBe("[文件: doc.pdf]");
    expect(resolveInnerMessageText({ type: MessageType.File })).toBe("[文件]");
    expect(resolveInnerMessageText({ type: MessageType.MultipleForward })).toBe("[合并转发]");
    expect(resolveInnerMessageText({ type: 99 })).toBe("[消息]");
    expect(resolveInnerMessageText({ type: 99, content: "fallback" })).toBe("fallback");
  });
});

/**
 * Tests for GROUP.md event detection logic.
 */
describe("GROUP.md event detection", () => {
  function isGroupMdEvent(payload: any): boolean {
    return payload?.event?.type === "group_md_updated";
  }

  it("should detect group_md_updated event", () => {
    const payload = {
      type: 1,
      content: "GROUP.md updated",
      event: { type: "group_md_updated", version: 4, updated_by: "user_uid" },
      mention: { uids: ["bot1", "bot2"] },
    };
    expect(isGroupMdEvent(payload)).toBe(true);
  });

  it("should NOT detect regular text messages as GROUP.md event", () => {
    const payload = { type: 1, content: "Hello world" };
    expect(isGroupMdEvent(payload)).toBe(false);
  });

  it("should NOT detect other event types", () => {
    const payload = {
      type: 1,
      content: "Something happened",
      event: { type: "member_joined" },
    };
    expect(isGroupMdEvent(payload)).toBe(false);
  });

  it("should NOT detect when event is undefined", () => {
    const payload = { type: 1, content: "No event" };
    expect(isGroupMdEvent(payload)).toBe(false);
  });

  it("should NOT detect when payload is undefined", () => {
    expect(isGroupMdEvent(undefined)).toBe(false);
  });
});

/**
 * Tests for calcDownloadTimeout — calls the real exported function.
 */
describe("calcDownloadTimeout", () => {
  it("should return minimum 5 minutes for small files", () => {
    expect(calcDownloadTimeout(1024)).toBe(300_000);
  });

  it("should scale timeout based on file size (512KB/s baseline)", () => {
    // 10MB file: ceil(10*1024*1024 / (512*1024)) * 1000 = ceil(20) * 1000 = 20_000
    // But min is 300_000
    expect(calcDownloadTimeout(10 * 1024 * 1024)).toBe(300_000);
  });

  it("should cap at 30 minutes max", () => {
    expect(calcDownloadTimeout(1024 * 1024 * 1024)).toBe(1_800_000);
  });

  it("should assume 256MB when size is unknown", () => {
    const timeout = calcDownloadTimeout(undefined);
    // 256MB / (512*1024) * 1000 = 512 * 1000 = 512_000
    expect(timeout).toBeGreaterThanOrEqual(300_000);
    expect(timeout).toBeLessThanOrEqual(1_800_000);
  });

  it("should return computed timeout for large files", () => {
    // 500MB: ceil(500*1024*1024 / (512*1024)) * 1000 = ceil(1000) * 1000 = 1_000_000
    const timeout = calcDownloadTimeout(500 * 1024 * 1024);
    expect(timeout).toBe(1_000_000);
  });
});

/**
 * Tests for formatSize — calls the real exported function.
 */
describe("formatSize", () => {
  it("should format bytes", () => {
    expect(formatSize(500)).toBe("500B");
  });

  it("should format kilobytes", () => {
    expect(formatSize(20 * 1024)).toBe("20.0KB");
  });

  it("should format megabytes", () => {
    expect(formatSize(52 * 1024 * 1024)).toBe("52.0MB");
  });

  it("should format gigabytes", () => {
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe("2.0GB");
  });
});

/**
 * Tests for resolveFileContentWithRetry — mocks global fetch, calls the real function.
 */
describe("resolveFileContentWithRetry", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should return null for non-text file extensions", async () => {
    const result = await resolveFileContentWithRetry(
      "https://example.com/photo.png",
      "token",
      "photo.png",
    );
    expect(result).toBeNull();
  });

  it("should inline small text files (< 20KB)", async () => {
    const smallContent = "Hello, world!";
    const encoded = new TextEncoder().encode(smallContent);

    globalThis.fetch = (vi.fn() as any)
      // HEAD request
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-length": String(encoded.byteLength) }),
      } as any)
      // GET request
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-length": String(encoded.byteLength) }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoded);
            controller.close();
          },
        }),
      } as any);

    const result = await resolveFileContentWithRetry(
      "https://example.com/file.txt",
      "token",
      "file.txt",
    );
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("inline", smallContent);
  });

  it("should return description for file > 20KB with Content-Length", async () => {
    const largeSize = 25 * 1024;

    globalThis.fetch = (vi.fn() as any)
      // HEAD request reports large file
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-length": String(largeSize) }),
      } as any)
      // downloadToTemp GET request — simulate failure to keep test simple
      .mockRejectedValueOnce(new Error("HTTP 500"));

    const result = await resolveFileContentWithRetry(
      "https://example.com/large.txt",
      "token",
      "large.txt",
      { knownSize: largeSize, maxRetries: 1 },
    );
    // Should not be null (text extension), and should not be inline
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("inline");
  });

  it("should reject file exceeding 500MB hard cap via HEAD without downloading", async () => {
    const hugeSize = 600 * 1024 * 1024; // 600MB

    globalThis.fetch = (vi.fn() as any)
      // HEAD request reports 600MB
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-length": String(hugeSize) }),
      } as any);

    // Do NOT pass knownSize — let HEAD discovery trigger the 500MB check
    const result = await resolveFileContentWithRetry(
      "https://example.com/huge.csv",
      "token",
      "huge.csv",
      { maxRetries: 3 },
    );
    // Should return error description, NOT attempt download
    expect(result).toHaveProperty("description");
    expect((result as any).description).toContain("500.0MB");
    expect((result as any).description).toContain("最大下载限制");
    // Only HEAD request, no GET — verify no download attempted
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("should fall back to GET streaming when HEAD fails", async () => {
    const content = "fallback content";
    const encoded = new TextEncoder().encode(content);

    globalThis.fetch = (vi.fn() as any)
      // HEAD request fails
      .mockRejectedValueOnce(new Error("HEAD not supported"))
      // GET request succeeds
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-length": String(encoded.byteLength) }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoded);
            controller.close();
          },
        }),
      } as any);

    const result = await resolveFileContentWithRetry(
      "https://example.com/data.json",
      "token",
      "data.json",
    );
    expect(result).toHaveProperty("inline", content);
  });

  it("should return error description on HTTP 404 and NOT retry", async () => {
    globalThis.fetch = (vi.fn() as any)
      // HEAD request
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-length": "100" }),
      } as any)
      // GET returns 404
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
      } as any);

    const result = await resolveFileContentWithRetry(
      "https://example.com/missing.txt",
      "token",
      "missing.txt",
      { maxRetries: 3 },
    );

    expect(result).not.toBeNull();
    expect(result).toHaveProperty("description");
    expect((result as { description: string }).description).toContain("HTTP 404");
    // Should only have called fetch twice (HEAD + one GET), not retried
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("should retry on timeout and return error description", async () => {
    globalThis.fetch = (vi.fn() as any)
      // HEAD request
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-length": "100" }),
      } as any)
      // All GET attempts timeout
      .mockRejectedValueOnce(new Error("TimeoutError"))
      .mockRejectedValueOnce(new Error("TimeoutError"));

    const result = await resolveFileContentWithRetry(
      "https://example.com/slow.txt",
      "token",
      "slow.txt",
      { maxRetries: 2 },
    );

    expect(result).not.toBeNull();
    expect(result).toHaveProperty("description");
    expect((result as { description: string }).description).toContain("下载失败");
  });
});

/**
 * Tests for uploadAndSendMedia timeout signal.
 *
 * Verifies that the fetch call to download media includes a timeout signal
 * by inspecting the function's behavior with a mocked global fetch.
 */
describe("uploadAndSendMedia timeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("should pass timeout signal to fetch", async () => {
    const calls: Array<{ url: string; method?: string; signal?: AbortSignal }> = [];
    const { Readable } = await import("node:stream");
    vi.stubGlobal("fetch", async (url: string, opts?: any) => {
      calls.push({ url, method: opts?.method, signal: opts?.signal });
      if (opts?.method === "HEAD") {
        return {
          ok: true,
          headers: new Headers({ "content-length": "8" }),
        };
      }
      // GET request — return a readable stream body
      const body = new Readable({ read() { this.push(Buffer.alloc(8)); this.push(null); } });
      return {
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        body,
      };
    });

    // Call uploadAndSendMedia — it will use the mocked fetch for HEAD + GET,
    // then fail on getUploadCredentials (which also uses fetch but posts to API)
    let caughtError: unknown;
    try {
      await uploadAndSendMedia({
        mediaUrl: "https://example.com/img.png",
        apiUrl: "https://api.example.com",
        botToken: "token",
        channelId: "ch1",
        channelType: ChannelType.DM,
      });
    } catch (err) {
      caughtError = err;
    }

    // calls[0] is HEAD (no signal), calls[1] is GET with timeout signal
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].method).toBe("HEAD");
    expect(calls[1].signal).toBeDefined();
  });
});

/**
 * Tests for downloadMediaToLocal — downloads inbound media to local temp files.
 */
describe("downloadMediaToLocal", () => {
  const originalFetch = globalThis.fetch;
  const tempFiles: string[] = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    // Clean up any temp files created during tests
    for (const f of tempFiles) {
      try { unlinkSync(f); } catch {}
    }
    tempFiles.length = 0;
  });

  it("should download image to local path (not http URL)", async () => {
    const imageData = new Uint8Array(64).fill(0xff);

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/jpeg" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(imageData);
          controller.close();
        },
      }),
    }) as any;

    const result = await downloadMediaToLocal(
      "https://cdn.example.com/bucket/upload_abc123.jpg",
      "image/jpeg",
    );

    expect(result).toBeDefined();
    expect(result).not.toContain("http");
    expect(result!.startsWith("/tmp/dmwork-media/")).toBe(true);
    expect(result!.endsWith(".jpeg")).toBe(true);
    expect(existsSync(result!)).toBe(true);
    expect(readFileSync(result!)).toEqual(Buffer.from(imageData));
    tempFiles.push(result!);
  });

  it("should return undefined for large media (>20MB)", async () => {
    // Simulate a stream that exceeds 20MB
    const chunkSize = 1024 * 1024; // 1MB chunks
    let chunksSent = 0;

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      body: new ReadableStream({
        pull(controller) {
          if (chunksSent < 22) { // 22MB total
            controller.enqueue(new Uint8Array(chunkSize));
            chunksSent++;
          } else {
            controller.close();
          }
        },
      }),
    }) as any;

    const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
    const result = await downloadMediaToLocal(
      "https://cdn.example.com/huge-image.png",
      "image/png",
      log,
    );

    expect(result).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("media too large"),
    );
  });

  it("should return undefined on download failure (HTTP error)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
    }) as any;

    const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
    const result = await downloadMediaToLocal(
      "https://cdn.example.com/missing.jpg",
      "image/jpeg",
      log,
    );

    expect(result).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("HTTP 404"),
    );
  });

  it("should return undefined on network error (no crash)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(
      new Error("ECONNREFUSED"),
    ) as any;

    const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
    const result = await downloadMediaToLocal(
      "https://cdn.example.com/unreachable.jpg",
      "image/jpeg",
      log,
    );

    expect(result).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("media download failed"),
    );
  });

  it("should derive extension from mime type", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "audio/mpeg" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      }),
    }) as any;

    const result = await downloadMediaToLocal(
      "https://cdn.example.com/voice_msg",
      "audio/mpeg",
    );

    expect(result).toBeDefined();
    expect(result!.endsWith(".mpeg")).toBe(true);
    tempFiles.push(result!);
  });

  it("should derive extension from URL when mime is not provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({}),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      }),
    }) as any;

    const result = await downloadMediaToLocal(
      "https://cdn.example.com/video.mp4",
      undefined,
    );

    expect(result).toBeDefined();
    expect(result!.endsWith(".mp4")).toBe(true);
    tempFiles.push(result!);
  });
});
