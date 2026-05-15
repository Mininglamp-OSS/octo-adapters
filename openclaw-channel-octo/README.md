# openclaw-channel-octo

Octo channel plugin for OpenClaw. Connects via WuKongIM WebSocket for real-time messaging.

> **v1.0.0+**: This package was renamed from `openclaw-channel-dmwork`. Old
> users still on `openclaw-channel-dmwork@0.6.x` will get an automatic
> migration path in a follow-up release. New users should use
> `openclaw-channel-octo` directly.

Repository: https://github.com/Mininglamp-OSS/octo-adapters

## Prerequisites

- Node.js >= 18
- OpenClaw installed and configured (`npm i -g openclaw`)
- A bot created via BotFather in Octo (send `/newbot` to BotFather)

## Install

`install` only sets up the plugin (no bot account). Use `bind` after install
to configure a bot account, or `quickstart` for batch creation across all
your agents.

```bash
# 1. Install the plugin
npx -y openclaw-channel-octo install

# 2. Bind a bot to an agent
npx -y openclaw-channel-octo bind \
  --bot-token bf_your_token_here \
  --api-url https://your-server.example/api \
  --account-id my_bot \
  --agent your_agent_id
```

`install` flags:

- `--force`: reinstall even if already installed
- `--dev`: install the `@dev` dist-tag instead of `@latest`

## CLI Commands

```bash
# Install/update the plugin (no bot config)
npx -y openclaw-channel-octo install

# Bind a bot to an agent (writes channels.octo + bindings(channel=octo))
npx -y openclaw-channel-octo bind --bot-token <T> --api-url <U> --account-id <ID> --agent <agent>

# Batch-create one bot per agent and bind them all
npx -y openclaw-channel-octo quickstart --api-key <user-api-key> --api-url <U>

# Update the plugin to the latest version
npx -y openclaw-channel-octo update

# Diagnose plugin health
npx -y openclaw-channel-octo doctor

# Uninstall (removes plugin + all bot configs under channels.octo)
npx -y openclaw-channel-octo uninstall

# Remove a single bot account (only touches channels.octo)
npx -y openclaw-channel-octo remove-account --account-id my_bot
```

### OpenClaw internal commands

After installation, these commands are available inside OpenClaw:

```
/octo_doctor              # Check plugin status and connectivity
/octo_doctor my_bot       # Check a specific account
```

The legacy `/dmwork_*` aliases keep working for one release cycle and emit a
deprecation hint on every invocation. Prefer the `/octo_*` names.

## Configuration

Bot accounts are stored in `~/.openclaw/openclaw.json` under `channels.octo.accounts`:

```json
{
  "channels": {
    "octo": {
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
- `apiUrl` (required): Octo server API URL
- `wsUrl` (optional): WuKongIM WebSocket URL. Auto-detected if omitted.
- `requireMention` (optional): Only respond when @mentioned in groups
- `historyLimit` (optional): Group chat history message limit (default: 20)

## What it does

1. Registers the bot with the Octo server via REST API
2. Connects to WuKongIM WebSocket for real-time message receiving
3. Auto-reconnects on disconnection
4. Sends a greeting to the bot owner on connect
5. Dispatches incoming messages to OpenClaw's message handler
6. Supports streaming responses (start/send/end), typing indicators, and read receipts

## As an OpenClaw Plugin

The `index.ts` exports a standard OpenClaw plugin object. When loaded by OpenClaw:

- `register(api)` is called automatically
- `api.runtime` is injected for logging and lifecycle management
- `api.registerChannel()` registers the Octo channel plugin
- `api.registerCommand()` registers `/octo_doctor` (and the legacy `/dmwork_doctor` alias)
- Configuration is read from `channels.octo` in OpenClaw's config

The plugin uses the `ChannelPlugin` SDK interface with support for:
- Direct messages and group chats
- Multi-account configuration via `channels.octo.accounts`
- Config hot-reload on `channels.octo` prefix changes

## Disconnect

To disconnect the bot, send `/disconnect` to BotFather in Octo. This invalidates the current IM token and kicks the WebSocket connection.
