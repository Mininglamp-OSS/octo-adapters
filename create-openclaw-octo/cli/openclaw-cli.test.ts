import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { pathEndsWith, RESOLVED_CFG_PATH } from "./__test_utils__/path.js";

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
      '[octo] registering before_prompt_build hook\n' +
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

describe("listLoadedPlugins", () => {
  it("parses plugins list --json output", async () => {
    const { listLoadedPlugins } = await loadModule();
    mockExecFileSync.mockReturnValue(JSON.stringify({
      plugins: [
        {
          id: "octo",
          status: "loaded",
          enabled: true,
          source: "/home/u/.openclaw/extensions/octo/dist/index.js",
          origin: "global",
          rootDir: "/home/u/.openclaw/extensions/octo",
        },
        {
          id: "openclaw-channel-octo",
          status: "loaded",
          enabled: true,
          source: "/home/u/.openclaw/npm/node_modules/openclaw-channel-octo/dist/index.js",
          origin: "npm",
          rootDir: "/home/u/.openclaw/npm/node_modules/openclaw-channel-octo",
        },
      ],
    }));

    const result = listLoadedPlugins();
    expect(result.supported).toBe(true);
    expect(result.plugins).toHaveLength(2);
    expect(result.plugins[0].id).toBe("octo");
    expect(result.plugins[1].id).toBe("openclaw-channel-octo");
    expect(result.plugins[1].rootDir).toContain("npm/node_modules");
  });

  it("strips preceding log/banner noise before JSON parse", async () => {
    const { listLoadedPlugins } = await loadModule();
    mockExecFileSync.mockReturnValue(
      "🦞 OpenClaw 2026.5.18\n" +
        "[plugins] loading...\n" +
        JSON.stringify({ plugins: [{ id: "octo", status: "loaded", enabled: true }] }),
    );

    const result = listLoadedPlugins();
    expect(result.supported).toBe(true);
    expect(result.plugins[0].id).toBe("octo");
  });

  it("tolerates trailing log noise after JSON object via brace-matching", async () => {
    // Some OpenClaw runtimes emit warnings AFTER the JSON object (e.g.
    // gateway shutdown warnings on subsequent commands). A naive
    // `JSON.parse(out.slice(start))` would fail because the slice includes
    // the trailing log lines; brace-matching extracts just the balanced
    // top-level object.
    const { listLoadedPlugins } = await loadModule();
    mockExecFileSync.mockReturnValue(
      JSON.stringify({ plugins: [{ id: "octo", status: "loaded", enabled: true }] }) +
        "\n[plugins] reload complete\n" +
        "Warning: deprecated config key X\n",
    );

    const result = listLoadedPlugins();
    expect(result.supported).toBe(true);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].id).toBe("octo");
  });

  it("brace-matching handles strings containing curly braces correctly", async () => {
    // Defense against a flawed brace-counter: source paths can contain
    // literal "}" or "{" inside string values. The matcher must respect
    // string boundaries so it doesn't terminate the object prematurely.
    const { listLoadedPlugins } = await loadModule();
    mockExecFileSync.mockReturnValue(JSON.stringify({
      plugins: [
        { id: "octo", status: "loaded", enabled: true, source: "/path/with/{braces}/in/it" },
      ],
    }));

    const result = listLoadedPlugins();
    expect(result.supported).toBe(true);
    expect(result.plugins[0].source).toContain("{braces}");
  });

  it("identifies `unknown command` as unsupported (old OpenClaw)", async () => {
    const { listLoadedPlugins } = await loadModule();
    mockExecFileSync.mockImplementation(() => {
      const err = new Error("error: unknown command 'list'") as any;
      err.stderr = "error: unknown command 'list'";
      throw err;
    });

    const result = listLoadedPlugins();
    expect(result.supported).toBe(false);
    expect(result.error).toBeNull();
  });

  it("reports a real error (e.g. EACCES) via `error` field, not unsupported", async () => {
    // Distinguishes "old OpenClaw doesn't recognise the subcommand"
    // (supported=false, error=null) from genuine errors (config corruption,
    // permission, plugin load crash) where the runtime cannot reliably
    // tell us what's loaded.
    const { listLoadedPlugins } = await loadModule();
    mockExecFileSync.mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as any;
      err.stderr = "EACCES: permission denied";
      throw err;
    });

    const result = listLoadedPlugins();
    expect(result.supported).toBe(false);
    expect(result.error).toMatch(/permission denied/i);
  });

  it("reports parse failure via `error`, not as old-runtime", async () => {
    const { listLoadedPlugins } = await loadModule();
    mockExecFileSync.mockReturnValue("usage: openclaw plugins list ...");

    const result = listLoadedPlugins();
    expect(result.supported).toBe(false);
    expect(result.error).toMatch(/no JSON|JSON/);
  });

  it("reports supported=false on old OpenClaw without `plugins list --json`", async () => {
    const { listLoadedPlugins } = await loadModule();
    mockExecFileSync.mockImplementation(() => {
      throw new Error("error: unknown command 'list'");
    });

    const result = listLoadedPlugins();
    expect(result.supported).toBe(false);
    expect(result.plugins).toEqual([]);
  });

  it("reports supported=false when output is not JSON", async () => {
    const { listLoadedPlugins } = await loadModule();
    mockExecFileSync.mockReturnValue("usage: openclaw plugins list ...");

    const result = listLoadedPlugins();
    expect(result.supported).toBe(false);
    expect(result.error).toMatch(/no JSON/);
  });

  it("reports supported=false when JSON has no plugins array", async () => {
    const { listLoadedPlugins } = await loadModule();
    mockExecFileSync.mockReturnValue(JSON.stringify({ unexpected: "shape" }));

    const result = listLoadedPlugins();
    expect(result.supported).toBe(false);
    expect(result.error).toMatch(/missing.*plugins.*array/i);
  });

  it("filters out entries with missing id", async () => {
    const { listLoadedPlugins } = await loadModule();
    mockExecFileSync.mockReturnValue(JSON.stringify({
      plugins: [
        { id: "octo", status: "loaded", enabled: true },
        { /* no id */ status: "loaded" },
        { id: "", status: "loaded" },
      ],
    }));

    const result = listLoadedPlugins();
    expect(result.supported).toBe(true);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].id).toBe("octo");
  });
});

describe("getOpenClawVersion", () => {
  it("should extract version from openclaw --version output", async () => {
    const { getOpenClawVersion } = await loadModule();
    mockExecFileSync.mockReturnValue("OpenClaw 2026.4.11 (769908e)\n");

    expect(getOpenClawVersion()).toBe("2026.4.11");
  });

  it("should return null when openclaw is not installed (ENOENT)", async () => {
    const { getOpenClawVersion } = await loadModule();
    mockExecFileSync.mockImplementation(() => {
      const err = new Error("spawn openclaw ENOENT") as any;
      err.code = "ENOENT";
      throw err;
    });

    expect(getOpenClawVersion()).toBeNull();
  });

  it("should return null on non-ENOENT errors (getOpenClawVersion)", async () => {
    const { getOpenClawVersion } = await loadModule();
    mockExecFileSync.mockImplementation(() => {
      throw new Error("permission denied");
    });

    expect(getOpenClawVersion()).toBeNull();
  });

  it("should throw on non-ENOENT errors (getOpenClawVersionStrict)", async () => {
    const { getOpenClawVersionStrict } = await loadModule();
    mockExecFileSync.mockImplementation(() => {
      throw new Error("permission denied");
    });

    expect(() => getOpenClawVersionStrict()).toThrow("Failed to execute openclaw");
  });
});

describe("configGet / configSet", () => {
  it("should pass correct args to execFileSync", async () => {
    const { configGet } = await loadModule();
    mockExecFileSync.mockReturnValue("some_value\n");

    const result = configGet("channels.octo.accounts.my_bot.botToken");
    expect(result).toBe("some_value");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "openclaw",
      ["config", "get", "channels.octo.accounts.my_bot.botToken"],
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
        expect.arrayContaining(["/d", "/v:off", "/c", "call"]),
        expect.any(Object),
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("should fallback to npm prefix when where openclaw fails on Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const { execSync } = await import("node:child_process");
      const { existsSync } = await import("node:fs");

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        // where openclaw / where openclaw.exe → fail
        if (cmdStr.includes("where") && cmdStr.includes("openclaw") && !cmdStr.includes("npm")) {
          throw new Error("not found");
        }
        // where.exe npm → return npm.cmd (for resolveCommand)
        if (cmdStr.includes("where") && cmdStr.includes("npm")) {
          return "C:\\Users\\mLamp\\AppData\\Roaming\\npm\\npm.cmd\r\n";
        }
        return "";
      });

      mockExecFileSync.mockClear();
      mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
        const argsArr = args as string[];
        // cmd.exe /d /v:off /c call npm.cmd config get prefix
        if (argsArr?.includes?.("prefix")) {
          return "C:\\Users\\mLamp\\AppData\\Roaming\\npm\n";
        }
        // openclaw --version via cmd.exe
        return "OpenClaw 2026.4.21\n";
      });

      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        return String(p).endsWith("openclaw.cmd");
      });

      const mod = await loadModule();
      mod.getOpenClawVersion();

      // Verify: openclaw.cmd found via npm prefix, executed via cmd.exe
      const cmdExeCalls = mockExecFileSync.mock.calls.filter(
        (call) => String(call[0]).includes("cmd.exe"),
      );
      expect(cmdExeCalls.length).toBeGreaterThanOrEqual(2); // npm prefix + openclaw --version
      expect(cmdExeCalls.some(
        (call) => (call[1] as string[]).some((a) => a.includes("openclaw.cmd")),
      )).toBe(true);
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
          plugin: { id: "openclaw-channel-octo", version: "0.5.21", enabled: true },
          install: { source: "npm", version: "0.5.21", installPath: "~/.openclaw/extensions/openclaw-channel-octo" },
        });
      }
      return "";
    });
    const state = resolvePluginState("openclaw-channel-octo");
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
        entries: { "openclaw-channel-octo": { enabled: true } },
        installs: { "openclaw-channel-octo": { version: "0.5.21", installPath: "~/.openclaw/extensions/openclaw-channel-octo" } },
      },
    }));
    vi.mocked(existsSync).mockReturnValue(true);

    const state = resolvePluginState("openclaw-channel-octo");
    expect(state.installed).toBe(true);
    expect(state.version).toBe("0.5.21");
    expect(state.source).toBe("fallback");
    expect(state.enabled).toBe(true);
    expect(state.installPath).toBe("~/.openclaw/extensions/openclaw-channel-octo");
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
            entries: { "openclaw-channel-octo": { enabled: true } },
            installs: { "openclaw-channel-octo": { installPath: "~/.openclaw/extensions/openclaw-channel-octo" } },
          },
        });
      }
      if (path.endsWith("package.json")) {
        return JSON.stringify({ version: "0.5.20" });
      }
      return "{}";
    });
    vi.mocked(existsSync).mockReturnValue(true);

    const state = resolvePluginState("openclaw-channel-octo");
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

    const state = resolvePluginState("openclaw-channel-octo");
    expect(state.installed).toBe(false);
    expect(state.version).toBeNull();
    expect(state.source).toBe("fallback");
  });
});

// ---------------------------------------------------------------------------
// compareOpenClawVersion — pure function, no mocks needed
//
// IMPORTANT: This block (and detectOpenClawState below) MUST stay before the
// `getConfigFilePathSafe` block. That block uses `vi.doMock("node:child_process",
// ...)` with a LOCAL mock fn, which permanently re-binds the module mock so the
// global `mockExecFileSync` reference (set at the top of this file) no longer
// reaches the openclaw-cli.js module instance after that. Tests below
// `getConfigFilePathSafe` can't reliably control execFileSync via that ref.
// ---------------------------------------------------------------------------

describe("compareOpenClawVersion", () => {
  it("returns 0 for equal versions", async () => {
    const { compareOpenClawVersion } = await loadModule();
    expect(compareOpenClawVersion("2026.4.15", "2026.4.15")).toBe(0);
  });

  it("returns -1 when a < b in patch", async () => {
    const { compareOpenClawVersion } = await loadModule();
    expect(compareOpenClawVersion("2026.4.14", "2026.4.15")).toBe(-1);
  });

  it("returns 1 when a > b in patch", async () => {
    const { compareOpenClawVersion } = await loadModule();
    expect(compareOpenClawVersion("2026.4.16", "2026.4.15")).toBe(1);
  });

  it("returns 1 when a > b in minor (major equal)", async () => {
    const { compareOpenClawVersion } = await loadModule();
    expect(compareOpenClawVersion("2026.5.0", "2026.4.99")).toBe(1);
  });

  it("returns 1 when a > b in major", async () => {
    const { compareOpenClawVersion } = await loadModule();
    expect(compareOpenClawVersion("2027.0.0", "2026.99.99")).toBe(1);
  });

  it("regression: double-digit minor is integer-compared, not lex-compared", async () => {
    // Lexical compare would say "10" < "9". Integer compare says "10" > "9".
    const { compareOpenClawVersion } = await loadModule();
    expect(compareOpenClawVersion("2026.10.0", "2026.9.0")).toBe(1);
    expect(compareOpenClawVersion("2026.9.0", "2026.10.0")).toBe(-1);
  });

  it("regression: double-digit patch is integer-compared, not lex-compared", async () => {
    const { compareOpenClawVersion } = await loadModule();
    expect(compareOpenClawVersion("2026.5.18", "2026.5.2")).toBe(1);
    expect(compareOpenClawVersion("2026.5.2", "2026.5.18")).toBe(-1);
  });

  it("treats missing segments as 0", async () => {
    const { compareOpenClawVersion } = await loadModule();
    expect(compareOpenClawVersion("2026.5", "2026.5.0")).toBe(0);
    expect(compareOpenClawVersion("2026", "2026.0.0")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectOpenClawState — three tiers: block / warn / ok
// ---------------------------------------------------------------------------

describe("detectOpenClawState", () => {
  it("block when openclaw is not on PATH (ENOENT)", async () => {
    const { detectOpenClawState } = await loadModule();
    mockExecFileSync.mockImplementation(() => {
      const err = new Error("spawn openclaw ENOENT") as any;
      err.code = "ENOENT";
      throw err;
    });
    const state = detectOpenClawState();
    expect(state.kind).toBe("block");
    if (state.kind === "block") {
      expect(state.version).toBeNull();
      expect(state.reason).toMatch(/not installed|not on PATH/i);
    }
  });

  it("block when version < OPENCLAW_PEER_MIN (2026.4.15)", async () => {
    const { detectOpenClawState } = await loadModule();
    mockExecFileSync.mockImplementation(() => "OpenClaw 2026.3.10 (abc1234)\n" as any);
    const state = detectOpenClawState();
    expect(state.kind).toBe("block");
    if (state.kind === "block") {
      expect(state.version).toBe("2026.3.10");
      expect(state.reason).toContain("2026.3.10");
      expect(state.reason).toContain("2026.4.15");
    }
  });

  it("warn when peer-min <= version < recommended (2026.5.18)", async () => {
    const { detectOpenClawState } = await loadModule();
    mockExecFileSync.mockImplementation(() => "OpenClaw 2026.4.20 (abc1234)\n" as any);
    const state = detectOpenClawState();
    expect(state.kind).toBe("warn");
    if (state.kind === "warn") {
      expect(state.version).toBe("2026.4.20");
      expect(state.reason).toContain("2026.4.20");
      expect(state.reason).toContain("2026.5.18");
    }
  });

  it("warn at exact peer-min (boundary)", async () => {
    const { detectOpenClawState } = await loadModule();
    mockExecFileSync.mockImplementation(() => "OpenClaw 2026.4.15 (abc1234)\n" as any);
    const state = detectOpenClawState();
    expect(state.kind).toBe("warn");
  });

  it("ok at exact recommended (boundary)", async () => {
    const { detectOpenClawState } = await loadModule();
    mockExecFileSync.mockImplementation(() => "OpenClaw 2026.5.18 (abc1234)\n" as any);
    const state = detectOpenClawState();
    expect(state.kind).toBe("ok");
    if (state.kind === "ok") {
      expect(state.version).toBe("2026.5.18");
    }
  });

  it("ok when version > recommended", async () => {
    const { detectOpenClawState } = await loadModule();
    mockExecFileSync.mockImplementation(() => "OpenClaw 2027.1.0 (abc1234)\n" as any);
    const state = detectOpenClawState();
    expect(state.kind).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// hasLegacyPluginArtifacts / hasVeryLegacyPluginArtifacts — direct unit
// coverage for the residue-detection helpers used by detectInstallState
// (octo-clawhub.legacyDmworkResidue) and detectScenario (rebrand priority).
//
// These need to count only ACTIVE residue (cfg state OpenClaw will read
// at startup) — not inert disk residue / orphaned allowlist entries that
// have no behavioural effect.
// ---------------------------------------------------------------------------

describe("hasLegacyPluginArtifacts", () => {
  it("entries.openclaw-channel-dmwork → true", async () => {
    const { hasLegacyPluginArtifacts } = await loadModule();
    expect(hasLegacyPluginArtifacts({
      plugins: { entries: { "openclaw-channel-dmwork": { enabled: true } } },
    })).toBe(true);
  });

  it("installs.openclaw-channel-dmwork → true", async () => {
    const { hasLegacyPluginArtifacts } = await loadModule();
    expect(hasLegacyPluginArtifacts({
      plugins: { installs: { "openclaw-channel-dmwork": { version: "0.6.4" } } },
    })).toBe(true);
  });

  it("channels.dmwork → true (data needs migration)", async () => {
    const { hasLegacyPluginArtifacts } = await loadModule();
    expect(hasLegacyPluginArtifacts({
      channels: { dmwork: { accounts: { bot1: { botToken: "x" } } } },
    })).toBe(true);
  });

  it("bindings(channel=dmwork) → true (routing needs migration)", async () => {
    const { hasLegacyPluginArtifacts } = await loadModule();
    expect(hasLegacyPluginArtifacts({
      bindings: [{ match: { channel: "dmwork" }, accountId: "x", agent: "main" }],
    })).toBe(true);
  });

  it("plugins.allow only (no entry/install/channel/binding) → false", async () => {
    // Allowlist alone is dead-letter — without a matching entry OpenClaw
    // doesn't load it. Not a critical residue.
    const { hasLegacyPluginArtifacts } = await loadModule();
    expect(hasLegacyPluginArtifacts({
      plugins: { allow: ["openclaw-channel-dmwork"] },
    })).toBe(false);
  });

  it("empty cfg with disk residue (mocked) → false (cosmetic only)", async () => {
    // Real-world Mac/Win scenario after rebrand uninstall:
    // ~/.openclaw/extensions/openclaw-channel-dmwork/ remains on disk
    // but cfg has no entry/install/channel/binding for it. OpenClaw's
    // disk-scan auto-adds a disabled entry (which never calls setup()).
    // No channel registration, no migration needed → not critical residue.
    const { hasLegacyPluginArtifacts } = await loadModule();
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);  // disk dir exists
    expect(hasLegacyPluginArtifacts({})).toBe(false);
  });

  it("null cfg → false", async () => {
    const { hasLegacyPluginArtifacts } = await loadModule();
    expect(hasLegacyPluginArtifacts(null)).toBe(false);
  });
});

describe("hasVeryLegacyPluginArtifacts", () => {
  it("entries.dmwork → true", async () => {
    const { hasVeryLegacyPluginArtifacts } = await loadModule();
    expect(hasVeryLegacyPluginArtifacts({
      plugins: { entries: { dmwork: { enabled: true } } },
    })).toBe(true);
  });

  it("installs.dmwork → true", async () => {
    const { hasVeryLegacyPluginArtifacts } = await loadModule();
    expect(hasVeryLegacyPluginArtifacts({
      plugins: { installs: { dmwork: { version: "0.5.21" } } },
    })).toBe(true);
  });

  it("plugins.allow only → false (dead-letter)", async () => {
    const { hasVeryLegacyPluginArtifacts } = await loadModule();
    expect(hasVeryLegacyPluginArtifacts({
      plugins: { allow: ["dmwork"] },
    })).toBe(false);
  });

  it("empty cfg with disk residue (mocked) → false (cosmetic only)", async () => {
    const { hasVeryLegacyPluginArtifacts } = await loadModule();
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);
    expect(hasVeryLegacyPluginArtifacts({})).toBe(false);
  });

  it("null cfg → false", async () => {
    const { hasVeryLegacyPluginArtifacts } = await loadModule();
    expect(hasVeryLegacyPluginArtifacts(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectInstallState — also kept BEFORE the `getConfigFilePathSafe` block for
// the same `vi.doMock` re-binding reason called out at line 560.
// ---------------------------------------------------------------------------

describe("detectInstallState", () => {
  // Helper: ClawHub octo present in cfg + extensions dir, with optional
  // `legacyNpm` toggle to add cfg.plugins.entries["openclaw-channel-octo"]
  // (the dual-active signal).
  function setupOctoClawHub(opts: {
    legacyNpmInEntries?: boolean;
    legacyNpmInInstalls?: boolean;
    npmDirResidue?: boolean;
    dmworkChannel?: boolean;
    dmworkBinding?: boolean;
    veryLegacyDmworkInEntries?: boolean;
    veryLegacyDmworkInInstalls?: boolean;
    /**
     * When true, `openclaw plugins list --json` returns a parseable
     * payload containing octo + any of the optional `*InList` ids.
     * When false (default), the command throws — simulating an old
     * OpenClaw runtime that doesn't support `plugins list --json` and
     * exercising the cfg.entries fallback path inside isPluginRegistered.
     */
    pluginsListSupported?: boolean;
    legacyNpmInList?: boolean;
    legacyDmworkInList?: boolean;
    veryLegacyDmworkInList?: boolean;
    /**
     * Disabled-only list entries — what OpenClaw produces when disk-scan
     * auto-discovers a residual plugin file but cfg has no entry for it.
     * Such entries do NOT have setup() called → cannot register a channel,
     * so they should NOT count as "active" by isPluginRegistered.
     */
    legacyNpmInListDisabled?: boolean;
    legacyDmworkInListDisabled?: boolean;
    veryLegacyDmworkInListDisabled?: boolean;
  }) {
    return async () => {
      const { existsSync, readFileSync } = await import("node:fs");
      const mkListEntry = (id: string, enabled = true) => ({
        id,
        status: enabled ? "loaded" : "disabled",
        enabled,
        source: `/home/user/.openclaw/extensions/${id}/dist/index.js`,
        origin: "global",
        rootDir: `/home/user/.openclaw/extensions/${id}`,
      });
      const listPayload = (() => {
        if (!opts.pluginsListSupported) return null;
        const plugins = [mkListEntry("octo")];
        if (opts.legacyNpmInList) plugins.push(mkListEntry("openclaw-channel-octo"));
        if (opts.legacyDmworkInList) plugins.push(mkListEntry("openclaw-channel-dmwork"));
        if (opts.veryLegacyDmworkInList) plugins.push(mkListEntry("dmwork"));
        if (opts.legacyNpmInListDisabled) plugins.push(mkListEntry("openclaw-channel-octo", false));
        if (opts.legacyDmworkInListDisabled) plugins.push(mkListEntry("openclaw-channel-dmwork", false));
        if (opts.veryLegacyDmworkInListDisabled) plugins.push(mkListEntry("dmwork", false));
        return JSON.stringify({ plugins });
      })();
      mockExecFileSync.mockImplementation((cmd, args) => {
        const argsArr = args as string[];
        if (argsArr[0] === "config" && argsArr[1] === "file") {
          return "/home/user/.openclaw/openclaw.json";
        }
        if (argsArr[0] === "plugins" && argsArr[1] === "list" && argsArr[2] === "--json") {
          if (listPayload) return listPayload;
          throw new Error("error: unknown command 'list'");
        }
        if (argsArr[0] === "plugins" && argsArr[1] === "inspect") {
          // simulate old OpenClaw → fallback path inside isHealthyInstall
          throw new Error("error: unknown command 'inspect'");
        }
        return "";
      });
      const cfg: any = {
        plugins: {
          entries: { octo: { enabled: true } },
          installs: { octo: { version: "1.0.12", installPath: "~/.openclaw/extensions/octo" } },
        },
      };
      if (opts.legacyNpmInEntries) {
        cfg.plugins.entries["openclaw-channel-octo"] = { enabled: true };
      }
      if (opts.legacyNpmInInstalls) {
        cfg.plugins.installs["openclaw-channel-octo"] = {
          version: "1.0.0",
          installPath: "~/.openclaw/npm/node_modules/openclaw-channel-octo",
        };
      }
      if (opts.dmworkChannel) {
        cfg.channels = { dmwork: { accounts: { "u1": {} } } };
      }
      if (opts.dmworkBinding) {
        cfg.bindings = [{ match: { channel: "dmwork" }, accountId: "u1", agent: "main" }];
      }
      if (opts.veryLegacyDmworkInEntries) {
        cfg.plugins.entries["dmwork"] = { enabled: true };
      }
      if (opts.veryLegacyDmworkInInstalls) {
        cfg.plugins.installs["dmwork"] = {
          version: "0.5.21",
          installPath: "~/.openclaw/extensions/dmwork",
        };
      }
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(cfg));
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        if (pathEndsWith(p, "/extensions/octo")) return true;
        if (pathEndsWith(p, ".openclaw/npm/node_modules/openclaw-channel-octo")) {
          return Boolean(opts.npmDirResidue);
        }
        return false;
      });
    };
  }

  it("octo-clawhub healthy and clean (no residue, no legacy active)", async () => {
    await setupOctoClawHub({})();
    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("octo-clawhub");
    if (state.kind === "octo-clawhub") {
      expect(state.legacyNpmActive).toBe(false);
      expect(state.legacyDmworkResidue).toBe(false);
      expect(state.npmResidue).toBe(false);
      expect(state.version).toBe("1.0.12");
    }
  });

  it("octo-clawhub with directory residue only — npmResidue=true, legacyNpmActive=false", async () => {
    await setupOctoClawHub({ npmDirResidue: true })();
    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("octo-clawhub");
    if (state.kind === "octo-clawhub") {
      expect(state.npmResidue).toBe(true);
      expect(state.legacyNpmActive).toBe(false);
    }
  });

  it("octo-clawhub with legacy npm still registered in cfg.entries — legacyNpmActive=true (BLOCK)", async () => {
    await setupOctoClawHub({ legacyNpmInEntries: true, legacyNpmInInstalls: true })();
    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("octo-clawhub");
    if (state.kind === "octo-clawhub") {
      expect(state.legacyNpmActive).toBe(true);
    }
  });

  it("octo-clawhub: legacyNpmActive takes precedence regardless of dir residue", async () => {
    await setupOctoClawHub({
      legacyNpmInEntries: true,
      legacyNpmInInstalls: true,
      npmDirResidue: true,
    })();
    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("octo-clawhub");
    if (state.kind === "octo-clawhub") {
      expect(state.legacyNpmActive).toBe(true);
      expect(state.npmResidue).toBe(true);
    }
  });

  it("octo-clawhub with dmwork channel residue — legacyDmworkResidue=true (BLOCK)", async () => {
    await setupOctoClawHub({ dmworkChannel: true })();
    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("octo-clawhub");
    if (state.kind === "octo-clawhub") {
      expect(state.legacyDmworkResidue).toBe(true);
      expect(state.legacyNpmActive).toBe(false);
    }
  });

  it("octo-clawhub with dmwork binding residue — legacyDmworkResidue=true (BLOCK)", async () => {
    await setupOctoClawHub({ dmworkBinding: true })();
    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("octo-clawhub");
    if (state.kind === "octo-clawhub") {
      expect(state.legacyDmworkResidue).toBe(true);
    }
  });

  it("octo-clawhub with very-legacy `dmwork` plugin entries — legacyDmworkResidue=true (BLOCK)", async () => {
    // Regression for the `hasVeryLegacyPluginArtifacts` precedence —
    // detectScenario() in install.ts treats `dmwork` (very-legacy id) as
    // priority 1 (legacy-to-octo migration) above `openclaw-channel-dmwork`
    // (intermediate id) at priority 2 (rebrand). The pre-flight must
    // surface BOTH ids so a stale `dmwork` entry without channels.dmwork
    // or bindings still blocks bind/quickstart/remove-account.
    await setupOctoClawHub({
      veryLegacyDmworkInEntries: true,
      veryLegacyDmworkInInstalls: true,
    })();
    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("octo-clawhub");
    if (state.kind === "octo-clawhub") {
      expect(state.legacyDmworkResidue).toBe(true);
      expect(state.legacyNpmActive).toBe(false);
    }
  });

  // ── plugins list --json signal path (#82 detection-layer refactor) ──

  it("octo-clawhub: legacyNpmActive sourced from `plugins list --json` (cfg.entries empty)", async () => {
    // Modern OpenClaw reports the legacy npm openclaw-channel-octo through
    // `plugins list --json`. Even when cfg.plugins.entries doesn't yet
    // reflect it (e.g. stale cfg snapshot vs runtime), the list signal is
    // the authoritative source.
    await setupOctoClawHub({
      pluginsListSupported: true,
      legacyNpmInList: true,
    })();
    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("octo-clawhub");
    if (state.kind === "octo-clawhub") {
      expect(state.legacyNpmActive).toBe(true);
    }
  });

  it("octo-clawhub: legacyDmworkResidue sourced from `plugins list --json` (LEGACY_PLUGIN_ID)", async () => {
    // Modern OpenClaw with intermediate dmwork id (`openclaw-channel-dmwork`)
    // active. The list signal catches it without depending on
    // `extensions/<id>` directory probing — important because dmwork
    // legacy is npm-installed (lives under npm/node_modules/<id>).
    await setupOctoClawHub({
      pluginsListSupported: true,
      legacyDmworkInList: true,
    })();
    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("octo-clawhub");
    if (state.kind === "octo-clawhub") {
      expect(state.legacyDmworkResidue).toBe(true);
      expect(state.legacyNpmActive).toBe(false);
    }
  });

  it("octo-clawhub: legacyDmworkResidue sourced from `plugins list --json` (VERY_LEGACY_PLUGIN_ID)", async () => {
    // Modern OpenClaw with very-legacy `dmwork` id active. Mirrors
    // detectScenario()'s priority-1 bucket through the list signal.
    await setupOctoClawHub({
      pluginsListSupported: true,
      veryLegacyDmworkInList: true,
    })();
    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("octo-clawhub");
    if (state.kind === "octo-clawhub") {
      expect(state.legacyDmworkResidue).toBe(true);
      expect(state.legacyNpmActive).toBe(false);
    }
  });

  it("octo-npm-legacy when ClawHub octo absent and NPM_PACKAGE_NAME healthy", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === "config" && argsArr[1] === "file") {
        return "/home/user/.openclaw/openclaw.json";
      }
      if (argsArr[0] === "plugins" && argsArr[1] === "list" && argsArr[2] === "--json") {
        // Old OpenClaw — not supported (caller falls back to cfg.entries)
        const e = new Error("error: unknown command 'list'") as any;
        e.stderr = "error: unknown command 'list'";
        throw e;
      }
      if (argsArr[0] === "plugins" && argsArr[1] === "inspect") {
        throw new Error("error: unknown command 'inspect'");
      }
      return "";
    });
    // No `octo` entry; only legacy npm is present
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      plugins: {
        entries: { "openclaw-channel-octo": { enabled: true } },
        installs: {
          "openclaw-channel-octo": {
            version: "1.0.0",
            installPath: "~/.openclaw/extensions/openclaw-channel-octo",
          },
        },
      },
    }));
    vi.mocked(existsSync).mockImplementation((p: unknown) =>
      pathEndsWith(p, "/extensions/openclaw-channel-octo"),
    );
    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("octo-npm-legacy");
    if (state.kind === "octo-npm-legacy") {
      expect(state.version).toBe("1.0.0");
    }
  });

  it("dmwork-legacy: both ids registered → classifier picks VERY_LEGACY first (priority 1 in detectScenario)", async () => {
    // Regression for codex review on PR #83: when both `dmwork`
    // (VERY_LEGACY_PLUGIN_ID) and `openclaw-channel-dmwork`
    // (LEGACY_PLUGIN_ID) are registered with no healthy octo present,
    // detectInstallState must mirror detectScenario()'s priority and
    // report the very-legacy id's version. Otherwise the pre-flight
    // surfaces a different version than the migration install.ts will
    // actually run (legacy-to-octo, not rebrand).
    const { existsSync, readFileSync } = await import("node:fs");
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === "config" && argsArr[1] === "file") {
        return "/home/user/.openclaw/openclaw.json";
      }
      if (argsArr[0] === "plugins" && argsArr[1] === "list" && argsArr[2] === "--json") {
        return JSON.stringify({
          plugins: [
            { id: "dmwork", status: "loaded", enabled: true },
            { id: "openclaw-channel-dmwork", status: "loaded", enabled: true },
          ],
        });
      }
      if (argsArr[0] === "plugins" && argsArr[1] === "inspect") {
        throw new Error("error: unknown command 'inspect'");
      }
      return "";
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      plugins: {
        entries: { dmwork: { enabled: true }, "openclaw-channel-dmwork": { enabled: true } },
        installs: {
          dmwork: { version: "0.5.21", installPath: "~/.openclaw/extensions/dmwork" },
          "openclaw-channel-dmwork": { version: "0.6.5", installPath: "~/.openclaw/npm/node_modules/openclaw-channel-dmwork" },
        },
      },
    }));
    vi.mocked(existsSync).mockReturnValue(false);

    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("dmwork-legacy");
    if (state.kind === "dmwork-legacy") {
      // Must pick the VERY_LEGACY (`dmwork`) version, not the LEGACY
      // (`openclaw-channel-dmwork`) version — matches detectScenario()
      // priority: `legacy-to-octo` migration runs first.
      expect(state.version).toBe("0.5.21");
    }
  });

  it("broken when only cfg.entries.openclaw-channel-octo is stale (no dir, list unsupported)", async () => {
    // Regression for PR #83 review: a stale cfg.plugins.entries entry left
    // behind by an incomplete uninstall on an old OpenClaw runtime should
    // classify as `broken` (so doctor --fix cleans it up), NOT
    // `octo-npm-legacy` (which would prompt the user to migrate a plugin
    // that isn't actually installed). Modern OpenClaw uses `plugins list
    // --json` as the authoritative active-set, but the older fallback
    // path must AND cfg.entries with the npm-layout install dir.
    const { existsSync, readFileSync } = await import("node:fs");
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === "config" && argsArr[1] === "file") {
        return "/home/user/.openclaw/openclaw.json";
      }
      if (argsArr[0] === "plugins" && argsArr[1] === "list" && argsArr[2] === "--json") {
        throw new Error("error: unknown command 'list'");
      }
      if (argsArr[0] === "plugins" && argsArr[1] === "inspect") {
        throw new Error("error: unknown command 'inspect'");
      }
      return "";
    });
    // cfg has stale entries.openclaw-channel-octo but no extensions dir
    // and no npm/node_modules dir — the plugin was uninstalled but the
    // entry never got cleaned up.
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      plugins: {
        entries: { "openclaw-channel-octo": { enabled: true } },
      },
    }));
    vi.mocked(existsSync).mockReturnValue(false);

    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("broken");
    if (state.kind === "broken") {
      expect(state.details).toContain("openclaw-channel-octo");
    }
  });

  it("fail-closed when `plugins list --json` errors for a real reason (not unsupported)", async () => {
    // Regression for codex review: when the OpenClaw runtime is in a
    // failure state (config corruption, permission denied, plugin load
    // crash, partial JSON), `plugins list --json` cannot reliably report
    // what's loaded. Trusting cfg.entries alone risks silently allowing
    // a dual-active state to slip through bind/quickstart/remove-account.
    // detectInstallState must surface this as `broken` so the user is
    // prompted to repair OpenClaw before any further config writes.
    const { existsSync, readFileSync } = await import("node:fs");
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === "config" && argsArr[1] === "file") {
        return "/home/user/.openclaw/openclaw.json";
      }
      if (argsArr[0] === "plugins" && argsArr[1] === "list" && argsArr[2] === "--json") {
        const e = new Error("EACCES: permission denied") as any;
        e.stderr = "EACCES: permission denied, open '/home/user/.openclaw/openclaw.json'";
        throw e;
      }
      if (argsArr[0] === "plugins" && argsArr[1] === "inspect") {
        throw new Error("error: unknown command 'inspect'");
      }
      return "";
    });
    // Even with a healthy-looking cfg, the list-failed signal must
    // dominate.
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      plugins: {
        entries: { octo: { enabled: true } },
        installs: { octo: { version: "1.0.12", installPath: "~/.openclaw/extensions/octo" } },
      },
    }));
    vi.mocked(existsSync).mockReturnValue(true);

    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("broken");
    if (state.kind === "broken") {
      expect(state.details).toMatch(/plugins list/);
      expect(state.details).toMatch(/permission denied/i);
    }
  });

  // ── disabled / disk-only residue should NOT be reported as critical ──
  // Mac/Windows real-machine evidence: after install the OpenClaw runtime
  // auto-discovers leftover plugin files via disk scan and lists them as
  // disabled (no cfg entry). Such entries do NOT have setup() called, so
  // they cannot register a channel — no duplicate channel risk. Doctor
  // should not report ✗ Unfinished migration in this state.

  it("octo-clawhub: legacy NPM_PACKAGE_NAME in plugins list as DISABLED → legacyNpmActive=false", async () => {
    // Real-world scenario: user upgraded from npm 1.0.0 → ClawHub octo.
    // OpenClaw's `plugins uninstall` left the npm/node_modules dir on disk;
    // gateway restart auto-discovered the file and listed it as `disabled`.
    // The cfg has no entry for it → setup() not called → channel "octo"
    // not registered by the legacy plugin → no dual-active risk.
    await setupOctoClawHub({
      pluginsListSupported: true,
      legacyNpmInListDisabled: true,
    })();
    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("octo-clawhub");
    if (state.kind === "octo-clawhub") {
      expect(state.legacyNpmActive).toBe(false);
      expect(state.legacyDmworkResidue).toBe(false);
    }
  });

  it("octo-clawhub: LEGACY_PLUGIN_ID in plugins list as DISABLED → legacyDmworkResidue=false", async () => {
    // Real-world scenario observed on Mac after dmwork rebrand: residual
    // `~/.openclaw/extensions/openclaw-channel-dmwork/` from an earlier
    // stock install is auto-discovered after rebrand uninstall, listed
    // as `disabled` because cfg has no entry. Harmless (won't load).
    await setupOctoClawHub({
      pluginsListSupported: true,
      legacyDmworkInListDisabled: true,
    })();
    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("octo-clawhub");
    if (state.kind === "octo-clawhub") {
      expect(state.legacyDmworkResidue).toBe(false);
      expect(state.legacyNpmActive).toBe(false);
    }
  });

  it("octo-clawhub: VERY_LEGACY_PLUGIN_ID in plugins list as DISABLED → legacyDmworkResidue=false", async () => {
    await setupOctoClawHub({
      pluginsListSupported: true,
      veryLegacyDmworkInListDisabled: true,
    })();
    const { detectInstallState } = await loadModule();
    const state = detectInstallState();
    expect(state.kind).toBe("octo-clawhub");
    if (state.kind === "octo-clawhub") {
      expect(state.legacyDmworkResidue).toBe(false);
    }
  });
});

describe("getConfigFilePathSafe (Windows relative path)", () => {
  it("should resolve Windows relative path .\\.\\.openclaw\\openclaw.json to homedir", async () => {
    vi.resetModules();
    const mockExec = vi.fn();
    // openclaw config file returns Windows relative path
    mockExec.mockReturnValue(".\\.openclaw\\openclaw.json\n");
    vi.doMock("node:child_process", () => ({
      execFileSync: mockExec,
      execSync: vi.fn().mockImplementation(() => { throw new Error("not found"); }),
    }));
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(false),
      };
    });

    const { getConfigFilePathSafe } = await import("./openclaw-cli.js");
    const result = getConfigFilePathSafe();

    // Should NOT contain literal ~ or relative .\ — must be resolved to absolute
    expect(result).not.toContain("~");
    expect(result).not.toMatch(/^\.\\/);
    expect(result).toContain(".openclaw");
    expect(result).toContain("openclaw.json");
  });

  it("should keep absolute paths unchanged", async () => {
    vi.resetModules();
    const mockExec = vi.fn();
    mockExec.mockReturnValue("/home/user/.openclaw/openclaw.json\n");
    vi.doMock("node:child_process", () => ({
      execFileSync: mockExec,
      execSync: vi.fn().mockImplementation(() => { throw new Error("not found"); }),
    }));
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(false),
      };
    });

    const { getConfigFilePathSafe } = await import("./openclaw-cli.js");
    const result = getConfigFilePathSafe();

    // RESOLVED_CFG_PATH = path.resolve("/home/user/.openclaw/openclaw.json"),
    // which on POSIX returns the input unchanged but on Windows prefixes
    // a drive letter and converts to backslashes. Either way, the production
    // contract (already-absolute paths come back unchanged after normalize)
    // holds.
    expect(result).toBe(RESOLVED_CFG_PATH);
  });
});
