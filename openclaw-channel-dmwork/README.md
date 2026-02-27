# openclaw-channel-dmwork

DMWork channel plugin for OpenClaw. Connects via WuKongIM WebSocket for real-time messaging.

Repository: https://github.com/Mininglamp-OSS/octo-adapters

## Prerequisites

- Node.js >= 18
- A bot created via BotFather in DMWork (send `/newbot` to BotFather)

## Install

```bash
git clone https://github.com/Mininglamp-OSS/octo-adapters.git
cd dmwork-adapters/openclaw-channel-dmwork
npm install
```

## Configure

Set environment variables:

```bash
export OCTO_BOT_TOKEN="bf_your_token_here"   # Bot token from BotFather
export OCTO_API_URL="http://your-server:8090" # DMWork server API URL
```

Or configure in `openclaw.plugin.json`:

```json
{
  "id": "dmwork",
  "channels": ["dmwork"],
  "configSchema": {
    "properties": {
      "botToken": { "type": "string" },
      "apiUrl": { "type": "string" },
      "wsUrl": { "type": "string" }
    }
  }
}
```

- `botToken` (required): Bot token from BotFather (`bf_` prefix)
- `apiUrl` (required): DMWork server API URL, e.g. `http://192.168.1.100:8090`
- `wsUrl` (optional): WuKongIM WebSocket URL. Auto-detected from register if omitted.

## Run

```bash
npm start
```

## What it does

1. Registers the bot with the DMWork server via REST API
2. Connects to WuKongIM WebSocket for real-time message receiving
3. Auto-reconnects on disconnection
4. Sends a greeting to the bot owner on connect
5. Dispatches incoming messages to OpenClaw's message handler
6. Supports streaming responses (start/send/end), typing indicators, and read receipts

## As an OpenClaw Plugin

When loaded by OpenClaw, the `register(api)` function in `index.ts` is called automatically. The plugin:

- Calls `api.getConfig()` to read `botToken` and `apiUrl`
- Calls `api.onMessage()` to register the inbound message handler
- Manages the WebSocket lifecycle internally

## Disconnect

To disconnect the bot, send `/disconnect` to BotFather in DMWork. This invalidates the current IM token and kicks the WebSocket connection.
