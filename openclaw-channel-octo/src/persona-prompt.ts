/**
 * persona_prompt cache + composer for the before_prompt_build hook
 * (GH octo-adapters#68).
 *
 * Persona clones (bot accounts with `account.config.onBehalfOf` set)
 * are granted a free-form `persona_prompt` by their grantor. That
 * prompt must reach the bot's LLM system prompt so the bot replies
 * in the grantor's voice.
 *
 * Historically this travelled via OBO v2 fan-out as `obo_system_hint`
 * → `GroupSystemPrompt` (see inbound.ts), which works only when
 * messages are routed through the OBO v2 envelope. Direct group /
 * DM messages addressed to the persona-clone bot skip that envelope,
 * so the persona_prompt was effectively dropped on those paths.
 *
 * This module owns the active-pull path:
 *   - on account start, fetch GET /v1/bot/obo-grant once
 *   - refresh every `refreshIntervalMs` (default 60s)
 *   - cache by accountId, surfaced via `getPersonaPromptForSession`
 *
 * The before_prompt_build hook in index.ts reads the cache on every
 * prompt build and prepends the composed hint to the system prompt.
 *
 * The legacy `obo_system_hint → GroupSystemPrompt` path in inbound.ts
 * is intentionally preserved as a fallback (per issue #68 禁改清单).
 */

import type { ChannelLogSink } from "openclaw/plugin-sdk/channel-contract";
import { getBotOboGrant, type BotOboGrant } from "./api-fetch.js";

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

let _refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS;

interface PersonaCacheEntry {
  /** Composed hint ready to be prepended to the LLM system prompt. */
  hint: string | undefined;
  fetchedAt: number;
}

/**
 * Minimal shape this module needs from an account. Kept structural
 * (not coupled to ResolvedDmworkAccount) so tests can construct a
 * stub without dragging in the full config-schema graph.
 */
export interface PersonaAccountInput {
  accountId: string;
  apiUrl: string;
  botToken: string;
  /** Grantor uid — when undefined, persona logic is a no-op. */
  onBehalfOf?: string;
}

const _cache = new Map<string, PersonaCacheEntry>();
const _timers = new Map<string, NodeJS.Timeout>();
/** Track which accounts have already logged their first successful fetch. */
const _firstFetchLogged = new Set<string>();
/**
 * Per-account generation counter. Bumped on every init/stop so that any
 * in-flight refresh fetch can detect that it has been superseded and bail
 * out before writing stale data into _cache.
 *
 * Without this guard, an account stop/reconfigure that races with an
 * in-flight `getBotOboGrant` call would let the old fetch resolve later
 * and overwrite the cleared cache (or replace the next account's fresh
 * hint). See PR#69 review.
 */
const _generation = new Map<string, number>();

function _bumpGeneration(accountId: string): number {
  const next = (_generation.get(accountId) ?? 0) + 1;
  _generation.set(accountId, next);
  return next;
}

function _currentGeneration(accountId: string): number {
  return _generation.get(accountId) ?? 0;
}

/**
 * Override the refresh interval (ms). Intended for tests; production
 * uses the default 60s cadence.
 */
export function setPersonaPromptRefreshIntervalMs(ms: number): void {
  if (ms > 0) _refreshIntervalMs = ms;
}

/**
 * Compose the system-prompt hint from a grant payload. Returns
 * undefined when the grant has no usable persona content.
 *
 * Format mirrors octo-server's buildFanoutCopyReq (obo_fanout.go) —
 * the OBO v2 fan-out path uses the same shape, so a single LLM
 * prompt template covers both routes.
 *
 * NOTE: buildFanoutCopyReq's prefix includes the message origin
 * (group name / sender name). That context is not available at
 * prompt-build time (the hook fires per session, not per inbound
 * message), so we omit it here and ship the channel-agnostic
 * variant the issue spec defines:
 *
 *   你正在以「<grantor>」的分身身份运作。请以 <grantor> 的身份回复。
 *
 *   <persona_prompt>
 */
export function composePersonaHint(grant: BotOboGrant): string | undefined {
  if (!grant.has_grant) return undefined;
  // Treat paused/inactive grants as no-prompt — the server may still
  // return the row, but the persona should not influence the LLM.
  if (grant.active === false) return undefined;
  const prompt = (grant.persona_prompt ?? "").trim();
  if (!prompt) return undefined;
  const grantorName = (grant.grantor_name ?? "").trim() || grant.grantor_uid;
  if (!grantorName) return undefined;
  return (
    `你正在以「${grantorName}」的分身身份运作。请以 ${grantorName} 的身份回复。` +
    `\n\n${prompt}`
  );
}

/**
 * Fetch the latest grant once and update the cache. Failures are
 * swallowed (logged) so a transient server hiccup never blocks
 * message processing — the next tick will retry.
 *
 * Each call captures the current generation token for the account.
 * If `stopPersonaPromptCache` or `initPersonaPromptCache` runs while
 * the fetch is in flight (bumping the generation), the post-fetch
 * branches bail out instead of writing the now-stale grant into the
 * cache. This prevents stop → in-flight resolve → cache resurrected
 * races, and also covers reconfigure (old account token still fetches,
 * resolves late, would otherwise overwrite the freshly-initialised
 * cache entry with stale data).
 */
export async function refreshPersonaPromptCache(
  account: PersonaAccountInput,
  log?: ChannelLogSink,
): Promise<void> {
  if (!account.onBehalfOf) return;
  const myGeneration = _currentGeneration(account.accountId);
  let grant: BotOboGrant | null;
  try {
    grant = await getBotOboGrant({
      apiUrl: account.apiUrl,
      botToken: account.botToken,
    });
  } catch (err) {
    // Even logging on a superseded fetch is noise — but skipping it
    // could mask real failures. Keep the warn but suppress cache writes.
    if (_currentGeneration(account.accountId) !== myGeneration) return;
    log?.warn?.(
      `octo: persona_prompt fetch failed for ${account.accountId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // Drop this result if the account was stopped or reconfigured while
  // the fetch was outstanding. Without this check, a stale grant could
  // overwrite the cleared cache or the next init's fresh entry.
  if (_currentGeneration(account.accountId) !== myGeneration) return;

  const hint = grant ? composePersonaHint(grant) : undefined;
  const prev = _cache.get(account.accountId);
  _cache.set(account.accountId, { hint, fetchedAt: Date.now() });

  if (!_firstFetchLogged.has(account.accountId)) {
    _firstFetchLogged.add(account.accountId);
    if (hint) {
      log?.info?.(
        `octo: persona_prompt loaded for ${account.accountId} (grantor=${account.onBehalfOf}, ${hint.length} chars)`,
      );
    } else {
      log?.info?.(
        `octo: persona_prompt not active for ${account.accountId} (grantor=${account.onBehalfOf}); cache will retry every ${_refreshIntervalMs}ms`,
      );
    }
    return;
  }
  if (prev?.hint !== hint) {
    log?.info?.(
      `octo: persona_prompt refreshed for ${account.accountId} (changed=${prev?.hint !== hint}, hasHint=${Boolean(hint)})`,
    );
  }
}

/**
 * Start the per-account refresh loop. Idempotent — calling twice
 * for the same accountId resets the timer.
 *
 * No-op when `account.onBehalfOf` is undefined (regular non-persona
 * bot) so the channel start path can call this unconditionally
 * without an outer guard.
 */
export function initPersonaPromptCache(
  account: PersonaAccountInput,
  log?: ChannelLogSink,
): void {
  if (!account.onBehalfOf) return;

  // Drop any pre-existing timer for this account so repeated calls
  // (hot reload, account reconfigure) don't leak intervals.
  const existing = _timers.get(account.accountId);
  if (existing) clearInterval(existing);

  // Bump generation so any fetch from a previous init/start-cycle that
  // is still in flight will see a generation mismatch when it resolves
  // and bail out before mutating _cache.
  _bumpGeneration(account.accountId);

  // Fire-and-forget initial fetch. We deliberately don't await
  // because account start should not block on persona init.
  void refreshPersonaPromptCache(account, log);

  const timer = setInterval(() => {
    void refreshPersonaPromptCache(account, log);
  }, _refreshIntervalMs);
  // Refresh timer alone must not keep the Node process alive.
  timer.unref?.();
  _timers.set(account.accountId, timer);
}

/**
 * Stop the refresh loop and clear cached state for an account.
 * Called when the account is shut down or reconfigured.
 */
export function stopPersonaPromptCache(accountId: string): void {
  // Bump generation BEFORE clearing state so any fetch that resolves
  // after this point sees the mismatch and skips its cache write.
  _bumpGeneration(accountId);
  const timer = _timers.get(accountId);
  if (timer) clearInterval(timer);
  _timers.delete(accountId);
  _cache.delete(accountId);
  _firstFetchLogged.delete(accountId);
}

/**
 * Read the composed persona hint for an account. Returns undefined
 * when:
 *   - the account is not a persona clone,
 *   - the initial fetch hasn't completed yet,
 *   - the grant is empty / paused / has no persona_prompt,
 *   - the fetch is failing (last successful hint is still served).
 *
 * Callers (currently the before_prompt_build hook in index.ts) can
 * push the return value directly into the prompt sections array
 * when truthy.
 */
export function getPersonaPromptForSession(
  accountId: string,
): string | undefined {
  return _cache.get(accountId)?.hint;
}

/** Test helper — fully reset module state between cases. */
export function _resetPersonaPromptCacheForTests(): void {
  for (const timer of _timers.values()) clearInterval(timer);
  _timers.clear();
  _cache.clear();
  _firstFetchLogged.clear();
  _generation.clear();
  _refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS;
}
