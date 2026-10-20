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

## MCP migration for bound Bots

Requires a matching Octo plugin with `octo-mcp` credential resolution and
an OpenClaw host >= 2026.9.8 supporting `registerMcpServerConnectionResolver`.
MCP checks reject older or unrecognized host versions before probing or saving.

**Users do not supply the MCP address.** The release/deployment pipeline sets
`OCTO_MCP_URL` when building both this tool and the channel plugin:

```bash
# Release operator only, in each package's directory.
OCTO_MCP_URL=https://mcp.example.com/ npm run build
```

The build ships the public endpoint inside both artifacts. The plugin also
ships a native MCP server declaration, so existing accounts can use the service
without manually adding a URL. Normal user commands remain:

```bash
npx -y create-openclaw-octo update
npx -y create-openclaw-octo bind --bot-token bf_example \
  --api-url https://octo.example.com --account-id my_bot --agent my_agent
npx -y create-openclaw-octo mcp --check
```

The runtime binding tool may also read the operator's `OCTO_MCP_URL` in hosted
installations. Explicit operator `--mcp-url` and runtime environment overrides
take precedence, followed by saved deployment settings and the bundled default.
Users need no such overrides. A server's environment variable is not sent over
the network to user machines; the release build carries the configured value.
No formal URL is hardcoded in source. Unconfigured source builds retain channel
behavior and explain that MCP is not enabled; invalid configured URLs fail.
An empty or unset build variable clears the bundled default. Supply the intended
endpoint for every deployment build, including repacking.

The deployment endpoint must be HTTPS, or loopback HTTP for local verification,
without embedded credentials, query or fragment. An explicitly disabled service
stays disabled unless an operator supplies an override. Migration is idempotent
and preserves Bot tokens, channel settings, bindings and unrelated MCP entries.
Named accounts need their own tokens and explicit Agent bindings; ambiguous
accounts and explicit tool denials stop migration. Without an explicit Agent roster, only the host's implicit main Agent is supported; migration materializes a host-supported agents.entries.main entry and stores its policy there, preserving agents.defaults. Stale bindings to deleted accounts are reported and skipped; ambiguous accounts and unknown Agents still fail closed.

The default service is declared in the plugin manifest under `octo-mcp`.
It is not copied into user configuration, so future plugin releases can change
the deployment default automatically. Explicit operator overrides use
`mcp.servers.octo-mcp` with
`transport: "streamable-http"`. Static headers/authentication, client certificates/keys and disabled TLS verification are rejected:
the plugin injects the receiving Bot's token per request. Migration extends a bound Agent's explicit `tools.allow` with `bundle-mcp`,
or uses `tools.alsoAllow` when no explicit allow list exists; it never combines
those mutually exclusive settings and preserves existing denial rules.
The host's MCP bundle may include other configured servers; review their access
and tool filters as part of enabling it. This does not switch every existing
CLI workflow: keep CLI for deferred document/PPT and binary paths.

Before writing a normal binding or migration, the tool initializes the HTTP
service and discovers either the two-tool or three-tool facade for configured
enabled accounts. `bind` scopes both account/Agent migration and probing to the account being bound, so stale credentials
on another account do not block it; `mcp --check` checks every bound account.
A saved binding remains successful if Gateway refresh needs manual recovery;
the command prints a warning with the recovery steps. It does not call business tools or prove runtime identity.
After reload, send a real task through each Bot to verify credential routing
and channel health. `quickstart` creates Bots remotely; it saves their issued
credentials before MCP network checks, so a network failure must not trigger a
blind rerun that creates duplicate Bots. These flags require this source version
to be released; they are absent from older published tools.

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

- `botToken` (required): Bot token. Either a User Bot token from BotFather (`bf_` prefix, full group + thread access) or an App Bot token from the Octo admin console (`app_` prefix, direct-message only — server-enforced).
- `apiUrl` (required): Octo server API URL
- `wsUrl` (optional): WuKongIM WebSocket URL. Auto-detected if omitted.
- `requireMention` (optional): Only respond when @mentioned in groups
- `historyLimit` (optional): Group chat history message limit (default: 20)

## Reporting issues

- CLI issues (install / bind / quickstart / doctor behavior): [octo-adapters](https://github.com/Mininglamp-OSS/octo-adapters/issues)
- Plugin runtime issues (message routing, message delivery, group/DM logic): [openclaw-channel-octo](https://github.com/Mininglamp-OSS/openclaw-channel-octo/issues)

Discovery resolves Bot credential templates from the current process, trusted
state `.env`, managed `gateway.env`, and configured `env` values. It supports
`${VAR}` and `${VAR:-fallback}` without saving expanded credentials. It deliberately
does not read workspace `.env` files: their trust rules vary with the host version.
Launch the migration with the Gateway's credential environment when credentials
exist only in a workspace file. With provider tool policies, an implicit or
ambiguous model must be made explicit before static policy checks can pass;
runtime session policy still requires a real Bot task after reload.

### Applying MCP configuration changes

Normal plugin update uses OpenClaw's supported Gateway restart. The MCP migration
and binding commands also request a restart after successful checks and saved
configuration when a Gateway is running, so cached addresses and credentials are
not reused. Active Bot connections may briefly reconnect. `mcp --check` never
writes configuration or restarts. If no Gateway is running, the saved settings
apply at its next start. A restart failure is reported separately from saved
configuration: run `openclaw gateway restart`, then `mcp --check` and a real Bot
task; do not repeat bind/quickstart to recreate Bots. No OpenClaw source patch is
required by this workflow. Direct manual config edits still follow the host's
normal cache lifecycle and may require the same restart.

Migration checks only enabled accounts referenced by explicit Octo bindings. Unbound
credentials are not probed. Before bind/migration writes a checked snapshot, it
compares the current configuration and refuses to overwrite changes made during
network validation; retry against the latest file if that comparison fails. An
unchanged existing configuration is backed up before a guarded write. This is an
optimistic snapshot check, not a cross-process lock: run configuration-changing
CLI commands serially, and avoid concurrent writers between comparison and rename.
If quickstart
has issued Bots but a concurrent edit rejects the write, their credentials are
retained in a uniquely named private recovery JSON next to the configuration.
Restore those existing accounts after resolving the conflict; do not rerun
quickstart to create duplicate Bots. The command never prints their tokens.

Migration preserves inherited global `alsoAllow` instead of copying it into an
Agent override. Later global grants and revocations continue to apply. Existing
Agent-local policies are extended only at their own scope. A restrictive inherited
profile without MCP access requires an explicit operator grant; migration does
not silently replace the profile or pin global permissions to an Agent.
Each bound account is checked against its own discovered two-tool or three-tool
catalog; canonical account collisions and malformed policy lists are rejected.

Supported Node 18/19 runtimes use a restricted dotenv parser when `util.parseEnv`
is unavailable. Trusted credential files support assignments, optional `export`,
quotes and comments; they never execute shell expressions or interpolate values.

If plugin installation succeeds but MCP migration fails, the command reports those
stages separately and remains unsuccessful for MCP. `doctor --fix` retains an MCP
warning and continues its remaining checks after a completed plugin installation.
Recover with `mcp` after fixing configuration or connectivity; do not recreate Bots.

For release verification against an installed public MCP-capable OpenClaw package,
run `npm run build` then `npm run check:mcp-host -- /path/to/openclaw`. This
pure-memory regression validates the migrated implicit-main schema and compares
global/provider allow controls with the host's actual policy expansion. It reads
only package code and synthetic fixtures; it does not load user configuration,
start a Gateway, or contact a business service.

### Retained MCP settings after removal

Uninstalling the channel or removing its last account intentionally retains the
operator's `mcp.servers.octo-mcp` override and Agent `bundle-mcp` grants. Those
grants may serve other MCP servers, so the tool cannot safely infer ownership.
If Octo is no longer needed, remove its server override and review each Agent's
MCP grants manually; preserve permissions needed by other servers.
