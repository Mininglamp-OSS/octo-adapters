/**
 * CLI utilities: version checking, accountId validation, readline prompts,
 * and string `channels.<id>.<...>` config-path helpers.
 *
 * Pure constants and runtime-safe helpers live in `src/constants.ts` and are
 * re-exported from here for convenience to CLI code. Runtime code (`src/*`)
 * should import directly from `src/constants.ts` and never from this file.
 */

import { createInterface } from "node:readline";
import { getOpenClawVersion, getOpenClawVersionStrict } from "./openclaw-cli.js";
import {
  PLUGIN_ID, CHANNEL_ID,
  LEGACY_PLUGIN_ID, LEGACY_CHANNEL_ID, VERY_LEGACY_PLUGIN_ID,
  stripChannelPrefix,
  getChannelConfig, getChannelConfigFor,
  ensureChannelConfigObject,
} from "../src/constants.js";

// ---------------------------------------------------------------------------
// Re-exports from src/constants.ts (so existing CLI imports keep working)
// ---------------------------------------------------------------------------

export {
  PLUGIN_ID, CHANNEL_ID,
  LEGACY_PLUGIN_ID, LEGACY_CHANNEL_ID, VERY_LEGACY_PLUGIN_ID,
  stripChannelPrefix,
  getChannelConfig, getChannelConfigFor,
  ensureChannelConfigObject,
};

// ---------------------------------------------------------------------------
// CLI-only constants
// ---------------------------------------------------------------------------

export const MIN_OPENCLAW_VERSION = "2026.4.15";
export const RECOMMENDED_DM_SCOPE = "per-account-channel-peer";

// ---------------------------------------------------------------------------
// Channel config-path helpers (string form, for configGet/configSet)
// ---------------------------------------------------------------------------

/** Build `channels.<CHANNEL_ID>.<...parts>` (current channel, default). */
export function channelConfigPath(...parts: string[]): string {
  return ["channels", CHANNEL_ID, ...parts].join(".");
}

/** Migration-only: build `channels.<channelId>.<...parts>` explicitly. */
// LEGACY-COMPAT: explicit channelId variant for migration code
export function channelConfigPathFor(channelId: string, ...parts: string[]): string {
  return ["channels", channelId, ...parts].join(".");
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/**
 * Compare two semver-like version strings. Returns -1, 0, or 1.
 *
 * Intentionally date-only: assumes inputs of the shape `2026.4.15` (matching
 * OpenClaw's `YYYY.M.PATCH` versioning). Prerelease suffixes (`2026.4.15-rc.1`)
 * would Number()-cast to NaN and break ordering. If MIN_OPENCLAW_VERSION ever
 * needs prerelease handling, switch this to `semver.compare`.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Check that openclaw is available. Exits if not found.
 * Warns (but continues) if version is below recommended minimum.
 */
export function ensureOpenClawCompat(): void {
  let version: string | null = null;
  try {
    version = getOpenClawVersionStrict();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (!version) {
    console.error(
      "Error: openclaw not found. Install it first: npm i -g openclaw",
    );
    process.exit(1);
  }
  if (compareVersions(version, MIN_OPENCLAW_VERSION) < 0) {
    console.warn(
      `Warning: OpenClaw ${version} is older than recommended ${MIN_OPENCLAW_VERSION}. Some features may not work correctly. Consider upgrading.`,
    );
  }
}

// ---------------------------------------------------------------------------
// accountId validation
// ---------------------------------------------------------------------------

const ACCOUNT_ID_RE = /^[A-Za-z0-9_]+$/;

export function validateAccountId(id: string): boolean {
  return ACCOUNT_ID_RE.test(id);
}

// ---------------------------------------------------------------------------
// Interactive detection
// ---------------------------------------------------------------------------

/** Returns true if stdin is a TTY (interactive terminal). */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}

// ---------------------------------------------------------------------------
// readline prompts (fail in non-TTY)
// ---------------------------------------------------------------------------

function createRL() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

/** Ask a yes/no question. Returns true for yes. In non-TTY, returns defaultYes. */
export async function confirm(
  question: string,
  defaultYes = false,
): Promise<boolean> {
  if (!isInteractive()) return defaultYes;
  const suffix = defaultYes ? "(Y/n)" : "(y/N)";
  const rl = createRL();
  return new Promise<boolean>((resolve) => {
    rl.question(`${question} ${suffix} `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") resolve(defaultYes);
      else resolve(trimmed === "y" || trimmed === "yes");
    });
  });
}

/**
 * Prompt for a text value. In non-TTY, exits with error.
 * Use requireParam() instead when possible.
 */
export async function prompt(question: string): Promise<string> {
  if (!isInteractive()) {
    console.error(
      `Error: Missing required input in non-interactive mode. Pass the value via command-line arguments.`,
    );
    process.exit(1);
  }
  const rl = createRL();
  return new Promise<string>((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
