import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requiresClawHubProtocol, validateAccountId } from "./utils.js";

describe("validateAccountId", () => {
  it("should accept valid IDs", () => {
    expect(validateAccountId("my_bot")).toBe(true);
    expect(validateAccountId("Bot123")).toBe(true);
    expect(validateAccountId("a")).toBe(true);
    expect(validateAccountId("test_bot_2")).toBe(true);
  });

  it("should reject invalid IDs", () => {
    expect(validateAccountId("")).toBe(false);
    expect(validateAccountId("my-bot")).toBe(false);
    expect(validateAccountId("my bot")).toBe(false);
    expect(validateAccountId("bot.name")).toBe(false);
    expect(validateAccountId("bot/name")).toBe(false);
    expect(validateAccountId("bot@name")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requiresClawHubProtocol() — install spec → version-gate intent
//
// Regression coverage for PR #91 review feedback: the prior implementation
// derived the gate from `!opts.from` alone, which let `install --from
// clawhub:octo` bypass the hard floor on pre-2026.3.22 OpenClaw and fail
// partway through migration — the exact failure mode this PR is meant to
// prevent.
// ---------------------------------------------------------------------------

describe("requiresClawHubProtocol", () => {
  it("returns true for the default install path (no --from)", () => {
    expect(requiresClawHubProtocol()).toBe(true);
    expect(requiresClawHubProtocol(undefined)).toBe(true);
  });

  it("returns true for any explicit clawhub: spec via --from", () => {
    expect(requiresClawHubProtocol("clawhub:octo")).toBe(true);
    expect(requiresClawHubProtocol("clawhub:openclaw-channel-octo")).toBe(true);
    expect(requiresClawHubProtocol("clawhub:openclaw-channel-octo@1.0.13")).toBe(true);
  });

  it("returns false for local tarball paths", () => {
    expect(requiresClawHubProtocol("/tmp/octo-1.0.13.tgz")).toBe(false);
    expect(requiresClawHubProtocol("./local-tarball.tgz")).toBe(false);
    expect(requiresClawHubProtocol("../path/to/octo.tgz")).toBe(false);
  });

  it("returns false for file:// URLs", () => {
    expect(requiresClawHubProtocol("file:///abs/path.tgz")).toBe(false);
  });

  it("returns false for bare npm package names", () => {
    expect(requiresClawHubProtocol("openclaw-channel-octo")).toBe(false);
    expect(requiresClawHubProtocol("openclaw-channel-octo@1.0.13")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ensureOpenClawCompat() — version gate
//
// Regression coverage for issue #90: the previous soft-warn-only
// implementation let install proceed past 4 steps of config mutation and die
// at step 5 with a raw stack trace on truly incompatible OpenClaw versions
// (e.g. < 2026.3.22, where the `clawhub:` protocol does not exist).
// We now delegate to detectOpenClawState() and hard-abort on `kind: "block"`.
// ---------------------------------------------------------------------------

describe("ensureOpenClawCompat", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let detectSpy: any;

  beforeEach(() => {
    vi.resetModules();
    // Replace process.exit with a thrower so the hard-abort path stops
    // execution without ending the test process. Keep call count assertable.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code ?? 0}`);
    }) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    detectSpy?.mockRestore?.();
  });

  async function loadWithDetect(state: { kind: "ok" | "warn" | "block"; version: string | null; reason?: string }) {
    const cliMod = await import("./openclaw-cli.js");
    detectSpy = vi.spyOn(cliMod, "detectOpenClawState").mockReturnValue(state as any);
    return await import("./utils.js");
  }

  it("blocks with friendly upgrade guidance when openclaw is too old AND caller requires clawhub: protocol", async () => {
    const { ensureOpenClawCompat } = await loadWithDetect({
      kind: "block",
      version: "2026.3.13",
      reason: "OpenClaw 2026.3.13 is too old (need >= 2026.3.22)",
    });
    expect(() => ensureOpenClawCompat({ requireClawHubProtocol: true })).toThrow(/__exit__:2/);
    const message = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(message).toMatch(/2026\.3\.13 is too old/);
    expect(message).toMatch(/openclaw update/);
    expect(message).toMatch(/Required:.*2026\.3\.22/);
    expect(message).toMatch(/Recommended:.*2026\.5\.22/);
  });

  it("warns (does not block) when openclaw is too old AND caller does not require clawhub: protocol", async () => {
    // Regression for codex review MAJOR #2: ensureOpenClawCompat() was
    // unconditionally hard-aborting on < OPENCLAW_PEER_MIN, breaking
    // uninstall and `install --from <local-tarball>` paths that don't
    // need the `clawhub:` protocol.
    const { ensureOpenClawCompat } = await loadWithDetect({
      kind: "block",
      version: "2026.3.13",
      reason: "OpenClaw 2026.3.13 is too old (need >= 2026.3.22)",
    });
    ensureOpenClawCompat(); // default: requireClawHubProtocol = false
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    const warning = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warning).toMatch(/2026\.3\.13 is too old/);
    expect(warning).toMatch(/clawhub:.*unavailable/);
    expect(warning).toMatch(/--from.*available/);
  });

  it("blocks with install guidance when openclaw is missing (regardless of requireClawHubProtocol)", async () => {
    const { ensureOpenClawCompat } = await loadWithDetect({
      kind: "block",
      version: null,
      reason: "OpenClaw is not installed or not on PATH",
    });
    expect(() => ensureOpenClawCompat()).toThrow(/__exit__:1/);
    const message = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(message).toMatch(/openclaw not found/);
    expect(message).toMatch(/npm i -g openclaw/);
  });

  it("blocks with install guidance when openclaw is missing even when not requiring clawhub:", async () => {
    const { ensureOpenClawCompat } = await loadWithDetect({
      kind: "block",
      version: null,
      reason: "OpenClaw is not installed or not on PATH",
    });
    expect(() => ensureOpenClawCompat({ requireClawHubProtocol: false })).toThrow(/__exit__:1/);
  });

  it("warns but does not exit when below recommended floor", async () => {
    const { ensureOpenClawCompat } = await loadWithDetect({
      kind: "warn",
      version: "2026.4.23",
      reason: "OpenClaw 2026.4.23 is older than recommended 2026.5.22",
    });
    ensureOpenClawCompat({ requireClawHubProtocol: true });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    const warning = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warning).toMatch(/older than recommended/);
    expect(warning).toMatch(/openclaw update/);
  });

  it("is silent when version meets recommended floor", async () => {
    const { ensureOpenClawCompat } = await loadWithDetect({
      kind: "ok",
      version: "2026.5.27",
    });
    ensureOpenClawCompat({ requireClawHubProtocol: true });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
