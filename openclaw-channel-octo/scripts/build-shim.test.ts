/**
 * B.2 smoke test for shim package build.
 *
 * Verifies:
 *   1. scripts/build-shim.mjs runs cleanly with CI_COMMIT_TAG injection
 *   2. The output package.json templates {{VERSION}} into both `version` and
 *      `dependencies["openclaw-channel-octo"]` (exact pin)
 *   3. The bin entry exists and is executable Node ESM
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(import.meta.url), "..");
const pkgRoot = resolve(here, "..");
const buildScript = resolve(pkgRoot, "scripts/build-shim.mjs");

const tmp = mkdtempSync(join(tmpdir(), "shim-test-"));

beforeAll(() => {
  execFileSync("node", [buildScript, tmp], {
    env: { ...process.env, CI_COMMIT_TAG: "v9.9.9-test.0" },
    encoding: "utf8",
  });
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe("build-shim", () => {
  it("templates {{VERSION}} from CI_COMMIT_TAG (stripping leading v)", () => {
    const pkg = JSON.parse(readFileSync(join(tmp, "package.json"), "utf8"));
    expect(pkg.version).toBe("9.9.9-test.0");
    expect(pkg.dependencies["openclaw-channel-octo"]).toBe("9.9.9-test.0");
  });

  it("produces correct package metadata for npm publish", () => {
    const pkg = JSON.parse(readFileSync(join(tmp, "package.json"), "utf8"));
    expect(pkg.name).toBe("openclaw-channel-dmwork");
    expect(pkg.type).toBe("module");
    expect(pkg.bin).toEqual({ "openclaw-channel-dmwork": "bin/dmwork.js" });
    // The non-standard `deprecated` field in package.json is intentionally
    // omitted — npm ignores it. We use `npm deprecate <pkg>@<ver> "..."` as
    // a post-publish step in the workflow instead.
    expect(pkg.deprecated).toBeUndefined();
  });

  it("bin entry forwards to openclaw-channel-octo/cli main()", () => {
    const bin = readFileSync(join(tmp, "bin/dmwork.js"), "utf8");
    expect(bin.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(bin).toMatch(/await import\(["']openclaw-channel-octo\/cli["']\)/);
    expect(bin).toMatch(/main\(\)/);
    // Deprecation notice goes to stderr
    expect(bin).toMatch(/deprecated/i);
  });

  it("does NOT include openclaw.plugin.json or dist/ — shim is a pure CLI forwarder", () => {
    expect(existsSync(join(tmp, "openclaw.plugin.json"))).toBe(false);
    expect(existsSync(join(tmp, "dist"))).toBe(false);
    // skills are also not part of the shim
    expect(existsSync(join(tmp, "skills"))).toBe(false);
  });
});
