import { describe, it, expect, vi } from "vitest";

/**
 * Unit tests for the deliver buffer pattern used in handleInboundMessage.
 *
 * The deliver callback dispatches by `info.kind`:
 *   - "tool"  → send immediately via sendTextFn (verbose tool output)
 *   - "block" → push into blockChunks (streaming fragment, joined with "")
 *   - "final" / unknown → push into finals (independent payload, joined with "\n\n")
 *   - isReasoning payloads are skipped entirely
 *   - media payloads are sent immediately with dedup
 *
 * After the dispatcher finishes, `flushBufferedText` joins blockChunks (no separator,
 * stream semantics) and finals (blank-line separator, payload semantics), and sends
 * everything once. `onError` flushes whatever was buffered first, then sends a
 * generic error notice.
 *
 * This mirrors the production logic in inbound.ts; if you change one, change the other.
 */

// ---- helpers that mirror the production logic in inbound.ts ----

function createDeliverBuffer() {
  return {
    blockChunks: [] as string[],
    finals: [] as string[],
    textSent: false,
  };
}

function makeFlushBufferedText(
  deliverBuffer: ReturnType<typeof createDeliverBuffer>,
  sendTextFn: (text: string) => Promise<void>,
) {
  return async (_reason: "finally" | "on-error"): Promise<void> => {
    if (deliverBuffer.textSent) return;
    const blockText = deliverBuffer.blockChunks.join("");
    const finalText = deliverBuffer.finals.join("\n\n");
    const parts = [blockText, finalText].filter((s) => s.length > 0);
    if (parts.length === 0) return;
    deliverBuffer.textSent = true;
    await sendTextFn(parts.join("\n\n"));
  };
}

function makeDeliver(
  deliverBuffer: ReturnType<typeof createDeliverBuffer>,
  sentMediaUrls: Set<string>,
  sendMediaFn: (url: string) => Promise<void>,
  sendTextFn: (text: string) => Promise<void>,
) {
  return async (
    payload: {
      text?: string;
      mediaUrls?: string[];
      mediaUrl?: string;
      isReasoning?: boolean;
    },
    info?: { kind?: string },
  ) => {
    if (payload.isReasoning) return;

    const kind = info?.kind ?? "final";

    const outboundMediaUrls = [
      ...(payload.mediaUrls ?? []),
      ...(payload.mediaUrl ? [payload.mediaUrl] : []),
    ].filter(Boolean);

    for (const url of outboundMediaUrls) {
      if (sentMediaUrls.has(url)) continue;
      try {
        await sendMediaFn(url);
        sentMediaUrls.add(url);
      } catch {
        // Failed media is NOT added to sentMediaUrls — can be retried
      }
    }

    const content = (payload.text ?? "").trim();
    const rawText = payload.text ?? "";
    if (!content && outboundMediaUrls.length > 0) return;
    if (!content) return;

    if (kind === "tool") {
      await sendTextFn(content);
      return;
    }

    if (kind === "block") {
      // Preserve raw text (including spaces) so join("") recovers the original stream.
      deliverBuffer.blockChunks.push(rawText);
      return;
    }

    // "final" or unknown kinds — trim, independent payloads
    deliverBuffer.finals.push(content);
  };
}

function makeOnError(
  deliverBuffer: ReturnType<typeof createDeliverBuffer>,
  flushBufferedText: (reason: "finally" | "on-error") => Promise<void>,
  sendErrorFn: () => Promise<void>,
) {
  return async (_err: unknown) => {
    // Try to flush already-buffered partial output first; do NOT discard.
    await flushBufferedText("on-error");
    deliverBuffer.textSent = true;
    await sendErrorFn();
  };
}

// ---- tests ----

describe("deliver buffer pattern", () => {
  it("multiple blocks: all chunks accumulate, finally joins them with no separator", async () => {
    // Regression: 0.6.4 only kept the LAST block, dropping every prior chunk.
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);

    // Streaming fragments — each block is a NEW slice of text, not a snapshot.
    await deliver({ text: "Hello, " }, { kind: "block" });
    await deliver({ text: "world! " }, { kind: "block" });
    await deliver({ text: "This is a test." }, { kind: "block" });

    // Nothing sent yet
    expect(sendText).not.toHaveBeenCalled();
    expect(deliverBuffer.blockChunks).toHaveLength(3);
    expect(deliverBuffer.textSent).toBe(false);

    // finally → joined with "" (stream semantics)
    await flush("finally");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("Hello, world! This is a test.");
    expect(deliverBuffer.textSent).toBe(true);
  });

  it("single final: buffered, sent via finally", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);

    await deliver({ text: "Final answer" }, { kind: "final" });

    expect(sendText).not.toHaveBeenCalled();
    expect(deliverBuffer.finals).toEqual(["Final answer"]);

    await flush("finally");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("Final answer");
  });

  it("multiple finals: each independent payload, joined with blank lines", async () => {
    // Regression: 0.6.4 only kept the LAST final.
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);

    await deliver({ text: "First reply" }, { kind: "final" });
    await deliver({ text: "Second reply" }, { kind: "final" });

    expect(sendText).not.toHaveBeenCalled();
    expect(deliverBuffer.finals).toHaveLength(2);

    await flush("finally");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("First reply\n\nSecond reply");
  });

  it("blocks then final: stream concatenated then final separated by blank line", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);

    await deliver({ text: "Working on it" }, { kind: "block" });
    await deliver({ text: "..." }, { kind: "block" });
    await deliver({ text: "Done!" }, { kind: "final" });

    await flush("finally");
    expect(sendText).toHaveBeenCalledTimes(1);
    // block stream → "Working on it..."  ; then final → "Done!"
    expect(sendText).toHaveBeenCalledWith("Working on it...\n\nDone!");
  });

  it("tool kind: sends text immediately, does not affect buffer", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);

    await deliver({ text: "Tool output: file listing..." }, { kind: "tool" });

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("Tool output: file listing...");
    expect(deliverBuffer.textSent).toBe(false);
    expect(deliverBuffer.blockChunks).toEqual([]);
    expect(deliverBuffer.finals).toEqual([]);
  });

  it("tool then block + final: tool sent immediately, blocks/final flushed by finally", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);

    await deliver({ text: "🔧 exec: ls" }, { kind: "tool" });
    expect(sendText).toHaveBeenCalledTimes(1);

    await deliver({ text: "Checking files" }, { kind: "block" });
    await deliver({ text: "..." }, { kind: "block" });
    await deliver({ text: "Here are your files: ..." }, { kind: "final" });
    expect(sendText).toHaveBeenCalledTimes(1); // still 1; blocks/final pending

    await flush("finally");
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenLastCalledWith("Checking files...\n\nHere are your files: ...");
  });

  it("undefined kind falls back to final-style accumulation", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);

    await deliver({ text: "Fallback text" }); // no info at all → defaults to "final"

    expect(deliverBuffer.finals).toEqual(["Fallback text"]);
    await flush("finally");
    expect(sendText).toHaveBeenCalledWith("Fallback text");
  });

  it("isReasoning: skips entirely for both block and final", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);

    await deliver({ text: "Internal reasoning...", isReasoning: true }, { kind: "block" });
    await deliver({ text: "More reasoning", isReasoning: true }, { kind: "final" });

    expect(deliverBuffer.blockChunks).toEqual([]);
    expect(deliverBuffer.finals).toEqual([]);

    await flush("finally");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("onError: flushes already-buffered content first, THEN sends error notice", async () => {
    // Regression: 0.6.4 nuked the buffer on any error and sent a generic message,
    // discarding partial replies the user could have seen.
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendError = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);
    const onError = makeOnError(deliverBuffer, flush, sendError);

    // Two blocks + a final arrive cleanly before the error
    await deliver({ text: "Step 1: " }, { kind: "block" });
    await deliver({ text: "Step 2 succeeded." }, { kind: "block" });
    await deliver({ text: "Summary" }, { kind: "final" });

    // Error fires
    await onError(new Error("downstream failure"));

    // Already-buffered text was flushed
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("Step 1: Step 2 succeeded.\n\nSummary");
    // Error notice was also sent
    expect(sendError).toHaveBeenCalledTimes(1);
    expect(deliverBuffer.textSent).toBe(true);
  });

  it("onError with empty buffer: only the error notice is sent", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendError = vi.fn().mockResolvedValue(undefined);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);
    const onError = makeOnError(deliverBuffer, flush, sendError);

    await onError(new Error("upstream failure"));

    expect(sendText).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledTimes(1);
    expect(deliverBuffer.textSent).toBe(true);
  });

  it("flush is idempotent: calling twice does not double-send", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);

    await deliver({ text: "hello" }, { kind: "final" });

    await flush("on-error");
    await flush("finally");

    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("dispatcher never calls deliver: finally flush is a no-op (no silent error)", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sendText = vi.fn().mockResolvedValue(undefined);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);

    await flush("finally");

    expect(sendText).not.toHaveBeenCalled();
    expect(deliverBuffer.textSent).toBe(false);
  });

  it("media is sent immediately via deliver, not buffered", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);

    await deliver({ mediaUrl: "https://example.com/img1.png" }, { kind: "final" });
    await deliver({
      mediaUrls: [
        "https://example.com/img2.png",
        "https://example.com/img3.png",
      ],
    }, { kind: "tool" });

    expect(sendMedia).toHaveBeenCalledTimes(3);
    expect(deliverBuffer.blockChunks).toEqual([]);
    expect(deliverBuffer.finals).toEqual([]);

    await flush("finally");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("sentMediaUrls dedup: same URL is not sent twice", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);

    await deliver({ mediaUrl: "https://example.com/img.png" }, { kind: "block" });
    await deliver({ mediaUrl: "https://example.com/img.png" }, { kind: "final" });

    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(sentMediaUrls.size).toBe(1);
  });
});
