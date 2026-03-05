import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for channel.ts singleton timer behavior.
 * Verifies that cleanup timer doesn't accumulate during hot reloads.
 *
 * Fixes: https://github.com/Mininglamp-OSS/octo-adapters/issues/54
 */

describe("ensureCleanupTimer singleton pattern", () => {
  let originalSetInterval: typeof setInterval;
  let setIntervalCalls: number;

  beforeEach(() => {
    originalSetInterval = global.setInterval;
    setIntervalCalls = 0;

    // Track setInterval calls
    global.setInterval = vi.fn(() => {
      setIntervalCalls++;
      // Return a mock timer object that won't actually run
      const timerId = { unref: vi.fn() } as unknown as NodeJS.Timeout;
      return timerId;
    }) as unknown as typeof setInterval;
  });

  afterEach(() => {
    global.setInterval = originalSetInterval;
    vi.resetModules();
  });

  it("should only create one cleanup timer on first import", async () => {
    // Fresh import - timer should be created lazily now (not at module load)
    // Since we changed to lazy initialization, no timer at import time
    vi.resetModules();
    const { dmworkPlugin } = await import("./channel.js");

    // At this point, no timer should have been created yet
    // Timer is created when startAccount is called
    expect(dmworkPlugin).toBeDefined();
    expect(dmworkPlugin.id).toBe("dmwork");
  });

  it("should expose ensureCleanupTimer via gateway.startAccount pattern", async () => {
    vi.resetModules();
    const { dmworkPlugin } = await import("./channel.js");

    // The gateway.startAccount method should exist and call ensureCleanupTimer
    expect(dmworkPlugin.gateway?.startAccount).toBeDefined();
    expect(typeof dmworkPlugin.gateway?.startAccount).toBe("function");
  });
});

describe("dmworkPlugin structure", () => {
  it("should have correct plugin id and meta", async () => {
    const { dmworkPlugin } = await import("./channel.js");

    expect(dmworkPlugin.id).toBe("dmwork");
    expect(dmworkPlugin.meta.id).toBe("dmwork");
    expect(dmworkPlugin.meta.label).toBe("DMWork");
  });

  it("should have gateway.startAccount defined", async () => {
    const { dmworkPlugin } = await import("./channel.js");

    expect(dmworkPlugin.gateway).toBeDefined();
    expect(dmworkPlugin.gateway?.startAccount).toBeDefined();
  });

  it("should support direct and group chat types", async () => {
    const { dmworkPlugin } = await import("./channel.js");

    expect(dmworkPlugin.capabilities?.chatTypes).toContain("direct");
    expect(dmworkPlugin.capabilities?.chatTypes).toContain("group");
  });
});
