/**
 * B.0 smoke test: ensures `import("openclaw-channel-octo/cli")` works
 * for the shim package's bin entry. Without exports["./cli"] this would
 * throw ERR_PACKAGE_PATH_NOT_EXPORTED.
 *
 * The shim package (Phase B.2) does:
 *   const { main } = await import("openclaw-channel-octo/cli");
 *   main();
 *
 * If this test fails, the shim cannot forward CLI invocations.
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
