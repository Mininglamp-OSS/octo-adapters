/**
 * Tests for multi-bot accountId isolation fix.
 *
 * Verifies that when multiple bots share the same OpenClaw Gateway process,
 * messages are sent from the correct bot account — not from whichever bot
 * last processed a message in the same group.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// We need to reset module state between tests since _groupToAccount is module-level
beforeEach(() => {
  vi.resetModules();
});

// ─── registerGroupToAccount / resolveAccountForGroup unit tests ─────────────

describe("registerGroupToAccount + resolveAccountForGroup", () => {
  it("single bot — resolveAccountForGroup returns the registered accountId", async () => {
    const { registerGroupToAccount, resolveAccountForGroup } = await import("./channel.js");

    registerGroupToAccount("group-001", "botA");

    expect(resolveAccountForGroup("group-001")).toBe("botA");
  });

  it("multi-bot same group — resolveAccountForGroup returns undefined", async () => {
    const { registerGroupToAccount, resolveAccountForGroup } = await import("./channel.js");

    registerGroupToAccount("group-001", "botA");
    registerGroupToAccount("group-001", "botB");

    expect(resolveAccountForGroup("group-001")).toBeUndefined();
  });

  it("unregistered group — resolveAccountForGroup returns undefined", async () => {
    const { resolveAccountForGroup } = await import("./channel.js");

    expect(resolveAccountForGroup("group-unknown")).toBeUndefined();
  });

  it("duplicate registration of same bot is idempotent", async () => {
    const { registerGroupToAccount, resolveAccountForGroup } = await import("./channel.js");

    registerGroupToAccount("group-001", "botA");
    registerGroupToAccount("group-001", "botA");

    // Still size 1 → should return the accountId
    expect(resolveAccountForGroup("group-001")).toBe("botA");
  });

  it("different groups with different bots resolve independently", async () => {
    const { registerGroupToAccount, resolveAccountForGroup } = await import("./channel.js");

    registerGroupToAccount("group-001", "botA");
    registerGroupToAccount("group-002", "botB");

    expect(resolveAccountForGroup("group-001")).toBe("botA");
    expect(resolveAccountForGroup("group-002")).toBe("botB");
  });
});

// ─── handleAction correction logic tests ─────────────────────────────────────

// Mock dependencies that handleAction calls
vi.mock("./actions.js", () => ({
  handleDmworkMessageAction: vi.fn(async () => ({ ok: true })),
  parseTarget: vi.fn(() => ({ channelId: "test", channelType: 2 })),
}));

vi.mock("./agent-tools.js", () => ({
  createDmworkManagementTools: vi.fn(() => []),
}));

vi.mock("./group-md.js", () => ({
  getOrCreateGroupMdCache: vi.fn(() => new Map()),
  registerBotGroupIds: vi.fn(),
  getKnownGroupIds: vi.fn(() => new Set()),
}));

vi.mock("./api-fetch.js", () => ({
  registerBot: vi.fn(),
  sendMessage: vi.fn(),
  sendHeartbeat: vi.fn(),
  sendMediaMessage: vi.fn(),
  inferContentType: vi.fn(),
  ensureTextCharset: vi.fn((s: string) => s),
  fetchBotGroups: vi.fn(async () => []),
  getGroupMd: vi.fn(),
  getGroupMembers: vi.fn(),
  parseImageDimensions: vi.fn(),
  parseImageDimensionsFromFile: vi.fn(),
  getUploadCredentials: vi.fn(),
  uploadFileToCOS: vi.fn(),
}));

describe("handleAction multi-bot isolation", () => {
  it("single bot — corrects wrong accountId to the sole owner", async () => {
    const { dmworkPlugin, registerGroupToAccount } = await import("./channel.js");
    const { handleDmworkMessageAction } = await import("./actions.js");

    // Only botA is in group-001
    registerGroupToAccount("group-001", "botA");

    const ctx = {
      accountId: "wrongBot",
      action: "send" as const,
      channel: "dmwork",
      params: { target: "group:group-001", text: "hello" },
      toolContext: { currentChannelId: "dmwork:group-001" },
      cfg: {
        channels: {
          dmwork: {
            accounts: {
              botA: { botToken: "tokenA", apiUrl: "http://api" },
              wrongBot: { botToken: "tokenWrong", apiUrl: "http://api" },
            },
          },
        },
      },
      log: { info: vi.fn() },
    };

    await dmworkPlugin.actions!.handleAction!(ctx as any);

    // handleDmworkMessageAction should have been called with botA's token
    expect(handleDmworkMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: "tokenA" }),
    );
    // Correction log should have fired
    expect(ctx.log.info).toHaveBeenCalledWith(
      expect.stringContaining("accountId corrected"),
    );
  });

  it("multi-bot same group — does NOT override ctx.accountId", async () => {
    const { dmworkPlugin, registerGroupToAccount } = await import("./channel.js");
    const { handleDmworkMessageAction } = await import("./actions.js");

    // Both botA and botB are in group-001
    registerGroupToAccount("group-001", "botA");
    registerGroupToAccount("group-001", "botB");

    const ctx = {
      accountId: "botA",
      action: "send" as const,
      channel: "dmwork",
      params: { target: "group:group-001", text: "hello from A" },
      toolContext: { currentChannelId: "dmwork:group-001" },
      cfg: {
        channels: {
          dmwork: {
            accounts: {
              botA: { botToken: "tokenA", apiUrl: "http://api" },
              botB: { botToken: "tokenB", apiUrl: "http://api" },
            },
          },
        },
      },
      log: { info: vi.fn() },
    };

    await dmworkPlugin.actions!.handleAction!(ctx as any);

    // Should use botA's token (the caller's original accountId), NOT botB's
    expect(handleDmworkMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: "tokenA" }),
    );
    // No correction log should have fired
    expect(ctx.log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("accountId corrected"),
    );
  });

  it("single bot — correct accountId is not re-corrected", async () => {
    const { dmworkPlugin, registerGroupToAccount } = await import("./channel.js");
    const { handleDmworkMessageAction } = await import("./actions.js");

    registerGroupToAccount("group-001", "botA");

    const ctx = {
      accountId: "botA", // already correct
      action: "send" as const,
      channel: "dmwork",
      params: { target: "group:group-001", text: "hello" },
      toolContext: { currentChannelId: "dmwork:group-001" },
      cfg: {
        channels: {
          dmwork: {
            accounts: {
              botA: { botToken: "tokenA", apiUrl: "http://api" },
            },
          },
        },
      },
      log: { info: vi.fn() },
    };

    await dmworkPlugin.actions!.handleAction!(ctx as any);

    expect(handleDmworkMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: "tokenA" }),
    );
    // No correction needed
    expect(ctx.log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("accountId corrected"),
    );
  });
});
