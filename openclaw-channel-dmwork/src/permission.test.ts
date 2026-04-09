import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType } from "./types.js";
import { registerOwnerUid, _clearOwnerRegistry } from "./owner-registry.js";
import { _clearMemberCache, _setCacheEntry } from "./member-cache.js";

const originalFetch = globalThis.fetch;

function mockFetch(handlers: Record<string, (url: string, init?: RequestInit) => Promise<Response>>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        return handler(url, init);
      }
    }
    return new Response("Not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("checkPermission", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _clearOwnerRegistry();
    _clearMemberCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _clearOwnerRegistry();
    _clearMemberCache();
  });

  // -----------------------------------------------------------------------
  // Missing requester
  // -----------------------------------------------------------------------
  it("should deny when requesterSenderId is undefined", async () => {
    const { checkPermission } = await import("./permission.js");
    const result = await checkPermission({
      requesterSenderId: undefined,
      channelId: "some-channel",
      channelType: ChannelType.DM,
      accountId: "acct1",
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("无法识别");
  });

  // -----------------------------------------------------------------------
  // Owner: full access
  // -----------------------------------------------------------------------
  it("should allow owner to query any DM", async () => {
    registerOwnerUid("acct1", "owner-uid");

    const { checkPermission } = await import("./permission.js");
    const result = await checkPermission({
      requesterSenderId: "owner-uid",
      channelId: "someone-else",
      channelType: ChannelType.DM,
      accountId: "acct1",
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
    });

    expect(result.allowed).toBe(true);
  });

  it("should allow owner to query any group", async () => {
    registerOwnerUid("acct1", "owner-uid");

    const { checkPermission } = await import("./permission.js");
    const result = await checkPermission({
      requesterSenderId: "owner-uid",
      channelId: "some-group",
      channelType: ChannelType.Group,
      accountId: "acct1",
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
    });

    expect(result.allowed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // DM: self-query allowed, cross-query denied
  // -----------------------------------------------------------------------
  it("should allow user to query their own DM", async () => {
    const { checkPermission } = await import("./permission.js");
    const result = await checkPermission({
      requesterSenderId: "user-abc",
      channelId: "user-abc",
      channelType: ChannelType.DM,
      accountId: "acct1",
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
    });

    expect(result.allowed).toBe(true);
  });

  it("should deny non-owner querying another user's DM", async () => {
    const { checkPermission } = await import("./permission.js");
    const result = await checkPermission({
      requesterSenderId: "user-abc",
      channelId: "user-xyz",
      channelType: ChannelType.DM,
      accountId: "acct1",
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("无权查询他人");
  });

  // -----------------------------------------------------------------------
  // Group: member check
  // -----------------------------------------------------------------------
  it("should allow user who is a group member", async () => {
    // Pre-populate member cache
    _setCacheEntry("grp1", [
      { uid: "user-abc", name: "Alice" },
      { uid: "user-xyz", name: "Bob" },
    ]);

    const { checkPermission } = await import("./permission.js");
    const result = await checkPermission({
      requesterSenderId: "user-abc",
      channelId: "grp1",
      channelType: ChannelType.Group,
      accountId: "acct1",
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
    });

    expect(result.allowed).toBe(true);
  });

  it("should deny user who is not a group member", async () => {
    // Pre-populate member cache without the requesting user
    _setCacheEntry("grp1", [
      { uid: "user-xyz", name: "Bob" },
    ]);

    const { checkPermission } = await import("./permission.js");
    const result = await checkPermission({
      requesterSenderId: "user-abc",
      channelId: "grp1",
      channelType: ChannelType.Group,
      accountId: "acct1",
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("你不在该群中");
  });

  it("should fetch members from API on cache miss", async () => {
    globalThis.fetch = mockFetch({
      "/members": async () =>
        jsonResponse([
          { uid: "user-abc", name: "Alice" },
          { uid: "user-xyz", name: "Bob" },
        ]),
    });

    const { checkPermission } = await import("./permission.js");
    const result = await checkPermission({
      requesterSenderId: "user-abc",
      channelId: "grp1",
      channelType: ChannelType.Group,
      accountId: "acct1",
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
    });

    expect(result.allowed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Unsupported channel type
  // -----------------------------------------------------------------------
  it("should deny for unsupported channel type", async () => {
    const { checkPermission } = await import("./permission.js");
    const result = await checkPermission({
      requesterSenderId: "user-abc",
      channelId: "some-channel",
      channelType: 99,
      accountId: "acct1",
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("不支持的频道类型");
  });

  // -----------------------------------------------------------------------
  // No accountId — owner check skipped
  // -----------------------------------------------------------------------
  it("should skip owner check when accountId is undefined", async () => {
    registerOwnerUid("acct1", "owner-uid");

    const { checkPermission } = await import("./permission.js");
    // Even though this is the owner uid, without accountId the owner check is skipped
    const result = await checkPermission({
      requesterSenderId: "owner-uid",
      channelId: "someone-else",
      channelType: ChannelType.DM,
      accountId: undefined,
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
    });

    // Falls through to DM check — "someone-else" ≠ "owner-uid" → denied
    expect(result.allowed).toBe(false);
  });
});
