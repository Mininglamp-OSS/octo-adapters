import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
