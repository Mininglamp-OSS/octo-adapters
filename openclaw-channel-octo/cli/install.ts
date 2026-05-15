/**
 * install command: install or update the Octo plugin.
 *
 * Phase B scenarios (in detection priority order):
 *   1. legacy-to-octo  — very-legacy plugin id "dmwork" present (predates
 *      openclaw-channel-dmwork). Runs runLegacyToOctoMigration().
 *   2. rebrand         — openclaw-channel-dmwork plugin OR channels.dmwork
 *      OR bindings(channel=dmwork) residue. Runs runRebrandMigration().
 *      Triggers even when octo is also installed (handles half-completed
 *      migrations such as octo-already-installed-but-bindings-not-rewritten).
 *   3. update          — octo healthy installed, compare against npm
 *   4. broken          — octo partial, cleanup + reinstall
 *   5. deadlock        — channels.octo without plugin
 *   6. fresh           — clean install
 *
 * Both rebrand and legacy-to-octo go through the same `runMigration()`
 * implementation, parameterized by which legacy plugin id to disable/uninstall.
 * Pure plugin management — does NOT configure new bots or bindings.
 */

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  capturePluginState,
  cleanupBrokenInstall,
  cleanupStaleWorkspaceIfEmpty,
  detectScenario,
  ensurePluginEnabled,
  ensurePluginsAllow,
  gatewayRestart,
  getConfigFilePathSafe,
  isHealthyInstall,
  migrateWorkspaceDir,
  pluginsDisable,
  pluginsEnable,
  pluginsInspect,
  pluginsInstall,
  pluginsUninstall,
  readConfigFromFile,
  removeBindingsFromFile,
  removeChannelConfigFromFile,
  restoreBindingsToFile,
  restoreChannelConfigToFile,
  runCmd,
  saveBindingsFromFile,
  saveChannelConfigFromFile,
  type PluginSnapshot,
} from "./openclaw-cli.js";
import {
  CHANNEL_ID,
  LEGACY_CHANNEL_ID,
  LEGACY_PLUGIN_ID,
  PLUGIN_ID,
  VERY_LEGACY_PLUGIN_ID,
  ensureOpenClawCompat,
} from "./utils.js";

function getLatestNpmVersion(tag: string): string | null {
  try {
    return runCmd("npm", ["view", `${PLUGIN_ID}@${tag}`, "version"], {
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export interface InstallOptions {
  force?: boolean;
  dev?: boolean;
  /**
   * Install the @next pre-release dist-tag instead of @latest.
   *
   * Use during rc/beta cycles: `npx -y openclaw-channel-octo@next install --next`
   * ensures the OpenClaw plugin install also resolves to the @next version
   * (without --next, the npx CLI is @next but pluginsInstall would let
   * OpenClaw fetch @latest, defeating the smoke test).
   */
  next?: boolean;
  /**
   * Override the install spec passed to `openclaw plugins install`.
   * Accepts anything OpenClaw's plugins-install accepts: a tarball path,
   * a directory path, an alternate npm spec, etc.
   *
   * Primary use: pre-publish local testing. Build a tarball with `npm pack`
   * and pass it here so the migration's pluginsInstall step doesn't try to
   * fetch a package that isn't on npm yet.
   *
   *   node bin/octo.js install --from ./openclaw-channel-octo-1.0.0-rc.1.tgz
   *
   * When set, --dev and --next are ignored for spec resolution. Update-scenario
   * version comparison is also skipped (tarball install is unconditional).
   */
  from?: string;
}

export async function runInstall(opts: InstallOptions): Promise<void> {
  ensureOpenClawCompat();

  const scenario = detectScenario();
  // Tag/spec selection: --from > --dev > --next > default (latest).
  const tag = opts.dev ? "dev" : opts.next ? "next" : "latest";
  const spec = opts.from
    ? opts.from
    : opts.dev ? `${PLUGIN_ID}@dev`
    : opts.next ? `${PLUGIN_ID}@next`
    : PLUGIN_ID;
  const quiet = false;
  let didChange = false;

  // Display label for "(dev)", "(next)", or "(from <path>)" in log lines.
  const tagLabel = opts.from
    ? ` (from ${opts.from})`
    : opts.dev ? " (dev)"
    : opts.next ? " (next)"
    : "";

  switch (scenario) {
    case "legacy-to-octo":
    case "legacy":
      // Phase B: full migration from very-legacy "dmwork" plugin id to octo.
      runLegacyToOctoMigration(spec, quiet, opts.force);
      didChange = true;
      break;
    case "rebrand":
    case "legacy-warn":
      // Phase B: full migration from openclaw-channel-dmwork to openclaw-channel-octo.
      runRebrandMigration(spec, quiet, opts.force);
      didChange = true;
      break;
    case "update": {
      const inspect = pluginsInspect(PLUGIN_ID);
      const currentVersion = inspect?.plugin?.version ?? "unknown";

      if (opts.force || opts.from) {
        // --from skips version comparison: tarball install is unconditional
        // because npm registry doesn't know about the tarball's contents.
        console.log(`Force installing Octo plugin${tagLabel}...`);
        pluginsInstall(spec, quiet, true);
        console.log("Plugin installed successfully.");
        didChange = true;
        break;
      }

      const targetVersion = getLatestNpmVersion(tag);

      if (!targetVersion) {
        console.log(`Cannot reach npm registry to check ${tag} version.`);
        console.log(`Current version: v${currentVersion}`);
        break;
      }

      if (currentVersion === targetVersion) {
        console.log(`Octo plugin v${currentVersion} is already the target version${tagLabel}. No update needed.`);
        break;
      }

      console.log(`Updating Octo plugin: v${currentVersion} → v${targetVersion}${tagLabel}...`);
      pluginsInstall(spec, quiet, true);
      console.log(`Octo plugin updated from v${currentVersion} to v${targetVersion}${tagLabel}.`);
      didChange = true;
      break;
    }
    case "broken": {
      console.log("Detected broken plugin install. Cleaning up...");
      const actions = cleanupBrokenInstall(PLUGIN_ID);
      actions.forEach((a) => console.log(`  ${a}`));
      console.log(`Installing Octo plugin${tagLabel}...`);
      pluginsInstall(spec, quiet, opts.force);
      console.log("Plugin installed successfully.");
      didChange = true;
      break;
    }
    case "deadlock":
      runDeadlockRepair(spec, quiet);
      didChange = true;
      break;
    case "fresh":
      console.log(`Installing Octo plugin${tagLabel}...`);
      pluginsInstall(spec, quiet, opts.force);
      console.log("Plugin installed successfully.");
      didChange = true;
      break;
  }

  // Self-heal config — runs even when no install happened.
  // After OpenClaw major upgrades (4.x → 5.x), plugins.entries.<id>.enabled has been
  // observed to be reset to false on third-party plugins.
  ensurePluginsAllow();
  ensurePluginEnabled();

  if (!didChange) return;

  console.log("Restarting gateway...");
  if (!gatewayRestart()) {
    console.log("Warning: Gateway restart failed. Run 'openclaw gateway restart' manually.");
  }

  console.log("\nOcto plugin ready! Use BotFather /newbot or /quickstart to configure bots.");
}

// ---------------------------------------------------------------------------
// Phase B: unified migration
//
// Both rebrand (openclaw-channel-dmwork → openclaw-channel-octo) and
// legacy-to-octo (very-legacy "dmwork" → openclaw-channel-octo) go through
// runMigration() with a different `legacyPluginId` parameter. Channel config
// and bindings always live under the same legacy channel id ("dmwork"), so
// data migration is identical.
// ---------------------------------------------------------------------------

interface MigrationContext {
  legacyPluginId: string;
  scenarioLabel: string;
  spec: string;
  quiet: boolean;
  force?: boolean;
}

function runMigration(ctx: MigrationContext): void {
  const { legacyPluginId, scenarioLabel, spec, quiet, force } = ctx;
  console.log(`Detected ${scenarioLabel}. Starting migration...`);

  // -------------------------------------------------------------------------
  // Step 0: capture pre-migration state (everything rollback needs)
  // -------------------------------------------------------------------------
  const configPath = getConfigFilePathSafe();
  const backupPath = configPath + `.${scenarioLabel}-backup`;
  const legacySnapshot = capturePluginState(legacyPluginId);
  const octoSnapshot = capturePluginState(PLUGIN_ID);
  const savedChannelConfigRaw = saveChannelConfigFromFile(LEGACY_CHANNEL_ID);
  const savedChannelConfig = savedChannelConfigRaw
    ? normalizeChannelConfig(savedChannelConfigRaw)
    : null;
  const savedBindings = saveBindingsFromFile(LEGACY_CHANNEL_ID);
  const hadLegacyChannelBefore = Boolean(savedChannelConfigRaw);
  const beforeBindingKeys = new Set(
    savedBindings.map((b) => `${b?.agentId ?? ""}:${b?.match?.accountId ?? ""}`),
  );

  // -------------------------------------------------------------------------
  // Step 1: backup the entire openclaw.json
  // -------------------------------------------------------------------------
  copyFileSync(configPath, backupPath);
  console.log(`  Backed up config to ${backupPath}.`);

  // -------------------------------------------------------------------------
  // Rollback closure — invoked on any unrecoverable error in steps 2-9.
  //
  // Restores cfg + plugin enabled state but does NOT restart the gateway.
  // If pluginsDisable already took effect against a running gateway, the
  // live process keeps the legacy plugin disabled until the next restart.
  // The user is told the migration aborted and instructed to re-run; the
  // next runInstall (or any explicit `openclaw gateway restart`) reconciles
  // live state. We intentionally don't restart here to keep rollback quick
  // and side-effect-minimal — adding a gateway restart could itself fail
  // and the rollback then has nothing to fall back to.
  // -------------------------------------------------------------------------
  const rollback = (reason: string): never => {
    console.error(`  Migration failed (${reason}). Rolling back...`);
    // (1) tear down any partial new install
    try { cleanupBrokenInstall(PLUGIN_ID); } catch { /* best effort */ }
    // (2) restore full cfg from backup
    try { copyFileSync(backupPath, configPath); } catch { /* best effort */ }
    // (3) re-enable legacy if it was enabled before
    if (legacySnapshot.enabled === true) {
      try { pluginsEnable(legacyPluginId); } catch { /* best effort */ }
    }
    console.error(`  Rollback complete. Backup retained at ${backupPath}.`);
    throw new Error(`Migration aborted: ${reason}`);
  };

  // -------------------------------------------------------------------------
  // Step 2: disable legacy plugin (only if currently enabled)
  // -------------------------------------------------------------------------
  if (legacySnapshot.enabled === true) {
    try {
      pluginsDisable(legacyPluginId);
      console.log(`  Disabled legacy plugin "${legacyPluginId}".`);
    } catch (err) {
      // Disable failure is non-fatal — we proceed and let uninstall handle it later.
      console.warn(`  Warning: could not disable legacy plugin: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: clear any partial octo install from a prior crashed migration
  // (cleanupBrokenInstall is a no-op when the install is healthy, so this is
  //  safe even in case-N where octo is already healthy.)
  // -------------------------------------------------------------------------
  cleanupBrokenInstall(PLUGIN_ID);

  // -------------------------------------------------------------------------
  // Step 4: temporarily remove channels.dmwork + bindings(channel=dmwork)
  // (must happen before pluginsInstall on old OpenClaw — channel id no longer
  //  registered after legacy plugin is disabled, validation would reject)
  // -------------------------------------------------------------------------
  if (hadLegacyChannelBefore) {
    removeChannelConfigFromFile(LEGACY_CHANNEL_ID);
    console.log(`  Removed channels.${LEGACY_CHANNEL_ID} (will restore as channels.${CHANNEL_ID}).`);
  }
  if (savedBindings.length > 0) {
    removeBindingsFromFile(LEGACY_CHANNEL_ID);
    console.log(`  Removed ${savedBindings.length} legacy bindings (will restore on channel=${CHANNEL_ID}).`);
  }

  // -------------------------------------------------------------------------
  // Step 5: install octo (skip if already healthy from a prior partial migration)
  // -------------------------------------------------------------------------
  const octoAlreadyHealthy = octoSnapshot.installed && isHealthyInstall(PLUGIN_ID);
  if (!octoAlreadyHealthy) {
    try {
      console.log(`  Installing ${PLUGIN_ID}...`);
      pluginsInstall(spec, quiet, force);
    } catch (err) {
      rollback(`pluginsInstall(${PLUGIN_ID}) threw: ${(err as Error).message}`);
    }
  } else {
    console.log(`  ${PLUGIN_ID} already installed and healthy — skipping reinstall.`);
  }

  // -------------------------------------------------------------------------
  // Steps 6-9: enable + restore channel/bindings + verify.
  //
  // Wrapped in try/catch so that any throw in steps 6-8 (e.g. fs error from
  // restoreChannelConfigToFile, unexpected pluginsEnable error that isn't
  // unknown-command/not-installed, JSON parse error in readConfigFromFile)
  // routes through rollback() instead of leaving the user with a half-migrated
  // openclaw.json (channels.dmwork removed but channels.octo not yet written).
  // -------------------------------------------------------------------------
  let bindingsAppended = 0;
  try {
    // Step 6: ensure octo is in plugins.allow + enabled
    ensurePluginsAllow(PLUGIN_ID);
    pluginsEnable(PLUGIN_ID);

    // Step 7: write channels.octo from saved channels.dmwork
    if (savedChannelConfig) {
      restoreChannelConfigToFile(savedChannelConfig, CHANNEL_ID);
      console.log(`  Restored channels.${CHANNEL_ID} from saved channels.${LEGACY_CHANNEL_ID}.`);
    }

    // Step 8: write bindings(channel=octo) from saved bindings(channel=dmwork)
    if (savedBindings.length > 0) {
      bindingsAppended = restoreBindingsToFile(savedBindings, LEGACY_CHANNEL_ID, CHANNEL_ID);
      console.log(`  Restored ${bindingsAppended} bindings on channel=${CHANNEL_ID} (deduped from ${savedBindings.length} legacy).`);
    }

    // Step 9: verify post-migration state
    const installOk = isHealthyInstall(PLUGIN_ID);
    const restored = readConfigFromFile();
    const channelsOk = !hadLegacyChannelBefore || Boolean(restored?.channels?.[CHANNEL_ID]);
    const restoredOctoKeys = new Set(
      Array.isArray(restored?.bindings)
        ? restored!.bindings
            .filter((b: any) => b?.match?.channel === CHANNEL_ID)
            .map((b: any) => `${b?.agentId ?? ""}:${b?.match?.accountId ?? ""}`)
        : [],
    );
    const missingKeys = [...beforeBindingKeys].filter((k) => !restoredOctoKeys.has(k));
    const bindingsOk = missingKeys.length === 0;

    if (!installOk) rollback("post-install verification: octo plugin not healthy");
    if (!channelsOk) rollback(`post-install verification: channels.${CHANNEL_ID} missing`);
    if (!bindingsOk) rollback(`post-install verification: ${missingKeys.length} bindings missing on channel=${CHANNEL_ID}`);

    console.log(`  Verified: octo healthy + channels.${CHANNEL_ID} present + ${restoredOctoKeys.size} bindings on channel=${CHANNEL_ID}.`);
  } catch (err) {
    // rollback() throws — but if the caught err *is* the rollback throw
    // itself, propagate as-is to avoid double-wrapping the message.
    const msg = (err as Error).message ?? String(err);
    if (msg.startsWith("Migration aborted:")) throw err;
    rollback(`steps 6-9: ${msg}`);
  }

  // -------------------------------------------------------------------------
  // Step 10 (best-effort): uninstall the legacy plugin
  // Plan B.1 decision: uninstall failure here is logged as a warning, NOT
  // rolled back — the migration's user-visible work is already done.
  // -------------------------------------------------------------------------
  if (legacySnapshot.installed) {
    try {
      pluginsUninstall(legacyPluginId, true);
      console.log(`  Uninstalled legacy plugin "${legacyPluginId}".`);
    } catch (err) {
      console.warn(`  Warning: could not uninstall legacy plugin "${legacyPluginId}". You may remove it manually with: openclaw plugins uninstall ${legacyPluginId} --force`);
      console.warn(`    ${(err as Error).message}`);
    }
  }

  // Step 11 (best-effort): clear any residue config entries for legacy
  try {
    cleanupBrokenInstall(legacyPluginId);
  } catch { /* best effort */ }

  // -------------------------------------------------------------------------
  // Step 11b (best-effort, cross-legacy cleanup): if the OTHER legacy plugin id
  // is also installed, uninstall it too. This handles the case where both
  // very-legacy "dmwork" AND intermediate "openclaw-channel-dmwork" are
  // present — one install run should leave the user fully on octo.
  //
  // The data migration (channels.dmwork / bindings on channel=dmwork) has
  // already moved to channels.octo by step 7-8, so the other legacy plugin
  // owns no live data at this point — pure plugin-record cleanup.
  //
  // In practice only the legacy-to-octo → cleanup-of-openclaw-channel-dmwork
  // direction fires: detectScenario() prioritizes very-legacy artifacts over
  // openclaw-channel-dmwork (see hasVeryLegacyPluginArtifacts above
  // hasLegacyPluginArtifacts in detectScenario). The reverse direction (rebrand
  // path observing very-legacy "dmwork" residue) is defensive — left in place
  // so a manually-corrupted or future-modified detection ordering doesn't
  // silently leak the other legacy id.
  // -------------------------------------------------------------------------
  const otherLegacyId = legacyPluginId === VERY_LEGACY_PLUGIN_ID
    ? LEGACY_PLUGIN_ID
    : VERY_LEGACY_PLUGIN_ID;
  const otherSnapshot = capturePluginState(otherLegacyId);
  if (otherSnapshot.installed) {
    console.log(`  Detected additional legacy plugin "${otherLegacyId}" — cleaning up.`);
    try {
      if (otherSnapshot.enabled === true) pluginsDisable(otherLegacyId);
      pluginsUninstall(otherLegacyId, true);
      console.log(`    Uninstalled "${otherLegacyId}".`);
    } catch (err) {
      console.warn(`    Warning: could not uninstall "${otherLegacyId}": ${(err as Error).message}`);
    }
    try { cleanupBrokenInstall(otherLegacyId); } catch { /* best effort */ }
  }

  // -------------------------------------------------------------------------
  // Step 12 (best-effort, post-verify): migrate workspace dir.
  // Failure here loses regenerable cache only — bot config is already safe.
  // The outcome union differentiates true success from "skipped because source
  // doesn't exist" (e.g. OpenClaw 4.20 doesn't use channel subdirs in
  // workspace/) vs "destination already exists" (left for manual merge).
  // -------------------------------------------------------------------------
  const wsOutcome = migrateWorkspaceDir(LEGACY_CHANNEL_ID, CHANNEL_ID);
  switch (wsOutcome) {
    case "renamed":
      console.log(`  Migrated workspace dir ${LEGACY_CHANNEL_ID}/ → ${CHANNEL_ID}/.`);
      cleanupStaleWorkspaceIfEmpty(LEGACY_CHANNEL_ID);
      break;
    case "skipped-no-source":
      // Common on OpenClaw 4.20 (no per-channel workspace subdirs) and on
      // installations that never created a workspace/<channel>/ entry.
      console.log(`  No workspace dir at ${LEGACY_CHANNEL_ID}/ — nothing to migrate.`);
      break;
    case "skipped-destination-exists":
      console.warn(
        `  Warning: both workspace/${LEGACY_CHANNEL_ID}/ and workspace/${CHANNEL_ID}/ exist; ` +
        `left both intact. Inspect manually if you need to merge cached state.`,
      );
      break;
    case "failed":
      console.warn(`  Warning: workspace dir migration failed (regenerable cache, non-fatal).`);
      break;
  }

  // Step 13: tidy up backup
  try { rmSync(backupPath, { force: true }); } catch { /* best effort */ }
  console.log(`  ${scenarioLabel} migration complete.`);
}

/**
 * Migrate channels.<LEGACY_CHANNEL_ID> shape from flat (botToken at top level)
 * to nested (accounts.default.{botToken, apiUrl}). Older channels.dmwork from
 * very-legacy "dmwork" plugin id used the flat shape; channels.octo always
 * uses the nested shape.
 */
function normalizeChannelConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const cloned = structuredClone(raw) as Record<string, any>;
  if (cloned.botToken && !cloned.accounts) {
    const apiUrl = cloned.apiUrl;
    cloned.accounts = {
      default: {
        botToken: cloned.botToken,
        ...(apiUrl !== undefined ? { apiUrl } : {}),
      },
    };
    delete cloned.botToken;
    delete cloned.apiUrl;
  }
  return cloned;
}

export function runRebrandMigration(spec: string, quiet: boolean, force?: boolean): void {
  runMigration({
    legacyPluginId: LEGACY_PLUGIN_ID,
    scenarioLabel: "rebrand",
    spec,
    quiet,
    force,
  });
}

export function runLegacyToOctoMigration(spec: string, quiet: boolean, force?: boolean): void {
  runMigration({
    legacyPluginId: VERY_LEGACY_PLUGIN_ID,
    scenarioLabel: "legacy-to-octo",
    spec,
    quiet,
    force,
  });
}

// ---------------------------------------------------------------------------
// Deadlock repair: channels.octo exists but plugin missing.
// (Distinct from rebrand — there's no legacy plugin/channel to migrate.)
// ---------------------------------------------------------------------------
function runDeadlockRepair(spec: string, quiet: boolean): void {
  console.log(`Detected config deadlock (channels.${CHANNEL_ID} exists but no plugin).`);

  const configPath = getConfigFilePathSafe();
  const backupPath = configPath + ".deadlock-backup";
  copyFileSync(configPath, backupPath);

  const savedChannelConfig = saveChannelConfigFromFile(CHANNEL_ID);
  const savedBindings = saveBindingsFromFile(CHANNEL_ID);
  const hadChannelBefore = Boolean(savedChannelConfig);

  if (hadChannelBefore) {
    removeChannelConfigFromFile(CHANNEL_ID);
    console.log(`  Temporarily removed channels.${CHANNEL_ID}.`);
  }

  // Symmetric with runMigration step 4: also remove bindings on the channel
  // before pluginsInstall. Some OpenClaw versions reject loading a config
  // that has bindings referencing an unregistered channel id; without this,
  // the deadlock-repair install itself can fail and re-trap the user in the
  // same deadlock. We restore the bindings (deduped) after enable.
  if (savedBindings.length > 0) {
    removeBindingsFromFile(CHANNEL_ID);
    console.log(`  Temporarily removed ${savedBindings.length} bindings on channel=${CHANNEL_ID}.`);
  }

  try {
    console.log(`  Installing ${PLUGIN_ID}...`);
    pluginsInstall(spec, quiet);
  } catch (err) {
    console.error("  Install failed! Restoring config...");
    try { copyFileSync(backupPath, configPath); } catch { /* best effort */ }
    // Cleanup: pluginsInstall may have left a partial extension dir / install
    // record. Without this, next detectScenario() sees octo dir+entries and
    // returns "broken" instead of "deadlock", routing to a different recovery
    // path. Drop the partial install so the next run hits the same scenario.
    try { cleanupBrokenInstall(PLUGIN_ID); } catch { /* best effort */ }
    try { rmSync(backupPath, { force: true }); } catch { /* best effort */ }
    throw err;
  }

  if (!isHealthyInstall(PLUGIN_ID)) {
    console.error("  Install completed but verification failed. Restoring config...");
    try { copyFileSync(backupPath, configPath); } catch { /* best effort */ }
    try { cleanupBrokenInstall(PLUGIN_ID); } catch { /* best effort */ }
    try { rmSync(backupPath, { force: true }); } catch { /* best effort */ }
    throw new Error("Deadlock repair failed: post-install verification did not pass");
  }

  // Wrap the post-install enable + channel/binding restore in the same
  // try/catch shape as runMigration's steps 6-9: an unexpected throw from
  // ensurePluginsAllow / pluginsEnable / restoreChannelConfigToFile /
  // restoreBindingsToFile would otherwise leave the user with channels.<id>
  // and bindings removed but never restored. Restore from backup on failure.
  let restoredCfg: any;
  let restoredOk = false;
  try {
    ensurePluginsAllow(PLUGIN_ID);
    pluginsEnable(PLUGIN_ID);

    if (savedChannelConfig) {
      restoreChannelConfigToFile(savedChannelConfig, CHANNEL_ID);
    }

    if (savedBindings.length > 0) {
      restoreBindingsToFile(savedBindings, CHANNEL_ID, CHANNEL_ID);
    }

    restoredCfg = readConfigFromFile();
    restoredOk = !hadChannelBefore || Boolean(restoredCfg?.channels?.[CHANNEL_ID]);
  } catch (err) {
    console.error(`  Deadlock repair post-install steps failed: ${(err as Error).message}. Restoring config...`);
    try { copyFileSync(backupPath, configPath); } catch { /* best effort */ }
    try { cleanupBrokenInstall(PLUGIN_ID); } catch { /* best effort */ }
    try { rmSync(backupPath, { force: true }); } catch { /* best effort */ }
    throw err;
  }

  if (restoredOk) {
    try { rmSync(backupPath, { force: true }); } catch { /* best effort */ }
    console.log("  Deadlock repaired!");
  } else {
    throw new Error(`Deadlock repair incomplete: plugin installed but channels.${CHANNEL_ID} could not be restored. Backup kept at ${backupPath}`);
  }
}

// Backward-compatible exports for update.ts / doctor.ts (now thin wrappers).
export { runRebrandMigration as runLegacyMigrationForUpdate };
export { runDeadlockRepair as runDeadlockRepairForUpdate };
