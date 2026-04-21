import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normalizeUsername } from "./quickstart.js";

// ── normalizeUsername unit tests ──────────────────────────────────

describe("normalizeUsername", () => {
  it("plain ascii id", () => {
    expect(normalizeUsername("main")).toBe("main_bot");
  });

  it("already has _bot suffix — no double suffix", () => {
    expect(normalizeUsername("main_bot")).toBe("main_bot");
  });

  it("mixed case normalized to lowercase", () => {
    expect(normalizeUsername("MyAgent")).toBe("myagent_bot");
  });

  it("hyphens and spaces stripped", () => {
    expect(normalizeUsername("My-Agent")).toBe("myagent_bot");
  });

  it("all CJK characters → fallback to agent", () => {
    expect(normalizeUsername("机器人")).toBe("agent_bot");
  });

  it("all symbols → fallback to agent", () => {
    expect(normalizeUsername("!!!")).toBe("agent_bot");
  });

  it("all underscores — kept, not empty", () => {
    expect(normalizeUsername("___")).toBe("____bot");
  });

  it("long id truncated to leave room for suffix", () => {
    const long = "a".repeat(30);
    const result = normalizeUsername(long);
    expect(result).toBe("a".repeat(17) + "_bot");
    expect(result.length).toBeLessThanOrEqual(21);
  });

  it("long id with _bot suffix — truncated correctly", () => {
    const long = "a".repeat(20) + "_bot";
    const result = normalizeUsername(long);
    expect(result.length).toBeLessThanOrEqual(21);
    expect(result.endsWith("_bot")).toBe(true);
  });

  it("leading/trailing whitespace trimmed", () => {
    expect(normalizeUsername("  agent  ")).toBe("agent_bot");
  });
});

// ── runQuickstart error output tests ─────────────────────────────

// Mock dependencies before importing runQuickstart
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

  // Re-apply mocks after resetModules
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

describe("runQuickstart error output", () => {
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

    // Default: agents list returns one agent "main"
    mockExecFileSync.mockReturnValue('[{"id":"main","name":"main"}]');
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
    vi.restoreAllMocks();
  });

  it("all 3 candidates 409: prints each conflict + final summary", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(makeResponse(409, "username occupied"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadAndRun({ apiKey: "uk_test", apiUrl: "http://api" }))
      .rejects.toThrow("process.exit(1)");

    const allOutput = [...logs, ...errors].join("\n");
    expect(allOutput).toContain("main_bot already occupied");
    expect(allOutput).toContain("main_2_bot already occupied");
    expect(allOutput).toContain("main_3_bot already occupied");
    expect(allOutput).toContain("all username variants conflicted");
    expect(allOutput).toContain("main_bot, main_2_bot, main_3_bot");
    expect(allOutput).toContain("Suggestion:");
    expect(exitCode).toBe(1);
  });

  it("first candidate 409, second succeeds: shows retry then success", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(makeResponse(409, "occupied"))
      .mockResolvedValueOnce(makeResponse(200, JSON.stringify({
        robot_id: "main_2_bot", bot_token: "bf_xxx", name: "main",
      })))
      // register + sendMessage for greeting
      .mockResolvedValue(makeResponse(200, JSON.stringify({ owner_uid: "u1" })));
    vi.stubGlobal("fetch", fetchMock);

    await loadAndRun({ apiKey: "uk_test", apiUrl: "http://api" });

    const allOutput = [...logs, ...errors].join("\n");
    expect(allOutput).toContain("main_bot already occupied");
    expect(allOutput).toContain("Created bot: main_2_bot");
    expect(exitCode).toBeUndefined(); // no exit(1)
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
    expect(allOutput).toContain("1 agent(s) failed");
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
    expect(allOutput).toContain("1 agent(s) failed");
    expect(exitCode).toBe(1);
  });
});
