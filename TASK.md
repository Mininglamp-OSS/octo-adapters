# Task: Fix group chat media (images/files) not visible to bot

## Problem
In group chats, when image/file messages are sent without @mentioning the bot, they enter the history cache. But the cache only stores `body` text (e.g. `[图片]`), losing the media URL. When the bot is later @mentioned, the history context only contains text placeholders — the bot cannot see any images.

## Root Cause (3 places in openclaw-channel-dmwork/src/inbound.ts)

### Fix 1: Non-@ message caching (around line 497)
The `entries.push()` for non-mentioned messages only stores `sender`, `body`, `timestamp`.
**Fix**: Also store `mediaDataUrl: inboundMediaUrl` (the base64 data URL that was already converted earlier in the flow).

### Fix 2: API history fallback (around line 542)  
When cache is insufficient, `getChannelMessages` fetches from API, but only extracts text via `resolveApiMessagePlaceholder`. 
**Fix**: For image/file/voice/video message types from API, call `resolveContent` to get the media URL, then `fetchAsDataUrl` to convert to base64, and store as `mediaDataUrl` in the entry.

### Fix 3: History context injection (around line 557)
The history JSON only outputs `sender` and `body`.
**Fix**: Include `mediaDataUrl` in the history entries. Also collect all `mediaDataUrl` values and append them to `historyMediaUrls` so they get included in the `MediaUrls` array passed to the Agent.

### Fix 4: Add debug logging
Add a debug log for `payload.url` value in `resolveContent` for image/file types, to help diagnose cases where payload.url might be empty/undefined.

## Files to modify
- `openclaw-channel-dmwork/src/inbound.ts`

## Constraints
- Do NOT modify any test files
- Do NOT change the private chat (non-group) flow
- Keep existing behavior for text messages unchanged
- The `fetchAsDataUrl` function already exists and handles Bearer token auth
- Run `cd openclaw-channel-dmwork && npx tsc --noEmit` to verify TypeScript compiles
