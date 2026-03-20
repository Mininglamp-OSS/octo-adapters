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
});
