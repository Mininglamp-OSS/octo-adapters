/**
 * SDK Compatibility Layer
 *
 * Centralizes protocol-level constants that may shift across OpenClaw SDK versions.
 * Types import directly from "openclaw/plugin-sdk" (always stable).
 */

/** The framework's default account identifier when none is explicitly specified. */
export const DEFAULT_ACCOUNT_ID = "default" as const;
