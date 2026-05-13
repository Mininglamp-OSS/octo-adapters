import { describe, it, expect, vi } from "vitest";

/**
 * Unit tests for the deliver buffer pattern used in handleInboundMessage.
 *
 * The deliver callback dispatches by `info.kind`:
 *   - "tool"  → send immediately via sendTextFn (verbose tool output)
 *   - "block" → push into ordered chunks as { kind: "block" }
 *   - "final" / unknown → push into ordered chunks as { kind: "final" }
 *   - isReasoning payloads are skipped entirely
 *   - media payloads are sent immediately with dedup
 *
 * After the dispatcher finishes, `flushBufferedText` walks the ordered chunks
 * and joins them with separators chosen by adjacent kinds:
 *   - block↔block: "\n"   (matches SDK's accumulatedBlockText separator)
 *   - everything else: "\n\n"
 * `onError` flushes whatever was buffered first, then sends a generic error notice.
 *
 * This mirrors the production logic in inbound.ts; if you change one, change the other.
 *
 * SDK fact verified against openclaw 5.x dispatch-*.js:
 *   `if (accumulatedBlockText.length > 0) accumulatedBlockText += "\n";`
 *   `accumulatedBlockText += payload.text;`
 * So consecutive blocks are line-separated, not space-concatenated.
 */

// ---- helpers that mirror the production logic in inbound.ts ----

type BufferedKind = "block" | "final";

function createDeliverBuffer() {
  return {
    chunks: [] as Array<{ kind: BufferedKind; text: string }>,
    textSent: false,
  };
}

function makeFlushBufferedText(
  deliverBuffer: ReturnType<typeof createDeliverBuffer>,
  sendTextFn: (text: string) => Promise<void>,
) {
  return async (_reason: "finally" | "on-error"): Promise<void> => {
    if (deliverBuffer.textSent) return;
    if (deliverBuffer.chunks.length === 0) return;
    deliverBuffer.textSent = true;
    let combined = "";
    for (let i = 0; i < deliverBuffer.chunks.length; i++) {
      const cur = deliverBuffer.chunks[i];
      if (i === 0) {
        combined = cur.text;
      } else {
        const prev = deliverBuffer.chunks[i - 1];
        const sep = prev.kind === "block" && cur.kind === "block" ? "\n" : "\n\n";
        combined += sep + cur.text;
      }
    }
    await sendTextFn(combined);
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

    const content = payload.text?.trim() ?? "";
    if (!content && outboundMediaUrls.length > 0) return;
    if (!content) return;

    if (kind === "tool") {
      await sendTextFn(content);
      return;
    }

    const bufferedKind: BufferedKind = kind === "block" ? "block" : "final";
    deliverBuffer.chunks.push({ kind: bufferedKind, text: content });
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
  it("multiple blocks: chunks accumulate, finally joins them with \\n (SDK semantics)", async () => {
    // Regression: 0.6.4 only kept the LAST block, dropping every prior chunk.
    // Separator is "\n" (not "" or "\n\n") to match SDK's accumulatedBlockText behavior.
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);

    // Sentence-level coalesced segments — three independent paragraphs.
    await deliver({ text: "段落一" }, { kind: "block" });
    await deliver({ text: "段落二" }, { kind: "block" });
    await deliver({ text: "段落三" }, { kind: "block" });

    expect(sendText).not.toHaveBeenCalled();
    expect(deliverBuffer.chunks).toHaveLength(3);

    await flush("finally");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("段落一\n段落二\n段落三");
    expect(deliverBuffer.textSent).toBe(true);
  });

  it("block separator matches SDK: '段一' + '段二' becomes '段一\\n段二', not '段一段二'", async () => {
    // SDK fact (dispatch-*.js): accumulatedBlockText += "\n" + payload.text.
    // We must use the same separator so the user sees what SDK assembled internally.
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);

    await deliver({ text: "段一" }, { kind: "block" });
    await deliver({ text: "段二" }, { kind: "block" });
    await flush("finally");

    expect(sendText).toHaveBeenCalledWith("段一\n段二");
    expect(sendText).not.toHaveBeenCalledWith("段一段二"); // explicit anti-regression
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

    await flush("finally");
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
    await flush("finally");

    expect(sendText).toHaveBeenCalledWith("First reply\n\nSecond reply");
  });

  it("blocks then final: blocks line-separated, final blank-line-separated from blocks", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);

    await deliver({ text: "Working on it" }, { kind: "block" });
    await deliver({ text: "Almost done" }, { kind: "block" });
    await deliver({ text: "Done!" }, { kind: "final" });
    await flush("finally");

    // block↔block uses "\n"; block↔final uses "\n\n"
    expect(sendText).toHaveBeenCalledWith("Working on it\nAlmost done\n\nDone!");
  });

  it("preserves real deliver order: final-then-block edge case is not re-grouped", async () => {
    // Defensive: if SDK ever interleaves final before block, we must not silently
    // re-order the output by partitioning chunks by kind.
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);

    await deliver({ text: "Notice first" }, { kind: "final" });
    await deliver({ text: "Then a block" }, { kind: "block" });
    await deliver({ text: "Another block" }, { kind: "block" });
    await flush("finally");

    // Order preserved: final, then block-block (latter two with "\n" between them).
    expect(sendText).toHaveBeenCalledWith("Notice first\n\nThen a block\nAnother block");
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
    expect(deliverBuffer.chunks).toEqual([]);
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
    await deliver({ text: "Found 3 files" }, { kind: "block" });
    await deliver({ text: "Here are your files: ..." }, { kind: "final" });
    expect(sendText).toHaveBeenCalledTimes(1); // still 1; blocks/final pending

    await flush("finally");
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenLastCalledWith(
      "Checking files\nFound 3 files\n\nHere are your files: ...",
    );
  });

  it("undefined kind falls back to final-style accumulation", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia, sendText);
    const flush = makeFlushBufferedText(deliverBuffer, sendText);

    await deliver({ text: "Fallback text" }); // no info at all → defaults to "final"

    expect(deliverBuffer.chunks).toEqual([{ kind: "final", text: "Fallback text" }]);
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

    expect(deliverBuffer.chunks).toEqual([]);
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
    await deliver({ text: "Step 1" }, { kind: "block" });
    await deliver({ text: "Step 2 succeeded" }, { kind: "block" });
    await deliver({ text: "Summary" }, { kind: "final" });

    await onError(new Error("downstream failure"));

    // Already-buffered text was flushed (with correct separators)
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("Step 1\nStep 2 succeeded\n\nSummary");
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
    expect(deliverBuffer.chunks).toEqual([]);

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
