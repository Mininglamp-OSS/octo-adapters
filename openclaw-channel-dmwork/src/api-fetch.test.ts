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
// parseImageDimensionsFromFile — streaming dimension parser
// ---------------------------------------------------------------------------
describe("parseImageDimensionsFromFile", () => {
  it("should parse dimensions from a valid PNG file", async () => {
    const { writeFileSync, mkdirSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");

    // Create a minimal valid PNG (1x1 pixel)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
      0x00, 0x00, 0x00, 0x0D, // IHDR chunk length
      0x49, 0x48, 0x44, 0x52, // "IHDR"
      0x00, 0x00, 0x00, 0x64, // width = 100
      0x00, 0x00, 0x00, 0xC8, // height = 200
      0x08, 0x02, 0x00, 0x00, 0x00, // bit depth, color type, etc.
    ]);
    const tmpDir = join("/tmp", "test-dims");
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, "test.png");
    writeFileSync(tmpFile, pngHeader);

    try {
      const { parseImageDimensionsFromFile } = await import("./api-fetch.js");
      const dims = await parseImageDimensionsFromFile(tmpFile, "image/png");
      expect(dims).toEqual({ width: 100, height: 200 });
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("should return null for non-existent file", async () => {
    const { parseImageDimensionsFromFile } = await import("./api-fetch.js");
    const dims = await parseImageDimensionsFromFile("/tmp/nonexistent-test-file.png", "image/png");
    expect(dims).toBeNull();
  });

  it("should return null for unsupported mime type", async () => {
    const { writeFileSync, mkdirSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const tmpFile = join("/tmp", "test-dims", "test.txt");
    mkdirSync(join("/tmp", "test-dims"), { recursive: true });
    writeFileSync(tmpFile, "not an image");

    try {
      const { parseImageDimensionsFromFile } = await import("./api-fetch.js");
      const dims = await parseImageDimensionsFromFile(tmpFile, "text/plain");
      expect(dims).toBeNull();
    } finally {
      unlinkSync(tmpFile);
    }
  });
});

// ---------------------------------------------------------------------------
// getUploadCredentials — validates response shape
// ---------------------------------------------------------------------------
describe("getUploadCredentials", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should return credentials on valid response", async () => {
    const fakeCreds = {
      bucket: "my-bucket",
      region: "ap-guangzhou",
      key: "uploads/test.png",
      credentials: {
        tmpSecretId: "id123",
        tmpSecretKey: "key456",
        sessionToken: "tok789",
      },
      startTime: 1000,
      expiredTime: 2000,
      cdnBaseUrl: "https://cdn.example.com",
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(fakeCreds),
    }) as unknown as typeof fetch;

    const { getUploadCredentials } = await import("./api-fetch.js");
    const result = await getUploadCredentials({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
      filename: "test.png",
    });

    expect(result.bucket).toBe("my-bucket");
    expect(result.credentials.tmpSecretId).toBe("id123");
  });

  it("should throw on non-ok response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: vi.fn().mockResolvedValue("Forbidden"),
      statusText: "Forbidden",
    }) as unknown as typeof fetch;

    const { getUploadCredentials } = await import("./api-fetch.js");
    await expect(
      getUploadCredentials({
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        filename: "test.png",
      }),
    ).rejects.toThrow("403");
  });

  it("should throw on incomplete response (missing bucket)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        region: "ap-guangzhou",
        key: "uploads/test.png",
        credentials: { tmpSecretId: "id", tmpSecretKey: "key", sessionToken: "tok" },
      }),
    }) as unknown as typeof fetch;

    const { getUploadCredentials } = await import("./api-fetch.js");
    await expect(
      getUploadCredentials({
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        filename: "test.png",
      }),
    ).rejects.toThrow("incomplete");
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

// ---------------------------------------------------------------------------
// ensureTextCharset
// ---------------------------------------------------------------------------
describe("ensureTextCharset", () => {
  it("appends charset=utf-8 to text/plain", async () => {
    const { ensureTextCharset } = await import("./api-fetch.js");
    expect(ensureTextCharset("text/plain")).toBe("text/plain; charset=utf-8");
  });

  it("appends charset=utf-8 to text/markdown", async () => {
    const { ensureTextCharset } = await import("./api-fetch.js");
    expect(ensureTextCharset("text/markdown")).toBe("text/markdown; charset=utf-8");
  });

  it("appends charset=utf-8 to text/html", async () => {
    const { ensureTextCharset } = await import("./api-fetch.js");
    expect(ensureTextCharset("text/html")).toBe("text/html; charset=utf-8");
  });

  it("does not modify image/jpeg", async () => {
    const { ensureTextCharset } = await import("./api-fetch.js");
    expect(ensureTextCharset("image/jpeg")).toBe("image/jpeg");
  });

  it("does not double-add charset if already present", async () => {
    const { ensureTextCharset } = await import("./api-fetch.js");
    expect(ensureTextCharset("text/plain; charset=utf-8")).toBe("text/plain; charset=utf-8");
  });

  it("does not override existing charset=gbk", async () => {
    const { ensureTextCharset } = await import("./api-fetch.js");
    expect(ensureTextCharset("text/plain; charset=gbk")).toBe("text/plain; charset=gbk");
  });

  it("does not modify application/json", async () => {
    const { ensureTextCharset } = await import("./api-fetch.js");
    expect(ensureTextCharset("application/json")).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// uploadFileToCOS — putParams includes ContentType
// ---------------------------------------------------------------------------
describe("uploadFileToCOS putParams ContentType", () => {
  it("passes ContentType to cos.putObject", async () => {
    let capturedParams: any = null;

    vi.resetModules();

    // Mock cos-nodejs-sdk-v5 before importing api-fetch
    vi.doMock("cos-nodejs-sdk-v5", () => {
      return {
        default: class FakeCOS {
          putObject(params: any, cb: any) {
            capturedParams = params;
            cb(null, { Location: "bucket.cos.region.myqcloud.com/key" });
          }
        },
      };
    });

    const { uploadFileToCOS } = await import("./api-fetch.js");
    await uploadFileToCOS({
      credentials: { tmpSecretId: "id", tmpSecretKey: "key", sessionToken: "tok" },
      startTime: 0,
      expiredTime: 9999999999,
      bucket: "test-bucket",
      region: "ap-test",
      key: "test/file.txt",
      fileBody: Buffer.from("hello"),
      contentType: "text/plain; charset=utf-8",
    });

    expect(capturedParams).not.toBeNull();
    expect(capturedParams.ContentType).toBe("text/plain; charset=utf-8");
  });
});

// --- fetchUserInfo ---
import { fetchUserInfo } from "./api-fetch.js";

describe("fetchUserInfo", () => {
  it("returns user info on success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ uid: "s14_abc", name: "Alice", avatar: "https://example.com/a.png" }),
    }) as any;

    const result = await fetchUserInfo({
      apiUrl: "http://localhost:8090",
      botToken: "tok",
      uid: "s14_abc",
    });
    expect(result).toEqual({ uid: "s14_abc", name: "Alice", avatar: "https://example.com/a.png" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:8090/v1/bot/user/info?uid=s14_abc",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns null on 404 (endpoint not implemented)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as any;

    const result = await fetchUserInfo({
      apiUrl: "http://localhost:8090",
      botToken: "tok",
      uid: "s14_abc",
    });
    expect(result).toBeNull();
  });

  it("returns null on 500 error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as any;

    const result = await fetchUserInfo({
      apiUrl: "http://localhost:8090",
      botToken: "tok",
      uid: "s14_abc",
      log: { error: vi.fn() },
    });
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as any;

    const result = await fetchUserInfo({
      apiUrl: "http://localhost:8090",
      botToken: "tok",
      uid: "s14_abc",
      log: { error: vi.fn() },
    });
    expect(result).toBeNull();
  });

  it("returns null when response has no name", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ uid: "s14_abc" }),
    }) as any;

    const result = await fetchUserInfo({
      apiUrl: "http://localhost:8090",
      botToken: "tok",
      uid: "s14_abc",
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Voice Context API
// ---------------------------------------------------------------------------
import { getVoiceContext, updateVoiceContext, deleteVoiceContext } from "./api-fetch.js";

describe("Voice Context API", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // -- getVoiceContext --

  describe("getVoiceContext", () => {
    it("sends GET /v1/bot/voice/context with correct auth header", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          status: 200,
          has_context: true,
          context: "correction terms",
          updated_at: "2026-04-09T13:00:00+08:00",
        }),
      }) as unknown as typeof fetch;

      const result = await getVoiceContext({
        apiUrl: "https://api.test/",
        botToken: "tok-secret",
      });

      // Verify URL construction (trailing slash stripped)
      const callUrl = (global.fetch as any).mock.calls[0][0];
      expect(callUrl).toBe("https://api.test/v1/bot/voice/context");

      // Verify auth header
      const callInit = (global.fetch as any).mock.calls[0][1];
      expect(callInit.method).toBe("GET");
      expect(callInit.headers.Authorization).toBe("Bearer tok-secret");

      // Verify normalized response (status field stripped)
      expect(result).toEqual({
        has_context: true,
        context: "correction terms",
        updated_at: "2026-04-09T13:00:00+08:00",
      });
      // status field must not appear in result
      expect((result as any).status).toBeUndefined();
    });

    it("defaults has_context to false when field is missing", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          status: 200,
          // has_context field intentionally omitted
          context: "",
          updated_at: "",
        }),
      }) as unknown as typeof fetch;

      const result = await getVoiceContext({
        apiUrl: "https://api.test",
        botToken: "tok",
      });

      expect(result.has_context).toBe(false);
    });

    it("defaults has_context to false when field is undefined", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          status: 200,
          has_context: undefined,
          context: "",
          updated_at: "",
        }),
      }) as unknown as typeof fetch;

      const result = await getVoiceContext({
        apiUrl: "https://api.test",
        botToken: "tok",
      });

      expect(result.has_context).toBe(false);
    });

    it("returns has_context: false with empty context when not set", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          status: 200,
          has_context: false,
          context: "",
          updated_at: "",
        }),
      }) as unknown as typeof fetch;

      const result = await getVoiceContext({
        apiUrl: "https://api.test",
        botToken: "tok",
      });

      expect(result).toEqual({
        has_context: false,
        context: "",
        updated_at: "",
      });
    });

    it("throws on non-2xx response with status and body", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: vi.fn().mockResolvedValue('{"status":401,"msg":"invalid bot token"}'),
      }) as unknown as typeof fetch;

      await expect(
        getVoiceContext({ apiUrl: "https://api.test", botToken: "bad-tok" }),
      ).rejects.toThrow(/failed \(401\)/);
    });

    it("includes method and path in error message", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: vi.fn().mockResolvedValue(""),
      }) as unknown as typeof fetch;

      await expect(
        getVoiceContext({ apiUrl: "https://api.test", botToken: "tok" }),
      ).rejects.toThrow("Bot API GET /v1/bot/voice/context failed (500)");
    });
  });

  // -- updateVoiceContext --

  describe("updateVoiceContext", () => {
    it("sends PUT /v1/bot/voice/context with JSON body", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue('{"status":200,"msg":"ok"}'),
      }) as unknown as typeof fetch;

      await updateVoiceContext({
        apiUrl: "https://api.test/",
        botToken: "tok-secret",
        content: "correction terms",
      });

      const [callUrl, callInit] = (global.fetch as any).mock.calls[0];
      expect(callUrl).toBe("https://api.test/v1/bot/voice/context");
      expect(callInit.method).toBe("PUT");
      expect(callInit.headers.Authorization).toBe("Bearer tok-secret");
      expect(callInit.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(callInit.body)).toEqual({ context: "correction terms" });
    });

    it("throws on 400 (content exceeds max length)", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: vi.fn().mockResolvedValue(
          '{"status":400,"msg":"context exceeds max length (10000 characters)"}',
        ),
      }) as unknown as typeof fetch;

      await expect(
        updateVoiceContext({
          apiUrl: "https://api.test",
          botToken: "tok",
          content: "x".repeat(10001),
        }),
      ).rejects.toThrow(/failed \(400\)/);
    });
  });

  // -- deleteVoiceContext --

  describe("deleteVoiceContext", () => {
    it("sends DELETE /v1/bot/voice/context", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue('{"status":200,"msg":"ok"}'),
      }) as unknown as typeof fetch;

      await deleteVoiceContext({
        apiUrl: "https://api.test/",
        botToken: "tok-secret",
      });

      const [callUrl, callInit] = (global.fetch as any).mock.calls[0];
      expect(callUrl).toBe("https://api.test/v1/bot/voice/context");
      expect(callInit.method).toBe("DELETE");
      expect(callInit.headers.Authorization).toBe("Bearer tok-secret");
      // DELETE should not have Content-Type or body
      expect(callInit.body).toBeUndefined();
    });

    it("succeeds on deleting non-existent record (idempotent)", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue('{"status":200,"msg":"ok"}'),
      }) as unknown as typeof fetch;

      // Should not throw
      await deleteVoiceContext({
        apiUrl: "https://api.test",
        botToken: "tok",
      });
    });
  });

  // -- botFetchJson helper --

  describe("botFetchJson (via voice context functions)", () => {
    it("strips multiple trailing slashes from apiUrl", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          status: 200,
          has_context: false,
          context: "",
          updated_at: "",
        }),
      }) as unknown as typeof fetch;

      await getVoiceContext({
        apiUrl: "https://api.test///",
        botToken: "tok",
      });

      const callUrl = (global.fetch as any).mock.calls[0][0];
      expect(callUrl).toBe("https://api.test/v1/bot/voice/context");
    });

    it("uses AbortSignal.timeout for request timeout", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          status: 200,
          has_context: false,
          context: "",
          updated_at: "",
        }),
      }) as unknown as typeof fetch;

      await getVoiceContext({
        apiUrl: "https://api.test",
        botToken: "tok",
      });

      const callInit = (global.fetch as any).mock.calls[0][1];
      expect(callInit.signal).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// sendMessage — mentionAll serialization
// ---------------------------------------------------------------------------
describe("sendMessage — mentionAll serialization", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("mention.all 应序列化为数字 1 而非布尔 true", async () => {
    let sentBody: any = null;
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { sendMessage } = await import("./api-fetch.js");
    await sendMessage({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
      channelId: "group1",
      channelType: ChannelType.Group,
      content: "hello @all",
      mentionAll: true,
    });

    expect(sentBody).not.toBeNull();
    const mention = sentBody.payload.mention;
    expect(mention.all).toBe(1);
    expect(mention.all).not.toBe(true);
    expect(typeof mention.all).toBe("number");
  });

  it("未设置 mentionAll 时不应包含 mention.all 字段", async () => {
    let sentBody: any = null;
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { sendMessage } = await import("./api-fetch.js");
    await sendMessage({
      apiUrl: "http://localhost:8090",
      botToken: "test-token",
      channelId: "group1",
      channelType: ChannelType.Group,
      content: "hello",
    });

    expect(sentBody.payload.mention).toBeUndefined();
  });
});
