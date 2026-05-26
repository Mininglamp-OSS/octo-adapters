# create-openclaw-octo

CLI tools for the [OpenClaw Octo channel plugin](https://github.com/Mininglamp-OSS/openclaw-channel-octo).

> **What this package is**: a thin CLI (`install` / `bind` / `quickstart` / `doctor` / `uninstall` / `remove-account`) that manages installation, configuration, and diagnostics for the Octo channel plugin.
>
> **What this package is NOT**: it does not contain the plugin source itself. The plugin lives in its own repository at [Mininglamp-OSS/openclaw-channel-octo](https://github.com/Mininglamp-OSS/openclaw-channel-octo) and is distributed via ClawHub.

> **Renamed from `openclaw-channel-octo`** (npm).
> The old npm package name has been replaced by `create-openclaw-octo`. The legacy npm name will print a redirect notice; please use `npx -y create-openclaw-octo ...` going forward.
>
> If you previously installed the old name globally (`npm i -g openclaw-channel-octo`), the `openclaw-channel-octo` shim binary on your `$PATH` will not be updated by the rename. Remove it with `npm uninstall -g openclaw-channel-octo` and switch to the `npx -y create-openclaw-octo ...` workflow above. (No global install of the new name is needed; `npx` always fetches the latest.)

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
# 1. Install the plugin (downloads from ClawHub, performs legacy migration if needed)
npx -y create-openclaw-octo install

# 2. Bind a bot to an agent
npx -y create-openclaw-octo bind \
  --bot-token bf_your_token_here \
  --api-url https://your-server.example/api \
  --account-id my_bot \
  --agent your_agent_id
```

`install` flags:

- `--force`: reinstall even if already installed
- `--from <spec>`: install from a local tarball or alternate `openclaw plugins install` spec (pre-publish local testing)

## CLI Commands

```bash
# Install/update the plugin (no bot config)
npx -y create-openclaw-octo install

# Bind a bot to an agent (writes channels.octo + bindings(channel=octo))
npx -y create-openclaw-octo bind --bot-token <T> --api-url <U> --account-id <ID> --agent <agent>

# Batch-create one bot per agent and bind them all
npx -y create-openclaw-octo quickstart --api-key <user-api-key> --api-url <U>

# Update the plugin to the latest version
npx -y create-openclaw-octo update

# Diagnose plugin health
npx -y create-openclaw-octo doctor

# Uninstall (removes plugin + all bot configs under channels.octo)
npx -y create-openclaw-octo uninstall

# Remove a single bot account (only touches channels.octo)
npx -y create-openclaw-octo remove-account --account-id my_bot
```

## Legacy / migration

Users on older installations will be auto-migrated on first `install`:

| Detected state | Action |
|---|---|
| ClawHub octo (current) | No-op or version update |
| npm 1.0.0 (`openclaw-channel-octo`) | Migrate to ClawHub install; preserve `channels.octo.accounts` |
| dmwork 0.6.x (`openclaw-channel-dmwork` / `dmwork`) | Migrate channel ID `dmwork` → `octo`; rewrite bindings; preserve bot accounts |

For non-`install` commands (`bind`, `quickstart`, etc.) running on a legacy plugin install, the CLI prints a clear upgrade prompt and exits — there is no silent legacy-write path. Run `install` once to migrate, then re-run the original command.

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

## Reporting issues

- CLI issues (install / bind / quickstart / doctor behavior): [octo-adapters](https://github.com/Mininglamp-OSS/octo-adapters/issues)
- Plugin runtime issues (message routing, message delivery, group/DM logic): [openclaw-channel-octo](https://github.com/Mininglamp-OSS/openclaw-channel-octo/issues)
