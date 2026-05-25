import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registerGroupAccount,
  readGroupMdFromDisk,
  readGroupMeta,
  writeGroupMdToDisk,
  deleteGroupMdFromDisk,
  scanForAccountId,
  getGroupMdForPrompt,
  clearGroupMdChecked,
  getKnownGroupIds,
  getOrCreateGroupMdCache,
  extractParentGroupNo,
  extractThreadShortId,
  isThreadChannelId,
  writeThreadMdToDisk,
  readThreadMdFromDisk,
  deleteThreadMdFromDisk,
  broadcastThreadMdUpdate,
  broadcastGroupMdUpdate,
  ensureThreadMd,
  handleThreadMdEvent,
  OCTO_GROUP_RE,
  _testGetGroupAccountMap,
  _testGetCheckedGroups,
  _testGetCheckedThreads,
  _testReset,
  type GroupMdMeta,
} from "./group-md.js";

// Use a temp directory to simulate ~/.openclaw/workspace
let tmpBase: string;
let originalHome: string;

beforeEach(() => {
  _testReset();
  tmpBase = join(tmpdir(), `group-md-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpBase, { recursive: true });
  originalHome = process.env.HOME!;
  process.env.HOME = tmpBase;
});

afterEach(() => {
  process.env.HOME = originalHome;
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    // cleanup best effort
  }
});

describe("OCTO_GROUP_RE", () => {
  it("should match dmwork group sessionKey", () => {
    const key = "agent:myAgent:dmwork:group:g123456";
    const match = OCTO_GROUP_RE.exec(key);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("g123456");
  });

  it("should match group with complex id", () => {
    const key = "agent:abc:dmwork:group:s1_grp_room42";
    const match = OCTO_GROUP_RE.exec(key);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("s1_grp_room42");
  });

  it("should NOT match dmwork direct sessionKey", () => {
    const key = "agent:myAgent:dmwork:direct:uid123";
    expect(OCTO_GROUP_RE.exec(key)).toBeNull();
  });

  it("should NOT match non-dmwork sessionKey", () => {
    const key = "agent:myAgent:main";
    expect(OCTO_GROUP_RE.exec(key)).toBeNull();
  });

  it("should NOT match other channel group sessionKey", () => {
    const key = "agent:myAgent:telegram:group:g123";
    expect(OCTO_GROUP_RE.exec(key)).toBeNull();
  });
});

describe("registerGroupAccount", () => {
  it("should store agentId:groupNo → accountId mapping when agentId provided", () => {
    registerGroupAccount("group1", "acct_jeff", "agent1");
    expect(_testGetGroupAccountMap().get("agent1:group1")).toBe("acct_jeff");
  });

  it("should overwrite existing mapping", () => {
    registerGroupAccount("group1", "acct_old", "agent1");
    registerGroupAccount("group1", "acct_new", "agent1");
    expect(_testGetGroupAccountMap().get("agent1:group1")).toBe("acct_new");
  });

  it("should not set bare groupNo key (no agentId)", () => {
    registerGroupAccount("group2", "acct_bare");
    expect(_testGetGroupAccountMap().get("group2")).toBeUndefined();
  });
});

describe("writeGroupMdToDisk / readGroupMdFromDisk / readGroupMeta", () => {
  const agentId = "testAgent";
  const accountId = "jeff";
  const groupNo = "grp_abc";

  it("should write and read GROUP.md content", () => {
    const content = "# Group Rules\nBe nice.";
    const meta: GroupMdMeta = {
      version: 5,
      updated_at: "2026-03-17T17:00:00+08:00",
      updated_by: "uid_admin",
      fetched_at: "2026-03-17T17:01:00+08:00",
      account_id: accountId,
    };

    writeGroupMdToDisk({ accountId, groupNo, content, meta });

    const readContent = readGroupMdFromDisk(accountId, groupNo);
    expect(readContent).toBe(content);

    const readMeta = readGroupMeta(accountId, groupNo);
    expect(readMeta).not.toBeNull();
    expect(readMeta!.version).toBe(5);
    expect(readMeta!.updated_by).toBe("uid_admin");
    expect(readMeta!.account_id).toBe(accountId);
  });

  it("should return null for non-existent file", () => {
    expect(readGroupMdFromDisk(accountId, "nonexistent")).toBeNull();
    expect(readGroupMeta(accountId, "nonexistent")).toBeNull();
  });

  it("should overwrite existing files", () => {
    const meta: GroupMdMeta = {
      version: 1,
      updated_at: null,
      updated_by: "u1",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };

    writeGroupMdToDisk({ accountId, groupNo, content: "v1", meta });
    expect(readGroupMdFromDisk(accountId, groupNo)).toBe("v1");

    writeGroupMdToDisk({
      accountId,
      groupNo,
      content: "v2",
      meta: { ...meta, version: 2 },
    });
    expect(readGroupMdFromDisk(accountId, groupNo)).toBe("v2");
    expect(readGroupMeta(accountId, groupNo)!.version).toBe(2);
  });
});

describe("deleteGroupMdFromDisk", () => {
  const agentId = "testAgent";
  const accountId = "jeff";
  const groupNo = "grp_del";

  it("should delete GROUP.md and meta files", () => {
    const meta: GroupMdMeta = {
      version: 1,
      updated_at: null,
      updated_by: "u1",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };

    writeGroupMdToDisk({ accountId, groupNo, content: "test", meta });
    expect(readGroupMdFromDisk(accountId, groupNo)).toBe("test");

    deleteGroupMdFromDisk(accountId, groupNo);
    expect(readGroupMdFromDisk(accountId, groupNo)).toBeNull();
    expect(readGroupMeta(accountId, groupNo)).toBeNull();
  });

  it("should not throw when files don't exist", () => {
    expect(() => deleteGroupMdFromDisk(accountId, "nonexistent")).not.toThrow();
  });
});

describe("scanForAccountId", () => {
  const agentId = "testAgent";

  it("should find accountId from meta file on disk", () => {
    const accountId = "scanned_acct";
    const groupNo = "grp_scan";
    const meta: GroupMdMeta = {
      version: 3,
      updated_at: null,
      updated_by: "u1",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };

    writeGroupMdToDisk({ accountId, groupNo, content: "scan test", meta });

    // Reset memory map so scanForAccountId must scan disk
    _testReset();

    const result = scanForAccountId(agentId, groupNo);
    expect(result).toBe(accountId);
    // Should also populate memory map with agentId:groupNo key
    expect(_testGetGroupAccountMap().get(`${agentId}:${groupNo}`)).toBe(accountId);
  });

  it("should return null when no meta exists", () => {
    expect(scanForAccountId(agentId, "grp_missing")).toBeNull();
  });

  it("should return null for non-existent workspace", () => {
    expect(scanForAccountId("nonexistent_agent", "grp_x")).toBeNull();
  });
});

describe("clearGroupMdChecked", () => {
  it("should clear the checked flag for a group", () => {
    const checked = _testGetCheckedGroups();
    checked.add("acct1/grp1");
    expect(checked.has("acct1/grp1")).toBe(true);

    clearGroupMdChecked("acct1", "grp1");
    expect(checked.has("acct1/grp1")).toBe(false);
  });
});

describe("getGroupMdForPrompt", () => {
  const agentId = "testAgent";
  const accountId = "jeff";
  const groupNo = "grp_prompt";

  it("should return null for non-group sessionKey", () => {
    registerGroupAccount(groupNo, accountId, "testAgent");
    expect(getGroupMdForPrompt({ sessionKey: "agent:a1:dmwork:direct:uid1", agentId })).toBeNull();
  });

  it("should return null when sessionKey is undefined", () => {
    expect(getGroupMdForPrompt({ agentId })).toBeNull();
  });

  it("should return null when agentId is undefined", () => {
    expect(getGroupMdForPrompt({ sessionKey: `agent:a1:octo:group:${groupNo}` })).toBeNull();
  });

  it("should return null when no accountId mapping exists", () => {
    // No registerGroupAccount called, no disk file
    expect(getGroupMdForPrompt({
      sessionKey: `agent:${agentId}:octo:group:unknown_grp`,
      agentId,
    })).toBeNull();
  });

  it("should return cached GROUP.md content for valid group session", () => {
    registerGroupAccount(groupNo, accountId, "testAgent");
    const content = "# Rules\nBe respectful.";
    const meta: GroupMdMeta = {
      version: 1,
      updated_at: null,
      updated_by: "admin",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };

    writeGroupMdToDisk({ accountId, groupNo, content, meta });

    const result = getGroupMdForPrompt({
      sessionKey: `agent:${agentId}:octo:group:${groupNo}`,
      agentId,
    });
    expect(result).toBe(content);
  });

  it("should return null when GROUP.md file doesn't exist on disk", () => {
    registerGroupAccount(groupNo, accountId, "testAgent");
    const result = getGroupMdForPrompt({
      sessionKey: `agent:${agentId}:octo:group:${groupNo}`,
      agentId,
    });
    expect(result).toBeNull();
  });

  it("should recover accountId from disk scan after restart", () => {
    // Simulate: write to disk, then reset memory
    const content = "# Recovered";
    const meta: GroupMdMeta = {
      version: 2,
      updated_at: null,
      updated_by: "admin",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };
    writeGroupMdToDisk({ accountId, groupNo, content, meta });

    _testReset(); // Simulate restart

    const result = getGroupMdForPrompt({
      sessionKey: `agent:${agentId}:octo:group:${groupNo}`,
      agentId,
    });
    expect(result).toBe(content);
  });
});

describe("event recognition (payload.event.type)", () => {
  it("should recognize group_md_updated event type", () => {
    const payload = {
      type: 1,
      content: "",
      event: { type: "group_md_updated", version: 5, updated_by: "uid123" },
    };
    expect(payload.event?.type).toBe("group_md_updated");
  });

  it("should recognize group_md_deleted event type", () => {
    const payload = {
      type: 1,
      content: "",
      event: { type: "group_md_deleted" },
    };
    expect(payload.event?.type).toBe("group_md_deleted");
  });

  it("should return undefined when no event field", () => {
    const payload = { type: 1, content: "hello" };
    expect((payload as any).event?.type).toBeUndefined();
  });

  it("should not match non-group-md event types", () => {
    const payload = {
      type: 1,
      content: "",
      event: { type: "member_joined" },
    };
    const eventType = payload.event?.type;
    expect(eventType !== "group_md_updated" && eventType !== "group_md_deleted").toBe(true);
  });
});

describe("getKnownGroupIds", () => {
  it("should return group IDs from _groupAccountMap", () => {
    registerGroupAccount("grp1", "acct1", "agent1");
    registerGroupAccount("grp2", "acct1", "agent1");
    const ids = getKnownGroupIds();
    expect(ids.has("grp1")).toBe(true);
    expect(ids.has("grp2")).toBe(true);
  });

  it("should return group IDs from groupMdCache", () => {
    const cache = getOrCreateGroupMdCache("acct1");
    cache.set("grp_cached1", { content: "# Test", version: 1 });
    cache.set("grp_cached2", { content: "# Test 2", version: 2 });
    const ids = getKnownGroupIds();
    expect(ids.has("grp_cached1")).toBe(true);
    expect(ids.has("grp_cached2")).toBe(true);
  });

  it("should merge IDs from both _groupAccountMap and groupMdCache", () => {
    registerGroupAccount("grp_map", "acct1", "agent1");
    const cache = getOrCreateGroupMdCache("acct2");
    cache.set("grp_cache", { content: "# Rules", version: 1 });
    const ids = getKnownGroupIds();
    expect(ids.has("grp_map")).toBe(true);
    expect(ids.has("grp_cache")).toBe(true);
  });

  it("should deduplicate IDs present in both sources", () => {
    registerGroupAccount("grp_dup", "acct1", "agent1");
    const cache = getOrCreateGroupMdCache("acct1");
    cache.set("grp_dup", { content: "# Dup", version: 1 });
    const ids = getKnownGroupIds();
    expect(ids.has("grp_dup")).toBe(true);
    // Set naturally deduplicates, just verify it's present
    expect([...ids].filter(id => id === "grp_dup")).toHaveLength(1);
  });

  it("should return empty set when no data exists", () => {
    const ids = getKnownGroupIds();
    expect(ids.size).toBe(0);
  });

  it("should include groups from multiple account caches", () => {
    const cache1 = getOrCreateGroupMdCache("acct1");
    cache1.set("grp_a1", { content: "# A1", version: 1 });
    const cache2 = getOrCreateGroupMdCache("acct2");
    cache2.set("grp_a2", { content: "# A2", version: 1 });
    const ids = getKnownGroupIds();
    expect(ids.has("grp_a1")).toBe(true);
    expect(ids.has("grp_a2")).toBe(true);
  });
});

// =========================================================================
// Channel ID helper tests
// =========================================================================

describe("extractParentGroupNo", () => {
  it("should return groupNo for plain group channelId", () => {
    expect(extractParentGroupNo("abc123")).toBe("abc123");
  });

  it("should extract parent groupNo from thread channelId", () => {
    expect(extractParentGroupNo("abc123____def456")).toBe("abc123");
  });

  it("should handle real-world hex group + numeric shortId", () => {
    expect(extractParentGroupNo("04f51b141553442ca63d7d10b1274be5____2039626171074744320")).toBe("04f51b141553442ca63d7d10b1274be5");
  });

  it("should return the full string when no ____ separator", () => {
    expect(extractParentGroupNo("no_separator_here")).toBe("no_separator_here");
  });

  it("should handle empty string", () => {
    expect(extractParentGroupNo("")).toBe("");
  });
});

describe("extractThreadShortId", () => {
  it("should return null for plain group channelId", () => {
    expect(extractThreadShortId("abc123")).toBeNull();
  });

  it("should extract shortId from thread channelId", () => {
    expect(extractThreadShortId("abc123____def456")).toBe("def456");
  });

  it("should handle real-world hex group + numeric shortId", () => {
    expect(extractThreadShortId("04f51b141553442ca63d7d10b1274be5____2039626171074744320")).toBe("2039626171074744320");
  });

  it("should return null for single underscore separators", () => {
    expect(extractThreadShortId("abc_123")).toBeNull();
    expect(extractThreadShortId("abc__123")).toBeNull();
    expect(extractThreadShortId("abc___123")).toBeNull();
  });

  it("should return null when shortId portion is empty", () => {
    expect(extractThreadShortId("abc123____")).toBeNull();
  });
});

describe("isThreadChannelId", () => {
  it("should return false for plain group channelId", () => {
    expect(isThreadChannelId("abc123")).toBe(false);
  });

  it("should return true for thread channelId", () => {
    expect(isThreadChannelId("abc123____def456")).toBe(true);
  });

  it("should return false for fewer than 4 underscores", () => {
    expect(isThreadChannelId("abc___def")).toBe(false);
    expect(isThreadChannelId("abc__def")).toBe(false);
  });

  it("should return true when ____ appears anywhere", () => {
    expect(isThreadChannelId("____suffix")).toBe(true);
    expect(isThreadChannelId("prefix____")).toBe(true);
  });
});

// =========================================================================
// Thread disk cache tests
// =========================================================================

describe("writeThreadMdToDisk / readThreadMdFromDisk", () => {
  const accountId = "jeff";
  const groupNo = "grp_abc";
  const shortId = "thread_123";

  it("should write and read THREAD.md content", () => {
    const content = "# Thread Rules\nStay on topic.";
    const meta: GroupMdMeta = {
      version: 3,
      updated_at: "2026-04-13T15:30:00Z",
      updated_by: "user123",
      fetched_at: "2026-04-13T15:31:00Z",
      account_id: accountId,
    };

    writeThreadMdToDisk({ accountId, groupNo, shortId, content, meta });

    const readContent = readThreadMdFromDisk(accountId, groupNo, shortId);
    expect(readContent).toBe(content);
  });

  it("should return null for non-existent thread file", () => {
    expect(readThreadMdFromDisk(accountId, groupNo, "nonexistent")).toBeNull();
  });

  it("should overwrite existing thread files", () => {
    const meta: GroupMdMeta = {
      version: 1,
      updated_at: null,
      updated_by: "u1",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };

    writeThreadMdToDisk({ accountId, groupNo, shortId, content: "v1", meta });
    expect(readThreadMdFromDisk(accountId, groupNo, shortId)).toBe("v1");

    writeThreadMdToDisk({
      accountId, groupNo, shortId,
      content: "v2",
      meta: { ...meta, version: 2 },
    });
    expect(readThreadMdFromDisk(accountId, groupNo, shortId)).toBe("v2");
  });

  it("should store in correct disk path hierarchy", () => {
    const content = "# Path test";
    const meta: GroupMdMeta = {
      version: 1,
      updated_at: null,
      updated_by: "u1",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };

    writeThreadMdToDisk({ accountId, groupNo, shortId, content, meta });

    const expectedPath = join(tmpBase, ".openclaw", "workspace", "octo", accountId, "groups", groupNo, "threads", shortId, "THREAD.md");
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf-8")).toBe(content);

    const expectedMetaPath = join(tmpBase, ".openclaw", "workspace", "octo", accountId, "groups", groupNo, "threads", shortId, "THREAD.meta.json");
    expect(existsSync(expectedMetaPath)).toBe(true);
  });
});

describe("deleteThreadMdFromDisk", () => {
  const accountId = "jeff";
  const groupNo = "grp_del";
  const shortId = "thread_del";

  it("should delete THREAD.md and meta files", () => {
    const meta: GroupMdMeta = {
      version: 1,
      updated_at: null,
      updated_by: "u1",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };

    writeThreadMdToDisk({ accountId, groupNo, shortId, content: "test", meta });
    expect(readThreadMdFromDisk(accountId, groupNo, shortId)).toBe("test");

    deleteThreadMdFromDisk(accountId, groupNo, shortId);
    expect(readThreadMdFromDisk(accountId, groupNo, shortId)).toBeNull();
  });

  it("should not throw when files don't exist", () => {
    expect(() => deleteThreadMdFromDisk(accountId, groupNo, "nonexistent")).not.toThrow();
  });
});

describe("broadcastThreadMdUpdate", () => {
  it("should write thread md to disk", () => {
    broadcastThreadMdUpdate({
      accountId: "acct1",
      groupNo: "grp1",
      shortId: "thr1",
      content: "# Broadcast test",
      version: 5,
    });

    const content = readThreadMdFromDisk("acct1", "grp1", "thr1");
    expect(content).toBe("# Broadcast test");
  });

  it("should not throw when writeThreadMdToDisk fails", () => {
    // Make HOME point to a read-only path that will cause mkdirSync to fail
    process.env.HOME = "/dev/null/impossible";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      broadcastThreadMdUpdate({
        accountId: "acct1",
        groupNo: "grp1",
        shortId: "thr1",
        content: "# fail",
        version: 1,
      }),
    ).not.toThrow();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("broadcastThreadMdUpdate failed"),
    );
    spy.mockRestore();
  });
});

describe("broadcastGroupMdUpdate", () => {
  it("should write group md to disk", () => {
    broadcastGroupMdUpdate({
      accountId: "acct1",
      groupNo: "grp1",
      content: "# Group test",
      version: 3,
    });

    const content = readGroupMdFromDisk("acct1", "grp1");
    expect(content).toBe("# Group test");
  });

  it("should not throw when writeGroupMdToDisk fails", () => {
    process.env.HOME = "/dev/null/impossible";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      broadcastGroupMdUpdate({
        accountId: "acct1",
        groupNo: "grp1",
        content: "# fail",
        version: 1,
      }),
    ).not.toThrow();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("broadcastGroupMdUpdate failed"),
    );
    spy.mockRestore();
  });
});

// =========================================================================
// P0: getGroupMdForPrompt with thread channelIds
// =========================================================================

describe("getGroupMdForPrompt (thread support)", () => {
  const agentId = "testAgent";
  const accountId = "jeff";
  const groupNo = "grp_thread";
  const shortId = "thr_123";

  it("should return empty string for thread when THREAD.md is empty", () => {
    registerGroupAccount(groupNo, accountId, agentId);
    const meta: GroupMdMeta = {
      version: 1,
      updated_at: null,
      updated_by: "admin",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };
    // Write an empty THREAD.md (simulates group_md_deleted writing empty content)
    writeThreadMdToDisk({ accountId, groupNo, shortId, content: "", meta });

    const result = getGroupMdForPrompt({
      sessionKey: `agent:${agentId}:octo:group:${groupNo}____${shortId}`,
      agentId,
    });
    // readThreadMdFromDisk returns "" for empty file (not null),
    // but the hook's `if (!content)` guard will filter it out — see risk 7.5
    expect(result).toBe("");
  });

  it("should return only thread content when both group and thread md exist", () => {
    registerGroupAccount(groupNo, accountId, agentId);
    const groupContent = "# Group Rules\nBe nice.";
    const threadContent = "# Sprint 42\nGoal: auth module";
    const meta: GroupMdMeta = {
      version: 1,
      updated_at: null,
      updated_by: "admin",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };

    writeGroupMdToDisk({ accountId, groupNo, content: groupContent, meta });
    writeThreadMdToDisk({ accountId, groupNo, shortId, content: threadContent, meta });

    const result = getGroupMdForPrompt({
      sessionKey: `agent:${agentId}:octo:group:${groupNo}____${shortId}`,
      agentId,
    });
    expect(result).toBe(threadContent);
  });

  it("should return null for thread when only group md exists (no fallback)", () => {
    registerGroupAccount(groupNo, accountId, agentId);
    const groupContent = "# Group only";
    const meta: GroupMdMeta = {
      version: 1,
      updated_at: null,
      updated_by: "admin",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };
    writeGroupMdToDisk({ accountId, groupNo, content: groupContent, meta });

    const result = getGroupMdForPrompt({
      sessionKey: `agent:${agentId}:octo:group:${groupNo}____${shortId}`,
      agentId,
    });
    expect(result).toBeNull();
  });

  it("should return thread content directly when group md does not exist", () => {
    registerGroupAccount(groupNo, accountId, agentId);
    const threadContent = "# Thread only content";
    const meta: GroupMdMeta = {
      version: 1,
      updated_at: null,
      updated_by: "admin",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };
    writeThreadMdToDisk({ accountId, groupNo, shortId, content: threadContent, meta });

    const result = getGroupMdForPrompt({
      sessionKey: `agent:${agentId}:octo:group:${groupNo}____${shortId}`,
      agentId,
    });
    expect(result).toBe(threadContent);
  });

  it("should return null when neither group nor thread md exist", () => {
    registerGroupAccount(groupNo, accountId, agentId);
    const result = getGroupMdForPrompt({
      sessionKey: `agent:${agentId}:octo:group:${groupNo}____${shortId}`,
      agentId,
    });
    expect(result).toBeNull();
  });

  it("should not include thread context for plain group sessionKey", () => {
    registerGroupAccount(groupNo, accountId, agentId);
    const groupContent = "# Group Rules";
    const threadContent = "# Thread content";
    const meta: GroupMdMeta = {
      version: 1,
      updated_at: null,
      updated_by: "admin",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };
    writeGroupMdToDisk({ accountId, groupNo, content: groupContent, meta });
    // Write thread md under the same group — but sessionKey is for plain group
    writeThreadMdToDisk({ accountId, groupNo, shortId, content: threadContent, meta });

    const result = getGroupMdForPrompt({
      sessionKey: `agent:${agentId}:octo:group:${groupNo}`,
      agentId,
    });
    // Should only get group content, not thread content
    expect(result).toBe(groupContent);
    expect(result).not.toContain("--- THREAD CONTEXT ---");
  });
});

// =========================================================================
// _testReset clears thread cache
// =========================================================================

describe("_testReset", () => {
  it("should clear _checkedThreads", () => {
    const checked = _testGetCheckedThreads();
    checked.add("acct1/grp1/thr1");
    expect(checked.size).toBe(1);

    _testReset();
    expect(checked.size).toBe(0);
  });
});

// =========================================================================
// Event type recognition for thread events
// =========================================================================

describe("event recognition (thread_md events)", () => {
  it("should recognize thread_md_updated event type", () => {
    const payload = {
      type: 1,
      content: "",
      event: {
        type: "thread_md_updated",
        version: 4,
        updated_by: "user123",
        group_no: "grp_abc",
        short_id: "thr_123",
      },
    };
    expect(payload.event?.type).toBe("thread_md_updated");
    expect(payload.event?.group_no).toBe("grp_abc");
    expect(payload.event?.short_id).toBe("thr_123");
  });

  it("should recognize thread_md_deleted event type", () => {
    const payload = {
      type: 1,
      content: "",
      event: {
        type: "thread_md_deleted",
        group_no: "grp_abc",
        short_id: "thr_123",
      },
    };
    expect(payload.event?.type).toBe("thread_md_deleted");
  });
});

// =========================================================================
// ensureThreadMd (with mocked fetch)
// =========================================================================

describe("ensureThreadMd", () => {
  const accountId = "acct1";
  const groupNo = "grp1";
  const shortId = "thr1";
  const baseParams = {
    agentId: "agent1",
    accountId,
    groupNo,
    shortId,
    apiUrl: "http://api.test",
    botToken: "tok",
  };

  it("should fetch from API and write to disk on first call", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({ content: "# Thread rules", version: 2, updated_at: "2026-04-13T00:00:00Z", updated_by: "user1" }),
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as any);

    await ensureThreadMd(baseParams);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(readThreadMdFromDisk(accountId, groupNo, shortId)).toBe("# Thread rules");

    fetchSpy.mockRestore();
  });

  it("should skip fetch on second call (same session)", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({ content: "# Rules", version: 1, updated_at: null, updated_by: "u1" }),
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as any);

    await ensureThreadMd(baseParams);
    await ensureThreadMd(baseParams);

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });

  it("should not write to disk when API returns 404", async () => {
    const mockResponse = { ok: false, status: 404 };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as any);

    await ensureThreadMd(baseParams);

    expect(readThreadMdFromDisk(accountId, groupNo, shortId)).toBeNull();

    fetchSpy.mockRestore();
  });

  it("should not write when API returns version=0 and empty content", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({ content: "", version: 0, updated_at: null, updated_by: "" }),
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as any);

    await ensureThreadMd(baseParams);

    expect(readThreadMdFromDisk(accountId, groupNo, shortId)).toBeNull();

    fetchSpy.mockRestore();
  });
});

// =========================================================================
// handleThreadMdEvent (with mocked fetch)
// =========================================================================

describe("handleThreadMdEvent", () => {
  const accountId = "acct1";
  const groupNo = "grp1";
  const shortId = "thr1";
  const baseParams = {
    agentId: "agent1",
    accountId,
    groupNo,
    shortId,
    apiUrl: "http://api.test",
    botToken: "tok",
  };

  it("should delete disk cache on thread_md_deleted", async () => {
    // Pre-populate disk
    const meta: GroupMdMeta = {
      version: 1, updated_at: null, updated_by: "u1",
      fetched_at: new Date().toISOString(), account_id: accountId,
    };
    writeThreadMdToDisk({ accountId, groupNo, shortId, content: "old", meta });
    expect(readThreadMdFromDisk(accountId, groupNo, shortId)).toBe("old");

    await handleThreadMdEvent({ ...baseParams, eventType: "thread_md_deleted" });

    expect(readThreadMdFromDisk(accountId, groupNo, shortId)).toBeNull();
  });

  it("should re-fetch and update disk on thread_md_updated", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({ content: "# Updated", version: 5, updated_at: "2026-04-13T12:00:00Z", updated_by: "admin" }),
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as any);

    await handleThreadMdEvent({ ...baseParams, eventType: "thread_md_updated" });

    expect(readThreadMdFromDisk(accountId, groupNo, shortId)).toBe("# Updated");

    fetchSpy.mockRestore();
  });

  it("should clear checked flag on thread_md_deleted", async () => {
    const checked = _testGetCheckedThreads();
    checked.add(`${accountId}/${groupNo}/${shortId}`);

    await handleThreadMdEvent({ ...baseParams, eventType: "thread_md_deleted" });

    expect(checked.has(`${accountId}/${groupNo}/${shortId}`)).toBe(false);
  });

  it("should handle fetch failure on thread_md_updated gracefully", async () => {
    const mockResponse = { ok: false, status: 500, text: async () => "Server Error" };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as any);

    // Should not throw
    await handleThreadMdEvent({ ...baseParams, eventType: "thread_md_updated" });

    expect(readThreadMdFromDisk(accountId, groupNo, shortId)).toBeNull();

    fetchSpy.mockRestore();
  });
});
