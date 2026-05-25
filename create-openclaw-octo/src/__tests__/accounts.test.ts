import { describe, it, expect } from "vitest";
import { resolveDmworkAccount } from "../accounts.js";

/**
 * Unit tests for resolveDmworkAccount account-id case-insensitive fallback.
 *
 * Background: OpenClaw's routing layer normalizes accountId to lowercase via
 * normalizeAccountId (canonicalizeAccountId in openclaw/dist/account-id-*.js),
 * but botfather generates mixed-case bot IDs (e.g. "27pBwzf2F6bfa5cd142_bot").
 * Without a case-insensitive fallback, outbound paths that re-resolve account
 * from the lowercased ID would miss the mixed-case config key and throw
 * "botToken is not configured", silently dropping replies.
 */

const MIXED_CASE_ID = "27pBwzf2F6bfa5cd142_bot";
const LOWERCASE_ID = "27pbwzf2f6bfa5cd142_bot";
const OTHER_MIXED_CASE_ID = "27pBwJ4bfWKed86272a_bot";

function buildCfg(accounts: Record<string, unknown>): unknown {
  return {
    channels: {
      octo: {
        accounts,
      },
    },
  };
}

describe("resolveDmworkAccount", () => {
  describe("strict (case-sensitive) match — primary path", () => {
    it("returns account config when accountId matches the configured key exactly", () => {
      const cfg = buildCfg({
        [MIXED_CASE_ID]: { botToken: "bf_strict_match", apiUrl: "https://im.example.com/api" },
      });

      const account = resolveDmworkAccount({ cfg: cfg as never, accountId: MIXED_CASE_ID });

      expect(account.config.botToken).toBe("bf_strict_match");
      expect(account.config.apiUrl).toBe("https://im.example.com/api");
      expect(account.configured).toBe(true);
    });
  });

  describe("case-insensitive fallback — bridges OpenClaw lowercase routing", () => {
    it("resolves a mixed-case configured account when given its lowercase form", () => {
      const cfg = buildCfg({
        [MIXED_CASE_ID]: { botToken: "bf_case_insensitive", apiUrl: "https://im.example.com/api" },
      });

      const account = resolveDmworkAccount({ cfg: cfg as never, accountId: LOWERCASE_ID });

      expect(account.config.botToken).toBe("bf_case_insensitive");
      expect(account.config.apiUrl).toBe("https://im.example.com/api");
      expect(account.configured).toBe(true);
    });

    it("matches the correct account when multiple mixed-case accounts coexist", () => {
      const cfg = buildCfg({
        [MIXED_CASE_ID]: { botToken: "bf_first", apiUrl: "https://first.example.com/api" },
        [OTHER_MIXED_CASE_ID]: { botToken: "bf_second", apiUrl: "https://second.example.com/api" },
      });

      const first = resolveDmworkAccount({ cfg: cfg as never, accountId: MIXED_CASE_ID.toLowerCase() });
      const second = resolveDmworkAccount({ cfg: cfg as never, accountId: OTHER_MIXED_CASE_ID.toLowerCase() });

      expect(first.config.botToken).toBe("bf_first");
      expect(second.config.botToken).toBe("bf_second");
    });
  });

  describe("missing account — fallback to top-level channel config", () => {
    it("falls back to top-level channel config when accountId is not found in any case", () => {
      const cfg = {
        channels: {
          octo: {
            botToken: "bf_top_level",
            apiUrl: "https://top-level.example.com/api",
          },
        },
      };

      const account = resolveDmworkAccount({ cfg: cfg as never, accountId: "nonexistent_account" });

      expect(account.config.botToken).toBe("bf_top_level");
      expect(account.config.apiUrl).toBe("https://top-level.example.com/api");
    });

    it("returns undefined botToken when neither account nor top-level config has it", () => {
      const cfg = buildCfg({
        [MIXED_CASE_ID]: { apiUrl: "https://im.example.com/api" },
      });

      const account = resolveDmworkAccount({ cfg: cfg as never, accountId: "totally_different" });

      expect(account.config.botToken).toBeUndefined();
      expect(account.configured).toBe(false);
    });
  });
});
