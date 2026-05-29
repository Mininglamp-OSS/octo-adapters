/**
 * CLI utilities: version checking, accountId validation, readline prompts,
 * and string `channels.<id>.<...>` config-path helpers.
 *
 * Pure constants and runtime-safe helpers live in `./constants.ts` and are
 * re-exported from here for convenience to CLI code.
 */

import { createInterface } from "node:readline";
import {
  detectInstallState,
  detectOpenClawState,
  OPENCLAW_PEER_MIN,
  OPENCLAW_RECOMMENDED,
} from "./openclaw-cli.js";
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
 * Caller intent for `ensureOpenClawCompat()`.
 *
 * `requireClawHubProtocol`: caller will dispatch through `openclaw plugins
 * install clawhub:<spec>`, which only exists on OpenClaw v2026.3.22+
 * (upstream commit 91b2800241). Setting this to `true` adds a hard floor:
 * versions below `OPENCLAW_PEER_MIN` exit with a friendly upgrade message
 * before any config is touched, instead of letting OpenClaw bail mid-flow
 * with `unsupported npm spec: protocol specs are not allowed`.
 *
 * Defaults to `false` so commands that don't reach the `clawhub:` path
 * (uninstall, `install --from <local-tarball>`, bind, etc.) still work on
 * older OpenClaw — they'll see a softer warning instead of a hard abort.
 */
export interface EnsureOpenClawCompatOptions {
  requireClawHubProtocol?: boolean;
}

/**
 * Decide whether an install spec resolves through `openclaw plugins
 * install clawhub:<…>` (which requires OpenClaw v2026.3.22+).
 *
 * - undefined / empty → default install path uses `clawhub:octo`.
 * - any spec starting with `clawhub:` → goes through the same `clawhub:`
 *   plugin install machinery and inherits the same version requirement
 *   (regression for PR #91 review: `--from clawhub:octo` previously
 *   bypassed the hard gate and ended up failing partway into migration).
 * - everything else (npm bare names, file paths, file://, http(s) URLs,
 *   local tarballs) → does NOT require `clawhub:` and is allowed on
 *   older OpenClaw with a softer warning.
 */
export function requiresClawHubProtocol(installSpec?: string): boolean {
  if (!installSpec) return true;
  return installSpec.startsWith("clawhub:");
}

/**
 * Check that openclaw is available and version-compatible. Behaviour
 * depends on `opts.requireClawHubProtocol`:
 *
 * - openclaw missing: always exit 1 with install guidance.
 * - openclaw < `OPENCLAW_PEER_MIN`:
 *     - `requireClawHubProtocol === true`: exit 2 with upgrade guidance,
 *       before any config mutation. (Why: `clawhub:` spec was introduced
 *       in v2026.3.22; older runtimes throw `unsupported npm spec`
 *       partway through migration.)
 *     - otherwise: warn that clawhub-based ops are unavailable, but allow
 *       the caller to proceed (uninstall, --from local tarball, etc.).
 * - openclaw < `OPENCLAW_RECOMMENDED`: warn, allow.
 * - openclaw >= `OPENCLAW_RECOMMENDED`: silent.
 *
 * Delegates to `detectOpenClawState()` so this function and the rest of
 * the CLI agree on a single version-policy source of truth — see
 * `openclaw-cli.ts`. Previously this function maintained a parallel
 * `MIN_OPENCLAW_VERSION` constant + local `compareVersions()` helper plus
 * a soft-warn-only path; that meant install proceeded past 4 steps of
 * config mutation before dying at step 5 with a raw stack trace on truly
 * incompatible versions (e.g. < 2026.3.22 has no `clawhub:` protocol
 * support). See issue #90.
 */
export function ensureOpenClawCompat(
  opts: EnsureOpenClawCompatOptions = {},
): void {
  const state = detectOpenClawState();
  if (state.kind === "block") {
    // Probe-failed: binary exists but couldn't be invoked. Common causes
    // are permission errors, broken shims, missing node interpreter, or
    // a wrapper that crashes on `--version`. Reinstalling is the wrong
    // remediation here — point the user at the resolved path and the
    // most likely failure modes. See issue #93.
    if (state.failureKind === "probe-failed") {
      console.error(
        [
          `Error: ${state.reason}`,
          "",
          "openclaw is on PATH but failed to run. Likely causes:",
          "  - missing execute permission (try: chmod +x " + (state.resolvedPath ?? "<openclaw>") + ")",
          "  - broken shim or missing node interpreter",
          "  - sandboxed filesystem denying execute on this path",
          "",
          "Inspect with:",
          "  which openclaw          # confirm the resolved path",
          "  openclaw --version      # see the raw failure",
          "",
          "Re-running the install is unlikely to help if it was previously working.",
        ].join("\n"),
      );
      process.exit(1);
    }
    if (state.failureKind === "missing" || state.version === null) {
      console.error(
        [
          "Error: openclaw not found. Install it first:",
          "",
          "  npm i -g openclaw",
        ].join("\n"),
      );
      process.exit(1);
    }
    if (opts.requireClawHubProtocol) {
      console.error(
        [
          `Error: ${state.reason}.`,
          "",
          `Required:    OpenClaw >= ${OPENCLAW_PEER_MIN}`,
          `Recommended: OpenClaw >= ${OPENCLAW_RECOMMENDED}`,
          "",
          "Run:",
          "  openclaw update",
          "",
          "Then re-run this command.",
        ].join("\n"),
      );
      process.exit(2);
    }
    // Caller doesn't need the clawhub: protocol path: surface the version
    // shortfall as a warning so e.g. uninstall and `install --from` still
    // work on pre-2026.3.22 hosts.
    console.warn(
      [
        `Warning: ${state.reason}.`,
        `(clawhub:-based install is unavailable on this OpenClaw version.`,
        ` Local-tarball install (--from) and uninstall remain available.)`,
      ].join("\n"),
    );
    return;
  }
  if (state.kind === "warn") {
    console.warn(
      `Warning: ${state.reason}. Consider upgrading: openclaw update`,
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
    // Probe-failed: binary exists but failed to invoke. Surface the
    // resolved path and likely causes — `npm i -g openclaw@latest` is the
    // wrong remediation here (re-installing into the same broken location).
    // Mirrors the discriminated rendering in `ensureOpenClawCompat()`.
    // See issue #93 / PR #101 review.
    if (openclaw.failureKind === "probe-failed") {
      printUpgradeNotice({
        status: "block",
        title: openclaw.reason,
        body:
          "openclaw is on PATH but failed to run. Likely causes: missing execute " +
          "permission, broken shim or missing node interpreter, sandboxed filesystem.",
        command: `which openclaw    # confirm path; chmod +x ${openclaw.resolvedPath ?? "<openclaw>"} if a permission issue`,
        followup:
          "Re-installing the package is unlikely to help if openclaw was previously working.",
      });
      process.exit(1);
    }
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
      // Dual-active state: ClawHub octo healthy AND legacy npm
      // openclaw-channel-octo still registered in cfg.plugins.entries. Both
      // register channel id "octo", so any write under channels.octo here
      // would land in a duplicated-channel state. Block and force the user
      // to migrate first.
      if (plugin.legacyNpmActive) {
        printUpgradeNotice({
          status: "block",
          title: "Legacy npm openclaw-channel-octo is still registered alongside ClawHub octo",
          body: "Both register channel \"octo\" — running this command would write into a duplicated-channel state. Migrate first:",
          command: "npx -y create-openclaw-octo install --force",
          followup: "Re-run your command after the migration completes.",
        });
        process.exit(1);
      }
      // dmwork → octo migration not finished. Mirrors install.ts detectScenario
      // priority: dmwork plugin/channel/binding residue triggers `rebrand`
      // even when octo is otherwise healthy. Block before bind/quickstart
      // write fresh channels.octo data over the unfinished migration.
      if (plugin.legacyDmworkResidue) {
        printUpgradeNotice({
          status: "block",
          title: "Unfinished dmwork → octo migration detected",
          body: "Legacy dmwork plugin or channel/binding residue is present alongside ClawHub octo. Run install to finish the migration:",
          command: "npx -y create-openclaw-octo install",
          followup: "Re-run your command after the migration completes.",
        });
        process.exit(1);
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
    // Differentiate probe-failed from missing/too-old. Suggesting
    // `npm i -g openclaw@latest` for a binary that exists but can't be run
    // (broken shebang / EACCES / sandboxed execute) sends users down the
    // wrong remediation path. See #93 / PR #101 review.
    if (openclaw.failureKind === "probe-failed") {
      lines.push(
        `  Run: which openclaw    # confirm path${openclaw.resolvedPath ? `; chmod +x ${openclaw.resolvedPath} if a permission issue` : ""}`,
      );
    } else {
      lines.push("  Upgrade: npm i -g openclaw@latest");
    }
  } else if (openclaw.kind === "warn") {
    lines.push(`⚠ ${openclaw.reason}`);
    lines.push("  Recommended: npm i -g openclaw@latest");
  }

  switch (plugin.kind) {
    case "octo-clawhub":
      if (plugin.legacyNpmActive) {
        lines.push("✗ Legacy npm openclaw-channel-octo still registered alongside ClawHub octo");
        lines.push("  Migrate: npx -y create-openclaw-octo install --force");
      } else if (plugin.legacyDmworkResidue) {
        lines.push("✗ Unfinished dmwork → octo migration (dmwork plugin/channel/binding residue)");
        lines.push("  Run: npx -y create-openclaw-octo install");
      } else if (plugin.npmResidue) {
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
