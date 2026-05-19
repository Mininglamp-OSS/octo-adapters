/**
 * Pure constants and pure functions for plugin/channel identifiers.
 *
 * **Layering rule (LEGACY-COMPAT-ALLOWED-FILE)**:
 * This file is `src/`-only and has no fs/child_process dependencies, so it can
 * be safely imported from both runtime code (`src/*.ts`) and CLI code
 * (`cli/*.ts`). Runtime code MUST NOT import from `cli/`.
 */

/**
 * Target plugin id after install — matches the ClawHub plugin id `octo`
 * (Mininglamp-OSS/openclaw-channel-octo standalone repo, published to ClawHub).
 * Used by cli/* for plugin inspect / enable / cleanup operations.
 */
export const PLUGIN_ID = "octo";
export const CHANNEL_ID = "octo";

/** The npm package name (this very package). Used as the install spec when
 * publishing to npm, and as a legacy plugin id to detect+cleanup when an older
 * version (1.x) was installed via `openclaw plugins install openclaw-channel-octo`.
 */
export const NPM_PACKAGE_NAME = "openclaw-channel-octo";

/** Spec passed to `openclaw plugins install <spec>` to install from ClawHub. */
export const CLAWHUB_INSTALL_SPEC = "clawhub:octo";

// LEGACY-COMPAT: legacy identifiers used only by Phase B migration code and
// Phase A's legacy-warn / dual-prefix compatibility paths.
export const LEGACY_PLUGIN_ID = "openclaw-channel-dmwork";
export const LEGACY_CHANNEL_ID = "dmwork";
export const VERY_LEGACY_PLUGIN_ID = "dmwork";

/**
 * Strip channel namespace prefix from a sessionKey or target string.
 * Accepts both the new `octo:` prefix and the legacy `dmwork:` prefix to
 * preserve backwards compatibility with existing OpenClaw sessions and any
 * agent/LLM caches that still emit the old prefix.
 */
// LEGACY-COMPAT: dmwork prefix kept for one release cycle (see plan A.3 / 1.7.1)
export function stripChannelPrefix(s: string): string {
  return s.replace(/^(?:octo|dmwork):/, "");
}

/** Return the per-channel sub-config for the current channel id (runtime read). */
export function getChannelConfig<T = unknown>(cfg: any): T {
  return (cfg?.channels?.[CHANNEL_ID] ?? {}) as T;
}

/**
 * Migration-only: read a specific channel's sub-config explicitly.
 * Used by Phase B rebrand / legacy-to-octo flows; runtime code should use
 * {@link getChannelConfig} instead.
 */
// LEGACY-COMPAT: explicit channelId variant for migration code
export function getChannelConfigFor<T = unknown>(cfg: any, channelId: string): T {
  return (cfg?.channels?.[channelId] ?? {}) as T;
}

/**
 * Lazily ensure `cfg.channels.<channelId>` exists and return the mutable
 * reference. Used by `bind` / `quickstart` to write account configuration.
 *
 * The default `channelId` is `CHANNEL_ID` (current channel). Migration paths
 * pass `LEGACY_CHANNEL_ID` explicitly.
 */
export function ensureChannelConfigObject(
  cfg: any,
  channelId: string = CHANNEL_ID,
): any {
  cfg.channels ??= {};
  cfg.channels[channelId] ??= {};
  cfg.channels[channelId].accounts ??= {};
  return cfg.channels[channelId];
}
