# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.6] - 2026-03-14

### Changed
- 历史消息 JSON 注入 mediaUrl 字段（而非 hasMedia 标记）
- makeFullUrl 改为 CDN 直连，去掉 /v1/botfile/ 认证路径

## [0.3.5] - 2026-03-14

### Fixed
- 修复群聊中媒体文件（图片/文件）在历史缓存中丢失的问题
