import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  composePersonaHint,
  getPersonaPromptForSession,
  initPersonaPromptCache,
  refreshPersonaPromptCache,
  setPersonaPromptRefreshIntervalMs,
  stopPersonaPromptCache,
  _resetPersonaPromptCacheForTests,
} from "./persona-prompt.js";
import type { BotOboGrant } from "./api-fetch.js";

const originalFetch = global.fetch;

function mockFetchOnce(body: unknown, init: Partial<{ status: number; ok: boolean }> = {}) {
  const status = init.status ?? 200;
  const ok = init.ok ?? status < 400;
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Err",
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  _resetPersonaPromptCacheForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  _resetPersonaPromptCacheForTests();
  global.fetch = originalFetch;
});

describe("composePersonaHint", () => {
  const baseGrant: BotOboGrant = {
    has_grant: true,
    grantor_uid: "u_admin",
    grantor_name: "Admin",
    persona_prompt: "Reply concisely.",
    active: true,
  };

  it("composes a hint matching the buildFanoutCopyReq-style prefix", () => {
    const hint = composePersonaHint(baseGrant);
    expect(hint).toBe(
      `你正在以「Admin」的分身身份运作。请以 Admin 的身份回复。\n\nReply concisely.`,
    );
  });

  it("falls back to grantor_uid when grantor_name is missing", () => {
    const hint = composePersonaHint({ ...baseGrant, grantor_name: "" });
    expect(hint).toContain("「u_admin」");
    expect(hint).toContain("请以 u_admin 的身份");
  });

  it("returns undefined when persona_prompt is empty / whitespace", () => {
    expect(composePersonaHint({ ...baseGrant, persona_prompt: "" })).toBeUndefined();
    expect(composePersonaHint({ ...baseGrant, persona_prompt: "   " })).toBeUndefined();
  });

  it("returns undefined when grant is inactive", () => {
    expect(composePersonaHint({ ...baseGrant, active: false })).toBeUndefined();
  });

  it("returns undefined when has_grant is false", () => {
    expect(composePersonaHint({ has_grant: false })).toBeUndefined();
  });

  it("returns undefined when both grantor_name and grantor_uid are missing", () => {
    expect(
      composePersonaHint({
        has_grant: true,
        persona_prompt: "p",
        active: true,
      }),
    ).toBeUndefined();
  });
});

describe("refreshPersonaPromptCache + getPersonaPromptForSession", () => {
  it("populates the cache from a 200 response", async () => {
    mockFetchOnce({
      has_grant: true,
      grantor_uid: "u_admin",
      grantor_name: "Admin",
      persona_prompt: "Be brief.",
      active: true,
    });

    await refreshPersonaPromptCache({
      accountId: "bot_a",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    });

    const hint = getPersonaPromptForSession("bot_a");
    expect(hint).toContain("「Admin」");
    expect(hint).toContain("Be brief.");
  });

  it("clears the cached hint when the server returns has_grant=false", async () => {
    mockFetchOnce({
      has_grant: true,
      grantor_uid: "u_admin",
      grantor_name: "Admin",
      persona_prompt: "old",
      active: true,
    });
    const account = {
      accountId: "bot_b",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    };
    await refreshPersonaPromptCache(account);
    expect(getPersonaPromptForSession("bot_b")).toBeDefined();

    mockFetchOnce({ has_grant: false });
    await refreshPersonaPromptCache(account);
    expect(getPersonaPromptForSession("bot_b")).toBeUndefined();
  });

  it("treats 404 as no grant (cache cleared, no throw)", async () => {
    mockFetchOnce({}, { status: 404, ok: false });
    await refreshPersonaPromptCache({
      accountId: "bot_c",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    });
    expect(getPersonaPromptForSession("bot_c")).toBeUndefined();
  });

  it("is a no-op when onBehalfOf is undefined", async () => {
    const fetchSpy = mockFetchOnce({ has_grant: true });
    await refreshPersonaPromptCache({
      accountId: "bot_regular",
      apiUrl: "http://api",
      botToken: "bf_x",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getPersonaPromptForSession("bot_regular")).toBeUndefined();
  });

  it("swallows 5xx errors and keeps the previous cached hint", async () => {
    mockFetchOnce({
      has_grant: true,
      grantor_uid: "u_admin",
      grantor_name: "Admin",
      persona_prompt: "stable",
      active: true,
    });
    const account = {
      accountId: "bot_d",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    };
    await refreshPersonaPromptCache(account);
    const before = getPersonaPromptForSession("bot_d");
    expect(before).toBeDefined();

    // Second call: server hiccups. Old cache must remain intact and we
    // must not throw — message processing depends on this.
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await expect(refreshPersonaPromptCache(account, log)).resolves.toBeUndefined();
    expect(getPersonaPromptForSession("bot_d")).toBe(before);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("sends Authorization: Bearer <botToken> to /v1/bot/obo-grant", async () => {
    const fetchSpy = mockFetchOnce({ has_grant: false });
    await refreshPersonaPromptCache({
      accountId: "bot_e",
      apiUrl: "http://api/",
      botToken: "bf_secret",
      onBehalfOf: "u_admin",
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://api/v1/bot/obo-grant");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer bf_secret",
    );
  });
});

describe("initPersonaPromptCache (timer behavior)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setPersonaPromptRefreshIntervalMs(1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("performs an initial fetch + periodic refreshes at the configured interval", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        has_grant: true,
        grantor_uid: "u_admin",
        grantor_name: "Admin",
        persona_prompt: "p",
        active: true,
      }),
      text: async () => "",
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    initPersonaPromptCache({
      accountId: "bot_t",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    });

    // initial fetch is scheduled microtask; flush it
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    stopPersonaPromptCache("bot_t");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("does NOT start a timer when onBehalfOf is undefined", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    initPersonaPromptCache({
      accountId: "bot_plain",
      apiUrl: "http://api",
      botToken: "bf_x",
    });

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("replaces an existing timer on repeated init (no leak)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ has_grant: false }),
      text: async () => "",
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    initPersonaPromptCache({
      accountId: "bot_repeat",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    // Re-init — should clear old timer and schedule a fresh one.
    initPersonaPromptCache({
      accountId: "bot_repeat",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(1000);
    // Only one timer should now be active — exactly one extra call, not two.
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    stopPersonaPromptCache("bot_repeat");
  });
});
