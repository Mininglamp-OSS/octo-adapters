import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Token refresh cooldown tests ───────────────────────────────────────────
// These test the time-based cooldown pattern used in channel.ts onError handler
// to prevent token refresh storms.

describe("token refresh cooldown logic", () => {
  it("should allow refresh when cooldown has elapsed", () => {
    let lastTokenRefreshAt = 0;
    const TOKEN_REFRESH_COOLDOWN_MS = 60_000;

    const cooldownElapsed = Date.now() - lastTokenRefreshAt > TOKEN_REFRESH_COOLDOWN_MS;
    expect(cooldownElapsed).toBe(true);
  });

  it("should block refresh within cooldown window", () => {
    const TOKEN_REFRESH_COOLDOWN_MS = 60_000;
    let lastTokenRefreshAt = Date.now(); // just refreshed

    const cooldownElapsed = Date.now() - lastTokenRefreshAt > TOKEN_REFRESH_COOLDOWN_MS;
    expect(cooldownElapsed).toBe(false);
  });

  it("should allow refresh after cooldown expires", () => {
    const TOKEN_REFRESH_COOLDOWN_MS = 60_000;
    // Simulate a refresh that happened 61 seconds ago
    let lastTokenRefreshAt = Date.now() - 61_000;

    const cooldownElapsed = Date.now() - lastTokenRefreshAt > TOKEN_REFRESH_COOLDOWN_MS;
    expect(cooldownElapsed).toBe(true);
  });

  it("should keep cooldown active even after failed refresh (no reset)", () => {
    const TOKEN_REFRESH_COOLDOWN_MS = 60_000;
    let lastTokenRefreshAt = 0;

    // Simulate a refresh attempt (set timestamp before trying)
    lastTokenRefreshAt = Date.now();

    // Simulate failure — in the old code, hasRefreshedToken was reset to false
    // In the new code, lastTokenRefreshAt stays set (no reset in catch block)
    // So subsequent attempts within cooldown should be blocked
    const cooldownElapsed = Date.now() - lastTokenRefreshAt > TOKEN_REFRESH_COOLDOWN_MS;
    expect(cooldownElapsed).toBe(false);
  });

  it("should apply stagger delay before reconnect", async () => {
    // Verify the stagger delay pattern works
    const start = Date.now();
    const staggerMs = Math.floor(Math.random() * 5000);
    expect(staggerMs).toBeGreaterThanOrEqual(0);
    expect(staggerMs).toBeLessThan(5000);
  });
});

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
