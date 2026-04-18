/**
 * CLI utilities: version checking, accountId validation, readline prompts.
 */

import { createInterface } from "node:readline";
import { getOpenClawVersion } from "./openclaw-cli.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PLUGIN_ID = "openclaw-channel-dmwork";
export const MIN_OPENCLAW_VERSION = "2026.4.15";
export const RECOMMENDED_DM_SCOPE = "per-account-channel-peer";

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/** Compare two semver-like version strings. Returns -1, 0, or 1. */
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
  const version = getOpenClawVersion();
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
