# Changelog

All notable changes to this project will be documented in this file.

## [1.0.1] - 2026-05-26

### Changed

- **npm package renamed**: `openclaw-channel-octo` → `create-openclaw-octo`.
  The old npm name will publish one final redirect-only version that prints
  `Use \`npx -y create-openclaw-octo\` instead` and exits.
- **Repository now CLI-only**: plugin runtime source (`src/`, `index.ts`,
  `openclaw.plugin.json`, `skills/`) removed. The plugin lives at
  [Mininglamp-OSS/openclaw-channel-octo](https://github.com/Mininglamp-OSS/openclaw-channel-octo)
  and is distributed via ClawHub. This package is purely the CLI manager.
- **Subdir renamed in monorepo**: `octo-adapters/openclaw-channel-octo/` →
  `octo-adapters/create-openclaw-octo/`.
- **Constants inlined**: `src/constants.ts` and `src/version.ts` moved to
  `cli/constants.ts` and `cli/version.ts` (CLI-local, no cross-tree imports).
- **prebuild script** now writes to `cli/version.ts` (was `src/version.ts`).

### Removed

- Plugin runtime dependencies (`axios`, `cos-nodejs-sdk-v5`, `crypto-js`,
  `curve25519-js`, `md5-typescript`, `ws`) — CLI only needs `commander`.
- `peerDependencies` on `openclaw` — CLI spawns `openclaw` via execFileSync,
  not via require/import, so peer-dep declaration is unnecessary.
- `main` / `types` / `exports` from `package.json` — no programmatic API.
- `files` array no longer ships `skills/` or `openclaw.plugin.json`.

## [1.0.0] - 2026-05-15

Initial product-rebranded release. Forked from `openclaw-channel-dmwork@0.6.x`
and renamed to align with the Octo product brand.

### Changed (vs `openclaw-channel-dmwork`)

- npm package name: `openclaw-channel-dmwork` → `openclaw-channel-octo`
- OpenClaw plugin id: `openclaw-channel-dmwork` → `openclaw-channel-octo`
- Channel id: `dmwork` → `octo` (config under `channels.octo.accounts.*`,
  bindings carry `match.channel = "octo"`)
- Workspace dir: `~/.openclaw/workspace/dmwork/` → `~/.openclaw/workspace/octo/`
- CLI bin: `openclaw-channel-dmwork` → `openclaw-channel-octo`
  (`bin/dmwork.js` → `bin/octo.js`)
- All `DMWork` user-visible labels and log prefixes → `Octo` / `octo:`
- Slash commands renamed `/dmwork_*` → `/octo_*` (see Backwards compatibility)
- Agent tool renamed `dmwork_management` → `octo_management`
  (see Backwards compatibility)

### Added

- `src/constants.ts`: centralised plugin/channel-id constants and
  `getChannelConfig` / `ensureChannelConfigObject` helpers used by the rest of
  the codebase to avoid hardcoded `dmwork` / `octo` strings.
- `cli/utils.ts`: `channelConfigPath()` for `configGet/configSet` paths.
- **Automatic migration from `openclaw-channel-dmwork`**:
  `install` detects a legacy `openclaw-channel-dmwork` plugin (or
  `channels.dmwork` / bindings(channel=dmwork) residue) and runs a
  command-driven migration — disable legacy → install octo → enable octo →
  rewrite channels.dmwork to channels.octo → rewrite bindings'
  `match.channel` to "octo" (deduped by `(agentId, accountId)`) → uninstall
  legacy → migrate workspace dir. The flow is transactional: any failure in
  the install/restore phase rolls back to the pre-migration `.bak` and
  re-enables the legacy plugin if it was enabled.
- **Automatic migration from very-legacy `dmwork` plugin id**:
  takes priority over the `openclaw-channel-dmwork` rebrand; flat
  `channels.dmwork.botToken` shape is normalized to nested
  `channels.octo.accounts.default`.
- **`exports["./cli"]` subpath export**: the CLI's `main()` is now
  exported explicitly via `exports["./cli"]` instead of running on
  import; enables programmatic use and third-party tooling.
- **No shim package**: `openclaw-channel-dmwork` is not republished as
  a forwarding shim. Users on the legacy plugin should explicitly run
  `npx -y openclaw-channel-octo install`; the install command detects
  and migrates any existing dmwork configuration automatically.

### Backwards compatibility (legacy aliases kept for one release cycle)

- Slash commands: each `/octo_*` command is also registered under its old
  `/dmwork_*` name. Alias invocations log a one-line deprecation hint.
- Agent tools: `dmwork_management` is registered alongside `octo_management`
  with the same schema and execute closure; alias logs a deprecation hint on
  each invocation.
- Channel namespace prefix in target strings and sessionKeys: parsers accept
  both `octo:` (new) and `dmwork:` (legacy); new outbound messages emit
  `octo:`. The `GROUP.md` regex matches both prefixes.

These aliases are scheduled for removal in a future minor release.

### Removed

- The Phase-A `legacy-warn` scenario (warned but did not migrate). It is
  superseded by the active `rebrand` and `legacy-to-octo` scenarios above.
  Existing `legacy` and `legacy-warn` strings still resolve to the new
  migration paths for backward compatibility.

---

## [0.5.7] - 2026-03-27

### Fixed
- Streaming upload to COS to prevent OOM on large files: HTTP downloads now stream to temp files instead of buffering entirely in memory, and COS uploads use ReadStream with ContentLength instead of Buffer
- Image dimension parsing reads only 64KB header from file instead of loading full image into memory
- Temp upload files are cleaned up after use, with opportunistic cleanup of stale files (>1h)
- Size limit enforcement (500MB) added for file:// uploads
- Removed unused `createReadStream`/`statSync` imports from api-fetch.ts

### Changed
- `uploadFileToCOS` now accepts `ReadableStream` in addition to `Buffer`, with optional `fileSize` for `ContentLength` header
- `uploadAndSendMedia` refactored from in-memory buffering to stream-based temp file approach

## [0.5.6] - 2026-03-27

### Fixed
- Re-encode COS key in CDN URL to prevent 404 on non-ASCII filenames

## [0.5.5] - 2026-03-26

### Fixed
- Align plugin id with npm package name to resolve startup warning
