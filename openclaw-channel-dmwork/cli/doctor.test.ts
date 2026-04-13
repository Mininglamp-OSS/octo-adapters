import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  type ConfigReader,
  runDoctorChecks,
  formatDoctorResult,
} from "./doctor.js";

/** Stub config reader that returns values from a plain object. */
function stubReader(data: Record<string, any>): ConfigReader {
  return {
    get(path: string): string | null {
      const parts = path.split(".");
      let cur: any = data;
      for (const p of parts) {
        if (cur == null || typeof cur !== "object") return null;
        cur = cur[p];
      }
      return cur == null ? null : String(cur);
    },
    getJson(path: string): any {
      const parts = path.split(".");
      let cur: any = data;
      for (const p of parts) {
        if (cur == null || typeof cur !== "object") return null;
        cur = cur[p];
      }
      return cur ?? null;
    },
  };
}

describe("doctor checks (in-process mode)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should PASS when accounts are configured with valid token", async () => {
    const reader = stubReader({
      channels: {
        dmwork: {
          apiUrl: "http://localhost:8090",
          accounts: {
            my_bot: {
              botToken: "bf_test123",
              apiUrl: "http://localhost:8090",
            },
          },
        },
      },
      session: { dmScope: "per-account-channel-peer" },
    });

    // Mock fetch for API probe
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

    const result = await runDoctorChecks({
      reader,
      inProcess: true,
    });

    globalThis.fetch = origFetch;

    const accountCheck = result.checks.find((c) => c.name === "Accounts configured");
    expect(accountCheck?.status).toBe("PASS");

    const tokenCheck = result.checks.find((c) => c.name === "my_bot: botToken");
    expect(tokenCheck?.status).toBe("PASS");

    const scopeCheck = result.checks.find((c) => c.name === "session.dmScope");
    expect(scopeCheck?.status).toBe("PASS");
  });

  it("should WARN when botToken does not start with bf_ in-process", async () => {
    const reader = stubReader({
      channels: {
        dmwork: {
          accounts: {
            bad_bot: { botToken: "invalid_token", apiUrl: "http://localhost" },
          },
        },
      },
      session: { dmScope: "per-account-channel-peer" },
    });

    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

    const result = await runDoctorChecks({ reader, inProcess: true });

    globalThis.fetch = vi.fn() as any;

    const tokenCheck = result.checks.find((c) => c.name === "bad_bot: botToken format");
    expect(tokenCheck?.status).toBe("WARN");
  });

  it("should fallback to legacy flat config when no accounts", async () => {
    const reader = stubReader({
      channels: {
        dmwork: {
          botToken: "bf_legacy",
          apiUrl: "http://localhost:8090",
        },
      },
      session: {},
    });

    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

    const result = await runDoctorChecks({ reader, inProcess: true });

    globalThis.fetch = vi.fn() as any;

    const accountCheck = result.checks.find((c) => c.name === "Accounts configured");
    expect(accountCheck?.status).toBe("PASS");
    expect(accountCheck?.detail).toContain("Legacy");
  });

  it("should FAIL when no accounts and no legacy botToken", async () => {
    const reader = stubReader({
      channels: { dmwork: {} },
      session: {},
    });

    const result = await runDoctorChecks({ reader, inProcess: true });

    const accountCheck = result.checks.find((c) => c.name === "Accounts configured");
    expect(accountCheck?.status).toBe("FAIL");
    expect(result.errors).toBeGreaterThan(0);
  });

  it("should WARN when dmScope is not the recommended value", async () => {
    const reader = stubReader({
      channels: {
        dmwork: {
          accounts: { bot1: { botToken: "bf_test", apiUrl: "http://localhost" } },
        },
      },
      session: { dmScope: "per-channel" },
    });

    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

    const result = await runDoctorChecks({ reader, inProcess: true });

    globalThis.fetch = vi.fn() as any;

    const scopeCheck = result.checks.find((c) => c.name === "session.dmScope");
    expect(scopeCheck?.status).toBe("WARN");
    expect(scopeCheck?.detail).toContain("per-channel");
  });

  it("should only check specified account when accountId is given", async () => {
    const reader = stubReader({
      channels: {
        dmwork: {
          accounts: {
            bot_a: { botToken: "bf_aaa", apiUrl: "http://localhost" },
            bot_b: { botToken: "bf_bbb", apiUrl: "http://localhost" },
          },
        },
      },
      session: { dmScope: "per-account-channel-peer" },
    });

    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

    const result = await runDoctorChecks({
      reader,
      accountId: "bot_a",
      inProcess: true,
    });

    globalThis.fetch = vi.fn() as any;

    const tokenChecks = result.checks.filter((c) => c.name.includes("botToken"));
    expect(tokenChecks).toHaveLength(1);
    expect(tokenChecks[0].name).toContain("bot_a");
  });
});

describe("formatDoctorResult", () => {
  it("should format checks into readable text", () => {
    const text = formatDoctorResult({
      checks: [
        { name: "Plugin installed", status: "PASS", detail: "v0.5.19" },
        { name: "Gateway running", status: "FAIL", detail: "Not running" },
      ],
      errors: 1,
      warnings: 0,
      fixed: 0,
    });

    expect(text).toContain("[PASS]");
    expect(text).toContain("Plugin installed");
    expect(text).toContain("[FAIL]");
    expect(text).toContain("Gateway running");
    expect(text).toContain("1 error(s)");
  });
});
