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
  };
});

const mockExecFileSync = vi.mocked(execFileSync);

// Helpers to mock module internals via execFileSync dispatch
function mockOpenClawVersion(version: string) {
  // openclaw --version returns version string
  return version;
}

async function loadInstall() {
  vi.resetModules();
  return await import("./install.js");
}

// We test by observing which commands are executed via execFileSync
function getCalledArgs(): string[][] {
  return mockExecFileSync.mock.calls.map((c) => c[1] as string[]);
}

function didCallPluginsInstall(calls: string[][]): boolean {
  return calls.some((args) => args[0] === "plugins" && args[1] === "install");
}

function didCallGatewayRestart(calls: string[][]): boolean {
  return calls.some((args) => args[0] === "gateway" && args[1] === "restart");
}

function pluginsInstallSpec(calls: string[][]): string | undefined {
  const call = calls.find((args) => args[0] === "plugins" && args[1] === "install");
  return call?.[2];
}

describe("runInstall — update scenario", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("already target version: no install, no restart", async () => {
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      // openclaw config file
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      // openclaw --version
      if (a[0] === "--version") return "OpenClaw 2026.4.15\n";
      // plugins inspect
      if (a[0] === "plugins" && a[1] === "inspect") {
        return JSON.stringify({ plugin: { id: "openclaw-channel-octo", version: "0.6.0", enabled: true } });
      }
      // npm view (targetVersion)
      if (a[0] === "view") return "0.6.0\n";
      return "";
    });

    await runInstall({ force: false, dev: false });

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(false);
    expect(didCallGatewayRestart(calls)).toBe(false);
  });

  it("--force: installs without checking version, then restarts", async () => {
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.4.15\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        return JSON.stringify({ plugin: { id: "openclaw-channel-octo", version: "0.6.0", enabled: true } });
      }
      // npm view should NOT be called for --force
      if (a[0] === "view") throw new Error("npm view should not be called with --force");
      // gateway restart
      if (a[0] === "gateway" && a[1] === "restart") return "";
      // plugins install
      if (a[0] === "plugins" && a[1] === "install") return "";
      return "";
    });

    await runInstall({ force: true, dev: false });

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(true);
    expect(pluginsInstallSpec(calls)).toBe("openclaw-channel-octo");
    expect(didCallGatewayRestart(calls)).toBe(true);
  });

  it("npm view fails: no install, no restart", async () => {
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.4.15\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        return JSON.stringify({ plugin: { id: "openclaw-channel-octo", version: "0.6.0", enabled: true } });
      }
      if (a[0] === "view") throw new Error("ENOTFOUND registry.npmjs.org");
      return "";
    });

    await runInstall({ force: false, dev: false });

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(false);
    expect(didCallGatewayRestart(calls)).toBe(false);
  });

  it("--dev: uses openclaw-channel-octo@dev spec", async () => {
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.4.15\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        return JSON.stringify({ plugin: { id: "openclaw-channel-octo", version: "0.6.0", enabled: true } });
      }
      // npm view openclaw-channel-octo@dev
      if (a[0] === "view" && a[1]?.includes("@dev")) return "0.6.0-dev.abc123\n";
      if (a[0] === "plugins" && a[1] === "install") return "";
      if (a[0] === "gateway" && a[1] === "restart") return "";
      return "";
    });

    await runInstall({ force: false, dev: true });

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(true);
    expect(pluginsInstallSpec(calls)).toBe("openclaw-channel-octo@dev");
    expect(didCallGatewayRestart(calls)).toBe(true);
  });

  it("--next: uses openclaw-channel-octo@next spec and queries @next dist-tag", async () => {
    // Regression: without --next, `npx -y openclaw-channel-octo@next install`
    // would have OpenClaw fetch @latest (defeating the smoke test). --next
    // forces both the npm view query and the pluginsInstall spec to @next.
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.5.7\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        return JSON.stringify({ plugin: { id: "openclaw-channel-octo", version: "1.0.0-rc.0", enabled: true } });
      }
      // npm view openclaw-channel-octo@next — must be queried (not @latest)
      if (a[0] === "view" && a[1] === "openclaw-channel-octo@next") return "1.0.0-rc.1\n";
      if (a[0] === "view" && a[1] === "openclaw-channel-octo@latest") {
        throw new Error("must not query @latest when --next is set");
      }
      if (a[0] === "plugins" && a[1] === "install") return "";
      if (a[0] === "gateway" && a[1] === "restart") return "";
      return "";
    });

    await runInstall({ force: false, dev: false, next: true });

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(true);
    // pluginsInstall must use @next spec, not bare
    expect(pluginsInstallSpec(calls)).toBe("openclaw-channel-octo@next");
    // npm view must query @next
    const viewCalls = calls.filter((c) => c[0] === "view");
    expect(viewCalls.some((c) => c[1] === "openclaw-channel-octo@next")).toBe(true);
    expect(didCallGatewayRestart(calls)).toBe(true);
  });

  it("new version available: installs and restarts", async () => {
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.4.15\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        return JSON.stringify({ plugin: { id: "openclaw-channel-octo", version: "0.5.21", enabled: true } });
      }
      if (a[0] === "view") return "0.6.0\n";
      if (a[0] === "plugins" && a[1] === "install") return "";
      if (a[0] === "gateway" && a[1] === "restart") return "";
      return "";
    });

    await runInstall({ force: false, dev: false });

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(true);
    expect(pluginsInstallSpec(calls)).toBe("openclaw-channel-octo");
    expect(didCallGatewayRestart(calls)).toBe(true);
  });

  it("already target version + entries.enabled=false: self-heals enabled, no install, no restart", async () => {
    // Regression: install used to early-return on already-at-target, bypassing
    // the self-heal that re-enables the plugin after OpenClaw major upgrades
    // reset entries.<id>.enabled.
    const fs = await import("node:fs");
    const mockReadFileSync = vi.mocked(fs.readFileSync);
    const mockWriteFileSync = vi.mocked(fs.writeFileSync);

    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith("openclaw.json")) {
        return JSON.stringify({
          plugins: {
            entries: { "openclaw-channel-octo": { enabled: false } },
            installs: {
              "openclaw-channel-octo": { source: "npm", version: "0.6.0" },
            },
          },
        });
      }
      return "{}";
    });

    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.4.15\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        return JSON.stringify({ plugin: { id: "openclaw-channel-octo", version: "0.6.0", enabled: false } });
      }
      if (a[0] === "view") return "0.6.0\n";
      return "";
    });

    await runInstall({ force: false, dev: false });

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(false);
    expect(didCallGatewayRestart(calls)).toBe(false);

    // Self-heal must have written a config with enabled: true
    const writes = mockWriteFileSync.mock.calls.map((c) => String(c[1]));
    const enabledWrite = writes.find((w) => w.includes('"enabled": true'));
    expect(enabledWrite).toBeDefined();
  });

  it("--from <spec>: pluginsInstall uses the override spec, npm view is skipped", async () => {
    // Pre-publish local testing affordance: --from ./tarball.tgz makes the
    // pluginsInstall step receive the tarball path instead of the bare npm
    // name (which would 404 before publish). Update-scenario version
    // comparison is also bypassed (tarball install is unconditional).
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.5.7\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        return JSON.stringify({ plugin: { id: "openclaw-channel-octo", version: "1.0.0-rc.0", enabled: true } });
      }
      // npm view must NOT be called when --from overrides the spec
      if (a[0] === "view") {
        throw new Error("npm view must not run when --from is set");
      }
      if (a[0] === "plugins" && a[1] === "install") return "";
      if (a[0] === "gateway" && a[1] === "restart") return "";
      return "";
    });

    await runInstall({ from: "./openclaw-channel-octo-1.0.0-rc.1.tgz" });

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(true);
    expect(pluginsInstallSpec(calls)).toBe("./openclaw-channel-octo-1.0.0-rc.1.tgz");
    expect(didCallGatewayRestart(calls)).toBe(true);
  });

  it("4.20 hardening: ensurePluginsAllow creates plugins.allow when missing", async () => {
    // OpenClaw 4.20 default config has no plugins.allow field at all.
    // Phase B's ensurePluginsAllow used to bail when the array was missing,
    // leaving 4.20 users with the "plugins.allow is empty" warn on every
    // gateway restart. Now we create the array and add PLUGIN_ID.
    const fs = await import("node:fs");
    const mockReadFileSync = vi.mocked(fs.readFileSync);
    const mockWriteFileSync = vi.mocked(fs.writeFileSync);

    // Track current state so writes are visible to subsequent reads.
    const state = {
      plugins: {
        entries: { "openclaw-channel-octo": { enabled: true } },
        installs: {
          "openclaw-channel-octo": { source: "npm", version: "0.6.0" },
        },
        // NOTE: no `allow` field — simulating fresh 4.20 cfg
      },
    };
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith("openclaw.json")) return JSON.stringify(state);
      return "{}";
    });
    mockWriteFileSync.mockImplementation((path: any, data: any) => {
      const p = String(path);
      if (p.endsWith("openclaw.json.tmp") || p.endsWith("openclaw.json")) {
        try { Object.assign(state, JSON.parse(String(data))); } catch { /* ignore */ }
      }
    });

    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.4.20\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        return JSON.stringify({ plugin: { id: "openclaw-channel-octo", version: "0.6.0", enabled: true } });
      }
      if (a[0] === "view") return "0.6.0\n"; // already at target → no install
      return "";
    });

    await runInstall({ force: false, dev: false });

    // Final state must contain plugins.allow with octo in it
    const finalCfg = state as any;
    expect(Array.isArray(finalCfg.plugins.allow)).toBe(true);
    expect(finalCfg.plugins.allow).toContain("openclaw-channel-octo");
  });
});
