/**
 * SDK Compatibility Layer
 *
 * Centralizes all value-level dependencies on the OpenClaw plugin SDK.
 * Type imports go directly to "openclaw/plugin-sdk" (always stable).
 *
 * Why: OpenClaw restructures its plugin-sdk exports across versions.
 * Rather than chasing sub-path changes (e.g. DEFAULT_ACCOUNT_ID moved from
 * "openclaw/plugin-sdk" to "openclaw/plugin-sdk/account-id" in v2026.5.4),
 * we pin frozen protocol constants here and import from this file everywhere.
 *
 * Rules:
 *   - Only frozen, semantic constants belong here (protocol-level contracts).
 *   - If a value is NOT frozen (could change across versions), use dynamic
 *     import with fallback instead of hardcoding.
 *   - Types are never placed here — import them directly from "openclaw/plugin-sdk".
 */

/**
 * The default account identifier used by the OpenClaw plugin framework
 * when no explicit account is specified. This is a protocol-level constant
 * frozen since the multi-account API was introduced.
 */
export const DEFAULT_ACCOUNT_ID = "default" as const;
