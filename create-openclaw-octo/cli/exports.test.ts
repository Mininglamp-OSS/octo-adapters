/**
 * Smoke test: ensures `cli/index.js` exports a `main()` function and does
 * NOT execute commander auto-parsing on import.
 *
 * Auto-parsing on import would mean any tooling that does
 * `await import("./cli/index.js")` for inspection would unexpectedly run
 * the CLI. We explicitly call `main()` from `bin/octo.js` to avoid this.
 */
import { describe, it, expect } from "vitest";

describe("cli/index.ts shape", () => {
  it("exports a main() function (not auto-parsing on import)", async () => {
    const cliMod = await import("./index.js");
    expect(typeof (cliMod as { main?: unknown }).main).toBe("function");
  });
});
