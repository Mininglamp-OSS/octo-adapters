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
        return JSON.stringify({ plugin: { id: "openclaw-channel-dmwork", version: "0.6.0", enabled: true } });
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
        return JSON.stringify({ plugin: { id: "openclaw-channel-dmwork", version: "0.6.0", enabled: true } });
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
    expect(pluginsInstallSpec(calls)).toBe("openclaw-channel-dmwork");
    expect(didCallGatewayRestart(calls)).toBe(true);
  });

  it("npm view fails: no install, no restart", async () => {
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.4.15\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        return JSON.stringify({ plugin: { id: "openclaw-channel-dmwork", version: "0.6.0", enabled: true } });
      }
      if (a[0] === "view") throw new Error("ENOTFOUND registry.npmjs.org");
      return "";
    });

    await runInstall({ force: false, dev: false });

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(false);
    expect(didCallGatewayRestart(calls)).toBe(false);
  });

  it("--dev: uses openclaw-channel-dmwork@dev spec", async () => {
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.4.15\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        return JSON.stringify({ plugin: { id: "openclaw-channel-dmwork", version: "0.6.0", enabled: true } });
      }
      // npm view openclaw-channel-dmwork@dev
      if (a[0] === "view" && a[1]?.includes("@dev")) return "0.6.0-dev.abc123\n";
      if (a[0] === "plugins" && a[1] === "install") return "";
      if (a[0] === "gateway" && a[1] === "restart") return "";
      return "";
    });

    await runInstall({ force: false, dev: true });

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(true);
    expect(pluginsInstallSpec(calls)).toBe("openclaw-channel-dmwork@dev");
    expect(didCallGatewayRestart(calls)).toBe(true);
  });

  it("new version available: installs and restarts", async () => {
    const { runInstall } = await loadInstall();

    mockExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === "config" && a[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (a[0] === "--version") return "OpenClaw 2026.4.15\n";
      if (a[0] === "plugins" && a[1] === "inspect") {
        return JSON.stringify({ plugin: { id: "openclaw-channel-dmwork", version: "0.5.21", enabled: true } });
      }
      if (a[0] === "view") return "0.6.0\n";
      if (a[0] === "plugins" && a[1] === "install") return "";
      if (a[0] === "gateway" && a[1] === "restart") return "";
      return "";
    });

    await runInstall({ force: false, dev: false });

    const calls = getCalledArgs();
    expect(didCallPluginsInstall(calls)).toBe(true);
    expect(pluginsInstallSpec(calls)).toBe("openclaw-channel-dmwork");
    expect(didCallGatewayRestart(calls)).toBe(true);
  });
});
