import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── runQuickstart error output tests ─────────────────────────────

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("./openclaw-cli.js", () => ({
  isHealthyInstall: vi.fn(() => true),
  readConfigFromFile: vi.fn(() => ({})),
  writeConfigAtomic: vi.fn(),
  getOpenClawBin: vi.fn(() => "openclaw"),
}));

vi.mock("./utils.js", () => ({
  PLUGIN_ID: "openclaw-channel-dmwork",
  RECOMMENDED_DM_SCOPE: "dmwork",
  ensureOpenClawCompat: vi.fn(),
}));

import { execFileSync } from "node:child_process";

const mockExecFileSync = vi.mocked(execFileSync);

function makeResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  } as Response;
}

async function loadAndRun(opts: { apiKey: string; apiUrl: string }) {
  vi.resetModules();

  vi.doMock("node:child_process", () => ({
    execFileSync: mockExecFileSync,
  }));
  vi.doMock("./openclaw-cli.js", () => ({
    isHealthyInstall: vi.fn(() => true),
    readConfigFromFile: vi.fn(() => ({})),
    writeConfigAtomic: vi.fn(),
    getOpenClawBin: vi.fn(() => "openclaw"),
  }));
  vi.doMock("./utils.js", () => ({
    PLUGIN_ID: "openclaw-channel-dmwork",
    RECOMMENDED_DM_SCOPE: "dmwork",
    ensureOpenClawCompat: vi.fn(),
  }));

  const mod = await import("./quickstart.js");
  return mod.runQuickstart(opts);
}

describe("runQuickstart", () => {
  let logs: string[];
  let errors: string[];
  let exitCode: number | undefined;
  const origLog = console.log;
  const origError = console.error;
  const origExit = process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    logs = [];
    errors = [];
    exitCode = undefined;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    console.error = (...args: any[]) => errors.push(args.join(" "));
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as any;

    mockExecFileSync.mockReturnValue('[{"id":"main","name":"main"}]');
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
    vi.restoreAllMocks();
  });

  it("creates bot with only name, uses response robot_id", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(makeResponse(200, JSON.stringify({
        robot_id: "27ba6or9NU_bot", bot_token: "bf_xxx", name: "main",
      })))
      .mockResolvedValue(makeResponse(200, JSON.stringify({ owner_uid: "u1" })));
    vi.stubGlobal("fetch", fetchMock);

    await loadAndRun({ apiKey: "uk_test", apiUrl: "http://api" });

    const createCall = fetchMock.mock.calls[0];
    const body = JSON.parse(createCall[1]?.body as string);
    expect(body.name).toBe("main");
    expect(body.username).toBeUndefined();

    const allOutput = [...logs, ...errors].join("\n");
    expect(allOutput).toContain("27ba6or9NU_bot");
    expect(exitCode).toBeUndefined();
  });

  it("401 API key error: prints HTTP status and response", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(makeResponse(401, "Unauthorized: invalid api key"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadAndRun({ apiKey: "uk_bad", apiUrl: "http://api" }))
      .rejects.toThrow("process.exit(1)");

    const allOutput = [...logs, ...errors].join("\n");
    expect(allOutput).toContain("HTTP 401");
    expect(allOutput).toContain("Unauthorized");
    expect(exitCode).toBe(1);
  });

  it("network error: prints error message", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadAndRun({ apiKey: "uk_test", apiUrl: "http://api" }))
      .rejects.toThrow("process.exit(1)");

    const allOutput = [...logs, ...errors].join("\n");
    expect(allOutput).toContain("ECONNREFUSED");
    expect(exitCode).toBe(1);
  });
});
