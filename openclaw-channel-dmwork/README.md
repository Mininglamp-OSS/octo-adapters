# openclaw-channel-dmwork

DMWork channel plugin for OpenClaw. Connects via DMWORK WebSocket for real-time messaging.

Repository: https://github.com/Mininglamp-OSS/octo-adapters

## Prerequisites

- Node.js >= 18
- OpenClaw installed and configured (`npm i -g openclaw`)
- A bot created via BotFather in DMWork (send `/newbot` to BotFather)

## Install

One-command install via npx (BotFather will provide the exact command):

```bash
npx -y openclaw-channel-dmwork install \
  --bot-token bf_your_token_here \
  --api-url http://your-server:8090 \
  --account-id my_bot
```

This will:
1. Install the plugin via `openclaw plugins install`
2. Configure the bot account in `channels.dmwork.accounts.<account-id>`
3. Restart the OpenClaw gateway

### Interactive install

Run without arguments to be prompted for each value:

```bash
npx -y openclaw-channel-dmwork install
```

## CLI Commands

```bash
# Update the plugin to the latest version
npx -y openclaw-channel-dmwork update

# Diagnose plugin health
npx -y openclaw-channel-dmwork doctor

# Uninstall (keeps bot config by default)
npx -y openclaw-channel-dmwork uninstall

# Remove a single bot account
npx -y openclaw-channel-dmwork remove-account --account-id my_bot
```

### OpenClaw internal commands

After installation, these commands are available inside OpenClaw:

```
/dmwork_doctor              # Check plugin status and connectivity
/dmwork_doctor my_bot       # Check a specific account
```

## Configuration

Bot accounts are stored in `~/.openclaw/openclaw.json` under `channels.dmwork.accounts`:

```json
{
  "channels": {
    "dmwork": {
      "apiUrl": "http://your-server:8090",
      "accounts": {
        "my_bot": {
          "botToken": "bf_your_token_here",
          "apiUrl": "http://your-server:8090"
        },
        "another_bot": {
          "botToken": "bf_another_token",
          "apiUrl": "https://im.example.com/api"
        }
      }
    }
  }
}
```

Configuration fields per account:

- `botToken` (required): Bot token from BotFather (`bf_` prefix)
- `apiUrl` (required): DMWork server API URL
- `wsUrl` (optional): DMWORK WebSocket URL. Auto-detected if omitted.
- `requireMention` (optional): Only respond when @mentioned in groups
- `historyLimit` (optional): Group chat history message limit (default: 20)

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
- `api.registerCommand()` registers `/dmwork_doctor`
- Configuration is read from `channels.dmwork` in OpenClaw's config

The plugin uses the `ChannelPlugin` SDK interface with support for:
- Direct messages and group chats
- Multi-account configuration via `channels.dmwork.accounts`
- Config hot-reload on `channels.dmwork` prefix changes

## Disconnect

To disconnect the bot, send `/disconnect` to BotFather in DMWork. This invalidates the current IM token and kicks the WebSocket connection.
