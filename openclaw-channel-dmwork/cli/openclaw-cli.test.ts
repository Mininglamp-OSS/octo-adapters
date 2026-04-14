import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";

// Mock child_process at module level
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

// Re-import after mock is set up — dynamic import to get fresh module
async function loadModule() {
  // Clear module cache to pick up the mock
  vi.resetModules();
  return await import("./openclaw-cli.js");
}

describe("gatewayStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should parse real openclaw gateway status --json structure as running", async () => {
    const { gatewayStatus } = await loadModule();
    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        service: { runtime: { status: "running", pid: 12345 } },
        health: { healthy: true },
        rpc: { ok: true },
      }),
    );

    expect(gatewayStatus()).toEqual({ running: true });
  });

  it("should detect stopped gateway", async () => {
    const { gatewayStatus } = await loadModule();
    mockExecFileSync.mockReturnValue(
      JSON.stringify({
        service: { runtime: { status: "stopped" } },
        health: { healthy: false },
      }),
    );

    expect(gatewayStatus()).toEqual({ running: false });
  });

  it("should handle command failure gracefully", async () => {
    const { gatewayStatus } = await loadModule();
    mockExecFileSync.mockImplementation(() => {
      throw new Error("command failed");
    });

    expect(gatewayStatus()).toEqual({ running: false });
  });
});

describe("pluginsInspect", () => {
  it("should parse JSON with preceding log noise", async () => {
    const { pluginsInspect } = await loadModule();
    mockExecFileSync.mockReturnValue(
      '[dmwork] registering before_prompt_build hook\n' +
        JSON.stringify({
          plugin: { id: "test", version: "1.0.0", enabled: true },
          install: { source: "npm", version: "1.0.0", installPath: "/tmp" },
        }),
    );

    const result = pluginsInspect("test");
    expect(result?.plugin?.version).toBe("1.0.0");
    expect(result?.plugin?.enabled).toBe(true);
  });

  it("should return null when plugin not found", async () => {
    const { pluginsInspect } = await loadModule();
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    expect(pluginsInspect("nonexistent")).toBeNull();
  });
});

describe("getOpenClawVersion", () => {
  it("should extract version from openclaw --version output", async () => {
    const { getOpenClawVersion } = await loadModule();
    mockExecFileSync.mockReturnValue("OpenClaw 2026.4.11 (769908e)\n");

    expect(getOpenClawVersion()).toBe("2026.4.11");
  });

  it("should return null when openclaw is not installed", async () => {
    const { getOpenClawVersion } = await loadModule();
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(getOpenClawVersion()).toBeNull();
  });
});

describe("configGet / configSet", () => {
  it("should pass correct args to execFileSync", async () => {
    const { configGet } = await loadModule();
    mockExecFileSync.mockReturnValue("some_value\n");

    const result = configGet("channels.dmwork.accounts.my_bot.botToken");
    expect(result).toBe("some_value");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "openclaw",
      ["config", "get", "channels.dmwork.accounts.my_bot.botToken"],
      expect.any(Object),
    );
  });

  it("should return null on empty output", async () => {
    const { configGet } = await loadModule();
    mockExecFileSync.mockReturnValue("\n");

    expect(configGet("nonexistent.path")).toBeNull();
  });
});
