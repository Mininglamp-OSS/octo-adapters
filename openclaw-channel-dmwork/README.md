# openclaw-channel-dmwork

DMWork channel plugin for OpenClaw. Connects via DMWORK WebSocket for real-time messaging.

Repository: https://github.com/Mininglamp-OSS/octo-adapters

## Prerequisites

- Node.js >= 18
- OpenClaw installed and configured
- A bot created via BotFather in DMWork (send `/newbot` to BotFather)

## Install as OpenClaw Extension

```bash
git clone https://github.com/Mininglamp-OSS/octo-adapters.git
cp -r dmwork-adapters/openclaw-channel-dmwork ~/.openclaw/extensions/dmwork
cd ~/.openclaw/extensions/dmwork && npm install
```

## Configure

Add to your `~/.openclaw/config.yaml`:

```yaml
channels:
  dmwork:
    botToken: "bf_your_token_here"   # Bot token from BotFather
    apiUrl: "http://your-server:8090" # DMWork server API URL
    # wsUrl: "ws://your-server:5200" # Optional — auto-detected from register if omitted
```

Configuration fields:

- `botToken` (required): Bot token from BotFather (`bf_` prefix)
- `apiUrl` (required): DMWork server API URL, e.g. `http://192.168.1.100:8090`
- `wsUrl` (optional): DMWORK WebSocket URL. Auto-detected from register if omitted.

## Run

```bash
openclaw gateway restart
```

The plugin is loaded automatically by OpenClaw when the gateway starts.

## What it does

1. Registers the bot with the DMWork server via REST API
2. Connects to DMWORK WebSocket for real-time message receiving
3. Auto-reconnects on disconnection
4. Sends a greeting to the bot owner on connect
5. Dispatches incoming messages to OpenClaw's message handler
6. Supports streaming responses (start/send/end), typing indicators, and read receipts

## As an OpenClaw Plugin

The `index.ts` exports a standard OpenClaw plugin object. When loaded by OpenClaw:

- `register(api)` is called automatically
- `api.runtime` is injected for logging and lifecycle management
- `api.registerChannel()` registers the DMWork channel plugin
- Configuration is read from `channels.dmwork` in OpenClaw's config

The plugin uses the `ChannelPlugin` SDK interface with support for:
- Direct messages and group chats
- Multi-account configuration via `channels.dmwork.accounts`
- Config hot-reload on `channels.dmwork` prefix changes

## Disconnect

To disconnect the bot, send `/disconnect` to BotFather in DMWork. This invalidates the current IM token and kicks the WebSocket connection.
