import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockCopyFileSync = vi.mocked(copyFileSync);

async function loadModule() {
  vi.resetModules();
  return await import("./openclaw-cli.js");
}

const SAMPLE_CONFIG = {
  channels: {
    dmwork: {
      apiUrl: "http://localhost:8090",
      accounts: {
        my_bot: { botToken: "bf_real_secret_token", apiUrl: "http://localhost:8090" },
        other_bot: { botToken: "bf_other_secret", apiUrl: "http://other:8090" },
      },
    },
  },
};

describe("saveChannelConfigFromFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should read channels.dmwork with real secrets from file", async () => {
    const { saveChannelConfigFromFile } = await loadModule();
    mockExecFileSync.mockReturnValue("/home/user/.openclaw/openclaw.json");
    mockReadFileSync.mockReturnValue(JSON.stringify(SAMPLE_CONFIG));

    const saved = saveChannelConfigFromFile();

    expect(saved).not.toBeNull();
    expect((saved as any).accounts.my_bot.botToken).toBe("bf_real_secret_token");
    expect((saved as any).accounts.other_bot.botToken).toBe("bf_other_secret");
  });

  it("should return null when channels.dmwork does not exist", async () => {
    const { saveChannelConfigFromFile } = await loadModule();
    mockExecFileSync.mockReturnValue("/home/user/.openclaw/openclaw.json");
    mockReadFileSync.mockReturnValue(JSON.stringify({ channels: {} }));

    expect(saveChannelConfigFromFile()).toBeNull();
  });

  it("should return null when file read fails", async () => {
    const { saveChannelConfigFromFile } = await loadModule();
    mockExecFileSync.mockReturnValue("/home/user/.openclaw/openclaw.json");
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT"); });

    expect(saveChannelConfigFromFile()).toBeNull();
  });
});

describe("restoreChannelConfigToFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should write channels.dmwork back to file with backup", async () => {
    const { restoreChannelConfigToFile } = await loadModule();
    mockExecFileSync.mockReturnValue("/home/user/.openclaw/openclaw.json");
    mockReadFileSync.mockReturnValue(JSON.stringify({ channels: {}, plugins: {} }));

    const dmworkConfig = SAMPLE_CONFIG.channels.dmwork;
    restoreChannelConfigToFile(dmworkConfig as any);

    // Should create backup
    expect(mockCopyFileSync).toHaveBeenCalledWith(
      "/home/user/.openclaw/openclaw.json",
      "/home/user/.openclaw/openclaw.json.bak",
    );

    // Should write merged config
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(writtenContent.channels.dmwork.accounts.my_bot.botToken).toBe("bf_real_secret_token");
    // Should preserve other config sections
    expect(writtenContent.plugins).toEqual({});
  });
});

describe("config preserve on install --force failure", () => {
  it("should restore config even when pluginsInstall throws", async () => {
    const mod = await loadModule();

    // getConfigFilePath returns path
    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === "config" && argsArr[1] === "file") {
        return "/home/user/.openclaw/openclaw.json";
      }
      if (argsArr[0] === "plugins" && argsArr[1] === "install") {
        throw new Error("network error during install");
      }
      return "";
    });

    // saveChannelConfigFromFile reads file
    mockReadFileSync.mockReturnValue(JSON.stringify(SAMPLE_CONFIG));

    const saved = mod.saveChannelConfigFromFile();
    expect(saved).not.toBeNull();

    // Simulate install --force with try/finally
    let installFailed = false;
    try {
      mod.pluginsInstall("test-plugin", true);
    } catch {
      installFailed = true;
    } finally {
      if (saved) {
        // Reset read mock for restore
        mockReadFileSync.mockReturnValue(JSON.stringify({ channels: {} }));
        mod.restoreChannelConfigToFile(saved);
      }
    }

    expect(installFailed).toBe(true);
    // Config should have been written back
    expect(mockWriteFileSync).toHaveBeenCalled();
    const restored = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(restored.channels.dmwork.accounts.my_bot.botToken).toBe("bf_real_secret_token");
  });
});

describe("config preserve on uninstall failure", () => {
  it("should restore config even when pluginsUninstall throws", async () => {
    const mod = await loadModule();

    mockExecFileSync.mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (argsArr[0] === "config" && argsArr[1] === "file") {
        return "/home/user/.openclaw/openclaw.json";
      }
      if (argsArr[0] === "plugins" && argsArr[1] === "uninstall") {
        throw new Error("uninstall partially failed");
      }
      return "";
    });

    mockReadFileSync.mockReturnValue(JSON.stringify(SAMPLE_CONFIG));

    const saved = mod.saveChannelConfigFromFile();
    expect(saved).not.toBeNull();

    let uninstallFailed = false;
    try {
      mod.pluginsUninstall("test-plugin", true);
    } catch {
      uninstallFailed = true;
    } finally {
      if (saved) {
        mockReadFileSync.mockReturnValue(JSON.stringify({ channels: {} }));
        mod.restoreChannelConfigToFile(saved);
      }
    }

    expect(uninstallFailed).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalled();
    const restored = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(restored.channels.dmwork.accounts.my_bot.botToken).toBe("bf_real_secret_token");
  });
});
