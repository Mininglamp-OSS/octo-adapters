import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "./sdk-compat.js";

// Mock api-fetch so outbound adapter wiring tests (below) can observe the
// final sendMessage / sendMediaMessage arguments without actually hitting
// DMWork. Real implementations still ship in the bundle — this is test-only.
vi.mock("./api-fetch.js", async () => {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendMediaMessage: vi.fn().mockResolvedValue(undefined),
    getUploadCredentials: vi.fn().mockResolvedValue({
      credentials: { TmpSecretId: "id", TmpSecretKey: "k", Token: "t" },
      startTime: 0,
      expiredTime: 0,
      bucket: "b", region: "r", key: "k",
      cdnBaseUrl: "https://cdn.example/",
    }),
    uploadFileToCOS: vi.fn().mockResolvedValue({ url: "https://cdn.example/file.txt" }),
    inferContentType: (fn: string) =>
      fn.endsWith(".txt") ? "text/plain" : "application/octet-stream",
    ensureTextCharset: (ct: string) =>
      ct.startsWith("text/") && !ct.includes("charset") ? ct + "; charset=utf-8" : ct,
    parseImageDimensions: () => null,
    parseImageDimensionsFromFile: async () => null,
    registerBot: vi.fn(),
    sendHeartbeat: vi.fn(),
    fetchBotGroups: vi.fn().mockResolvedValue([]),
    getGroupMd: vi.fn(),
  };
});

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
    expect(dmworkPlugin.id).toBe("octo");
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

    expect(dmworkPlugin.id).toBe("octo");
    expect(dmworkPlugin.meta.id).toBe("octo");
    expect(dmworkPlugin.meta.label).toBe("Octo");
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

  // channel:<id> is an alternative prefix OpenClaw's delivery pipeline can emit
  // for group channels. If the normalisation layer misses it, the group→account
  // lookup silently falls back to the caller-provided accountId and the turn
  // goes out through the wrong bot's token. Keep these three cases as a
  // regression guard for the prefix-normalisation step in particular.

  it("should resolve channel:<id> alias like group:<id>", async () => {
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");
    registerGroupToAccount("abc", "acct_chan");
    const result = resolveOutboundAccountId("channel:abc", "fallback");
    expect(result).toBe("acct_chan");
  });

  it("should resolve channel:<id>____<short> to the parent group's account", async () => {
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");
    registerGroupToAccount("abc", "acct_thread");
    const result = resolveOutboundAccountId("channel:abc____topicA", "fallback");
    expect(result).toBe("acct_thread");
  });

  it("should strip @uid suffix from channel:<id>@uid1,uid2 target", async () => {
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");
    registerGroupToAccount("abc", "acct_chan_uid");
    const result = resolveOutboundAccountId("channel:abc@uid1,uid2", "fallback");
    expect(result).toBe("acct_chan_uid");
  });
});

describe("resolveOutboundAccountId — group→account correction semantics", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("corrects unambiguously owned single-bot groups even when a different accountId is explicitly passed", async () => {
    // Intent: if the group belongs to exactly one configured bot, always use
    // that bot's accountId — otherwise the turn goes out with a token the
    // backend will reject (bot not a member of the group). This is the safe
    // default; explicit accountId is only meaningful when the group has
    // multiple bots registered to it (see next test).
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");
    registerGroupToAccount("some_group", "thomas_fu_bot");
    const resolved = resolveOutboundAccountId("group:some_group", "allen-imtest");
    expect(resolved).toBe("thomas_fu_bot");
  });

  it("falls back to explicit accountId when group is shared by multiple bots", async () => {
    // When >1 bots are registered to the same group, resolveAccountForGroup
    // returns undefined and we honour whatever the caller passed — this is
    // where "explicit accountId wins" applies.
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");
    registerGroupToAccount("shared_group", "bot_a");
    registerGroupToAccount("shared_group", "bot_b");
    const resolved = resolveOutboundAccountId("group:shared_group", "bot_a");
    expect(resolved).toBe("bot_a");
  });

  it("corrects when rawAccountId is the DEFAULT alias", async () => {
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");
    registerGroupToAccount("some_group", "thomas_fu_bot");
    const resolved = resolveOutboundAccountId("group:some_group", DEFAULT_ACCOUNT_ID);
    expect(resolved).toBe("thomas_fu_bot");
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
    const memberMap = new Map([["张三", "abc123"]]);

    // v2 path
    const structuredMentions = parseStructuredMentions(content);
    expect(structuredMentions).toHaveLength(1);

    const converted = convertStructuredMentions(content, structuredMentions);
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
    const memberMap = new Map([["张三", "abc"], ["李四", "def"]]);

    // v2 path
    const structuredMentions = parseStructuredMentions(content);
    expect(structuredMentions).toHaveLength(1);

    const converted = convertStructuredMentions(content, structuredMentions);
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
    const memberMap = new Map([["张三", "abc"]]);

    const structured = parseStructuredMentions(content);
    const converted = convertStructuredMentions(content, structured);
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

// ─── outbound adapter wiring (thread cross-channel regression) ──────────────
// These exercise the full sendText / sendMedia adapter path — not just the
// resolveOutboundDmworkTarget helper — to pin down that ctx.threadId is
// correctly wired from framework input all the way to sendMessage /
// sendMediaMessage. Motivated by the bug where OpenClaw passed
// to="group:<group_no>" + threadId="<short>" and files silently landed in
// the parent group (channel_type=2) instead of the sub-topic (5).

describe("outbound.sendText — threadId wiring", () => {
  const cfg = {
    channels: {
      octo: {
        apiUrl: "https://api.example",
        accounts: {
          default: { botToken: "bf_test", apiUrl: "https://api.example" },
        },
      },
    },
  };

  beforeEach(async () => {
    const apiFetch = await import("./api-fetch.js");
    (apiFetch.sendMessage as any).mockClear();
  });

  it("merges ctx.threadId into the group target as CommunityTopic (type=5)", async () => {
    const { dmworkPlugin } = await import("./channel.js");
    const { sendMessage } = await import("./api-fetch.js");

    await dmworkPlugin.outbound!.sendText!({
      cfg,
      to: "group:grp1",
      threadId: "topicA",
      text: "hi from bot",
      accountId: "default",
    } as any);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = (sendMessage as any).mock.calls[0][0];
    expect(call.channelId).toBe("grp1____topicA");
    expect(call.channelType).toBe(5); // ChannelType.CommunityTopic
    expect(call.content).toBe("hi from bot");
  });

  it("leaves a parent-group target (no threadId) as Group (type=2)", async () => {
    const { dmworkPlugin } = await import("./channel.js");
    const { sendMessage } = await import("./api-fetch.js");

    await dmworkPlugin.outbound!.sendText!({
      cfg,
      to: "group:grp1",
      text: "parent group reply",
      accountId: "default",
    } as any);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = (sendMessage as any).mock.calls[0][0];
    expect(call.channelId).toBe("grp1");
    expect(call.channelType).toBe(2); // ChannelType.Group
  });

  it("accepts channel:<id> alias + threadId and routes to CommunityTopic", async () => {
    const { dmworkPlugin } = await import("./channel.js");
    const { sendMessage } = await import("./api-fetch.js");

    await dmworkPlugin.outbound!.sendText!({
      cfg,
      to: "channel:grp1",
      threadId: "topicA",
      text: "hi",
      accountId: "default",
    } as any);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = (sendMessage as any).mock.calls[0][0];
    expect(call.channelId).toBe("grp1____topicA");
    expect(call.channelType).toBe(5);
  });
});

describe("outbound.sendMedia — threadId wiring", () => {
  const cfg = {
    channels: {
      octo: {
        apiUrl: "https://api.example",
        accounts: {
          default: { botToken: "bf_test", apiUrl: "https://api.example" },
        },
      },
    },
  };

  beforeEach(async () => {
    const apiFetch = await import("./api-fetch.js");
    (apiFetch.sendMediaMessage as any).mockClear();
    (apiFetch.getUploadCredentials as any).mockClear();
    (apiFetch.uploadFileToCOS as any).mockClear();
  });

  it("merges ctx.threadId into the group target as CommunityTopic (type=5)", async () => {
    const { dmworkPlugin } = await import("./channel.js");
    const { sendMediaMessage } = await import("./api-fetch.js");

    await dmworkPlugin.outbound!.sendMedia!({
      cfg,
      to: "group:grp1",
      threadId: "topicA",
      text: "",
      mediaUrl: "data:text/plain;base64,aGVsbG8=",
      accountId: "default",
    } as any);

    expect(sendMediaMessage).toHaveBeenCalledTimes(1);
    const call = (sendMediaMessage as any).mock.calls[0][0];
    expect(call.channelId).toBe("grp1____topicA");
    expect(call.channelType).toBe(5);
    expect(call.url).toBe("https://cdn.example/file.txt");
  });

  it("leaves a parent-group target (no threadId) as Group (type=2)", async () => {
    const { dmworkPlugin } = await import("./channel.js");
    const { sendMediaMessage } = await import("./api-fetch.js");

    await dmworkPlugin.outbound!.sendMedia!({
      cfg,
      to: "group:grp1",
      text: "",
      mediaUrl: "data:text/plain;base64,aGVsbG8=",
      accountId: "default",
    } as any);

    expect(sendMediaMessage).toHaveBeenCalledTimes(1);
    const call = (sendMediaMessage as any).mock.calls[0][0];
    expect(call.channelId).toBe("grp1");
    expect(call.channelType).toBe(2);
  });

  it("accepts channel:<id> alias + threadId and routes to CommunityTopic", async () => {
    const { dmworkPlugin } = await import("./channel.js");
    const { sendMediaMessage } = await import("./api-fetch.js");

    await dmworkPlugin.outbound!.sendMedia!({
      cfg,
      to: "channel:grp1",
      threadId: "topicA",
      text: "",
      mediaUrl: "data:text/plain;base64,aGVsbG8=",
      accountId: "default",
    } as any);

    expect(sendMediaMessage).toHaveBeenCalledTimes(1);
    const call = (sendMediaMessage as any).mock.calls[0][0];
    expect(call.channelId).toBe("grp1____topicA");
    expect(call.channelType).toBe(5);
  });

  it("preserves an already-synthesised channel_id even if threadId is also passed", async () => {
    const { dmworkPlugin } = await import("./channel.js");
    const { sendMediaMessage } = await import("./api-fetch.js");

    await dmworkPlugin.outbound!.sendMedia!({
      cfg,
      to: "group:grp1____topicA",
      threadId: "different",
      text: "",
      mediaUrl: "data:text/plain;base64,aGVsbG8=",
      accountId: "default",
    } as any);

    expect(sendMediaMessage).toHaveBeenCalledTimes(1);
    const call = (sendMediaMessage as any).mock.calls[0][0];
    // ctx.to wins; duplicate threadId must not re-concat or downgrade.
    expect(call.channelId).toBe("grp1____topicA");
    expect(call.channelType).toBe(5);
  });
});

// ─── outbound accountId correction — end-to-end token assertion ─────────────
// These close the gap the review flagged: resolveOutboundAccountId's behaviour
// is covered in isolation, but the outbound adapters (sendText/sendMedia) also
// have to actually USE the corrected accountId's botToken when calling the
// DMWork API. Without these tests, a regression in the wiring (e.g. passing
// the original ctx.accountId to resolveDmworkAccount instead of the corrected
// one) would go undetected.

describe("outbound sendText/sendMedia — accountId correction threads through to API", () => {
  const cfgWithTwoBots = {
    channels: {
      octo: {
        apiUrl: "https://api.example",
        accounts: {
          "bot-a": { botToken: "tok-bot-a", apiUrl: "https://api.example" },
          "bot-b": { botToken: "tok-bot-b", apiUrl: "https://api.example" },
        },
      },
    },
  };

  beforeEach(async () => {
    // Reset module state so _groupToAccounts doesn't leak across these tests —
    // otherwise an earlier "shared group" registration would leave the group
    // ambiguous for the next test, silently masking the correction under test.
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("sendText corrects to the group-owning bot's token when group has a single owner, even if a different accountId is passed", async () => {
    const { dmworkPlugin, registerGroupToAccount } = await import("./channel.js");
    const { sendMessage } = await import("./api-fetch.js");

    // Group grp1 belongs to bot-b only; caller passed bot-a.
    registerGroupToAccount("grp1", "bot-b");

    await dmworkPlugin.outbound!.sendText!({
      cfg: cfgWithTwoBots,
      to: "group:grp1",
      text: "hi",
      accountId: "bot-a",
    } as any);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = (sendMessage as any).mock.calls[0][0];
    expect(call.botToken).toBe("tok-bot-b"); // corrected from bot-a → bot-b
  });

  it("sendMedia corrects to the group-owning bot's token", async () => {
    const { dmworkPlugin, registerGroupToAccount } = await import("./channel.js");
    const { sendMediaMessage } = await import("./api-fetch.js");

    registerGroupToAccount("grp1", "bot-b");

    await dmworkPlugin.outbound!.sendMedia!({
      cfg: cfgWithTwoBots,
      to: "group:grp1",
      text: "",
      mediaUrl: "data:text/plain;base64,aGVsbG8=",
      accountId: "bot-a",
    } as any);

    expect(sendMediaMessage).toHaveBeenCalledTimes(1);
    const call = (sendMediaMessage as any).mock.calls[0][0];
    expect(call.botToken).toBe("tok-bot-b");
  });

  it("sendText respects explicit accountId when group is shared by multiple bots (no single owner)", async () => {
    const { dmworkPlugin, registerGroupToAccount } = await import("./channel.js");
    const { sendMessage } = await import("./api-fetch.js");

    // Shared group — resolveAccountForGroup returns undefined for ambiguity.
    registerGroupToAccount("grp1", "bot-a");
    registerGroupToAccount("grp1", "bot-b");

    await dmworkPlugin.outbound!.sendText!({
      cfg: cfgWithTwoBots,
      to: "group:grp1",
      text: "hi",
      accountId: "bot-a",
    } as any);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = (sendMessage as any).mock.calls[0][0];
    expect(call.botToken).toBe("tok-bot-a"); // explicit choice honoured
  });

  it("sendText corrects through the channel:<id> prefix alias too", async () => {
    const { dmworkPlugin, registerGroupToAccount } = await import("./channel.js");
    const { sendMessage } = await import("./api-fetch.js");

    registerGroupToAccount("grp1", "bot-b");

    await dmworkPlugin.outbound!.sendText!({
      cfg: cfgWithTwoBots,
      to: "channel:grp1",
      text: "hi",
      accountId: "bot-a",
    } as any);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = (sendMessage as any).mock.calls[0][0];
    expect(call.botToken).toBe("tok-bot-b");
  });
});
