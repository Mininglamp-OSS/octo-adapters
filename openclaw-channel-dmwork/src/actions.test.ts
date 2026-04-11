import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType } from "./types.js";
import { registerOwnerUid, _clearOwnerRegistry } from "./owner-registry.js";
import { _clearMemberCache, _setCacheEntry } from "./member-cache.js";
import { registerBotGroupIds, _testReset as _resetGroupMd } from "./group-md.js";

// Mock uploadAndSendMedia — the streaming COS upload uses its own SDK internals
// that can't be tested via fetch mocks alone. Upload logic is tested in inbound.test.ts.
vi.mock("./inbound.js", () => ({
  uploadAndSendMedia: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Tests for message action handlers.
 * All API calls are mocked via global.fetch.
 */

const originalFetch = globalThis.fetch;

// Helper to create a mock fetch that routes based on URL/method
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

describe("handleDmworkMessageAction", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _clearOwnerRegistry();
    _clearMemberCache();
    _resetGroupMd();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _clearOwnerRegistry();
    _clearMemberCache();
    _resetGroupMd();
  });

  // -----------------------------------------------------------------------
  // send action
  // -----------------------------------------------------------------------
  describe("send — text to group", () => {
    it("should send text to a group target", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: { target: "group:chan123", message: "Hello group" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.channel_id).toBe("chan123");
      expect(sentPayload.channel_type).toBe(ChannelType.Group);
      expect(sentPayload.payload.content).toBe("Hello group");
    });
  });

  describe("send — text to user (DM)", () => {
    it("should send text to a user target", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: { target: "user:uid456", message: "Hello user" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.channel_id).toBe("uid456");
      expect(sentPayload.channel_type).toBe(ChannelType.DM);
    });
  });

  describe("send — bare target defaults to DM", () => {
    it("should default to DM when no prefix", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: { target: "some_uid", message: "Hello" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.channel_type).toBe(ChannelType.DM);
      expect(sentPayload.channel_id).toBe("some_uid");
    });
  });

  describe("send — @mentions resolved from memberMap", () => {
    it("should resolve @mentions to UIDs via memberMap", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const memberMap = new Map([
        ["陈皮皮", "uid_chen"],
        ["bob", "uid_bob"],
      ]);

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "Hello @陈皮皮 and @bob!" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        memberMap,
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.payload.mention.uids).toEqual(["uid_chen", "uid_bob"]);
    });
  });

  // -----------------------------------------------------------------------
  // send — v2 structured mentions (@[uid:name])
  // -----------------------------------------------------------------------
  describe("send — v2 structured mentions converted to @name + entities", () => {
    it("should convert @[uid:name] to @name with correct entities", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const uidToNameMap = new Map([
        ["uid_chen", "陈皮皮"],
        ["uid_bob", "bob"],
      ]);

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "Hello @[uid_chen:陈皮皮] and @[uid_bob:bob]!" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        uidToNameMap,
      });

      expect(result.ok).toBe(true);
      // Content should have @name format (not @[uid:name])
      expect(sentPayload.payload.content).toBe("Hello @陈皮皮 and @bob!");
      // Entities should have correct offset/length/uid
      const entities = sentPayload.payload.mention.entities;
      expect(entities).toHaveLength(2);
      expect(entities[0]).toMatchObject({ uid: "uid_chen", offset: 6, length: 4 });
      expect(entities[1]).toMatchObject({ uid: "uid_bob", offset: 15, length: 4 });
      // UIDs should be present
      expect(sentPayload.payload.mention.uids).toEqual(["uid_chen", "uid_bob"]);
    });
  });

  describe("send — @all detection", () => {
    it("should set mentionAll when @all is present", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "Attention @all please read" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.payload.mention.all).toBe(1);
    });
  });

  describe("send — @所有人 detection", () => {
    it("should set mentionAll when @所有人 is present", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "大家注意 @所有人 请查收" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.payload.mention.all).toBe(1);
    });
  });

  describe("send — mixed v1+v2 mentions", () => {
    it("should resolve both @[uid:name] and @name in same message", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const memberMap = new Map([["alice", "uid_alice"]]);
      const uidToNameMap = new Map([
        ["uid_chen", "陈皮皮"],
        ["uid_alice", "alice"],
      ]);

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "Hey @[uid_chen:陈皮皮] and @alice!" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        memberMap,
        uidToNameMap,
      });

      expect(result.ok).toBe(true);
      // Content should have both converted
      expect(sentPayload.payload.content).toBe("Hey @陈皮皮 and @alice!");
      const entities = sentPayload.payload.mention.entities;
      expect(entities).toHaveLength(2);
      // First entity from v2 conversion
      expect(entities[0]).toMatchObject({ uid: "uid_chen", offset: 4, length: 4 });
      // Second entity from v1 fallback
      expect(entities[1]).toMatchObject({ uid: "uid_alice", offset: 13, length: 6 });
    });
  });

  describe("send — v2 without uidToNameMap graceful fallback", () => {
    it("should leave @[uid:name] unchanged when uidToNameMap is not provided", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "Hello @[uid_chen:陈皮皮]!" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        // no uidToNameMap provided
      });

      expect(result.ok).toBe(true);
      // Content should be unchanged — no conversion without uidToNameMap
      expect(sentPayload.payload.content).toBe("Hello @[uid_chen:陈皮皮]!");
    });
  });

  describe("send — invalid uid in v2 (uid not in uidToNameMap)", () => {
    it("should convert format but not create entity for unknown uid", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const uidToNameMap = new Map([
        ["uid_bob", "bob"],
      ]);
      // uid_unknown is NOT in uidToNameMap

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "Hello @[uid_unknown:Ghost] and @[uid_bob:bob]!" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        uidToNameMap,
      });

      expect(result.ok).toBe(true);
      // Format is still converted for both
      expect(sentPayload.payload.content).toBe("Hello @Ghost and @bob!");
      // Only valid uid gets an entity
      const entities = sentPayload.payload.mention.entities;
      expect(entities).toHaveLength(1);
      expect(entities[0]).toMatchObject({ uid: "uid_bob" });
    });
  });

  describe("send — unresolvable @mentions still sends", () => {
    it("should send without mentionUids when names are unresolvable", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const memberMap = new Map<string, string>(); // empty

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "Hello @unknown_user" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        memberMap,
      });

      expect(result.ok).toBe(true);
      // No mention field when UIDs can't be resolved
      expect(sentPayload.payload.mention).toBeUndefined();
    });
  });

  describe("send — media only (no text)", () => {
    it("should upload and send media without text", async () => {
      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: { target: "user:uid1", mediaUrl: "https://example.com/image.png" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(uploadSpy).toHaveBeenCalledOnce();
      expect(uploadSpy.mock.calls[0][0]).toMatchObject({
        mediaUrl: "https://example.com/image.png",
        channelId: "uid1",
      });
    });
  });

  describe("send — media + text", () => {
    it("should send both text and media", async () => {
      let textSent = false;

      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();

      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          const body = JSON.parse(init?.body as string);
          if (body.payload?.content) textSent = true;
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: {
          target: "group:grp1",
          message: "Check this file",
          media: "https://example.com/doc.pdf",
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(textSent).toBe(true);
      expect(uploadSpy).toHaveBeenCalledOnce();
    });
  });

  describe("send — missing target", () => {
    it("should return error when target is missing", async () => {
      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: { message: "Hello" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("target");
    });
  });

  describe("send — missing message and media", () => {
    it("should return error when both message and media are missing", async () => {
      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: { target: "user:uid1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("message");
    });
  });

  // -----------------------------------------------------------------------
  // read action
  // -----------------------------------------------------------------------
  describe("read — same-channel group messages", () => {
    it("should read and return messages from current group (no permission check)", async () => {
      registerBotGroupIds(["grp1"]);
      const fakeMessages = {
        messages: [
          {
            from_uid: "user1",
            message_id: "m1",
            timestamp: 1709654400,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "Hello" })).toString("base64"),
          },
          {
            from_uid: "user2",
            message_id: "m2",
            timestamp: 1709654401,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "Hi there" })).toString("base64"),
          },
        ],
      };

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse(fakeMessages),
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "read",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.count).toBe(2);
      expect(data.messages[0].content).toBe("Hello");
      expect(data.messages[1].content).toBe("Hi there");
      expect(data.hasMore).toBe(false);
      // Same-channel should NOT have prompt injection wrapper
      expect(data.header).toBeUndefined();
    });
  });

  describe("read — custom limit (same channel)", () => {
    it("should cap at 100+1 for same-channel reads", async () => {
      registerBotGroupIds(["grp1"]);
      let requestBody: any = null;

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async (_url, init) => {
          requestBody = JSON.parse(init?.body as string);
          return jsonResponse({ messages: [] });
        },
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      await handleDmworkMessageAction({
        action: "read",
        args: { target: "group:grp1", limit: 200 },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1",
      });

      // Same channel: capped at 100, but API receives limit+1
      expect(requestBody.limit).toBe(101);
    });
  });

  describe("read — uid-to-name resolution", () => {
    it("should resolve from_uid to display names", async () => {
      registerBotGroupIds(["grp1"]);
      const fakeMessages = {
        messages: [
          {
            from_uid: "uid_chen",
            message_id: "m1",
            timestamp: 1709654400,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "你好" })).toString("base64"),
          },
        ],
      };

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse(fakeMessages),
      });

      const uidToNameMap = new Map([["uid_chen", "陈皮皮"]]);

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "read",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        uidToNameMap,
        currentChannelId: "grp1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.messages[0].from).toBe("陈皮皮");
      expect(data.messages[0].from_uid).toBe("uid_chen");
    });
  });

  describe("read — missing target", () => {
    it("should return error when target is missing", async () => {
      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "read",
        args: {},
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("target");
    });
  });

  // -----------------------------------------------------------------------
  // member-info action
  // -----------------------------------------------------------------------
  describe("member-info — get group members", () => {
    it("should return group member list", async () => {
      const fakeMembers = [
        { uid: "uid1", name: "Alice", role: "admin" },
        { uid: "uid2", name: "Bob", role: "member" },
      ];

      globalThis.fetch = mockFetch({
        "/members": async () => jsonResponse(fakeMembers),
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "member-info",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.count).toBe(2);
      expect(data.members[0].name).toBe("Alice");
      expect(data.members[1].name).toBe("Bob");
    });
  });

  describe("member-info — missing target", () => {
    it("should return error when target is missing", async () => {
      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "member-info",
        args: {},
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("target");
    });
  });

  // -----------------------------------------------------------------------
  // channel-list action
  // -----------------------------------------------------------------------
  describe("channel-list — list bot groups", () => {
    it("should return list of groups the bot belongs to", async () => {
      const fakeGroups = [
        { group_no: "grp1", name: "Dev Team" },
        { group_no: "grp2", name: "Support" },
      ];

      globalThis.fetch = mockFetch({
        "/v1/bot/groups": async () => jsonResponse(fakeGroups),
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "channel-list",
        args: {},
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.count).toBe(2);
      expect(data.groups[0].name).toBe("Dev Team");
      expect(data.groups[1].group_no).toBe("grp2");
    });
  });

  // -----------------------------------------------------------------------
  // channel-info action
  // -----------------------------------------------------------------------
  describe("channel-info — get group info", () => {
    it("should return group info", async () => {
      const fakeInfo = { group_no: "grp1", name: "Dev Team", member_count: 10 };

      globalThis.fetch = mockFetch({
        "/v1/bot/groups/grp1": async () => jsonResponse(fakeInfo),
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "channel-info",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.group_no).toBe("grp1");
      expect(data.name).toBe("Dev Team");
      expect(data.member_count).toBe(10);
    });
  });

  describe("channel-info — missing target", () => {
    it("should return error when target is missing", async () => {
      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "channel-info",
        args: {},
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("target");
    });
  });

  // -----------------------------------------------------------------------
  // General
  // -----------------------------------------------------------------------
  describe("unknown action", () => {
    it("should return error for unknown action", async () => {
      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "nonexistent",
        args: {},
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Unknown action");
    });
  });

  describe("missing botToken", () => {
    it("should return error when botToken is empty", async () => {
      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: { target: "user:uid1", message: "hello" },
        apiUrl: "http://localhost:8090",
        botToken: "",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("botToken");
    });
  });

  // -----------------------------------------------------------------------
  // group-md-read action
  // -----------------------------------------------------------------------
  describe("group-md-read — read from cache", () => {
    it("should return cached GROUP.md content", async () => {
      const groupMdCache = new Map([
        ["grp1", { content: "# Group Rules\nBe nice.", version: 3 }],
      ]);

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "group-md-read",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupMdCache,
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.content).toBe("# Group Rules\nBe nice.");
      expect(data.version).toBe(3);
      expect(data.source).toBe("cache");
    });
  });

  describe("group-md-read — cache miss (API fallback)", () => {
    it("should fetch from API when not in cache", async () => {
      globalThis.fetch = mockFetch({
        "/v1/bot/groups/grp1/md": async () =>
          jsonResponse({
            content: "# From API",
            version: 5,
            updated_at: "2024-03-01T00:00:00Z",
            updated_by: "user_abc",
          }),
      });

      const groupMdCache = new Map<string, { content: string; version: number }>();

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "group-md-read",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupMdCache,
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.content).toBe("# From API");
      expect(data.version).toBe(5);
      expect(data.updated_by).toBe("user_abc");
      // Cache should be updated
      expect(groupMdCache.get("grp1")?.version).toBe(5);
    });
  });

  describe("group-md-read — missing target", () => {
    it("should return error when target is missing", async () => {
      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "group-md-read",
        args: {},
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("target");
    });
  });

  // -----------------------------------------------------------------------
  // group-md-update action
  // -----------------------------------------------------------------------
  describe("group-md-update — update successfully", () => {
    it("should update GROUP.md and return new version", async () => {
      globalThis.fetch = mockFetch({
        "/v1/bot/groups/grp1/md": async (_url, init) => {
          if (init?.method === "PUT") {
            return jsonResponse({ version: 6 });
          }
          return new Response("Not found", { status: 404 });
        },
      });

      const groupMdCache = new Map<string, { content: string; version: number }>();

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "group-md-update",
        args: { target: "group:grp1", content: "# Updated Rules" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupMdCache,
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.version).toBe(6);
      // Cache should be updated
      expect(groupMdCache.get("grp1")?.content).toBe("# Updated Rules");
      expect(groupMdCache.get("grp1")?.version).toBe(6);
    });
  });

  describe("group-md-update — missing target", () => {
    it("should return error when target is missing", async () => {
      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "group-md-update",
        args: { content: "some content" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("target");
    });
  });

  describe("group-md-update — missing content", () => {
    it("should return error when content is missing", async () => {
      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "group-md-update",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("content");
    });
  });

  // -----------------------------------------------------------------------
  // read — cross-channel permission checks
  // -----------------------------------------------------------------------
  describe("read — cross-channel DM (self)", () => {
    it("should allow user to read their own DM cross-channel", async () => {
      const fakeMessages = {
        messages: [
          {
            from_uid: "user-abc",
            message_id: "m1",
            timestamp: 1709654400,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "Hello from DM" })).toString("base64"),
          },
        ],
      };

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse(fakeMessages),
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "read",
        args: { target: "user:user-abc" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "different-channel",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.messages[0].content).toBe("Hello from DM");
      // Cross-channel should have prompt injection wrapper
      expect(data.header).toBeDefined();
      expect(data.footer).toBeDefined();
      expect(data.metadata?.trustLevel).toBe("untrusted-data");
    });
  });

  describe("read — cross-channel DM (unauthorized)", () => {
    it("should deny non-owner reading another user's DM", async () => {
      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "read",
        args: { target: "user:someone-else" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "different-channel",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("无权查询他人");
    });
  });

  describe("read — cross-channel group (member)", () => {
    it("should allow group member to read cross-channel", async () => {
      _setCacheEntry("target-grp", [
        { uid: "user-abc", name: "Alice" },
        { uid: "user-xyz", name: "Bob" },
      ]);

      const fakeMessages = {
        messages: [
          {
            from_uid: "user-xyz",
            message_id: "m1",
            timestamp: 1709654400,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "Group msg" })).toString("base64"),
          },
        ],
      };

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse(fakeMessages),
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "read",
        args: { target: "group:target-grp" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "different-channel",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.messages[0].content).toBe("Group msg");
      expect(data.header).toBeDefined();
    });
  });

  describe("read — cross-channel group (non-member)", () => {
    it("should deny non-member reading another group", async () => {
      _setCacheEntry("target-grp", [
        { uid: "user-xyz", name: "Bob" },
      ]);

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "read",
        args: { target: "group:target-grp" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "different-channel",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("你不在该群中");
    });
  });

  describe("read — cross-channel missing requesterSenderId", () => {
    it("should deny when requester is unknown", async () => {
      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "read",
        args: { target: "user:someone" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "different-channel",
        // requesterSenderId not provided
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("无法识别");
    });
  });

  describe("read — owner cross-channel access", () => {
    it("should allow owner to read any DM", async () => {
      registerOwnerUid("acct1", "owner-uid");

      const fakeMessages = {
        messages: [
          {
            from_uid: "someone-else",
            message_id: "m1",
            timestamp: 1709654400,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "Private msg" })).toString("base64"),
          },
        ],
      };

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse(fakeMessages),
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "read",
        args: { target: "user:someone-else" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "different-channel",
        requesterSenderId: "owner-uid",
        accountId: "acct1",
      });

      expect(result.ok).toBe(true);
    });
  });

  describe("read — cross-channel limit cap at 50", () => {
    it("should cap cross-channel reads at 50+1", async () => {
      _setCacheEntry("target-grp", [{ uid: "user-abc", name: "Alice" }]);

      let requestBody: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async (_url, init) => {
          requestBody = JSON.parse(init?.body as string);
          return jsonResponse({ messages: [] });
        },
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      await handleDmworkMessageAction({
        action: "read",
        args: { target: "group:target-grp", limit: 200 },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "different-channel",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      // Cross-channel: capped at 50, API receives limit+1
      expect(requestBody.limit).toBe(51);
    });
  });

  describe("read — hasMore detection", () => {
    it("should set hasMore=true when more messages exist", async () => {
      registerBotGroupIds(["grp1"]);
      // Request limit=2, return 3 messages (limit+1 triggers hasMore)
      const fakeMessages = {
        messages: [
          {
            from_uid: "u1", message_id: "m1", timestamp: 1709654400,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "A" })).toString("base64"),
          },
          {
            from_uid: "u2", message_id: "m2", timestamp: 1709654401,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "B" })).toString("base64"),
          },
          {
            from_uid: "u3", message_id: "m3", timestamp: 1709654402,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "C" })).toString("base64"),
          },
        ],
      };

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse(fakeMessages),
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "read",
        args: { target: "group:grp1", limit: 2 },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.hasMore).toBe(true);
      expect(data.count).toBe(2); // Trimmed to requested limit
    });
  });

  describe("read — content truncation and type tags", () => {
    it("should truncate long text and show type tags for non-text messages", async () => {
      registerBotGroupIds(["grp1"]);
      const longContent = "A".repeat(600);
      const fakeMessages = {
        messages: [
          {
            from_uid: "u1", message_id: "m1", timestamp: 1709654400,
            payload: Buffer.from(JSON.stringify({ type: 1, content: longContent })).toString("base64"),
          },
          {
            from_uid: "u2", message_id: "m2", timestamp: 1709654401,
            payload: Buffer.from(JSON.stringify({ type: 2, content: "" })).toString("base64"),
          },
          {
            from_uid: "u3", message_id: "m3", timestamp: 1709654402,
            payload: Buffer.from(JSON.stringify({ type: 4, content: "" })).toString("base64"),
          },
          {
            from_uid: "u4", message_id: "m4", timestamp: 1709654403,
            payload: Buffer.from(JSON.stringify({ type: 8, name: "report.pdf" })).toString("base64"),
          },
        ],
      };

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse(fakeMessages),
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "read",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      // Long text should be truncated to 500 + …
      expect(data.messages[0].content).toHaveLength(501);
      expect(data.messages[0].content.endsWith("…")).toBe(true);
      // Image type tag
      expect(data.messages[1].content).toBe("[图片]");
      // Voice type tag
      expect(data.messages[2].content).toBe("[语音]");
      // File type tag
      expect(data.messages[3].content).toBe("[文件: report.pdf]");
    });
  });

  describe("read — dmwork: prefix stripped for same-channel check", () => {
    it("should treat dmwork:grp1 currentChannelId as same channel for grp1 target", async () => {
      registerBotGroupIds(["grp1"]);
      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse({ messages: [] }),
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "read",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "dmwork:grp1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      // Should be treated as same channel (no wrapper)
      expect(data.header).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // search action
  // -----------------------------------------------------------------------
  describe("search — shared-groups", () => {
    it("should return shared groups from cache", async () => {
      _setCacheEntry("grp1", [
        { uid: "user-abc", name: "Alice" },
        { uid: "user-xyz", name: "Bob" },
      ], "Dev Team");
      _setCacheEntry("grp2", [
        { uid: "user-abc", name: "Alice" },
      ], "Support");

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "search",
        args: { query: "shared-groups" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.total).toBe(2);
      expect(data.sharedGroups.map((g: any) => g.groupNo).sort()).toEqual(["grp1", "grp2"]);
    });
  });

  describe("search — shared-groups (no query defaults to shared-groups)", () => {
    it("should default to shared-groups when query is empty", async () => {
      _setCacheEntry("grp1", [
        { uid: "user-abc", name: "Alice" },
      ], "Dev Team");

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "search",
        args: {},
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.total).toBe(1);
    });
  });

  describe("search — missing requesterSenderId", () => {
    it("should return error when requester is unknown", async () => {
      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "search",
        args: { query: "shared-groups" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        // no requesterSenderId
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("无法识别");
    });
  });

  describe("search — unsupported query", () => {
    it("should return error for unsupported query type", async () => {
      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "search",
        args: { query: "keyword-search" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        requesterSenderId: "user-abc",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Unsupported search query");
    });
  });

  describe("search — shared-groups via API (cache miss)", () => {
    it("should fall back to API when cache is empty", async () => {
      globalThis.fetch = mockFetch({
        // /members must come before /v1/bot/groups to avoid false match
        "/members": async () =>
          jsonResponse([
            { uid: "user-abc", name: "Alice" },
          ]),
        "/v1/bot/groups": async () =>
          jsonResponse([
            { group_no: "grp1", name: "Dev Team" },
          ]),
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "search",
        args: { query: "shared-groups" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.total).toBe(1);
      expect(data.sharedGroups[0].groupNo).toBe("grp1");
      expect(data.sharedGroups[0].groupName).toBe("Dev Team");
    });
  });

  // -----------------------------------------------------------------------
  // read — isSameChannel channelType bypass prevention
  // -----------------------------------------------------------------------
  describe("read — channelType mismatch prevents same-channel bypass", () => {
    it("should NOT treat user:grp1 as same-channel when currentChannelId is grp1 (group)", async () => {
      registerBotGroupIds(["grp1"]);

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "read",
        args: { target: "user:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      // channelId matches but channelType differs (DM vs Group) → cross-channel → permission denied
      expect(result.ok).toBe(false);
      expect(result.error).toContain("无权查询他人");
    });

    it("should NOT treat group:uid1 as same-channel when currentChannelId is uid1 (DM)", async () => {
      // uid1 is NOT a known group, so currentChannelType = DM
      // target is group:uid1 → channelType = Group → mismatch

      // Need member cache so the group permission check can proceed
      _setCacheEntry("uid1", [{ uid: "user-abc", name: "Alice" }]);

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse({ messages: [] }),
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "read",
        args: { target: "group:uid1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "uid1",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      // Cross-channel (channelType mismatch) → permission check runs → allowed (user is member)
      // But response should include cross-channel wrapper
      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.header).toBeDefined();
      expect(data.metadata?.trustLevel).toBe("untrusted-data");
    });
  });

  // -----------------------------------------------------------------------
  // search — API fallback error handling
  // -----------------------------------------------------------------------
  describe("search — shared-groups fetchBotGroups failure", () => {
    it("should return error when fetchBotGroups throws", async () => {
      globalThis.fetch = mockFetch({
        "/v1/bot/groups": async () => {
          throw new Error("network timeout");
        },
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "search",
        args: { query: "shared-groups" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("获取群列表失败");
    });
  });

  describe("search — shared-groups per-group member fetch failure", () => {
    it("should skip failed groups and return partial results", async () => {
      globalThis.fetch = mockFetch({
        // /members must come before /v1/bot/groups to avoid false match
        "/members": async (url) => {
          if (url.includes("grp2")) {
            throw new Error("API error");
          }
          return jsonResponse([{ uid: "user-abc", name: "Alice" }]);
        },
        "/v1/bot/groups": async () =>
          jsonResponse([
            { group_no: "grp1", name: "Dev Team" },
            { group_no: "grp2", name: "Broken Group" },
          ]),
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "search",
        args: { query: "shared-groups" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      // grp1 should succeed, grp2 should be skipped
      expect(data.total).toBe(1);
      expect(data.sharedGroups[0].groupNo).toBe("grp1");
    });
  });
});

describe("parseTarget", () => {
  it("should parse group: prefix", async () => {
    const { parseTarget } = await import("./actions.js");
    const result = parseTarget("group:chan123");
    expect(result.channelId).toBe("chan123");
    expect(result.channelType).toBe(ChannelType.Group);
  });

  it("should parse user: prefix", async () => {
    const { parseTarget } = await import("./actions.js");
    const result = parseTarget("user:uid456");
    expect(result.channelId).toBe("uid456");
    expect(result.channelType).toBe(ChannelType.DM);
  });

  it("should default bare string to DM", async () => {
    const { parseTarget } = await import("./actions.js");
    const result = parseTarget("some_id");
    expect(result.channelId).toBe("some_id");
    expect(result.channelType).toBe(ChannelType.DM);
  });

  it("should treat bare ID as Group when it matches a known group", async () => {
    const { parseTarget } = await import("./actions.js");
    const knownGroups = new Set(["grpX", "grpY"]);
    const result = parseTarget("grpX", undefined, knownGroups);
    expect(result.channelId).toBe("grpX");
    expect(result.channelType).toBe(ChannelType.Group);
  });

  it("should still default to DM when bare ID is not a known group", async () => {
    const { parseTarget } = await import("./actions.js");
    const knownGroups = new Set(["grpX", "grpY"]);
    const result = parseTarget("unknown_uid", undefined, knownGroups);
    expect(result.channelId).toBe("unknown_uid");
    expect(result.channelType).toBe(ChannelType.DM);
  });

  it("should let explicit prefix win over knownGroupIds", async () => {
    const { parseTarget } = await import("./actions.js");
    const knownGroups = new Set(["grpX"]);
    const result = parseTarget("user:grpX", undefined, knownGroups);
    expect(result.channelId).toBe("grpX");
    expect(result.channelType).toBe(ChannelType.DM);
  });

  it("should treat bare ID matching currentChannelId but NOT in knownGroupIds as DM", async () => {
    const { parseTarget } = await import("./actions.js");
    const knownGroups = new Set(["otherGroup"]);
    // currentChannelId matches target, but target is not a known group → DM
    const result = parseTarget("someChannel", "someChannel", knownGroups);
    expect(result.channelId).toBe("someChannel");
    expect(result.channelType).toBe(ChannelType.DM);
  });

  it("should strip dmwork: prefix from bare ID", async () => {
    const { parseTarget } = await import("./actions.js");
    const result = parseTarget("dmwork:someId");
    expect(result.channelId).toBe("someId");
    expect(result.channelType).toBe(ChannelType.DM);
  });

  it("should strip dmwork: prefix and detect group via knownGroupIds", async () => {
    const { parseTarget } = await import("./actions.js");
    const knownGroups = new Set(["grpZ"]);
    const result = parseTarget("dmwork:grpZ", undefined, knownGroups);
    expect(result.channelId).toBe("grpZ");
    expect(result.channelType).toBe(ChannelType.Group);
  });
});
