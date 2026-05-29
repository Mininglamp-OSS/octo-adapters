/**
 * Package metadata lint: keeps `package.json` declarations in lockstep with
 * runtime constants in `cli/openclaw-cli.ts`.
 *
 * Why this exists: the install entry runs a hard version gate against
 * `OPENCLAW_PEER_MIN`. We also declare `peerDependencies.openclaw` so npm
 * can warn the user at install time (rather than only at first command
 * execution — see issue #96). If those two values silently drift apart,
 * one population gets a warning at install time and a different population
 * gets a hard abort later, which is confusing and hard to diagnose.
 *
 * This test fails fast if the manifest declaration doesn't match the
 * runtime constant.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OPENCLAW_PEER_MIN } from "./openclaw-cli.js";

const PKG_JSON_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json",
);
const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, "utf-8")) as {
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

describe("package.json peerDependencies.openclaw stays in sync with OPENCLAW_PEER_MIN", () => {
  it("declares an openclaw peer dependency", () => {
    expect(pkg.peerDependencies).toBeDefined();
    expect(pkg.peerDependencies?.openclaw).toBeDefined();
  });

  it("uses the exact `>=${OPENCLAW_PEER_MIN}` range", () => {
    // Single, machine-verifiable shape. If we ever need a more permissive
    // range (e.g. a beta window), update this test alongside the manifest.
    const expected = `>=${OPENCLAW_PEER_MIN}`;
    expect(pkg.peerDependencies?.openclaw).toBe(expected);
  });

  it("marks the openclaw peer as optional", () => {
    // Without `optional: true`, npm refuses install when openclaw is not
    // yet on PATH (a common state — users often install openclaw and the
    // adapter in either order). We want a warning, not a hard block, so
    // openclaw must stay opt-in.
    expect(pkg.peerDependenciesMeta?.openclaw?.optional).toBe(true);
  });
});
