/**
 * Regression test for the channel-id rebrand (Phase A).
 *
 * Verifies that `bind` / `remove-account` write to `channels.octo` (not
 * `channels.dmwork`) and that bindings carry `match.channel === "octo"`.
 * If a future refactor accidentally re-introduces the old channel id,
 * these tests fail loudly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks must be declared before importing the modules under test.
// ---------------------------------------------------------------------------

// Stub utils.js so ensureOpenClawCompat doesn't try to spawn `openclaw`.
// Re-export the real CHANNEL_ID/PLUGIN_ID/etc. via importOriginal so the
// module under test sees the canonical helper behaviour for paths/objects.
vi.mock("./utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils.js")>();
  return {
    ...actual,
    ensureOpenClawCompat: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Shared cfg state used by the mocked openclaw-cli reader/writer
// ---------------------------------------------------------------------------
let cfgState: any = {};
let writtenCfgs: any[] = [];

vi.mock("./openclaw-cli.js", () => ({
  isHealthyInstall: vi.fn(() => true),
  readConfigFromFile: vi.fn(() => cfgState),
  writeConfigAtomic: vi.fn((cfg: any) => {
    cfgState = cfg;
    writtenCfgs.push(JSON.parse(JSON.stringify(cfg)));
  }),
  configGet: vi.fn((path: string) => {
    const parts = path.split(".");
    let cur: any = cfgState;
    for (const p of parts) {
      if (cur == null) return null;
      cur = cur[p];
    }
    return cur != null ? String(cur) : null;
  }),
  configGetJson: vi.fn((path: string) => {
    const parts = path.split(".");
    let cur: any = cfgState;
    for (const p of parts) {
      if (cur == null) return null;
      cur = cur[p];
    }
    return cur ?? null;
  }),
  configUnset: vi.fn((path: string) => {
    const parts = path.split(".");
    let cur: any = cfgState;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur == null) return;
      cur = cur[parts[i]];
    }
    if (cur != null) delete cur[parts[parts.length - 1]];
  }),
  gatewayRestart: vi.fn(() => true),
  pluginsUninstall: vi.fn(),
}));

import { runBind } from "./bind.js";
import { runRemoveAccount } from "./remove-account.js";

beforeEach(() => {
  cfgState = {};
  writtenCfgs = [];
  // Stub fetch so runBind's bot-register / greeting calls never hit a network.
  global.fetch = vi.fn(async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
    text: async () => "",
  })) as any;
});

describe("bind — writes to channels.octo (not channels.dmwork)", () => {
  it("creates channels.octo.accounts.<id>, never channels.dmwork", async () => {
    await runBind({
      botToken: "bf_test_token",
      apiUrl: "https://api.example",
      accountId: "my_bot",
      agent: "agent1",
    });

    expect(cfgState.channels?.octo?.accounts?.my_bot?.botToken).toBe("bf_test_token");
    expect(cfgState.channels?.octo?.accounts?.my_bot?.apiUrl).toBe("https://api.example");
    // Negative: must not have written the legacy namespace
    expect(cfgState.channels?.dmwork).toBeUndefined();
  });

  it("creates a binding with match.channel === 'octo'", async () => {
    await runBind({
      botToken: "bf_test_token",
      apiUrl: "https://api.example",
      accountId: "my_bot",
      agent: "agent1",
    });

    expect(Array.isArray(cfgState.bindings)).toBe(true);
    const binding = cfgState.bindings.find(
      (b: any) => b.match?.accountId === "my_bot",
    );
    expect(binding).toBeDefined();
    expect(binding.match.channel).toBe("octo");
    expect(binding.agentId).toBe("agent1");
    // Negative: no dmwork-channel binding
    expect(cfgState.bindings.some((b: any) => b.match?.channel === "dmwork")).toBe(false);
  });

  it("updates an existing octo binding instead of duplicating", async () => {
    cfgState = {
      channels: { octo: { accounts: {} } },
      bindings: [
        { agentId: "agent-old", match: { channel: "octo", accountId: "my_bot" } },
      ],
    };

    await runBind({
      botToken: "bf_test_token",
      apiUrl: "https://api.example",
      accountId: "my_bot",
      agent: "agent-new",
    });

    const octoBindings = cfgState.bindings.filter(
      (b: any) => b.match?.channel === "octo" && b.match?.accountId === "my_bot",
    );
    expect(octoBindings).toHaveLength(1);
    expect(octoBindings[0].agentId).toBe("agent-new");
  });
});

describe("remove-account — only touches channels.octo", () => {
  it("looks up the account under channels.octo and leaves legacy channels.dmwork intact", async () => {
    cfgState = {
      channels: {
        octo: {
          accounts: {
            my_bot: { botToken: "bf_octo_token", apiUrl: "https://api.example" },
            // Second account so the "no remaining accounts → uninstall plugin"
            // branch doesn't fire and wipe channels.octo entirely.
            other_bot: { botToken: "bf_other_token", apiUrl: "https://api.example" },
          },
        },
        // Phase A boundary: legacy channels.dmwork must be left intact.
        dmwork: {
          accounts: {
            legacy_bot: { botToken: "bf_legacy_token" },
          },
        },
      },
      bindings: [
        { agentId: "agent1", match: { channel: "octo", accountId: "my_bot" } },
        { agentId: "agent2", match: { channel: "dmwork", accountId: "legacy_bot" } },
      ],
    };

    await runRemoveAccount({ accountId: "my_bot", yes: true });

    // Octo my_bot account is gone; other_bot still there
    expect(cfgState.channels.octo.accounts.my_bot).toBeUndefined();
    expect(cfgState.channels.octo.accounts.other_bot).toBeDefined();

    // Legacy channels.dmwork is left completely intact (Phase A boundary)
    expect(cfgState.channels.dmwork?.accounts?.legacy_bot?.botToken).toBe(
      "bf_legacy_token",
    );
  });
});
