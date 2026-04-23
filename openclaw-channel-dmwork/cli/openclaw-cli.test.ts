import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";

// Mock child_process at module level
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

describe("findGlobalOpenclaw (via module load)", () => {
  it("should skip _npx paths and pick global path", async () => {
    const { execSync } = await import("node:child_process");
    vi.mocked(execSync).mockReturnValue(
      "/Users/test/.npm/_npx/abc123/node_modules/.bin/openclaw\n/usr/local/bin/openclaw\n",
    );
    const mod = await loadModule();
    mockExecFileSync.mockReturnValue("test\n");
    mod.configGet("test.path");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/local/bin/openclaw",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("should handle CRLF output from Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const { execSync } = await import("node:child_process");
      vi.mocked(execSync).mockReturnValue(
        "C:\\npm\\_npx\\openclaw.cmd\r\nC:\\Program Files\\openclaw\\openclaw.exe\r\n",
      );
      const mod = await loadModule();
      mockExecFileSync.mockReturnValue("test\n");
      mod.configGet("test.path");
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "C:\\Program Files\\openclaw\\openclaw.exe",
        expect.any(Array),
        expect.any(Object),
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("should prefer .cmd when where returns both shim variants on Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const { execSync } = await import("node:child_process");
      vi.mocked(execSync).mockReturnValue(
        "C:\\Users\\mLamp\\AppData\\Roaming\\npm\\openclaw\r\nC:\\Users\\mLamp\\AppData\\Roaming\\npm\\openclaw.cmd\r\n",
      );
      const mod = await loadModule();
      mockExecFileSync.mockReturnValue("OpenClaw 2026.4.21\n");
      mod.getOpenClawVersion();
      // Windows .cmd files are executed via cmd.exe /d /s /c
      expect(mockExecFileSync).toHaveBeenCalledWith(
        expect.stringContaining("cmd.exe"),
        expect.arrayContaining(["/d", "/s", "/c"]),
        expect.any(Object),
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("should fallback to candidate paths when which/where fails", async () => {
    const { execSync } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    vi.mocked(execSync).mockImplementation(() => { throw new Error("not found"); });
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p) === "/usr/local/bin/openclaw",
    );
    const mod = await loadModule();
    mockExecFileSync.mockReturnValue("test\n");
    mod.configGet("test.path");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/local/bin/openclaw",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("should fallback to 'openclaw' when nothing found", async () => {
    const { execSync } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    vi.mocked(execSync).mockImplementation(() => { throw new Error("not found"); });
    vi.mocked(existsSync).mockReturnValue(false);
    const mod = await loadModule();
    mockExecFileSync.mockReturnValue("test\n");
    mod.configGet("test.path");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "openclaw",
      expect.any(Array),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// pluginsInstall degradation
// ---------------------------------------------------------------------------

describe("pluginsInstall 3-layer degradation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should succeed on first attempt (newest openclaw)", async () => {
    const { pluginsInstall } = await loadModule();
    mockExecFileSync.mockReturnValue("");
    pluginsInstall("test-plugin", true, true);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync.mock.calls[0][1]).toContain("--dangerously-force-unsafe-install");
    expect(mockExecFileSync.mock.calls[0][1]).toContain("--force");
  });

  it("should degrade from --dangerously-force-unsafe-install to --force", async () => {
    const { pluginsInstall } = await loadModule();
    mockExecFileSync
      .mockImplementationOnce(() => {
        const err = new Error("error: unknown option '--dangerously-force-unsafe-install'");
        (err as any).stderr = Buffer.from("error: unknown option '--dangerously-force-unsafe-install'");
        throw err;
      })
      .mockReturnValue("");
    pluginsInstall("test-plugin", true, true);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(mockExecFileSync.mock.calls[1][1]).toContain("--force");
    expect(mockExecFileSync.mock.calls[1][1]).not.toContain("--dangerously-force-unsafe-install");
  });

  it("should degrade to bare install when --force also unsupported", async () => {
    const { pluginsInstall } = await loadModule();
    mockExecFileSync
      .mockImplementationOnce(() => {
        const err = new Error("unknown option");
        (err as any).stderr = Buffer.from("error: unknown option '--dangerously-force-unsafe-install'");
        throw err;
      })
      .mockImplementationOnce(() => {
        const err = new Error("unknown option");
        (err as any).stderr = Buffer.from("error: unknown option '--force'");
        throw err;
      })
      .mockReturnValue("");
    pluginsInstall("test-plugin", true, true);
    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
    const lastArgs = mockExecFileSync.mock.calls[2][1] as string[];
    expect(lastArgs).not.toContain("--force");
    expect(lastArgs).not.toContain("--dangerously-force-unsafe-install");
    expect(lastArgs).toContain("test-plugin");
  });

  it("should throw non-option errors without degrading", async () => {
    const { pluginsInstall } = await loadModule();
    mockExecFileSync.mockImplementation(() => {
      const err = new Error("network error");
      (err as any).stderr = Buffer.from("ECONNREFUSED");
      throw err;
    });
    expect(() => pluginsInstall("test-plugin", true)).toThrow("network error");
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("should work without force (2-layer degradation)", async () => {
    const { pluginsInstall } = await loadModule();
    mockExecFileSync
      .mockImplementationOnce(() => {
        const err = new Error("unknown option");
        (err as any).stderr = Buffer.from("error: unknown option '--dangerously-force-unsafe-install'");
        throw err;
      })
      .mockReturnValue("");
    pluginsInstall("test-plugin", true);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    const lastArgs = mockExecFileSync.mock.calls[1][1] as string[];
    expect(lastArgs).not.toContain("--force");
    expect(lastArgs).not.toContain("--dangerously-force-unsafe-install");
  });
});

// ---------------------------------------------------------------------------
// pluginsUpdateCompat precise fallback
// ---------------------------------------------------------------------------

describe("pluginsUpdateCompat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should succeed when plugins update works", async () => {
    const { pluginsUpdateCompat } = await loadModule();
    mockExecFileSync.mockReturnValue("");
    pluginsUpdateCompat("test-plugin", "latest", true);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync.mock.calls[0][1]).toContain("update");
  });

  it("should fallback to install when update reports not installed", async () => {
    const { pluginsUpdateCompat } = await loadModule();
    mockExecFileSync
      .mockImplementationOnce(() => {
        const err = new Error("plugin not found");
        (err as any).stderr = Buffer.from("plugin not found");
        throw err;
      })
      .mockReturnValue(""); // install succeeds
    pluginsUpdateCompat("test-plugin", "latest", true);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(mockExecFileSync.mock.calls[1][1]).toContain("install");
  });

  it("should fallback to install when update command is unsupported", async () => {
    const { pluginsUpdateCompat } = await loadModule();
    mockExecFileSync
      .mockImplementationOnce(() => {
        const err = new Error("unknown option");
        (err as any).stderr = Buffer.from("error: unknown option 'update'");
        throw err;
      })
      .mockReturnValue("");
    pluginsUpdateCompat("test-plugin", "latest", true);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it("should throw network errors without fallback", async () => {
    const { pluginsUpdateCompat } = await loadModule();
    mockExecFileSync.mockImplementation(() => {
      const err = new Error("ECONNREFUSED");
      (err as any).stderr = Buffer.from("connect ECONNREFUSED 127.0.0.1:443");
      throw err;
    });
    expect(() => pluginsUpdateCompat("test-plugin", "latest", true)).toThrow("ECONNREFUSED");
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("should throw permission errors without fallback", async () => {
    const { pluginsUpdateCompat } = await loadModule();
    mockExecFileSync.mockImplementation(() => {
      const err = new Error("EACCES");
      (err as any).stderr = Buffer.from("EACCES: permission denied");
      throw err;
    });
    expect(() => pluginsUpdateCompat("test-plugin", "latest", true)).toThrow("EACCES");
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// resolvePluginState (inspect + fallback)
// ---------------------------------------------------------------------------

describe("resolvePluginState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return inspect data when plugins inspect succeeds", async () => {
    const { resolvePluginState } = await loadModule();
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === "config" && argsArr[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (argsArr[0] === "plugins" && argsArr[1] === "inspect") {
        return JSON.stringify({
          plugin: { id: "openclaw-channel-dmwork", version: "0.5.21", enabled: true },
          install: { source: "npm", version: "0.5.21", installPath: "~/.openclaw/extensions/openclaw-channel-dmwork" },
        });
      }
      return "";
    });
    const state = resolvePluginState("openclaw-channel-dmwork");
    expect(state.installed).toBe(true);
    expect(state.version).toBe("0.5.21");
    expect(state.source).toBe("inspect");
    expect(state.enabled).toBe(true);
  });

  it("should fallback to config+dir when inspect fails (old OpenClaw)", async () => {
    const { resolvePluginState } = await loadModule();
    const { existsSync, readFileSync } = await import("node:fs");
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === "config" && argsArr[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (argsArr[0] === "plugins" && argsArr[1] === "inspect") {
        throw new Error("error: unknown command 'inspect'");
      }
      return "";
    });
    // readConfigFromFile reads the config file
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      plugins: {
        entries: { "openclaw-channel-dmwork": { enabled: true } },
        installs: { "openclaw-channel-dmwork": { version: "0.5.21", installPath: "~/.openclaw/extensions/openclaw-channel-dmwork" } },
      },
    }));
    vi.mocked(existsSync).mockReturnValue(true);

    const state = resolvePluginState("openclaw-channel-dmwork");
    expect(state.installed).toBe(true);
    expect(state.version).toBe("0.5.21");
    expect(state.source).toBe("fallback");
    expect(state.enabled).toBe(true);
    expect(state.installPath).toBe("~/.openclaw/extensions/openclaw-channel-dmwork");
  });

  it("should read version from package.json when installs record has no version", async () => {
    const { resolvePluginState } = await loadModule();
    const { existsSync, readFileSync } = await import("node:fs");
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === "config" && argsArr[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (argsArr[0] === "plugins") throw new Error("unknown command");
      return "";
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("openclaw.json")) {
        return JSON.stringify({
          plugins: {
            entries: { "openclaw-channel-dmwork": { enabled: true } },
            installs: { "openclaw-channel-dmwork": { installPath: "~/.openclaw/extensions/openclaw-channel-dmwork" } },
          },
        });
      }
      if (path.endsWith("package.json")) {
        return JSON.stringify({ version: "0.5.20" });
      }
      return "{}";
    });
    vi.mocked(existsSync).mockReturnValue(true);

    const state = resolvePluginState("openclaw-channel-dmwork");
    expect(state.installed).toBe(true);
    expect(state.version).toBe("0.5.20");
    expect(state.source).toBe("fallback");
  });

  it("should return not installed when nothing exists", async () => {
    const { resolvePluginState } = await loadModule();
    const { existsSync, readFileSync } = await import("node:fs");
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === "config" && argsArr[1] === "file") return "/home/user/.openclaw/openclaw.json";
      if (argsArr[0] === "plugins") throw new Error("unknown command");
      return "";
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({}));
    vi.mocked(existsSync).mockReturnValue(false);

    const state = resolvePluginState("openclaw-channel-dmwork");
    expect(state.installed).toBe(false);
    expect(state.version).toBeNull();
    expect(state.source).toBe("fallback");
  });
});
