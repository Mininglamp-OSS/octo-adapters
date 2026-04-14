# hermes-channel-dmwork

DMWork (WuKongIM) platform adapter for [Hermes Agent](https://github.com/NousResearch/hermes-agent).

## Overview

This adapter enables Hermes Agent to communicate through the DMWork messaging platform, which uses the WuKongIM binary protocol over WebSocket for real-time messaging.

### Features

- **WuKongIM Binary Protocol**: Full implementation of the custom binary wire protocol (CONNECT/CONNACK/RECV/RECVACK/PING/PONG)
- **ECDH Key Exchange**: Curve25519 key exchange + AES-128-CBC encryption for secure communication
- **Auto-Reconnection**: Exponential backoff with jitter for robust connection recovery
- **Mention Support**: @mention parsing and conversion between human-readable and structured formats
- **Bot API**: Complete HTTP API client for message sending, typing indicators, group management

## Installation

```bash
pip install hermes-channel-dmwork
```

Or for development:

```bash
cd hermes-channel-dmwork
pip install -e ".[dev]"
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OCTO_API_URL` | Yes | DMWork Bot API base URL (e.g. `https://api.example.com`) |
| `OCTO_BOT_TOKEN` | Yes | Bot authentication token |

### Hermes config.yaml

```yaml
platforms:
  dmwork:
    enabled: true
    extra:
      api_url: "https://api.example.com"
      bot_token: "your-bot-token"
```

## Architecture

```
┌─────────────┐     HTTP API      ┌──────────────┐
│ DMWorkAdapter│ ──────────────── │ DMWork Server │
│             │  (send/typing/    │              │
│             │   register)       │              │
│             │                   │              │
│             │  WuKongIM WS     │              │
│             │ ◄────────────── │              │
│             │  (binary proto)   │              │
└─────────────┘                   └──────────────┘
```

### Protocol Flow

1. **Registration**: `POST /v1/bot/register` → get `ws_url`, `im_token`, `robot_id`
2. **WebSocket Connect**: Open WS to `ws_url`
3. **CONNECT Frame**: Send CONNECT with ECDH public key + IM token
4. **CONNACK**: Server responds with its public key → derive AES shared secret
5. **Message Loop**: Receive encrypted RECV frames → decrypt → dispatch to agent
6. **Heartbeat**: Periodic PING/PONG to keep connection alive
7. **RECVACK**: Acknowledge each received message

### Key Implementation Notes

- Protocol version: **4** (PROTO_VERSION)
- Binary encoding: **Big-endian** throughout
- Encryption: **AES-128-CBC** with key derived from Curve25519 ECDH shared secret (MD5 of base64)
- IV: First 16 characters of the CONNACK salt
- Heartbeat: 60-second interval, 3 missed PONGs triggers reconnect
- Reconnect: Exponential backoff (3s base, 60s max) with ±25% jitter

## Project Structure

```
src/hermes_dmwork/
├── __init__.py      # Package exports
├── adapter.py       # Main DMWorkAdapter (BasePlatformAdapter subclass)
├── api.py           # HTTP API client (aiohttp)
├── mention.py       # @mention parsing and conversion
├── protocol.py      # WuKongIM binary protocol encoder/decoder
└── types.py         # Data types and enums
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run syntax check
python -m py_compile src/hermes_dmwork/protocol.py
python -m py_compile src/hermes_dmwork/adapter.py

# Run tests (when available)
pytest
```

## License

MIT
