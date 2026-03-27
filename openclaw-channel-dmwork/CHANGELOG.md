# Changelog

All notable changes to this project will be documented in this file.

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
