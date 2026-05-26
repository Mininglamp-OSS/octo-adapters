/**
 * CLI utilities: version checking, accountId validation, readline prompts,
 * and string `channels.<id>.<...>` config-path helpers.
 *
 * Pure constants and runtime-safe helpers live in `./constants.ts` and are
 * re-exported from here for convenience to CLI code.
 */

import { createInterface } from "node:readline";
import { getOpenClawVersion, getOpenClawVersionStrict, detectInstallState, detectOpenClawState } from "./openclaw-cli.js";
import {
  PLUGIN_ID, CHANNEL_ID,
  NPM_PACKAGE_NAME, CLAWHUB_INSTALL_SPEC,
  LEGACY_PLUGIN_ID, LEGACY_CHANNEL_ID, VERY_LEGACY_PLUGIN_ID,
  stripChannelPrefix,
  getChannelConfig, getChannelConfigFor,
  ensureChannelConfigObject,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Re-exports from ./constants.ts (so existing CLI imports keep working)
// ---------------------------------------------------------------------------

export {
  PLUGIN_ID, CHANNEL_ID,
  NPM_PACKAGE_NAME, CLAWHUB_INSTALL_SPEC,
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

// ---------------------------------------------------------------------------
// Upgrade notice (boxed)
// ---------------------------------------------------------------------------

/**
 * Render a left-anchored "open-right" notice box for upgrade/error prompts.
 * Intentionally minimal: no feature lists, no marketing — just (1) status,
 * (2) one-line context, (3) the command, (4) optional follow-up.
 *
 * Always written to stderr. The caller decides whether to exit afterwards.
 */
export interface UpgradeNoticeOpts {
  /** "block" prints ✗; "warn" prints ⚠. */
  status: "block" | "warn";
  /** Short one-line headline, e.g. "Outdated octo plugin detected: ... 1.0.0". */
  title: string;
  /** Optional one-line context above the command, e.g. "This version is no longer supported. Please upgrade:". */
  body?: string;
  /** The shell command the user should run to fix the situation. */
  command: string;
  /** Optional one-line message after the command, e.g. "Re-run your command after the upgrade completes.". */
  followup?: string;
}

export function printUpgradeNotice(opts: UpgradeNoticeOpts): void {
  const symbol = opts.status === "block" ? "✗" : "⚠";
  const horizontal = "─".repeat(62);
  const out = (s: string) => console.error(s);

  out("");
  out(`┌${horizontal}`);
  out(`│ ${symbol} ${opts.title}`);
  if (opts.body) {
    out(`│`);
    out(`│ ${opts.body}`);
  }
  out(`│`);
  out(`│   ${opts.command}`);
  if (opts.followup) {
    out(`│`);
    out(`│ ${opts.followup}`);
  }
  out(`└${horizontal}`);
  out("");
}

// ---------------------------------------------------------------------------
// Plan A: pre-flight enforce (shared by bind / quickstart / remove-account)
// ---------------------------------------------------------------------------

/**
 * Block the caller unless we have a healthy ClawHub octo install AND a
 * recent-enough OpenClaw runtime. Prints the appropriate upgrade notice
 * to stderr and exits with code 1 otherwise.
 *
 * Returns normally when:
 *   - ClawHub octo is healthy (may print a one-liner ⚠ if OpenClaw is
 *     below recommended, or if a stale npm residue is detected — neither
 *     blocks).
 */
export function enforceHealthyClawHubInstall(): void {
  const openclaw = detectOpenClawState();

  // OpenClaw too old or missing → hard block (plugin can't load at all)
  if (openclaw.kind === "block") {
    printUpgradeNotice({
      status: "block",
      title: openclaw.reason,
      body: "Upgrade OpenClaw first:",
      command: "npm i -g openclaw@latest",
      followup: "Then re-run your command.",
    });
    process.exit(1);
  }

  const plugin = detectInstallState();
  switch (plugin.kind) {
    case "octo-clawhub":
      if (openclaw.kind === "warn") {
        console.warn(`⚠  ${openclaw.reason}.`);
        console.warn("   Consider upgrading: npm i -g openclaw@latest\n");
      }
      if (plugin.npmResidue) {
        console.warn("⚠  Legacy npm plugin residue detected at ~/.openclaw/npm/node_modules/openclaw-channel-octo.");
        console.warn("   Clean up by re-running install: npx -y create-openclaw-octo install\n");
      }
      return;

    case "octo-npm-legacy":
      printUpgradeNotice({
        status: "block",
        title: `Outdated octo plugin detected: openclaw-channel-octo ${plugin.version ?? "1.0.x"}`,
        body: "This version is no longer supported. Please upgrade:",
        command: "npx -y create-openclaw-octo install",
        followup: "Re-run your command after the upgrade completes.",
      });
      process.exit(1);

    case "dmwork-legacy":
      printUpgradeNotice({
        status: "block",
        title: `Outdated dmwork plugin detected${plugin.version ? ` (${plugin.version})` : ""}`,
        body: "This version is no longer supported. Please upgrade:",
        command: "npx -y create-openclaw-octo install",
        followup: "Re-run your command after the upgrade completes.",
      });
      process.exit(1);

    case "broken":
      printUpgradeNotice({
        status: "block",
        title: "Octo plugin install is in a broken state",
        body: plugin.details,
        command: "npx -y create-openclaw-octo install --force",
      });
      process.exit(1);

    case "none":
      printUpgradeNotice({
        status: "block",
        title: "Octo plugin is not installed",
        body: "Install it first:",
        command: "npx -y create-openclaw-octo install",
      });
      process.exit(1);
  }
}

/**
 * Returns a compact one- or two-line-per-issue banner summarising plugin
 * and OpenClaw state. Returns `null` when everything is healthy (no noise
 * on the happy path). Used by `doctor` to show "you should upgrade" hints
 * without blocking the diagnostic checks.
 */
export function renderInstallStatusBanner(): string | null {
  const plugin = detectInstallState();
  const openclaw = detectOpenClawState();
  const lines: string[] = [];

  if (openclaw.kind === "block") {
    lines.push(`✗ ${openclaw.reason}`);
    lines.push("  Upgrade: npm i -g openclaw@latest");
  } else if (openclaw.kind === "warn") {
    lines.push(`⚠ ${openclaw.reason}`);
    lines.push("  Recommended: npm i -g openclaw@latest");
  }

  switch (plugin.kind) {
    case "octo-clawhub":
      if (plugin.npmResidue) {
        lines.push("⚠ Legacy npm plugin residue at ~/.openclaw/npm/node_modules/openclaw-channel-octo");
        lines.push("  Clean up: npx -y create-openclaw-octo install");
      }
      break;
    case "octo-npm-legacy":
      lines.push(`⚠ Outdated octo plugin: openclaw-channel-octo ${plugin.version ?? "1.0.x"}`);
      lines.push("  Upgrade: npx -y create-openclaw-octo install");
      break;
    case "dmwork-legacy":
      lines.push(`⚠ Outdated dmwork plugin${plugin.version ? ` (${plugin.version})` : ""}`);
      lines.push("  Upgrade: npx -y create-openclaw-octo install");
      break;
    case "broken":
      lines.push(`✗ Octo plugin install is broken: ${plugin.details}`);
      lines.push("  Fix: npx -y create-openclaw-octo install --force");
      break;
    case "none":
      lines.push("✗ Octo plugin is not installed");
      lines.push("  Install: npx -y create-openclaw-octo install");
      break;
  }

  return lines.length > 0 ? lines.join("\n") : null;
}
