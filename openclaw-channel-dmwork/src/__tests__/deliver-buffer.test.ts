import { describe, it, expect, vi } from "vitest";

/**
 * Unit tests for the deliver buffer pattern used in handleInboundMessage.
 *
 * The deliver callback is a closure inside handleInboundMessage, so we
 * extract and test the core logic via pure helper functions that mirror
 * the production behavior:
 *
 * - Text payloads are buffered (each deliver call overwrites the previous)
 * - Media payloads are sent immediately with dedup via sentMediaUrls
 * - After the dispatcher finishes, the finally block sends the last buffered text
 * - If onError fires, it clears the buffer to prevent stale text from being sent
 */

// ---- helpers that mirror the production logic in inbound.ts ----

function createDeliverBuffer() {
  return {
    lastText: null as string | null,
    textSent: false,
  };
}

function makeDeliver(
  deliverBuffer: ReturnType<typeof createDeliverBuffer>,
  sentMediaUrls: Set<string>,
  sendMediaFn: (url: string) => Promise<void>,
) {
  return async (payload: {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
  }) => {
    // Media: send immediately with dedup
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

    // Text: buffer only
    const content = payload.text?.trim() ?? "";
    if (!content && outboundMediaUrls.length > 0) return;
    if (!content) return;
    deliverBuffer.lastText = content;
  };
}

function makeOnError(
  deliverBuffer: ReturnType<typeof createDeliverBuffer>,
  sendErrorFn: () => Promise<void>,
) {
  return async (_err: unknown) => {
    deliverBuffer.lastText = null;
    await sendErrorFn();
  };
}

async function runFinally(
  deliverBuffer: ReturnType<typeof createDeliverBuffer>,
  sendTextFn: (text: string) => Promise<void>,
) {
  if (deliverBuffer.lastText && !deliverBuffer.textSent) {
    deliverBuffer.textSent = true;
    await sendTextFn(deliverBuffer.lastText);
  }
}

// ---- tests ----

describe("deliver buffer pattern", () => {
  it("normal flow: multiple deliver calls buffer text, finally sends only the last", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia);

    // Simulate dispatcher calling deliver multiple times with progressive text
    await deliver({ text: "Hello" });
    await deliver({ text: "Hello, how are you" });
    await deliver({ text: "Hello, how are you? I'm here to help." });

    // Text should NOT have been sent yet
    expect(sendText).not.toHaveBeenCalled();
    expect(deliverBuffer.lastText).toBe("Hello, how are you? I'm here to help.");

    // Simulate finally block
    await runFinally(deliverBuffer, sendText);

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("Hello, how are you? I'm here to help.");
    expect(deliverBuffer.textSent).toBe(true);
  });

  it("onError clears buffer so finally does not send stale text", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendError = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia);
    const onError = makeOnError(deliverBuffer, sendError);

    // Partial text buffered before error
    await deliver({ text: "Partial response from AI..." });
    expect(deliverBuffer.lastText).toBe("Partial response from AI...");

    // onError fires
    await onError(new Error("AI generation failed"));

    expect(deliverBuffer.lastText).toBeNull();
    expect(sendError).toHaveBeenCalledTimes(1);

    // finally block — should NOT send anything
    await runFinally(deliverBuffer, sendText);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("media is sent immediately via deliver, not buffered", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia);

    await deliver({ mediaUrl: "https://example.com/img1.png" });
    await deliver({
      mediaUrls: [
        "https://example.com/img2.png",
        "https://example.com/img3.png",
      ],
    });

    // Media sent immediately — three calls total
    expect(sendMedia).toHaveBeenCalledTimes(3);
    expect(sendMedia).toHaveBeenCalledWith("https://example.com/img1.png");
    expect(sendMedia).toHaveBeenCalledWith("https://example.com/img2.png");
    expect(sendMedia).toHaveBeenCalledWith("https://example.com/img3.png");

    // No text was buffered
    expect(deliverBuffer.lastText).toBeNull();

    // finally should not send text
    await runFinally(deliverBuffer, sendText);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("sentMediaUrls dedup: same URL is not sent twice", async () => {
    const deliverBuffer = createDeliverBuffer();
    const sentMediaUrls = new Set<string>();
    const sendMedia = vi.fn().mockResolvedValue(undefined);
    const deliver = makeDeliver(deliverBuffer, sentMediaUrls, sendMedia);

    await deliver({ mediaUrl: "https://example.com/img.png" });
    await deliver({ mediaUrl: "https://example.com/img.png" });

    // Only one call — second was deduped
    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(sentMediaUrls.size).toBe(1);
  });
});
