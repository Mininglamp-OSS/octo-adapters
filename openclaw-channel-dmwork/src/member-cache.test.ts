import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getGroupMembersFromCache,
  findSharedGroupsFromCache,
  preloadGroupMemberCache,
  invalidateGroupCache,
  evictGroupFromCache,
  _clearMemberCache,
  _setCacheEntry,
} from "./member-cache.js";

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

describe("member-cache", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _clearMemberCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _clearMemberCache();
  });

  // -----------------------------------------------------------------------
  // getGroupMembersFromCache
  // -----------------------------------------------------------------------
  describe("getGroupMembersFromCache", () => {
    it("should return cached members when available", async () => {
      _setCacheEntry("grp1", [
        { uid: "u1", name: "Alice" },
        { uid: "u2", name: "Bob" },
      ]);

      const result = await getGroupMembersFromCache({
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupNo: "grp1",
      });

      expect(result).toHaveLength(2);
      expect(result[0].uid).toBe("u1");
      expect(result[1].uid).toBe("u2");
    });

    it("should fetch from API on cache miss", async () => {
      globalThis.fetch = mockFetch({
        "/members": async () =>
          jsonResponse([
            { uid: "u1", name: "Alice" },
          ]),
      });

      const result = await getGroupMembersFromCache({
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupNo: "grp1",
      });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Alice");
    });

    it("should re-fetch after cache expiry", async () => {
      // Set cache with expired TTL
      _setCacheEntry("grp1", [{ uid: "old", name: "Old" }], undefined, -1);

      globalThis.fetch = mockFetch({
        "/members": async () =>
          jsonResponse([
            { uid: "new", name: "New" },
          ]),
      });

      const result = await getGroupMembersFromCache({
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupNo: "grp1",
      });

      expect(result).toHaveLength(1);
      expect(result[0].uid).toBe("new");
    });
  });

  // -----------------------------------------------------------------------
  // findSharedGroupsFromCache
  // -----------------------------------------------------------------------
  describe("findSharedGroupsFromCache", () => {
    it("should return null when no cache data", () => {
      const result = findSharedGroupsFromCache("u1");
      expect(result).toBeNull();
    });

    it("should return shared groups from reverse index", () => {
      _setCacheEntry("grp1", [
        { uid: "u1", name: "Alice" },
        { uid: "u2", name: "Bob" },
      ], "Dev Team");
      _setCacheEntry("grp2", [
        { uid: "u1", name: "Alice" },
        { uid: "u3", name: "Charlie" },
      ], "Support");

      const result = findSharedGroupsFromCache("u1");
      expect(result).not.toBeNull();
      expect(result).toHaveLength(2);
      expect(result!.map((g) => g.groupNo).sort()).toEqual(["grp1", "grp2"]);
      expect(result!.find((g) => g.groupNo === "grp1")?.groupName).toBe("Dev Team");
      expect(result!.find((g) => g.groupNo === "grp2")?.memberCount).toBe(2);
    });

    it("should not return groups user is not in", () => {
      _setCacheEntry("grp1", [
        { uid: "u1", name: "Alice" },
      ]);

      const result = findSharedGroupsFromCache("u2");
      expect(result).toBeNull();
    });

    it("should return null when all cached entries are expired", () => {
      _setCacheEntry("grp1", [{ uid: "u1", name: "Alice" }], undefined, -1);

      const result = findSharedGroupsFromCache("u1");
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // preloadGroupMemberCache
  // -----------------------------------------------------------------------
  describe("preloadGroupMemberCache", () => {
    it("should preload members for all bot groups", async () => {
      globalThis.fetch = mockFetch({
        // /members must come before /v1/bot/groups to avoid false match
        "/members": async (url) => {
          if (url.includes("grp1")) {
            return jsonResponse([{ uid: "u1", name: "Alice" }]);
          }
          return jsonResponse([{ uid: "u2", name: "Bob" }]);
        },
        "/v1/bot/groups": async () => {
          return jsonResponse([
            { group_no: "grp1", name: "Dev Team" },
            { group_no: "grp2", name: "Support" },
          ]);
        },
      });

      await preloadGroupMemberCache({
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      // Verify cache is populated
      const grp1 = await getGroupMembersFromCache({
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupNo: "grp1",
      });
      expect(grp1).toHaveLength(1);
      expect(grp1[0].uid).toBe("u1");

      // Verify reverse index
      const shared = findSharedGroupsFromCache("u1");
      expect(shared).not.toBeNull();
      expect(shared!.some((g) => g.groupNo === "grp1")).toBe(true);
    });

    it("should not throw when preload fails", async () => {
      globalThis.fetch = mockFetch({
        "/v1/bot/groups": async () => {
          throw new Error("network error");
        },
      });

      // Should not throw
      await expect(
        preloadGroupMemberCache({
          apiUrl: "http://localhost:8090",
          botToken: "test-token",
        }),
      ).rejects.toThrow(); // fetchBotGroups will throw for network errors
    });
  });

  // -----------------------------------------------------------------------
  // invalidateGroupCache / evictGroupFromCache
  // -----------------------------------------------------------------------
  describe("cache invalidation", () => {
    it("invalidateGroupCache should remove cache entry", async () => {
      _setCacheEntry("grp1", [{ uid: "u1", name: "Alice" }]);

      invalidateGroupCache("grp1");

      // Should need to re-fetch
      globalThis.fetch = mockFetch({
        "/members": async () => jsonResponse([{ uid: "u1", name: "Alice" }]),
      });

      const result = await getGroupMembersFromCache({
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupNo: "grp1",
      });
      // Will re-fetch from API
      expect(result).toHaveLength(1);
    });

    it("evictGroupFromCache should remove cache and reverse index", () => {
      _setCacheEntry("grp1", [
        { uid: "u1", name: "Alice" },
      ]);

      // Verify reverse index exists
      expect(findSharedGroupsFromCache("u1")).not.toBeNull();

      evictGroupFromCache("grp1");

      // Reverse index should be gone
      expect(findSharedGroupsFromCache("u1")).toBeNull();
    });
  });
});
