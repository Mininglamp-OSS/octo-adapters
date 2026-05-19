/**
 * runInstall — non-migration scenarios:
 *   - update (already healthy, compare via openclaw plugins inspect --json)
 *   - --force, --from, --dev / --next (deprecated warn + latest fallback)
 *   - 4.20 hardening (plugins.allow self-heal)
 *
 * v2.0.0 changes vs v1.x:
 *   - Plugin id is now "octo" (ClawHub plugin id), not "openclaw-channel-octo"
 *   - Install spec is "clawhub:octo", not "openclaw-channel-octo"
 *   - latest-version source: `openclaw plugins inspect octo --json` (via
 *     OpenClaw's built-in ClawHub client) instead of `npm view ...@<tag>`
 *   - --dev / --next are no-ops that warn + fall back to ClawHub @latest
 *   - Entry-point cleanup of legacy npm `openclaw-channel-octo` plugin (deferred
 *     until ClawHub install verifies healthy)
 *
 * Plugin id dispatch in mocks: `inspect openclaw-channel-octo` returns
 * not-found by default so the legacy npm cleanup path no-ops; tests that
 * exercise the cleanup path override this explicitly.
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
  };
});

const mockExecFileSync = vi.mocked(execFileSync);

async function loadInstall() {
  vi.resetModules();
  return await import("./install.js");
}

function getCalledArgs(): string[][] {
  return mockExecFileSync.mock.calls.map((c) => c[1] as string[]);
}

function didCallPluginsInstall(calls: string[][]): boolean {
  return calls.some((args) => args[0] === "plugins" && args[1] === "install");
}

function didCallPluginsUpdate(calls: string[][]): boolean {
  return calls.some((args) => args[0] === "plugins" && args[1] === "update");
}

function didCallGatewayRestart(calls: string[][]): boolean {
  return calls.some((args) => args[0] === "gateway" && args[1] === "restart");
}

function pluginsInstallSpec(calls: string[][]): string | undefined {
  const call = calls.find((args) => args[0] === "plugins" && args[1] === "install");
  return call?.[2];
}

/**
 * Default dispatch for `plugins inspect`. Returns octo plugin metadata when
 * args[2] === "octo"; returns not-found for the legacy npm name so the entry
 * cleanup path no-ops. Override per-test for cleanup-path scenarios.
 */
function inspectDispatch(args: string[], octoData: object): string {
  const id = args[2];
  if (id === "openclaw-channel-octo") {
    throw new Error("Plugin not found: openclaw-channel-octo");
  }
  // Default (id === "octo" or empty): return octo metadata
  return JSON.stringify({ plugin: octoData });
}

describe("runInstall — update scenario", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("already target version: no install, no restart", async () => {
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.4.15\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        // getLatestClawHubVersion (id=octo, --json) returns plugin.latestVersion;
        // detectScenario inspect (id=octo) returns current plugin metadata.
        return inspectDispatch(a, {
          id: "octo",
          version: "0.6.0",
          latestVersion: "0.6.0",
          enabled: true,
        });
      }
      return "";
    });

    await runInstall({ force: false, dev: false });

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(false);
    expect(didCallGatewayRestart(calls)).toBe(false);
  });

  it("--force: installs with ClawHub spec, then restarts", async () => {
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.4.15\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        return inspectDispatch(a, {
          id: "octo",
          version: "0.6.0",
          latestVersion: "0.6.0",
          enabled: true,
        });
      }
      if (a[0] === "gateway" && a[1] === "restart") return "";
      if (a[0] === "plugins" && a[1] === "install") return "";
      return "";
    });

    await runInstall({ force: true, dev: false });

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(true);
    expect(pluginsInstallSpec(calls)).toBe("clawhub:octo");
    expect(didCallGatewayRestart(calls)).toBe(true);
  });

  it("no latestVersion locally: delegates to `openclaw plugins update`", async () => {
    // v2.0.0+: when inspect doesn't report latestVersion (e.g. older OpenClaw
    // doesn't track ClawHub upstream), fall back to `openclaw plugins update`
    // which queries ClawHub via OpenClaw's built-in client. If already latest,
    // it's a no-op and we skip the gateway restart.
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.4.15\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        // No latestVersion field → triggers the pluginsUpdate fallback path.
        return inspectDispatch(a, {
          id: "octo",
          version: "0.6.0",
          enabled: true,
        });
      }
      if (a[0] === "plugins" && a[1] === "update") return "";
      return "";
    });

    await runInstall({ force: false, dev: false });

    const calls = getCalledArgs();
    // Delegated to plugins update, not plugins install
    expect(didCallPluginsInstall(calls)).toBe(false);
    expect(didCallPluginsUpdate(calls)).toBe(true);
    // No change → no restart
    expect(didCallGatewayRestart(calls)).toBe(false);
  });

  it("--dev: warns then falls back to ClawHub @latest spec", async () => {
    // v2.0.0+: --dev / --next are no-op flags that warn the user. ClawHub's
    // release model differs from npm dist-tags; for pre-release testing use
    // --from <tarball>.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { /* noop */ });
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.4.15\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        return inspectDispatch(a, {
          id: "octo",
          version: "0.5.21",
          latestVersion: "0.6.0",
          enabled: true,
        });
      }
      if (a[0] === "plugins" && a[1] === "install") return "";
      if (a[0] === "gateway" && a[1] === "restart") return "";
      return "";
    });

    await runInstall({ force: false, dev: true });

    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("--dev / --next"))).toBe(true);

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(true);
    expect(pluginsInstallSpec(calls)).toBe("clawhub:octo");
    expect(didCallGatewayRestart(calls)).toBe(true);

    warnSpy.mockRestore();
  });

  it("--next: warns then falls back to ClawHub @latest spec", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { /* noop */ });
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.5.7\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        return inspectDispatch(a, {
          id: "octo",
          version: "1.0.0-rc.0",
          latestVersion: "1.0.0",
          enabled: true,
        });
      }
      if (a[0] === "plugins" && a[1] === "install") return "";
      if (a[0] === "gateway" && a[1] === "restart") return "";
      return "";
    });

    await runInstall({ force: false, dev: false, next: true });

    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("--dev / --next"))).toBe(true);

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(true);
    expect(pluginsInstallSpec(calls)).toBe("clawhub:octo");
    expect(didCallGatewayRestart(calls)).toBe(true);

    warnSpy.mockRestore();
  });

  it("new version available: installs ClawHub spec and restarts", async () => {
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.4.15\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        return inspectDispatch(a, {
          id: "octo",
          version: "0.5.21",
          latestVersion: "0.6.0",
          enabled: true,
        });
      }
      if (a[0] === "plugins" && a[1] === "install") return "";
      if (a[0] === "gateway" && a[1] === "restart") return "";
      return "";
    });

    await runInstall({ force: false, dev: false });

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(true);
    expect(pluginsInstallSpec(calls)).toBe("clawhub:octo");
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
            entries: { octo: { enabled: false } },
            installs: {
              octo: { source: "clawhub", version: "0.6.0" },
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
        return inspectDispatch(a, {
          id: "octo",
          version: "0.6.0",
          latestVersion: "0.6.0",
          enabled: false,
        });
      }
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

  it("--from <spec>: pluginsInstall uses the override spec, version check is skipped", async () => {
    // Pre-publish local testing affordance: --from ./tarball.tgz makes the
    // pluginsInstall step receive the tarball path instead of the bare
    // ClawHub spec. Update-scenario version comparison is also bypassed
    // (tarball install is unconditional).
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.5.7\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        return inspectDispatch(a, {
          id: "octo",
          version: "1.0.0-rc.0",
          latestVersion: "1.0.0-rc.0",
          enabled: true,
        });
      }
      if (a[0] === "plugins" && a[1] === "install") return "";
      if (a[0] === "gateway" && a[1] === "restart") return "";
      return "";
    });

    await runInstall({ from: "./openclaw-channel-octo-2.0.0-rc.1.tgz" });

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(true);
    expect(pluginsInstallSpec(calls)).toBe("./openclaw-channel-octo-2.0.0-rc.1.tgz");
    expect(didCallGatewayRestart(calls)).toBe(true);
  });

  it("4.20 hardening: ensurePluginsAllow creates plugins.allow when missing", async () => {
    // OpenClaw 4.20 default config has no plugins.allow field at all.
    // Phase B's ensurePluginsAllow used to bail when the array was missing,
    // leaving 4.20 users with the "plugins.allow is empty" warn on every
    // gateway restart. Now we create the array and add PLUGIN_ID (="octo").
    const fs = await import("node:fs");
    const mockReadFileSync = vi.mocked(fs.readFileSync);
    const mockWriteFileSync = vi.mocked(fs.writeFileSync);

    // Track current state so writes are visible to subsequent reads.
    const state = {
      plugins: {
        entries: { octo: { enabled: true } },
        installs: {
          octo: { source: "clawhub", version: "0.6.0" },
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
        return inspectDispatch(a, {
          id: "octo",
          version: "0.6.0",
          latestVersion: "0.6.0",
          enabled: true,
        });
      }
      return "";
    });

    await runInstall({ force: false, dev: false });

    // Final state must contain plugins.allow with octo in it
    const finalCfg = state as any;
    expect(Array.isArray(finalCfg.plugins.allow)).toBe(true);
    expect(finalCfg.plugins.allow).toContain("octo");
  });

  it("legacy npm openclaw-channel-octo installed: cleanup after ClawHub install verifies healthy", async () => {
    // v2.0.0 transactional cleanup: when entry-point detects the legacy npm
    // `openclaw-channel-octo` plugin, defer uninstall until AFTER the ClawHub
    // install completes + isHealthyInstall("octo") returns true. Prevents a
    // broken state if ClawHub install fails midway.
    const fs = await import("node:fs");
    const mockReadFileSync = vi.mocked(fs.readFileSync);
    const mockExistsSync = vi.mocked(fs.existsSync);

    // Pretend the user has the legacy npm plugin: entries + installs both
    // record "openclaw-channel-octo" + the ClawHub octo plugin is also healthy
    // (extension dir + entries.octo + installs.octo all present).
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith("openclaw.json")) {
        return JSON.stringify({
          plugins: {
            entries: {
              "openclaw-channel-octo": { enabled: true },
              octo: { enabled: true },
            },
            installs: {
              "openclaw-channel-octo": { source: "npm", version: "1.0.0" },
              octo: { source: "clawhub", version: "1.0.7" },
            },
            allow: ["openclaw-channel-octo", "octo"],
          },
        });
      }
      return "{}";
    });
    mockExistsSync.mockImplementation((path) => {
      // pretend extensions/octo exists so isHealthyInstall("octo") returns true
      return String(path).endsWith("extensions/octo");
    });

    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.5.7\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        const id = a[2];
        if (id === "openclaw-channel-octo") {
          // Legacy npm plugin IS installed (this is the cleanup-path scenario)
          return JSON.stringify({
            plugin: { id: "openclaw-channel-octo", version: "1.0.0", enabled: true },
          });
        }
        return inspectDispatch(a, {
          id: "octo",
          version: "1.0.7",
          latestVersion: "1.0.7",
          enabled: true,
        });
      }
      if (a[0] === "plugins" && a[1] === "uninstall") return "";
      if (a[0] === "plugins" && a[1] === "disable") return "";
      if (a[0] === "gateway" && a[1] === "restart") return "";
      return "";
    });

    await runInstall({ force: false, dev: false });

    const calls = getCalledArgs();
    // Cleanup: legacy npm openclaw-channel-octo must be uninstalled
    const uninstallCalls = calls.filter(
      (a) => a[0] === "plugins" && a[1] === "uninstall" && a[2] === "openclaw-channel-octo",
    );
    expect(uninstallCalls.length).toBeGreaterThan(0);
    // Gateway must have been restarted (didChange = true via cleanup)
    expect(didCallGatewayRestart(calls)).toBe(true);
  });
});
