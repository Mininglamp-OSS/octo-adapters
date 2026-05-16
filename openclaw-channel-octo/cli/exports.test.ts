/**
 * Smoke test: ensures `import("openclaw-channel-octo/cli")` resolves
 * correctly via the exports["./cli"] subpath.
 *
 * This subpath is public API — external tooling and scripts may import
 * the CLI programmatically. If this test fails, consumers that rely on
 * the ./cli subpath (e.g. `await import("openclaw-channel-octo/cli")`)
 * would get ERR_PACKAGE_PATH_NOT_EXPORTED at runtime.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, "../package.json");

describe("package exports", () => {
  it("exposes ./cli as a subpath export", () => {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    expect(pkg.exports).toBeDefined();
    expect(pkg.exports["./cli"]).toBeDefined();
    expect(pkg.exports["./cli"].import).toBe("./dist/cli/index.js");
  });

  it("cli/index.ts exports a main() function (not auto-parsing on import)", async () => {
    const cliMod = await import("./index.js");
    expect(typeof (cliMod as { main?: unknown }).main).toBe("function");
  });
});
