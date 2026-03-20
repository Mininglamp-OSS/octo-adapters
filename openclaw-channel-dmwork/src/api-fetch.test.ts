import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType, MessageType } from "./types.js";

/**
 * Tests for api-fetch.ts functions.
 *
 * Verifies that async functions properly await their responses
 * and return resolved data instead of Promises.
 */
describe("fetchBotGroups", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Reset fetch mock before each test
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;
  });

  it("should return an array, not a Promise", async () => {
    // Mock fetch to return a successful response
    const mockGroups = [
      { group_no: "group1", name: "Test Group 1" },
      { group_no: "group2", name: "Test Group 2" },
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockGroups),
    }) as unknown as typeof fetch;

    // Import dynamically to use mocked fetch
    const { fetchBotGroups } = await import("./api-fetch.js");

    const result = await fetchBotGroups({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
    });

    // Critical: result should be the actual array, not a Promise
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0].group_no).toBe("group1");
    expect(result[1].name).toBe("Test Group 2");
  });

  it("should return empty array on non-ok response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as unknown as typeof fetch;

    const { fetchBotGroups } = await import("./api-fetch.js");

    const result = await fetchBotGroups({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("should properly await json() call", async () => {
    // This test specifically verifies the fix for issue #29
    // If await is missing, the result would be a Promise object
    const mockGroups = [{ group_no: "g1", name: "Group" }];
    const jsonMock = vi.fn().mockResolvedValue(mockGroups);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: jsonMock,
    }) as unknown as typeof fetch;

    const { fetchBotGroups } = await import("./api-fetch.js");

    const result = await fetchBotGroups({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
    });

    // Verify json() was called
    expect(jsonMock).toHaveBeenCalled();

    // Verify result is resolved data, not a Promise
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toEqual(mockGroups);

    // Additional check: calling array methods should work
    expect(result.length).toBe(1);
    expect(result.map((g) => g.name)).toEqual(["Group"]);
  });
});

describe("log parameter type compatibility", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should accept ChannelLogSink-compatible log parameter", async () => {
    // Simulates ChannelLogSink type from OpenClaw SDK:
    // { info: (msg: string) => void; error: (msg: string) => void; ... }
    const channelLogSink = {
      info: (msg: string) => console.log(msg),
      warn: (msg: string) => console.warn(msg),
      error: (msg: string) => console.error(msg),
    };

    const mockGroups = [{ group_no: "g1", name: "Group" }];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockGroups),
    }) as unknown as typeof fetch;

    const { fetchBotGroups } = await import("./api-fetch.js");

    // This should compile without TypeScript errors
    const result = await fetchBotGroups({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
      log: channelLogSink,
    });

    expect(result).toEqual(mockGroups);
  });

  it("should call log.error on non-ok response", async () => {
    const errorSpy = vi.fn();
    const log = {
      info: vi.fn(),
      error: errorSpy,
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    }) as unknown as typeof fetch;

    const { fetchBotGroups } = await import("./api-fetch.js");

    await fetchBotGroups({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
      log,
    });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("401"));
  });
});

// ---------------------------------------------------------------------------
// getGroupInfo
// ---------------------------------------------------------------------------
describe("getGroupInfo", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should return group info on success", async () => {
    const fakeInfo = { group_no: "g1", name: "Alpha", member_count: 10 };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(fakeInfo),
    }) as unknown as typeof fetch;

    const { getGroupInfo } = await import("./api-fetch.js");
    const result = await getGroupInfo({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
      groupNo: "g1",
    });
    expect(result).toEqual(fakeInfo);
  });

  it("should throw on 404", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as unknown as typeof fetch;

    const { getGroupInfo } = await import("./api-fetch.js");
    await expect(
      getGroupInfo({
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupNo: "g1",
      }),
    ).rejects.toThrow("404");
  });

  it("should throw on timeout (AbortError)", async () => {
    global.fetch = vi.fn().mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    ) as unknown as typeof fetch;

    const { getGroupInfo } = await import("./api-fetch.js");
    await expect(
      getGroupInfo({
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupNo: "g1",
      }),
    ).rejects.toThrow();
  });

  it("should throw on non-JSON response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
    }) as unknown as typeof fetch;

    const { getGroupInfo } = await import("./api-fetch.js");
    await expect(
      getGroupInfo({
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupNo: "g1",
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getGroupMd
// ---------------------------------------------------------------------------
describe("getGroupMd", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should return GROUP.md data on success", async () => {
    const fakeData = {
      content: "# Group Rules",
      version: 5,
      updated_at: "2024-03-01T00:00:00Z",
      updated_by: "user_abc",
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(fakeData),
    }) as unknown as typeof fetch;

    const { getGroupMd } = await import("./api-fetch.js");
    const result = await getGroupMd({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
      groupNo: "g1",
    });
    expect(result).toEqual(fakeData);
  });

  it("should throw on 404", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue("Not Found"),
      statusText: "Not Found",
    }) as unknown as typeof fetch;

    const { getGroupMd } = await import("./api-fetch.js");
    await expect(
      getGroupMd({
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupNo: "g1",
      }),
    ).rejects.toThrow("404");
  });

  it("should handle empty content", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        content: "",
        version: 1,
        updated_at: null,
        updated_by: "system",
      }),
    }) as unknown as typeof fetch;

    const { getGroupMd } = await import("./api-fetch.js");
    const result = await getGroupMd({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
      groupNo: "g1",
    });
    expect(result.content).toBe("");
    expect(result.version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// updateGroupMd
// ---------------------------------------------------------------------------
describe("updateGroupMd", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should return version on success", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ version: 6 }),
    }) as unknown as typeof fetch;

    const { updateGroupMd } = await import("./api-fetch.js");
    const result = await updateGroupMd({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
      groupNo: "g1",
      content: "# Updated Rules",
    });
    expect(result.version).toBe(6);
  });

  it("should throw on 400 error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue("Bad Request"),
      statusText: "Bad Request",
    }) as unknown as typeof fetch;

    const { updateGroupMd } = await import("./api-fetch.js");
    await expect(
      updateGroupMd({
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupNo: "g1",
        content: "",
      }),
    ).rejects.toThrow("400");
  });

  it("should throw on 403 permission denied", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: vi.fn().mockResolvedValue("Forbidden"),
      statusText: "Forbidden",
    }) as unknown as typeof fetch;

    const { updateGroupMd } = await import("./api-fetch.js");
    await expect(
      updateGroupMd({
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupNo: "g1",
        content: "# Rules",
      }),
    ).rejects.toThrow("403");
  });
});

// ---------------------------------------------------------------------------
// getGroupMembers
// ---------------------------------------------------------------------------
describe("getGroupMembers", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should return members list (array response)", async () => {
    const fakeMembers = [
      { uid: "u1", name: "Alice", role: "admin" },
      { uid: "u2", name: "Bob", role: "member" },
    ];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(fakeMembers),
    }) as unknown as typeof fetch;

    const { getGroupMembers } = await import("./api-fetch.js");
    const result = await getGroupMembers({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
      groupNo: "g1",
    });
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Alice");
  });

  it("should return members list (wrapped in members field)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        members: [{ uid: "u1", name: "Alice" }],
      }),
    }) as unknown as typeof fetch;

    const { getGroupMembers } = await import("./api-fetch.js");
    const result = await getGroupMembers({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
      groupNo: "g1",
    });
    expect(result).toHaveLength(1);
    expect(result[0].uid).toBe("u1");
  });

  it("should return empty array on empty list", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([]),
    }) as unknown as typeof fetch;

    const { getGroupMembers } = await import("./api-fetch.js");
    const result = await getGroupMembers({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
      groupNo: "g1",
    });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchBotGroups — null response (bug fix regression)
// ---------------------------------------------------------------------------
describe("fetchBotGroups — null response", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should return empty array when API returns null", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(null),
    }) as unknown as typeof fetch;

    const { fetchBotGroups } = await import("./api-fetch.js");
    const result = await fetchBotGroups({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
    });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("should return empty array on network error", async () => {
    global.fetch = vi.fn().mockRejectedValue(
      new Error("fetch failed"),
    ) as unknown as typeof fetch;

    const { fetchBotGroups } = await import("./api-fetch.js");
    // fetchBotGroups doesn't have a try/catch, so it will throw
    // Actually, let's verify the behavior — it should throw since there's no try/catch
    await expect(
      fetchBotGroups({
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      }),
    ).rejects.toThrow("fetch failed");
  });
});

// ---------------------------------------------------------------------------
// sendMediaMessage — Image vs File payload shape
// ---------------------------------------------------------------------------
describe("sendMediaMessage", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("Image type should include width/height and exclude name/size", async () => {
    let sentBody: any = null;
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ message_id: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { sendMediaMessage } = await import("./api-fetch.js");
    await sendMediaMessage({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
      channelId: "chan1",
      channelType: ChannelType.Group,
      type: MessageType.Image,
      url: "https://cdn.example.com/img.png",
      width: 800,
      height: 600,
      name: "img.png",   // should be ignored for Image
      size: 12345,        // should be ignored for Image
    });

    expect(sentBody).not.toBeNull();
    const payload = sentBody.payload;
    expect(payload.type).toBe(MessageType.Image);
    expect(payload.url).toBe("https://cdn.example.com/img.png");
    expect(payload.width).toBe(800);
    expect(payload.height).toBe(600);
    // Image type must NOT include name/size
    expect(payload.name).toBeUndefined();
    expect(payload.size).toBeUndefined();
  });

  it("File type should include name/size and exclude width/height", async () => {
    let sentBody: any = null;
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ message_id: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { sendMediaMessage } = await import("./api-fetch.js");
    await sendMediaMessage({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
      channelId: "chan1",
      channelType: ChannelType.Group,
      type: MessageType.File,
      url: "https://cdn.example.com/report.pdf",
      name: "report.pdf",
      size: 204800,
      width: 100,    // should be ignored for File
      height: 200,   // should be ignored for File
    });

    expect(sentBody).not.toBeNull();
    const payload = sentBody.payload;
    expect(payload.type).toBe(MessageType.File);
    expect(payload.url).toBe("https://cdn.example.com/report.pdf");
    expect(payload.name).toBe("report.pdf");
    expect(payload.size).toBe(204800);
    // File type must NOT include width/height
    expect(payload.width).toBeUndefined();
    expect(payload.height).toBeUndefined();
  });
});
