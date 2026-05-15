#!/usr/bin/env node
/**
 * Build the openclaw-channel-dmwork shim package from shim-stub/.
 *
 * Reads the canonical version from one of (in priority order):
 *   1. CI_COMMIT_TAG env var (GitLab CI tag pipelines, e.g. "v1.0.0-rc.1")
 *   2. SHIM_VERSION env var (manual override, e.g. "1.0.0-rc.1")
 *   3. ../package.json version field (local dev / fallback)
 *
 * Substitutes {{VERSION}} in shim-stub/package.json with the resolved version
 * and writes the assembled shim package to <outDir> (default: /tmp/shim-build).
 *
 * Usage:
 *   node scripts/build-shim.mjs [outDir]
 */
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const stubDir = resolve(pkgRoot, "shim-stub");
const canonicalPkgPath = resolve(pkgRoot, "package.json");

const outDir = resolve(process.argv[2] ?? "/tmp/shim-build");

function resolveVersion() {
  if (process.env.CI_COMMIT_TAG) {
    // strip leading "v" if present
    return process.env.CI_COMMIT_TAG.replace(/^v/, "");
  }
  if (process.env.SHIM_VERSION) {
    return process.env.SHIM_VERSION;
  }
  const canonical = JSON.parse(readFileSync(canonicalPkgPath, "utf8"));
  return canonical.version;
}

function copyDirRecursive(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

function main() {
  if (!existsSync(stubDir)) {
    console.error(`shim-stub directory not found: ${stubDir}`);
    process.exit(1);
  }

  const version = resolveVersion();
  console.log(`[build-shim] resolved version: ${version}`);
  console.log(`[build-shim] outDir: ${outDir}`);

  // Clean output dir
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // Copy stub tree (everything except package.json which we templatize)
  copyDirRecursive(stubDir, outDir);

  // Template the package.json
  const stubPkgPath = join(stubDir, "package.json");
  let pkgText = readFileSync(stubPkgPath, "utf8");
  pkgText = pkgText.replace(/\{\{VERSION\}\}/g, version);
  writeFileSync(join(outDir, "package.json"), pkgText, "utf8");

  console.log(`[build-shim] shim package assembled at ${outDir}`);
  console.log(`[build-shim] next: cd ${outDir} && npm publish --access public`);
}

main();
