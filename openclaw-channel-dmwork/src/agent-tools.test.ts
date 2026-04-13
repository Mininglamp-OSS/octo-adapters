import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./accounts.js", () => ({
  listDmworkAccountIds: vi.fn(),
  resolveDmworkAccount: vi.fn(),
  resolveDefaultDmworkAccountId: vi.fn(),
}));

vi.mock("./api-fetch.js", () => ({
  fetchBotGroups: vi.fn(),
  getGroupInfo: vi.fn(),
  getGroupMembers: vi.fn(),
  getGroupMd: vi.fn(),
  updateGroupMd: vi.fn(),
  getVoiceContext: vi.fn(),
  updateVoiceContext: vi.fn(),
  deleteVoiceContext: vi.fn(),
}));

vi.mock("./group-md.js", () => ({
  broadcastGroupMdUpdate: vi.fn(),
}));

import { createDmworkManagementTools } from "./agent-tools.js";
import {
  listDmworkAccountIds,
  resolveDmworkAccount,
  resolveDefaultDmworkAccountId,
} from "./accounts.js";
import {
  fetchBotGroups,
  getGroupInfo,
  getGroupMembers,
  getGroupMd,
  updateGroupMd,
  getVoiceContext,
  updateVoiceContext,
  deleteVoiceContext,
} from "./api-fetch.js";
import { broadcastGroupMdUpdate } from "./group-md.js";

// Minimal config stub — mocked account functions don't inspect it
const mockCfg = { channels: { dmwork: { botToken: "tok-secret" } } } as any;

function setupMocks(overrides?: {
  enabled?: boolean;
  configured?: boolean;
  botToken?: string;
  apiUrl?: string;
}) {
  const {
    enabled = true,
    configured = true,
    botToken = "tok-secret",
    apiUrl = "http://api.test",
  } = overrides ?? {};

  vi.mocked(listDmworkAccountIds).mockReturnValue(["default"]);
  vi.mocked(resolveDefaultDmworkAccountId).mockReturnValue("default");
  vi.mocked(resolveDmworkAccount).mockReturnValue({
    accountId: "default",
    enabled,
    configured,
    config: {
      botToken,
      apiUrl,
      pollIntervalMs: 2000,
      heartbeatIntervalMs: 30000,
    },
  });
}

/** Create tool and return its execute function */
function getExecute() {
  const tools = createDmworkManagementTools({ cfg: mockCfg });
  expect(tools).toHaveLength(1);
  return tools[0].execute as (
    id: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
}

function parseText(result: { content: { text: string }[] }): any {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------

describe("createDmworkManagementTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  // -----------------------------------------------------------------------
  // tool creation
  // -----------------------------------------------------------------------
  describe("tool creation", () => {
    it("returns empty array when cfg is undefined", () => {
      expect(createDmworkManagementTools({ cfg: undefined })).toEqual([]);
    });

    it("returns empty array when no account has botToken", () => {
      setupMocks({ botToken: "" });
      expect(createDmworkManagementTools({ cfg: mockCfg })).toEqual([]);
    });

    it("returns empty array when account is disabled", () => {
      setupMocks({ enabled: false });
      expect(createDmworkManagementTools({ cfg: mockCfg })).toEqual([]);
    });

    it("returns empty array when account is not configured", () => {
      setupMocks({ configured: false });
      expect(createDmworkManagementTools({ cfg: mockCfg })).toEqual([]);
    });

    it("returns empty array when listDmworkAccountIds throws", () => {
      vi.mocked(listDmworkAccountIds).mockImplementation(() => {
        throw new Error("bad config");
      });
      expect(createDmworkManagementTools({ cfg: mockCfg })).toEqual([]);
    });

    it("returns one tool when account is properly configured", () => {
      const tools = createDmworkManagementTools({ cfg: mockCfg });
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("dmwork_management");
    });
  });

  // -----------------------------------------------------------------------
  // list-groups
  // -----------------------------------------------------------------------
  describe("execute — list-groups", () => {
    it("returns groups on success", async () => {
      vi.mocked(fetchBotGroups).mockResolvedValue([
        { group_no: "g1", name: "Alpha" },
        { group_no: "g2", name: "Beta" },
      ]);
      const result = await getExecute()("tc", { action: "list-groups" });
      const data = parseText(result);
      expect(data.groups).toHaveLength(2);
      expect(data.groups[0].group_no).toBe("g1");
    });

    it("returns error on API failure", async () => {
      vi.mocked(fetchBotGroups).mockRejectedValue(new Error("Network error"));
      const result = await getExecute()("tc", { action: "list-groups" });
      const data = parseText(result);
      expect(data.error).toContain("list-groups failed");
    });
  });

  // -----------------------------------------------------------------------
  // group-info
  // -----------------------------------------------------------------------
  describe("execute — group-info", () => {
    it("returns group info on success", async () => {
      vi.mocked(getGroupInfo).mockResolvedValue({
        group_no: "g1",
        name: "Alpha",
        member_count: 5,
      });
      const result = await getExecute()("tc", {
        action: "group-info",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.group_no).toBe("g1");
      expect(data.name).toBe("Alpha");
    });

    it("returns error when groupId is missing", async () => {
      const result = await getExecute()("tc", { action: "group-info" });
      const data = parseText(result);
      expect(data.error).toContain("groupId");
    });

    it("returns error on API failure", async () => {
      vi.mocked(getGroupInfo).mockRejectedValue(new Error("404"));
      const result = await getExecute()("tc", {
        action: "group-info",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.error).toContain("group-info failed");
    });
  });

  // -----------------------------------------------------------------------
  // group-members
  // -----------------------------------------------------------------------
  describe("execute — group-members", () => {
    it("returns members on success", async () => {
      vi.mocked(getGroupMembers).mockResolvedValue([
        { uid: "u1", name: "Alice" },
        { uid: "u2", name: "Bob", role: "admin" },
      ]);
      const result = await getExecute()("tc", {
        action: "group-members",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.members).toHaveLength(2);
      expect(data.members[0].name).toBe("Alice");
    });

    it("returns error when groupId is missing", async () => {
      const result = await getExecute()("tc", { action: "group-members" });
      const data = parseText(result);
      expect(data.error).toContain("groupId");
    });
  });

  // -----------------------------------------------------------------------
  // group-md-read
  // -----------------------------------------------------------------------
  describe("execute — group-md-read", () => {
    it("returns GROUP.md content on success", async () => {
      vi.mocked(getGroupMd).mockResolvedValue({
        content: "# Rules\nBe nice.",
        version: 3,
        updated_at: "2024-01-01",
        updated_by: "admin",
      });
      const result = await getExecute()("tc", {
        action: "group-md-read",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.content).toBe("# Rules\nBe nice.");
      expect(data.version).toBe(3);
    });

    it("returns error when groupId is missing", async () => {
      const result = await getExecute()("tc", { action: "group-md-read" });
      const data = parseText(result);
      expect(data.error).toContain("groupId");
    });
  });

  // -----------------------------------------------------------------------
  // group-md-update
  // -----------------------------------------------------------------------
  describe("execute — group-md-update", () => {
    it("updates and calls broadcastGroupMdUpdate", async () => {
      vi.mocked(updateGroupMd).mockResolvedValue({ version: 7 });
      const result = await getExecute()("tc", {
        action: "group-md-update",
        groupId: "g1",
        content: "# Updated",
      });
      const data = parseText(result);
      expect(data.updated).toBe(true);
      expect(data.version).toBe(7);
      expect(broadcastGroupMdUpdate).toHaveBeenCalledWith({
        accountId: "default",
        groupNo: "g1",
        content: "# Updated",
        version: 7,
      });
    });

    it("returns error when groupId is missing", async () => {
      const result = await getExecute()("tc", {
        action: "group-md-update",
        content: "# New",
      });
      const data = parseText(result);
      expect(data.error).toContain("groupId");
    });

    it("returns error when content is missing", async () => {
      const result = await getExecute()("tc", {
        action: "group-md-update",
        groupId: "g1",
      });
      const data = parseText(result);
      expect(data.error).toContain("content");
    });
  });

  // -----------------------------------------------------------------------
  // accountId resolution
  // -----------------------------------------------------------------------
  describe("accountId resolution", () => {
    it("uses provided accountId", async () => {
      vi.mocked(listDmworkAccountIds).mockReturnValue(["default", "acct2"]);
      vi.mocked(resolveDmworkAccount).mockImplementation(({ accountId }: any) => ({
        accountId: accountId ?? "default",
        enabled: true,
        configured: true,
        config: {
          botToken: "tok-acct2",
          apiUrl: "http://api2.test",
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      }));
      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      await execute("tc", { action: "list-groups", accountId: "acct2" });
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api2.test",
        botToken: "tok-acct2",
      });
    });

    it("falls back to default accountId when not provided", async () => {
      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      await execute("tc", { action: "list-groups" });
      expect(resolveDefaultDmworkAccountId).toHaveBeenCalled();
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api.test",
        botToken: "tok-secret",
      });
    });

    it("multi-account: falls back to first account when no accountId and no default", async () => {
      vi.mocked(listDmworkAccountIds).mockReturnValue(["bot-a", "bot-b"]);
      vi.mocked(resolveDefaultDmworkAccountId).mockReturnValue(null as any);
      vi.mocked(resolveDmworkAccount).mockImplementation(({ accountId }: any) => ({
        accountId,
        enabled: true,
        configured: true,
        config: {
          botToken: `tok-${accountId}`,
          apiUrl: `http://api-${accountId}.test`,
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      }));
      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      await execute("tc", { action: "list-groups" });
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api-bot-a.test",
        botToken: "tok-bot-a",
      });
    });

    it('multi-account: accountId="default" falls back to first account', async () => {
      vi.mocked(listDmworkAccountIds).mockReturnValue(["bot-a", "bot-b"]);
      vi.mocked(resolveDefaultDmworkAccountId).mockReturnValue(null as any);
      vi.mocked(resolveDmworkAccount).mockImplementation(({ accountId }: any) => ({
        accountId,
        enabled: true,
        configured: true,
        config: {
          botToken: `tok-${accountId}`,
          apiUrl: `http://api-${accountId}.test`,
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      }));
      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      await execute("tc", { action: "list-groups", accountId: "default" });
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api-bot-a.test",
        botToken: "tok-bot-a",
      });
    });

    it("resolves correct account in multi-account setup", async () => {
      vi.mocked(listDmworkAccountIds).mockReturnValue(["primary", "secondary"]);
      vi.mocked(resolveDmworkAccount).mockImplementation(({ accountId }: any) => {
        if (accountId === "secondary") {
          return {
            accountId: "secondary",
            enabled: true,
            configured: true,
            config: {
              botToken: "tok-secondary",
              apiUrl: "http://api-secondary.test",
              pollIntervalMs: 2000,
              heartbeatIntervalMs: 30000,
            },
          };
        }
        return {
          accountId: "primary",
          enabled: true,
          configured: true,
          config: {
            botToken: "tok-primary",
            apiUrl: "http://api-primary.test",
            pollIntervalMs: 2000,
            heartbeatIntervalMs: 30000,
          },
        };
      });

      vi.mocked(fetchBotGroups).mockResolvedValue([]);
      const execute = getExecute();
      await execute("tc", { action: "list-groups", accountId: "secondary" });
      expect(fetchBotGroups).toHaveBeenCalledWith({
        apiUrl: "http://api-secondary.test",
        botToken: "tok-secondary",
      });
    });
  });

  // -----------------------------------------------------------------------
  // parameter validation
  // -----------------------------------------------------------------------
  describe("parameter validation", () => {
    it("returns error for unknown action", async () => {
      const result = await getExecute()("tc", { action: "do-magic" });
      const data = parseText(result);
      expect(data.error).toContain("Unknown action");
    });

    it("returns error when action is missing", async () => {
      const result = await getExecute()("tc", {});
      const data = parseText(result);
      expect(data.error).toContain("Unknown action");
    });
  });

  // -----------------------------------------------------------------------
  // token security
  // -----------------------------------------------------------------------
  describe("token security", () => {
    it("tool schema does not contain botToken", () => {
      const tools = createDmworkManagementTools({ cfg: mockCfg });
      const schema = JSON.stringify(tools[0].parameters);
      expect(schema).not.toContain("botToken");
    });

    it("successful results do not leak botToken", async () => {
      vi.mocked(fetchBotGroups).mockResolvedValue([{ group_no: "g1", name: "G1" }]);
      const result = await getExecute()("tc", { action: "list-groups" });
      expect(result.content[0].text).not.toContain("tok-secret");
    });

    it("error results do not leak botToken", async () => {
      const execute = getExecute();
      // After tool creation, change mock so execute sees no botToken
      vi.mocked(resolveDmworkAccount).mockReturnValue({
        accountId: "default",
        enabled: true,
        configured: true,
        config: {
          botToken: undefined,
          apiUrl: "http://api.test",
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      });
      const result = await execute("tc", { action: "list-groups" });
      expect(result.content[0].text).not.toContain("tok-secret");
    });
  });

  // -----------------------------------------------------------------------
  // voice-context actions
  // -----------------------------------------------------------------------
  describe("voice-context actions", () => {
    // -- Schema tests --

    it("tool schema includes voice-context-* actions", () => {
      const tools = createDmworkManagementTools({ cfg: mockCfg });
      const schema = tools[0].parameters;
      const actionEnum = schema.properties.action.enum;
      expect(actionEnum).toContain("voice-context-read");
      expect(actionEnum).toContain("voice-context-update");
      expect(actionEnum).toContain("voice-context-delete");
    });

    it("tool description mentions voice correction context", () => {
      const tools = createDmworkManagementTools({ cfg: mockCfg });
      expect(tools[0].description).toContain("voice correction context");
    });

    // Token leak prevention
    it("tool schema does not contain botToken", () => {
      const tools = createDmworkManagementTools({ cfg: mockCfg });
      const schema = JSON.stringify(tools[0].parameters);
      expect(schema).not.toContain("botToken");
      expect(schema).not.toContain("tok-secret");
    });

    // -- voice-context-read tests --

    it("voice-context-read returns normalized result", async () => {
      vi.mocked(getVoiceContext).mockResolvedValue({
        has_context: true,
        context: "correction terms",
        updated_at: "2026-04-09T13:00:00+08:00",
      });

      const result = await getExecute()("tc", { action: "voice-context-read" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.has_context).toBe(true);
      expect(parsed.context).toBe("correction terms");
      expect(parsed.updated_at).toBe("2026-04-09T13:00:00+08:00");
      // No status field in result
      expect(parsed.status).toBeUndefined();
    });

    it("voice-context-read calls getVoiceContext with correct params", async () => {
      vi.mocked(getVoiceContext).mockResolvedValue({
        has_context: false,
        context: "",
        updated_at: "",
      });

      await getExecute()("tc", { action: "voice-context-read" });

      expect(getVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api.test",
        botToken: "tok-secret",
      });
    });

    it("voice-context-read result does not leak botToken", async () => {
      vi.mocked(getVoiceContext).mockResolvedValue({
        has_context: true,
        context: "terms",
        updated_at: "",
      });

      const result = await getExecute()("tc", { action: "voice-context-read" });
      expect(result.content[0].text).not.toContain("tok-secret");
    });

    it("voice-context-read wraps API errors in makeError", async () => {
      vi.mocked(getVoiceContext).mockRejectedValue(
        new Error("Bot API GET /v1/bot/voice/context failed (401): invalid token"),
      );

      const result = await getExecute()("tc", { action: "voice-context-read" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toContain("voice-context-read failed");
      // Error must not leak token
      expect(parsed.error).not.toContain("tok-secret");
    });

    // -- voice-context-update tests --

    it("voice-context-update succeeds with valid content", async () => {
      vi.mocked(updateVoiceContext).mockResolvedValue(undefined);

      const result = await getExecute()("tc", {
        action: "voice-context-update",
        content: "new correction terms",
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.updated).toBe(true);
      expect(updateVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api.test",
        botToken: "tok-secret",
        content: "new correction terms",
      });
    });

    // Empty string rejection tests

    it("voice-context-update rejects undefined content", async () => {
      const result = await getExecute()("tc", {
        action: "voice-context-update",
        // content not provided
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("must not be empty");
      expect(updateVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-update rejects null content", async () => {
      const result = await getExecute()("tc", {
        action: "voice-context-update",
        content: null,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("must not be empty");
      expect(updateVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-update rejects empty string content", async () => {
      const result = await getExecute()("tc", {
        action: "voice-context-update",
        content: "",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("must not be empty");
      expect(updateVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-update rejects whitespace-only content", async () => {
      const result = await getExecute()("tc", {
        action: "voice-context-update",
        content: "   \t\n  ",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("must not be empty");
      expect(updateVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-update wraps API errors", async () => {
      vi.mocked(updateVoiceContext).mockRejectedValue(
        new Error("Bot API PUT /v1/bot/voice/context failed (400): context exceeds max length"),
      );

      const result = await getExecute()("tc", {
        action: "voice-context-update",
        content: "x".repeat(10001),
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("voice-context-update failed");
    });

    // -- voice-context-delete tests --

    it("voice-context-delete succeeds", async () => {
      vi.mocked(deleteVoiceContext).mockResolvedValue(undefined);

      const result = await getExecute()("tc", { action: "voice-context-delete" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.deleted).toBe(true);
      expect(deleteVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api.test",
        botToken: "tok-secret",
      });
    });

    it("voice-context-delete wraps API errors", async () => {
      vi.mocked(deleteVoiceContext).mockRejectedValue(
        new Error("Bot API DELETE /v1/bot/voice/context failed (401): invalid token"),
      );

      const result = await getExecute()("tc", { action: "voice-context-delete" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("voice-context-delete failed");
    });

    // Multi-account tests

    it("voice-context-read uses specified accountId", async () => {
      vi.mocked(listDmworkAccountIds).mockReturnValue(["primary", "secondary"]);
      vi.mocked(resolveDmworkAccount).mockImplementation(({ accountId }: any) => {
        if (accountId === "secondary") {
          return {
            accountId: "secondary",
            enabled: true,
            configured: true,
            config: {
              apiUrl: "http://api-secondary.test",
              botToken: "tok-secondary",
              pollIntervalMs: 2000,
              heartbeatIntervalMs: 30000,
            },
          } as any;
        }
        return {
          accountId: "primary",
          enabled: true,
          configured: true,
          config: {
            apiUrl: "http://api.test",
            botToken: "tok-secret",
            pollIntervalMs: 2000,
            heartbeatIntervalMs: 30000,
          },
        } as any;
      });

      vi.mocked(getVoiceContext).mockResolvedValue({
        has_context: false,
        context: "",
        updated_at: "",
      });

      await getExecute()("tc", {
        action: "voice-context-read",
        accountId: "secondary",
      });

      expect(getVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api-secondary.test",
        botToken: "tok-secondary",
      });
    });

    it("voice-context-update uses specified accountId", async () => {
      vi.mocked(listDmworkAccountIds).mockReturnValue(["primary", "secondary"]);
      vi.mocked(resolveDmworkAccount).mockImplementation(({ accountId }: any) => {
        if (accountId === "secondary") {
          return {
            accountId: "secondary",
            enabled: true,
            configured: true,
            config: {
              apiUrl: "http://api-secondary.test",
              botToken: "tok-secondary",
              pollIntervalMs: 2000,
              heartbeatIntervalMs: 30000,
            },
          } as any;
        }
        return {
          accountId: "primary",
          enabled: true,
          configured: true,
          config: {
            apiUrl: "http://api.test",
            botToken: "tok-secret",
            pollIntervalMs: 2000,
            heartbeatIntervalMs: 30000,
          },
        } as any;
      });

      vi.mocked(updateVoiceContext).mockResolvedValue(undefined);

      await getExecute()("tc", {
        action: "voice-context-update",
        content: "terms",
        accountId: "secondary",
      });

      expect(updateVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api-secondary.test",
        botToken: "tok-secondary",
        content: "terms",
      });
    });

    it("voice-context-delete uses specified accountId", async () => {
      vi.mocked(listDmworkAccountIds).mockReturnValue(["primary", "secondary"]);
      vi.mocked(resolveDmworkAccount).mockImplementation(({ accountId }: any) => {
        if (accountId === "secondary") {
          return {
            accountId: "secondary",
            enabled: true,
            configured: true,
            config: {
              apiUrl: "http://api-secondary.test",
              botToken: "tok-secondary",
              pollIntervalMs: 2000,
              heartbeatIntervalMs: 30000,
            },
          } as any;
        }
        return {
          accountId: "primary",
          enabled: true,
          configured: true,
          config: {
            apiUrl: "http://api.test",
            botToken: "tok-secret",
            pollIntervalMs: 2000,
            heartbeatIntervalMs: 30000,
          },
        } as any;
      });

      vi.mocked(deleteVoiceContext).mockResolvedValue(undefined);

      await getExecute()("tc", {
        action: "voice-context-delete",
        accountId: "secondary",
      });

      expect(deleteVoiceContext).toHaveBeenCalledWith({
        apiUrl: "http://api-secondary.test",
        botToken: "tok-secondary",
      });
    });

    // Token not leaked on multi-account calls
    it("multi-account results do not leak secondary botToken", async () => {
      vi.mocked(resolveDmworkAccount).mockReturnValue({
        accountId: "secondary",
        enabled: true,
        configured: true,
        config: {
          apiUrl: "http://api-secondary.test",
          botToken: "tok-secondary-secret-123",
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      } as any);

      vi.mocked(getVoiceContext).mockResolvedValue({
        has_context: true,
        context: "terms",
        updated_at: "",
      });

      const result = await getExecute()("tc", {
        action: "voice-context-read",
        accountId: "secondary",
      });

      expect(result.content[0].text).not.toContain("tok-secondary-secret-123");
    });

    // -- strict accountId validation --

    it("voice-context-read with non-existent accountId returns error", async () => {
      vi.mocked(listDmworkAccountIds).mockReturnValue(["primary", "secondary"]);
      const execute = getExecute();

      const result = await execute("tc", {
        action: "voice-context-read",
        accountId: "nonexistent",
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toContain("Account not found");
      expect(parsed.error).toContain("nonexistent");
      expect(getVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-update with non-existent accountId returns error", async () => {
      vi.mocked(listDmworkAccountIds).mockReturnValue(["primary", "secondary"]);
      const execute = getExecute();

      const result = await execute("tc", {
        action: "voice-context-update",
        content: "some terms",
        accountId: "nonexistent",
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toContain("Account not found");
      expect(parsed.error).toContain("nonexistent");
      expect(updateVoiceContext).not.toHaveBeenCalled();
    });

    it("voice-context-delete with non-existent accountId returns error", async () => {
      vi.mocked(listDmworkAccountIds).mockReturnValue(["primary", "secondary"]);
      const execute = getExecute();

      const result = await execute("tc", {
        action: "voice-context-delete",
        accountId: "nonexistent",
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toContain("Account not found");
      expect(parsed.error).toContain("nonexistent");
      expect(deleteVoiceContext).not.toHaveBeenCalled();
    });

    // -- botToken not configured --

    it("returns error when botToken is not configured", async () => {
      const execute = getExecute();
      // After tool creation, change mock so execute sees no botToken
      vi.mocked(resolveDmworkAccount).mockReturnValue({
        accountId: "no-token",
        enabled: true,
        configured: true,
        config: {
          apiUrl: "http://api.test",
          botToken: "",
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 30000,
        },
      } as any);

      const result = await execute("tc", { action: "voice-context-read" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("botToken is not configured");
    });

    // No alias for voice-context actions

    it("voice-context-* actions do not accept aliases", async () => {
      // Action name must be exact
      const result = await getExecute()("tc", { action: "voice-read" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("Unknown action");
    });
  });
});
