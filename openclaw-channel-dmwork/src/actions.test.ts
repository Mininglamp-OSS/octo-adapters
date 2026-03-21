import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType } from "./types.js";

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
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
      let uploadCalled = false;
      let mediaSentPayload: any = null;

      globalThis.fetch = mockFetch({
        "/v1/bot/upload/credentials": async () => {
          // Return 404 to trigger fallback to legacy upload
          return new Response("Not implemented in test", { status: 404 });
        },
        "/v1/bot/file/upload": async () => {
          uploadCalled = true;
          return jsonResponse({ url: "https://cdn.example.com/file/chat/img.png" });
        },
        "/v1/bot/sendMessage": async (_url, init) => {
          mediaSentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
        "https://example.com/image.png": async () => {
          return new Response(Buffer.from("fake-image"), {
            status: 200,
            headers: { "Content-Type": "image/png" },
          });
        },
      });

      const { handleDmworkMessageAction } = await import("./actions.js");
      const result = await handleDmworkMessageAction({
        action: "send",
        args: { target: "user:uid1", mediaUrl: "https://example.com/image.png" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(uploadCalled).toBe(true);
    });
  });

  describe("send — media + text", () => {
    it("should send both text and media", async () => {
      let textSent = false;
      let uploadCalled = false;

      globalThis.fetch = mockFetch({
        "/v1/bot/upload/credentials": async () => {
          // Return 404 to trigger fallback to legacy upload
          return new Response("Not implemented in test", { status: 404 });
        },
        "/v1/bot/file/upload": async () => {
          uploadCalled = true;
          return jsonResponse({ url: "https://cdn.example.com/file/chat/doc.pdf" });
        },
        "/v1/bot/sendMessage": async (_url, init) => {
          const body = JSON.parse(init?.body as string);
          if (body.payload?.content) textSent = true;
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
        "https://example.com/doc.pdf": async () => {
          return new Response(Buffer.from("fake-pdf"), {
            status: 200,
            headers: { "Content-Type": "application/pdf" },
          });
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
      expect(uploadCalled).toBe(true);
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
  describe("read — group messages", () => {
    it("should read and return messages from a group", async () => {
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
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.count).toBe(2);
      expect(data.messages[0].content).toBe("Hello");
      expect(data.messages[1].content).toBe("Hi there");
    });
  });

  describe("read — custom limit", () => {
    it("should pass limit to API and cap at 100", async () => {
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
      });

      // Should be capped at 100
      expect(requestBody.limit).toBe(100);
    });
  });

  describe("read — uid-to-name resolution", () => {
    it("should resolve from_uid to display names", async () => {
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
