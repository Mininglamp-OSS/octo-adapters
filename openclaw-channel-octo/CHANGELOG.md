# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0-rc.1] - 2026-05-14

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
- New install scenario `legacy-warn`: when a residual
  `openclaw-channel-dmwork` install or `channels.dmwork` config is detected,
  install logs a deprecation warning and otherwise behaves as a fresh install
  (legacy plugin and config are left intact). Full automatic migration is
  scheduled for a follow-up release.

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

- Phase A drops the active `legacy` migration scenario from the install
  switch (it now warns rather than migrating). The migration helpers
  themselves remain in `cli/install.ts` as `LEGACY-MIGRATION`-tagged dead
  code, ready for the follow-up that re-wires them as a proper
  `dmwork → octo` rebrand path.

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
