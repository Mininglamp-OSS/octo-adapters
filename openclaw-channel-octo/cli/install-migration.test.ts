/**
 * Phase B migration tests.
 *
 * Two scenarios share the same runMigration() implementation:
 *   - rebrand:        openclaw-channel-dmwork → openclaw-channel-octo
 *   - legacy-to-octo: very-legacy "dmwork" plugin id → openclaw-channel-octo
 *
 * Both transform channels.dmwork → channels.octo and rewrite bindings'
 * match.channel from "dmwork" to "octo". Tests assert the command sequence
 * (via execFileSync mock) and final config state (via fs writeFileSync mock).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(() => ""),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => "{}"),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    renameSync: vi.fn(),
    rmSync: vi.fn(),
    readdirSync: vi.fn(() => [] as any),
    statSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

const mockExecFileSync = vi.mocked(execFileSync);

async function loadInstall() {
  vi.resetModules();
  return await import("./install.js");
}

interface FakeFsState {
  /** Current openclaw.json contents (mutated by writeFileSync simulation). */
  cfg: any;
  /** extension dirs that "exist". */
  extDirs: Set<string>;
  /** workspace dirs that "exist". */
  workspaceDirs: Set<string>;
}

function setupFs(initial: {
  cfg: any;
  extDirs?: string[];
  workspaceDirs?: string[];
}): FakeFsState {
  const state: FakeFsState = {
    cfg: structuredClone(initial.cfg),
    extDirs: new Set(initial.extDirs ?? []),
    workspaceDirs: new Set(initial.workspaceDirs ?? []),
  };

  return state;
}

async function applyFsMocks(state: FakeFsState) {
  const fs = await import("node:fs");
  vi.mocked(fs.readFileSync).mockImplementation((path: any) => {
    const p = String(path);
    if (p.endsWith("openclaw.json")) {
      return JSON.stringify(state.cfg);
    }
    return "{}";
  });
  vi.mocked(fs.writeFileSync).mockImplementation((path: any, data: any) => {
    const p = String(path);
    if (p.endsWith("openclaw.json.tmp") || p.endsWith("openclaw.json")) {
      try {
        state.cfg = JSON.parse(String(data));
      } catch { /* ignore */ }
    }
  });
  vi.mocked(fs.renameSync).mockImplementation(() => {
    // Simulated atomic rename — no-op for our purposes (writeFileSync already updated state.cfg)
  });
  vi.mocked(fs.copyFileSync).mockImplementation(() => {
    // backup files — no-op
  });
  vi.mocked(fs.existsSync).mockImplementation((path: any) => {
    const p = String(path);
    if (p.includes("/extensions/")) {
      // Match `/extensions/<id>` — return true if in extDirs
      const m = p.match(/\/extensions\/([^/]+)$/);
      if (m && state.extDirs.has(m[1])) return true;
      return false;
    }
    if (p.includes("/workspace/")) {
      const m = p.match(/\/workspace\/([^/]+)$/);
      if (m && state.workspaceDirs.has(m[1])) return true;
      return false;
    }
    if (p.endsWith("openclaw.json")) return true;
    return false;
  });
  vi.mocked(fs.rmSync).mockImplementation((path: any) => {
    const p = String(path);
    const m = p.match(/\/extensions\/([^/]+)$/);
    if (m) state.extDirs.delete(m[1]);
    const wm = p.match(/\/workspace\/([^/]+)$/);
    if (wm) state.workspaceDirs.delete(wm[1]);
  });
}

interface OpenClawMockOpts {
  /** Scripted responses for `openclaw plugins inspect <id>` keyed by id. */
  inspect?: Record<string, any | null>;
  /** Throw on this op. e.g. {op: "plugins install <spec>"} */
  failOn?: { match: RegExp; error?: Error };
  /** OpenClaw version string returned by --version. */
  version?: string;
  /** If true, all `plugins enable/disable/uninstall` throw "unknown command" (4.20). */
  unknownCommands?: boolean;
}

function mockOpenclawCli(opts: OpenClawMockOpts = {}) {
  mockExecFileSync.mockImplementation((cmd: any, args: any) => {
    const a = args as string[];
    const op = a.join(" ");

    if (opts.failOn && opts.failOn.match.test(op)) {
      throw opts.failOn.error ?? new Error(`mocked failure on: ${op}`);
    }

    if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
    if (a[0] === "--version") return opts.version ?? "OpenClaw 2026.5.7\n";

    if (a[0] === "plugins" && a[1] === "inspect") {
      const id = a[2];
      const result = opts.inspect?.[id];
      if (!result) {
        const err: any = new Error("plugin not found");
        err.stderr = "not found";
        throw err;
      }
      return JSON.stringify(result);
    }

    if (a[0] === "plugins" && (a[1] === "enable" || a[1] === "disable" || a[1] === "uninstall")) {
      if (opts.unknownCommands) {
        const err: any = new Error("unknown command");
        err.stderr = "unknown command";
        throw err;
      }
      return "";
    }

    if (a[0] === "plugins" && a[1] === "install") return "";
    if (a[0] === "gateway") return "";
    if (cmd === "npm" && a[0] === "view") return "1.0.0\n";

    return "";
  });
}

function calledOps(): string[] {
  return mockExecFileSync.mock.calls.map((c) => (c[1] as string[]).join(" "));
}

// ---------------------------------------------------------------------------
// rebrand scenario
// ---------------------------------------------------------------------------

describe("runInstall — rebrand scenario (openclaw-channel-dmwork → octo)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("case A: dmwork enabled + channels + bindings → full migration sequence", async () => {
    const state = setupFs({
      cfg: {
        plugins: {
          entries: { "openclaw-channel-dmwork": { enabled: true } },
          installs: { "openclaw-channel-dmwork": { source: "npm", version: "0.6.4" } },
          allow: ["openclaw-channel-dmwork"],
        },
        channels: {
          dmwork: {
            accounts: { mybot: { botToken: "bf_xxx", apiUrl: "https://im.example.com" } },
          },
        },
        bindings: [
          { agentId: "agent1", match: { channel: "dmwork", accountId: "mybot" } },
        ],
      },
      extDirs: ["openclaw-channel-dmwork"],
    });
    await applyFsMocks(state);

    mockOpenclawCli({
      inspect: {
        "openclaw-channel-dmwork": { plugin: { id: "openclaw-channel-dmwork", version: "0.6.4", enabled: true } },
      },
    });

    // After pluginsInstall(octo) is called, octo's dirs/cfg should appear.
    // Simulate by intercepting plugins install side effects:
    const origExecImpl = mockExecFileSync.getMockImplementation();
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const a = args as string[];
      if (a[0] === "plugins" && a[1] === "install" && a[2]?.startsWith("openclaw-channel-octo")) {
        // Side effect: octo install populates entries/installs/dir
        state.cfg.plugins ??= {};
        state.cfg.plugins.entries ??= {};
        state.cfg.plugins.entries["openclaw-channel-octo"] = { enabled: true };
        state.cfg.plugins.installs ??= {};
        state.cfg.plugins.installs["openclaw-channel-octo"] = { source: "npm", version: "1.0.0" };
        state.cfg.plugins.allow ??= [];
        if (!state.cfg.plugins.allow.includes("openclaw-channel-octo")) {
          state.cfg.plugins.allow.push("openclaw-channel-octo");
        }
        state.extDirs.add("openclaw-channel-octo");
        return "";
      }
      // After install, inspect octo should succeed too — re-dispatch via opts
      if (a[0] === "plugins" && a[1] === "inspect" && a[2] === "openclaw-channel-octo") {
        if (state.cfg.plugins?.entries?.["openclaw-channel-octo"]) {
          return JSON.stringify({
            plugin: { id: "openclaw-channel-octo", version: "1.0.0", enabled: true },
          });
        }
      }
      return origExecImpl!(cmd, args, undefined as any) as any;
    });

    const { runInstall } = await loadInstall();
    await runInstall({ force: false, dev: false });

    const ops = calledOps();
    // Sequence: disable legacy → install octo → enable octo → uninstall legacy
    const disableIdx = ops.findIndex((o) => /^plugins disable openclaw-channel-dmwork$/.test(o));
    const installIdx = ops.findIndex((o) => /^plugins install openclaw-channel-octo/.test(o));
    const enableIdx = ops.findIndex((o) => /^plugins enable openclaw-channel-octo$/.test(o));
    const uninstallIdx = ops.findIndex((o) => /^plugins uninstall openclaw-channel-dmwork/.test(o));

    expect(disableIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeGreaterThan(disableIdx);
    expect(enableIdx).toBeGreaterThan(installIdx);
    expect(uninstallIdx).toBeGreaterThan(enableIdx);

    // Final cfg: channels.octo populated, channels.dmwork gone, bindings rewritten.
    expect(state.cfg.channels?.octo?.accounts?.mybot?.botToken).toBe("bf_xxx");
    expect(state.cfg.channels?.dmwork).toBeUndefined();
    expect(state.cfg.bindings).toHaveLength(1);
    expect(state.cfg.bindings[0].match.channel).toBe("octo");
    expect(state.cfg.bindings[0].agentId).toBe("agent1");
  });

  it("case B: 4.x→5.x dmwork enabled=false residue → no disable call, rollback won't re-enable", async () => {
    const state = setupFs({
      cfg: {
        plugins: {
          entries: { "openclaw-channel-dmwork": { enabled: false } },
          installs: { "openclaw-channel-dmwork": { source: "npm", version: "0.6.4" } },
        },
        channels: {
          dmwork: { accounts: { b1: { botToken: "bf_b1" } } },
        },
        bindings: [{ agentId: "a1", match: { channel: "dmwork", accountId: "b1" } }],
      },
      extDirs: ["openclaw-channel-dmwork"],
    });
    await applyFsMocks(state);

    mockOpenclawCli({
      inspect: {
        "openclaw-channel-dmwork": { plugin: { id: "openclaw-channel-dmwork", version: "0.6.4", enabled: false } },
      },
    });

    const origExecImpl = mockExecFileSync.getMockImplementation();
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const a = args as string[];
      if (a[0] === "plugins" && a[1] === "install" && a[2]?.startsWith("openclaw-channel-octo")) {
        state.cfg.plugins.entries["openclaw-channel-octo"] = { enabled: true };
        state.cfg.plugins.installs["openclaw-channel-octo"] = { source: "npm", version: "1.0.0" };
        state.extDirs.add("openclaw-channel-octo");
        return "";
      }
      if (a[0] === "plugins" && a[1] === "inspect" && a[2] === "openclaw-channel-octo"
          && state.cfg.plugins?.entries?.["openclaw-channel-octo"]) {
        return JSON.stringify({ plugin: { id: "openclaw-channel-octo", version: "1.0.0", enabled: true } });
      }
      return origExecImpl!(cmd, args, undefined as any) as any;
    });

    const { runInstall } = await loadInstall();
    await runInstall({ force: false, dev: false });

    const ops = calledOps();
    // disable should NOT be called since dmwork was enabled=false
    expect(ops.some((o) => /^plugins disable openclaw-channel-dmwork$/.test(o))).toBe(false);
    // Migration still completes
    expect(state.cfg.channels?.octo?.accounts?.b1?.botToken).toBe("bf_b1");
  });

  it("case M: full migration done → detected as update, not rebrand", async () => {
    const state = setupFs({
      cfg: {
        plugins: {
          entries: { "openclaw-channel-octo": { enabled: true } },
          installs: { "openclaw-channel-octo": { source: "npm", version: "1.0.0" } },
        },
        channels: {
          octo: { accounts: { b1: { botToken: "bf_b1" } } },
        },
        bindings: [{ agentId: "a1", match: { channel: "octo", accountId: "b1" } }],
      },
      extDirs: ["openclaw-channel-octo"],
    });
    await applyFsMocks(state);

    mockOpenclawCli({
      inspect: {
        "openclaw-channel-octo": { plugin: { id: "openclaw-channel-octo", version: "1.0.0", enabled: true } },
      },
    });

    const { runInstall } = await loadInstall();
    await runInstall({ force: false, dev: false });

    const ops = calledOps();
    // No disable / uninstall called — pure update path
    expect(ops.some((o) => /^plugins disable/.test(o))).toBe(false);
    expect(ops.some((o) => /^plugins uninstall/.test(o))).toBe(false);
  });

  it("case N: octo installed + dmwork residue → rebrand finishes the data migration", async () => {
    const state = setupFs({
      cfg: {
        plugins: {
          entries: { "openclaw-channel-octo": { enabled: true } },
          installs: { "openclaw-channel-octo": { source: "npm", version: "1.0.0" } },
        },
        channels: {
          dmwork: { accounts: { b1: { botToken: "bf_b1" } } },
        },
        bindings: [{ agentId: "a1", match: { channel: "dmwork", accountId: "b1" } }],
      },
      extDirs: ["openclaw-channel-octo"],
    });
    await applyFsMocks(state);

    mockOpenclawCli({
      inspect: {
        "openclaw-channel-octo": { plugin: { id: "openclaw-channel-octo", version: "1.0.0", enabled: true } },
      },
    });

    const { runInstall } = await loadInstall();
    await runInstall({ force: false, dev: false });

    const ops = calledOps();
    // pluginsInstall should NOT be called (octo already healthy → migration skips reinstall)
    const installCalls = ops.filter((o) => /^plugins install openclaw-channel-octo/.test(o));
    expect(installCalls.length).toBe(0);
    // Data migration still happens
    expect(state.cfg.channels?.octo?.accounts?.b1?.botToken).toBe("bf_b1");
    expect(state.cfg.channels?.dmwork).toBeUndefined();
    expect(state.cfg.bindings[0].match.channel).toBe("octo");
  });

  it("bindings dedupe: existing octo binding survives, legacy duplicate is dropped", async () => {
    const state = setupFs({
      cfg: {
        plugins: {
          entries: { "openclaw-channel-dmwork": { enabled: true } },
          installs: { "openclaw-channel-dmwork": { source: "npm", version: "0.6.4" } },
        },
        channels: {
          dmwork: { accounts: { b1: { botToken: "bf_LEGACY" } } },
          octo: { accounts: { b1: { botToken: "bf_NEW" } } },
        },
        bindings: [
          { agentId: "a1", match: { channel: "dmwork", accountId: "b1" } },
          { agentId: "a1", match: { channel: "octo", accountId: "b1" }, target: "newer" },
        ],
      },
      extDirs: ["openclaw-channel-dmwork", "openclaw-channel-octo"],
    });
    await applyFsMocks(state);

    mockOpenclawCli({
      inspect: {
        "openclaw-channel-dmwork": { plugin: { id: "openclaw-channel-dmwork", version: "0.6.4", enabled: true } },
        "openclaw-channel-octo": { plugin: { id: "openclaw-channel-octo", version: "1.0.0", enabled: true } },
      },
    });

    const { runInstall } = await loadInstall();
    await runInstall({ force: false, dev: false });

    const octoBindings = state.cfg.bindings.filter((b: any) => b.match.channel === "octo");
    // (a1, b1) should appear exactly once — the existing octo binding wins
    expect(octoBindings).toHaveLength(1);
    expect(octoBindings[0].target).toBe("newer");
  });

  it("regression: same accountId on different agents migrates as TWO bindings (not deduped)", async () => {
    // Earlier impl used b.match.agentId (which doesn't exist) for dedupe key,
    // so two bindings sharing the same accountId would collapse to one.
    // Real binding shape: agentId top-level, match holds {channel, accountId}.
    const state = setupFs({
      cfg: {
        plugins: {
          entries: { "openclaw-channel-dmwork": { enabled: true } },
          installs: { "openclaw-channel-dmwork": { source: "npm", version: "0.6.4" } },
        },
        channels: { dmwork: { accounts: { b1: { botToken: "bf_b1" } } } },
        bindings: [
          { agentId: "agent_alpha", match: { channel: "dmwork", accountId: "b1" } },
          { agentId: "agent_beta",  match: { channel: "dmwork", accountId: "b1" } },
        ],
      },
      extDirs: ["openclaw-channel-dmwork"],
    });
    await applyFsMocks(state);

    mockOpenclawCli({
      inspect: {
        "openclaw-channel-dmwork": { plugin: { id: "openclaw-channel-dmwork", version: "0.6.4", enabled: true } },
      },
    });

    const origImpl = mockExecFileSync.getMockImplementation();
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const a = args as string[];
      if (a[0] === "plugins" && a[1] === "install" && a[2]?.startsWith("openclaw-channel-octo")) {
        state.cfg.plugins.entries["openclaw-channel-octo"] = { enabled: true };
        state.cfg.plugins.installs["openclaw-channel-octo"] = { source: "npm", version: "1.0.0" };
        state.extDirs.add("openclaw-channel-octo");
        return "";
      }
      if (a[0] === "plugins" && a[1] === "inspect" && a[2] === "openclaw-channel-octo"
          && state.cfg.plugins?.entries?.["openclaw-channel-octo"]) {
        return JSON.stringify({ plugin: { id: "openclaw-channel-octo", version: "1.0.0", enabled: true } });
      }
      return origImpl!(cmd, args, undefined as any) as any;
    });

    const { runInstall } = await loadInstall();
    await runInstall({ force: false, dev: false });

    const octoBindings = state.cfg.bindings.filter((b: any) => b.match.channel === "octo");
    expect(octoBindings).toHaveLength(2);
    const agentIds = octoBindings.map((b: any) => b.agentId).sort();
    expect(agentIds).toEqual(["agent_alpha", "agent_beta"]);
  });

  it("rollback on pluginsInstall failure: octo not installed, legacy re-enabled if was enabled", async () => {
    const state = setupFs({
      cfg: {
        plugins: {
          entries: { "openclaw-channel-dmwork": { enabled: true } },
          installs: { "openclaw-channel-dmwork": { source: "npm", version: "0.6.4" } },
        },
        channels: { dmwork: { accounts: { b1: { botToken: "bf_b1" } } } },
        bindings: [{ agentId: "a1", match: { channel: "dmwork", accountId: "b1" } }],
      },
      extDirs: ["openclaw-channel-dmwork"],
    });
    await applyFsMocks(state);

    mockOpenclawCli({
      inspect: {
        "openclaw-channel-dmwork": { plugin: { id: "openclaw-channel-dmwork", version: "0.6.4", enabled: true } },
      },
      failOn: { match: /^plugins install openclaw-channel-octo/ },
    });

    const { runInstall } = await loadInstall();
    await expect(runInstall({ force: false, dev: false })).rejects.toThrow(/Migration aborted/);

    const ops = calledOps();
    // Rollback: pluginsEnable(legacy) called after install failure
    const installFailIdx = ops.findIndex((o) => /^plugins install openclaw-channel-octo/.test(o));
    const reEnableIdx = ops.findIndex(
      (o, i) => i > installFailIdx && /^plugins enable openclaw-channel-dmwork$/.test(o),
    );
    expect(reEnableIdx).toBeGreaterThan(installFailIdx);
  });

  it("step 10 uninstall failure: warns but does NOT rollback", async () => {
    const state = setupFs({
      cfg: {
        plugins: {
          entries: { "openclaw-channel-dmwork": { enabled: true } },
          installs: { "openclaw-channel-dmwork": { source: "npm", version: "0.6.4" } },
        },
        channels: { dmwork: { accounts: { b1: { botToken: "bf_b1" } } } },
        bindings: [{ agentId: "a1", match: { channel: "dmwork", accountId: "b1" } }],
      },
      extDirs: ["openclaw-channel-dmwork"],
    });
    await applyFsMocks(state);

    const inspectMap: Record<string, any> = {
      "openclaw-channel-dmwork": { plugin: { id: "openclaw-channel-dmwork", version: "0.6.4", enabled: true } },
    };
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const a = args as string[];
      const op = a.join(" ");
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.5.7\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        const id = a[2];
        const result = inspectMap[id];
        if (!result) { const e: any = new Error("not found"); e.stderr = "not found"; throw e; }
        return JSON.stringify(result);
      }
      if (op === "plugins uninstall openclaw-channel-dmwork --force") {
        const e: any = new Error("uninstall failed");
        e.stderr = "EBUSY";
        throw e;
      }
      if (a[0] === "plugins" && a[1] === "install" && a[2]?.startsWith("openclaw-channel-octo")) {
        state.cfg.plugins.entries["openclaw-channel-octo"] = { enabled: true };
        state.cfg.plugins.installs["openclaw-channel-octo"] = { source: "npm", version: "1.0.0" };
        state.extDirs.add("openclaw-channel-octo");
        inspectMap["openclaw-channel-octo"] = { plugin: { id: "openclaw-channel-octo", version: "1.0.0", enabled: true } };
        return "";
      }
      if (a[0] === "plugins" && (a[1] === "enable" || a[1] === "disable")) return "";
      if (a[0] === "gateway") return "";
      if (cmd === "npm" && a[0] === "view") return "1.0.0\n";
      return "";
    });

    const { runInstall } = await loadInstall();
    await runInstall({ force: false, dev: false }); // should NOT throw

    // Migration data succeeded
    expect(state.cfg.channels?.octo?.accounts?.b1?.botToken).toBe("bf_b1");
    expect(state.cfg.bindings[0].match.channel).toBe("octo");
    // octo install still in place (no rollback)
    expect(state.cfg.plugins.entries["openclaw-channel-octo"]?.enabled).toBe(true);
  });

  it("4.20 fallback: unknown command for plugins disable/enable falls back to cfg edit", async () => {
    const state = setupFs({
      cfg: {
        plugins: {
          entries: { "openclaw-channel-dmwork": { enabled: true } },
          installs: { "openclaw-channel-dmwork": { source: "npm", version: "0.6.4" } },
        },
        channels: { dmwork: { accounts: { b1: { botToken: "bf_b1" } } } },
        bindings: [{ agentId: "a1", match: { channel: "dmwork", accountId: "b1" } }],
      },
      extDirs: ["openclaw-channel-dmwork"],
    });
    await applyFsMocks(state);

    mockOpenclawCli({
      version: "OpenClaw 2026.4.20\n",
      inspect: {
        "openclaw-channel-dmwork": { plugin: { id: "openclaw-channel-dmwork", version: "0.6.4", enabled: true } },
      },
      unknownCommands: true, // 4.20 doesn't have plugins disable/enable/uninstall
    });

    const origImpl = mockExecFileSync.getMockImplementation();
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const a = args as string[];
      if (a[0] === "plugins" && a[1] === "install" && a[2]?.startsWith("openclaw-channel-octo")) {
        state.cfg.plugins.entries["openclaw-channel-octo"] = { enabled: true };
        state.cfg.plugins.installs["openclaw-channel-octo"] = { source: "npm", version: "1.0.0" };
        state.extDirs.add("openclaw-channel-octo");
        return "";
      }
      if (a[0] === "plugins" && a[1] === "inspect" && a[2] === "openclaw-channel-octo"
          && state.cfg.plugins?.entries?.["openclaw-channel-octo"]) {
        return JSON.stringify({ plugin: { id: "openclaw-channel-octo", version: "1.0.0", enabled: true } });
      }
      return origImpl!(cmd, args, undefined as any) as any;
    });

    const { runInstall } = await loadInstall();
    await runInstall({ force: false, dev: false });

    // Final state: dmwork is fully gone (uninstall fallback removes
    // entries/installs/dir, not just sets enabled=false). octo is enabled.
    expect(state.cfg.plugins.entries["openclaw-channel-dmwork"]).toBeUndefined();
    expect(state.cfg.plugins.installs?.["openclaw-channel-dmwork"]).toBeUndefined();
    expect(state.extDirs.has("openclaw-channel-dmwork")).toBe(false);
    expect(state.cfg.plugins.entries["openclaw-channel-octo"]?.enabled).toBe(true);
    expect(state.cfg.channels?.octo?.accounts?.b1?.botToken).toBe("bf_b1");
  });

  it("rollback on step 6-9 failure: pluginsEnable throws → cfg restored, legacy re-enabled", async () => {
    // Reviewer-requested regression: prior to the fix, an exception in step
    // 6-8 (pluginsEnable / restoreChannelConfigToFile / restoreBindingsToFile)
    // would bypass step 9's rollback() calls and leave the user with
    // channels.dmwork removed but channels.octo not yet written.
    const state = setupFs({
      cfg: {
        plugins: {
          entries: { "openclaw-channel-dmwork": { enabled: true } },
          installs: { "openclaw-channel-dmwork": { source: "npm", version: "0.6.4" } },
        },
        channels: { dmwork: { accounts: { b1: { botToken: "bf_b1" } } } },
        bindings: [{ agentId: "a1", match: { channel: "dmwork", accountId: "b1" } }],
      },
      extDirs: ["openclaw-channel-dmwork"],
    });
    await applyFsMocks(state);

    const inspectMap: Record<string, any> = {
      "openclaw-channel-dmwork": { plugin: { id: "openclaw-channel-dmwork", version: "0.6.4", enabled: true } },
    };
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const a = args as string[];
      const op = a.join(" ");
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.5.7\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        const id = a[2];
        const r = inspectMap[id];
        if (!r) { const e: any = new Error("not found"); e.stderr = "not found"; throw e; }
        return JSON.stringify(r);
      }
      if (a[0] === "plugins" && a[1] === "install" && a[2]?.startsWith("openclaw-channel-octo")) {
        state.cfg.plugins.entries["openclaw-channel-octo"] = { enabled: true };
        state.cfg.plugins.installs["openclaw-channel-octo"] = { source: "npm", version: "1.0.0" };
        state.extDirs.add("openclaw-channel-octo");
        inspectMap["openclaw-channel-octo"] = { plugin: { id: "openclaw-channel-octo", version: "1.0.0", enabled: true } };
        return "";
      }
      // pluginsEnable(octo) throws an UNEXPECTED error (not unknown-command,
      // not not-installed) — should propagate and trigger rollback.
      if (op === "plugins enable openclaw-channel-octo") {
        const e: any = new Error("permission denied");
        e.stderr = "permission denied";
        throw e;
      }
      if (a[0] === "plugins" && (a[1] === "enable" || a[1] === "disable" || a[1] === "uninstall")) return "";
      if (a[0] === "gateway") return "";
      if (cmd === "npm" && a[0] === "view") return "1.0.0\n";
      return "";
    });

    const { runInstall } = await loadInstall();
    await expect(runInstall({ force: false, dev: false })).rejects.toThrow(/Migration aborted: steps 6-9/);

    // Sequence: pluginsEnable(legacy) was called by rollback() to re-enable
    // dmwork (since it was enabled before)
    const ops = calledOps();
    const enableLegacyAfterRollback = ops.some(
      (o) => o === "plugins enable openclaw-channel-dmwork",
    );
    expect(enableLegacyAfterRollback).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// legacy-to-octo scenario (very-legacy plugin id "dmwork")
// ---------------------------------------------------------------------------

describe("runInstall — legacy-to-octo scenario (very-legacy 'dmwork' → octo)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flat channels.dmwork shape is normalized to nested accounts.default", async () => {
    const state = setupFs({
      cfg: {
        plugins: {
          entries: { dmwork: { enabled: true } },
          installs: { dmwork: { source: "npm", version: "0.5.0" } },
        },
        channels: {
          dmwork: { botToken: "bf_FLAT", apiUrl: "https://im.example.com" },
        },
      },
      extDirs: ["dmwork"],
    });
    await applyFsMocks(state);

    const inspectMap: Record<string, any> = {
      dmwork: { plugin: { id: "dmwork", version: "0.5.0", enabled: true } },
    };
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.4.20\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        const id = a[2];
        const r = inspectMap[id];
        if (!r) { const e: any = new Error("not found"); e.stderr = "not found"; throw e; }
        return JSON.stringify(r);
      }
      if (a[0] === "plugins" && a[1] === "install" && a[2]?.startsWith("openclaw-channel-octo")) {
        state.cfg.plugins.entries["openclaw-channel-octo"] = { enabled: true };
        state.cfg.plugins.installs["openclaw-channel-octo"] = { source: "npm", version: "1.0.0" };
        state.extDirs.add("openclaw-channel-octo");
        inspectMap["openclaw-channel-octo"] = { plugin: { id: "openclaw-channel-octo", version: "1.0.0", enabled: true } };
        return "";
      }
      if (a[0] === "plugins" && a[1] === "uninstall") {
        // Side effect: remove plugin from cfg + extDirs + inspect map
        const id = a[2];
        if (state.cfg.plugins?.entries?.[id]) delete state.cfg.plugins.entries[id];
        if (state.cfg.plugins?.installs?.[id]) delete state.cfg.plugins.installs[id];
        if (Array.isArray(state.cfg.plugins?.allow)) {
          state.cfg.plugins.allow = state.cfg.plugins.allow.filter((x: string) => x !== id);
        }
        state.extDirs.delete(id);
        delete inspectMap[id];
        return "";
      }
      if (a[0] === "plugins" && (a[1] === "enable" || a[1] === "disable")) return "";
      if (a[0] === "gateway") return "";
      if (cmd === "npm" && a[0] === "view") return "1.0.0\n";
      return "";
    });

    const { runInstall } = await loadInstall();
    await runInstall({ force: false, dev: false });

    // Normalization: flat botToken → accounts.default.botToken
    expect(state.cfg.channels?.octo?.accounts?.default?.botToken).toBe("bf_FLAT");
    expect(state.cfg.channels?.octo?.accounts?.default?.apiUrl).toBe("https://im.example.com");
    expect(state.cfg.channels?.octo?.botToken).toBeUndefined();
  });

  it("legacy-to-octo wins over rebrand: very-legacy 'dmwork' detected first", async () => {
    const state = setupFs({
      cfg: {
        plugins: {
          // BOTH dmwork (very-legacy) AND openclaw-channel-dmwork (intermediate) present
          entries: {
            dmwork: { enabled: true },
            "openclaw-channel-dmwork": { enabled: true },
          },
          installs: {
            dmwork: { source: "npm", version: "0.5.0" },
            "openclaw-channel-dmwork": { source: "npm", version: "0.6.4" },
          },
        },
        channels: {
          dmwork: { accounts: { b1: { botToken: "bf_b1" } } },
        },
      },
      extDirs: ["dmwork", "openclaw-channel-dmwork"],
    });
    await applyFsMocks(state);

    const inspectMap: Record<string, any> = {
      dmwork: { plugin: { id: "dmwork", version: "0.5.0", enabled: true } },
      "openclaw-channel-dmwork": { plugin: { id: "openclaw-channel-dmwork", version: "0.6.4", enabled: true } },
    };
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.5.7\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        const id = a[2];
        const r = inspectMap[id];
        if (!r) { const e: any = new Error("not found"); e.stderr = "not found"; throw e; }
        return JSON.stringify(r);
      }
      if (a[0] === "plugins" && a[1] === "install" && a[2]?.startsWith("openclaw-channel-octo")) {
        state.cfg.plugins.entries["openclaw-channel-octo"] = { enabled: true };
        state.cfg.plugins.installs["openclaw-channel-octo"] = { source: "npm", version: "1.0.0" };
        state.extDirs.add("openclaw-channel-octo");
        inspectMap["openclaw-channel-octo"] = { plugin: { id: "openclaw-channel-octo", version: "1.0.0", enabled: true } };
        return "";
      }
      if (a[0] === "plugins" && a[1] === "uninstall") {
        // Side effect: remove plugin from cfg + extDirs + inspect map
        const id = a[2];
        if (state.cfg.plugins?.entries?.[id]) delete state.cfg.plugins.entries[id];
        if (state.cfg.plugins?.installs?.[id]) delete state.cfg.plugins.installs[id];
        if (Array.isArray(state.cfg.plugins?.allow)) {
          state.cfg.plugins.allow = state.cfg.plugins.allow.filter((x: string) => x !== id);
        }
        state.extDirs.delete(id);
        delete inspectMap[id];
        return "";
      }
      if (a[0] === "plugins" && (a[1] === "enable" || a[1] === "disable")) return "";
      if (a[0] === "gateway") return "";
      if (cmd === "npm" && a[0] === "view") return "1.0.0\n";
      return "";
    });

    const { runInstall } = await loadInstall();
    await runInstall({ force: false, dev: false });

    const ops = calledOps();
    // legacy-to-octo runs first: pluginsDisable + uninstall the very-legacy "dmwork" id
    expect(ops.some((o) => o === "plugins disable dmwork")).toBe(true);
    expect(ops.some((o) => o === "plugins uninstall dmwork --force")).toBe(true);
    // Step 11b cross-legacy cleanup: openclaw-channel-dmwork is ALSO uninstalled
    // in the same run (so users don't need a second install to be fully on octo).
    expect(ops.some((o) => o === "plugins uninstall openclaw-channel-dmwork --force")).toBe(true);
    // After cleanup, both legacy plugin entries gone from cfg
    expect(state.cfg.plugins.entries["dmwork"]).toBeUndefined();
    expect(state.cfg.plugins.entries["openclaw-channel-dmwork"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deadlock scenario (channels.octo exists but plugin not installed)
// ---------------------------------------------------------------------------

describe("runInstall — deadlock scenario (channels.octo without plugin)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes channel + bindings before pluginsInstall, restores after enable", async () => {
    // Reviewer-flagged regression (Jerry-Xin, round 4): runDeadlockRepair
    // must remove bindings(channel=octo) before pluginsInstall, otherwise
    // an OpenClaw config validator that rejects bindings referencing an
    // unregistered channel id can re-trap the user in the same deadlock.
    // Symmetric with runMigration step 4 (channel + bindings removed
    // before install, restored after enable).
    const state = setupFs({
      cfg: {
        // No plugin installed (no entries / installs / extension dir)
        plugins: { entries: {}, installs: {}, allow: [] },
        channels: {
          // channels.octo exists in config — that's the deadlock
          octo: { accounts: { mybot: { botToken: "bf_xxx" } } },
        },
        bindings: [
          // Binding on channel=octo predates plugin installation
          { agentId: "agent1", match: { channel: "octo", accountId: "mybot" } },
        ],
      },
      extDirs: [],
    });
    await applyFsMocks(state);

    const inspectMap: Record<string, any> = {};
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.5.7\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        const id = a[2];
        const r = inspectMap[id];
        if (!r) { const e: any = new Error("not found"); e.stderr = "not found"; throw e; }
        return JSON.stringify(r);
      }
      if (a[0] === "plugins" && a[1] === "install" && a[2]?.startsWith("openclaw-channel-octo")) {
        // Side effect: at this point, channels.octo and bindings(channel=octo)
        // must ALREADY be removed (asserted below). pluginsInstall populates
        // plugin records.
        state.cfg.plugins.entries["openclaw-channel-octo"] = { enabled: true };
        state.cfg.plugins.installs["openclaw-channel-octo"] = { source: "npm", version: "1.0.0" };
        state.extDirs.add("openclaw-channel-octo");
        inspectMap["openclaw-channel-octo"] = { plugin: { id: "openclaw-channel-octo", version: "1.0.0", enabled: true } };
        return "";
      }
      if (a[0] === "plugins" && (a[1] === "enable" || a[1] === "disable")) return "";
      if (a[0] === "gateway") return "";
      if (cmd === "npm" && a[0] === "view") return "1.0.0\n";
      return "";
    });

    // Capture cfg state at the moment pluginsInstall is invoked, so we can
    // assert that channels + bindings were removed first.
    const stateAtInstall: { hadChannel: boolean; hadBinding: boolean } = {
      hadChannel: true,
      hadBinding: true,
    };
    const origImpl = mockExecFileSync.getMockImplementation();
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const a = args as string[];
      if (a[0] === "plugins" && a[1] === "install" && a[2]?.startsWith("openclaw-channel-octo")) {
        // At install time, neither channels.octo nor bindings(channel=octo)
        // should be in cfg yet — they were temporarily removed.
        stateAtInstall.hadChannel = Boolean(state.cfg.channels?.octo);
        stateAtInstall.hadBinding = Array.isArray(state.cfg.bindings) &&
          state.cfg.bindings.some((b: any) => b?.match?.channel === "octo");
      }
      return origImpl!(cmd, args, undefined as any) as any;
    });

    const { runInstall } = await loadInstall();
    await runInstall({ force: false, dev: false });

    // Assertion 1: channel + bindings were removed BEFORE pluginsInstall
    expect(stateAtInstall.hadChannel).toBe(false);
    expect(stateAtInstall.hadBinding).toBe(false);

    // Assertion 2: after the full repair, channel + binding are back
    expect(state.cfg.channels?.octo?.accounts?.mybot?.botToken).toBe("bf_xxx");
    const restoredBindings = (state.cfg.bindings as any[]).filter(
      (b) => b?.match?.channel === "octo",
    );
    expect(restoredBindings).toHaveLength(1);
    expect(restoredBindings[0].agentId).toBe("agent1");
    expect(restoredBindings[0].match.accountId).toBe("mybot");

    // Assertion 3: plugin is now installed and enabled
    expect(state.cfg.plugins.entries["openclaw-channel-octo"]?.enabled).toBe(true);
  });
});
