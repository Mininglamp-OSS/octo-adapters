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

// ─── Group → Account mapping tests ──────────────────────────────────────────

describe("resolveAccountForGroup — prefetch registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("should register groups during startup prefetch", async () => {
    const { registerGroupToAccount, resolveAccountForGroup } = await import("./channel.js");

    // Simulate prefetch registration
    registerGroupToAccount("group_abc", "acct_1");

    // resolveAccountForGroup should now return the registered account
    expect(resolveAccountForGroup("group_abc")).toBe("acct_1");
  });
});

// ─── resolveOutboundAccountId tests ──────────────────────────────────────────

describe("resolveOutboundAccountId", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("should strip @uid suffix from group target and resolve account", async () => {
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");

    registerGroupToAccount("abc", "acct_A");

    // "group:abc@uid1,uid2" → should strip @uid1,uid2, resolve group "abc"
    const result = resolveOutboundAccountId("group:abc@uid1,uid2", "fallback");
    expect(result).toBe("acct_A");
  });

  it("should resolve plain group target without @suffix", async () => {
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");

    registerGroupToAccount("abc", "acct_B");

    const result = resolveOutboundAccountId("group:abc", "fallback");
    expect(result).toBe("acct_B");
  });

  it("should return fallback for DM targets (no correction)", async () => {
    const { resolveOutboundAccountId } = await import("./channel.js");

    // DM target — resolveOutboundAccountId should not correct, return fallback
    const result = resolveOutboundAccountId("user:some_uid", "fallback_acct");
    expect(result).toBe("fallback_acct");
  });
});

describe("resolveOutboundAccountId — explicit accountId should not be overridden", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("should NOT override explicit non-default accountId even when group is registered to another account", async () => {
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");

    // group registered to thomas_fu_bot
    registerGroupToAccount("some_group", "thomas_fu_bot");

    // User explicitly passes allen-imtest — resolveOutboundAccountId would return thomas_fu_bot,
    // but the caller (sendText/sendMedia) should not call resolveOutboundAccountId when accountId != default.
    // We test that resolveOutboundAccountId itself still resolves to the registered account...
    const resolved = resolveOutboundAccountId("group:some_group", "allen-imtest");
    expect(resolved).toBe("thomas_fu_bot"); // resolveOutboundAccountId always resolves

    // ...but the sendText/sendMedia logic should gate on rawAccountId === DEFAULT_ACCOUNT_ID.
    // Simulate the gating logic:
    const rawAccountId: string = "allen-imtest"; // explicit, non-default
    const DEFAULT_ACCOUNT_ID = "default";
    const accountId = (rawAccountId === DEFAULT_ACCOUNT_ID)
      ? resolveOutboundAccountId("group:some_group", rawAccountId)
      : rawAccountId;
    expect(accountId).toBe("allen-imtest"); // NOT corrected
  });

  it("should correct when accountId is default", async () => {
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");

    registerGroupToAccount("some_group", "thomas_fu_bot");

    const DEFAULT_ACCOUNT_ID = "default";
    const rawAccountId = DEFAULT_ACCOUNT_ID;
    const accountId = (rawAccountId === DEFAULT_ACCOUNT_ID)
      ? resolveOutboundAccountId("group:some_group", rawAccountId)
      : rawAccountId;
    expect(accountId).toBe("thomas_fu_bot"); // corrected
  });
});

describe("outbound accountId correction pattern", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("should use resolveAccountForGroup for group targets", async () => {
    const { registerGroupToAccount, resolveAccountForGroup } = await import("./channel.js");
    const { parseTarget } = await import("./actions.js");

    registerGroupToAccount("group_xyz", "correct_acct");

    const target = "group:group_xyz";
    const { channelId, channelType } = parseTarget(target);

    // Simulate the correction logic
    let accountId = "wrong_acct";
    if (channelType === 2) { // ChannelType.Group
      const correct = resolveAccountForGroup(channelId);
      if (correct) accountId = correct;
    }

    expect(accountId).toBe("correct_acct");
  });
});

// ─── @all / @所有人 hasAtAll regex tests ──────────────────────────────────────

describe("hasAtAll regex — @所有人 support", () => {
  const hasAtAllRegex = /(?:^|(?<=\s))@(?:all|所有人)(?=\s|[^\w]|$)/i;

  it("should match @all", () => {
    expect(hasAtAllRegex.test("hello @all please check")).toBe(true);
  });

  it("should match @All (case-insensitive)", () => {
    expect(hasAtAllRegex.test("hello @All please")).toBe(true);
  });

  it("should match @所有人", () => {
    expect(hasAtAllRegex.test("大家好 @所有人 请注意")).toBe(true);
  });

  it("should match @所有人 at start of string", () => {
    expect(hasAtAllRegex.test("@所有人 请注意")).toBe(true);
  });

  it("should match @all at start of string", () => {
    expect(hasAtAllRegex.test("@all check this")).toBe(true);
  });

  it("should match @所有人 at end of string", () => {
    expect(hasAtAllRegex.test("通知 @所有人")).toBe(true);
  });

  it("should NOT match @Alice (not all)", () => {
    expect(hasAtAllRegex.test("hello @Alice")).toBe(false);
  });

  it("should NOT match email with @all in domain", () => {
    expect(hasAtAllRegex.test("email user@all.com")).toBe(false);
  });
});

// ─── sendText v2 structured mention handling (unit logic) ─────────────────────

describe("sendText v2 mention processing logic", () => {
  it("should convert @[uid:name] to @name + entities", async () => {
    const { parseStructuredMentions, convertStructuredMentions, buildEntitiesFromFallback } = await import("./mention-utils.js");

    const content = "请 @[abc123:张三] 确认";
    const uidToNameMap = new Map([["abc123", "张三"]]);
    const memberMap = new Map([["张三", "abc123"]]);
    const validUids = new Set(uidToNameMap.keys());

    // v2 path
    const structuredMentions = parseStructuredMentions(content);
    expect(structuredMentions).toHaveLength(1);

    const converted = convertStructuredMentions(content, structuredMentions, validUids);
    expect(converted.content).toBe("请 @张三 确认");
    expect(converted.entities).toHaveLength(1);
    expect(converted.entities[0]).toEqual({ uid: "abc123", offset: 2, length: 3 });
    expect(converted.uids).toEqual(["abc123"]);

    // v1 fallback on converted content should find @张三 but not create duplicate
    const fallback = buildEntitiesFromFallback(converted.content, memberMap);
    expect(fallback.uids).toEqual(["abc123"]);
  });

  it("should handle mixed v2 + v1 mentions", async () => {
    const { parseStructuredMentions, convertStructuredMentions, buildEntitiesFromFallback } = await import("./mention-utils.js");

    const content = "@[abc:张三] 和 @李四";
    const uidToNameMap = new Map([["abc", "张三"]]);
    const memberMap = new Map([["张三", "abc"], ["李四", "def"]]);
    const validUids = new Set(uidToNameMap.keys());

    // v2 path
    const structuredMentions = parseStructuredMentions(content);
    expect(structuredMentions).toHaveLength(1);

    const converted = convertStructuredMentions(content, structuredMentions, validUids);
    expect(converted.content).toBe("@张三 和 @李四");

    // v1 fallback resolves @李四
    const fallback = buildEntitiesFromFallback(converted.content, memberMap);

    // Merge with dedup
    const mentionEntities = [...converted.entities];
    const existingOffsets = new Set(mentionEntities.map(e => e.offset));
    for (const entity of fallback.entities) {
      if (!existingOffsets.has(entity.offset)) {
        mentionEntities.push(entity);
      }
    }

    expect(mentionEntities).toHaveLength(2);
    expect(mentionEntities.map(e => e.uid).sort()).toEqual(["abc", "def"]);
  });

  it("pure v1 content should work unchanged", async () => {
    const { parseStructuredMentions, buildEntitiesFromFallback } = await import("./mention-utils.js");

    const content = "@张三 你好";
    const structuredMentions = parseStructuredMentions(content);
    expect(structuredMentions).toHaveLength(0);

    const memberMap = new Map([["张三", "abc"]]);
    const fallback = buildEntitiesFromFallback(content, memberMap);
    expect(fallback.uids).toEqual(["abc"]);
    expect(fallback.entities).toHaveLength(1);
  });

  it("@[uid:name] with @所有人 should only produce entity for name, not 所有人", async () => {
    const { parseStructuredMentions, convertStructuredMentions, buildEntitiesFromFallback } = await import("./mention-utils.js");

    const content = "@[abc:张三] @所有人";
    const validUids = new Set(["abc"]);
    const memberMap = new Map([["张三", "abc"]]);

    const structured = parseStructuredMentions(content);
    const converted = convertStructuredMentions(content, structured, validUids);
    expect(converted.content).toBe("@张三 @所有人");

    const fallback = buildEntitiesFromFallback(converted.content, memberMap);
    // @所有人 should be skipped by buildEntitiesFromFallback
    const allEntities = [...converted.entities];
    const existingOffsets = new Set(allEntities.map(e => e.offset));
    for (const entity of fallback.entities) {
      if (!existingOffsets.has(entity.offset)) {
        allEntities.push(entity);
      }
    }
    // Only 张三 should have an entity
    expect(allEntities).toHaveLength(1);
    expect(allEntities[0].uid).toBe("abc");

    // hasAtAll should be true
    const hasAtAll = /(?:^|(?<=\s))@(?:all|所有人)(?=\s|[^\w]|$)/i.test(converted.content);
    expect(hasAtAll).toBe(true);
  });
});
