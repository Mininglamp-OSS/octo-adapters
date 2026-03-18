# Changelog

## 0.1.0 (2026-03-16)

Initial release — WebSocket gateway connecting Claude Agent SDK to DMWork messaging.

### Features

- **Real-time WebSocket**: WuKongIM binary protocol with DH key exchange and AES-CBC encryption
- **Streaming replies**: Uses DMWork stream API for incremental response delivery, with fallback to regular messages
- **DM + Group chat**: Direct messages and @mention-triggered group responses
- **Group context**: Caches recent group messages and member mappings for context-aware replies
- **Session persistence**: Per-peer conversation history with sliding window (40 messages)
- **Auto-reconnect**: Handles WS disconnections and token expiry with automatic recovery
- **Typing indicators**: Shows typing status while Claude processes
- **Process lock**: Prevents multiple gateway instances for the same bot
- **Configurable SDK**: Customizable tools, permission mode, system prompt, and settings sources
