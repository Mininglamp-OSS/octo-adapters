# claude-code-dmwork (WebSocket Gateway)

A WebSocket-based gateway that connects [Claude Agent SDK](https://github.com/anthropics/claude-code) to DMWork messaging via the [WuKongIM](https://github.com/WuKongIM/WuKongIM) protocol.

## How It Works

```
DMWork Users ←→ WuKongIM WebSocket ←→ Gateway ←→ Claude Agent SDK
```

The gateway maintains a persistent WebSocket connection to WuKongIM, receives messages in real-time, routes them to Claude Code for processing, and sends replies back via the DMWork Bot REST API.

### vs. claude-code-dmwork (Polling)

The existing `claude-code-dmwork` adapter in this repo uses a bash polling script. This gateway differs in:

| | Polling Adapter | WebSocket Gateway |
|---|---|---|
| Protocol | REST polling | WuKongIM binary WebSocket |
| Latency | Poll interval (seconds) | Real-time (< 100ms) |
| Session | Stateless | Persistent with history |
| Group chat | Not supported | Full support (context + @mention) |
| Runtime | Bash + Claude Code skill | Node.js + Claude Agent SDK |
| Encryption | None | DH key exchange + AES-CBC |

## Prerequisites

- Node.js >= 18
- A DMWork server with BotFather enabled
- A bot token from BotFather
- Claude Code CLI installed and authenticated

## Setup

```bash
# Install dependencies
npm install

# Copy and edit config
cp config.example.json config.json
# Edit config.json with your bot token and API URL

# Run in development mode
npm run dev

# Or build and run
npm run build
npm start
```

## Configuration

| Field | Description |
|---|---|
| `botToken` | Bot token from BotFather |
| `apiUrl` | DMWork API base URL |
| `cwd` | Working directory for Claude Code (loads CLAUDE.md, skills, etc.) |
| `sdk.settingSources` | Which Claude Code settings to load: `"user"`, `"project"`, `"local"` |
| `sdk.allowedTools` | Tools the agent can use (e.g., `["Read", "Glob", "Grep"]`) |
| `sdk.permissionMode` | `"bypassPermissions"` for headless, `"acceptEdits"` for semi-auto |
| `sdk.maxTurns` | Max conversation turns per request (optional) |
| `sdk.systemPrompt` | Custom system prompt (optional, uses built-in default if omitted) |

### Security Note

Since the gateway runs headless, `bypassPermissions` is typically required. Be aware of the following:

**Tool restrictions**: Carefully restrict `allowedTools` to limit what the agent can do. Avoid including `Bash` unless you fully trust all users who can message the bot. Even `Write` and `Edit` allow file modifications within `cwd`.

**Settings loading**: The default `settingSources: ["user", "project"]` loads both user-level (`~/.claude`) and project-level (`cwd/.claude`) settings, including `CLAUDE.md` files, skills, and custom system prompts. This means:
- Any persona or behavior defined in `CLAUDE.md` will apply to bot responses
- Project-level skills will be available to the agent

If the bot is shared with untrusted users, consider:
- Setting `settingSources: []` to disable all external settings
- Providing an explicit `sdk.systemPrompt` for full control over bot behavior
- Using a dedicated `cwd` directory instead of a personal project

## Features

- **DM + Group Chat**: Responds to direct messages and @mentions in groups
- **Session Persistence**: Maintains conversation history per peer (sliding window of 40 messages)
- **Group Context**: Caches recent group messages and member mappings for context-aware replies
- **Auto-Reconnect**: Handles WS disconnections and token expiry with automatic recovery
- **Typing Indicators**: Shows typing status while Claude processes
- **Streaming Replies**: Incremental response delivery via DMWork stream API, with fallback to regular messages
- **Process Lock**: Prevents multiple gateway instances for the same bot

## Architecture

```
src/
├── index.ts              # Entry point
├── config.ts             # Config loader (file + env vars)
├── gateway.ts            # Core: message routing + Claude SDK integration
├── session-store.ts      # Conversation history persistence
├── group-context.ts      # Group chat context cache + member resolution
└── dmwork/
    ├── socket.ts          # WuKongIM binary protocol (DH, AES, heartbeat)
    ├── api.ts             # DMWork Bot REST API client
    ├── types.ts           # Type definitions
    └── mentions.ts        # @mention parsing
```

## Environment Variables

These override `config.json` for connection settings:

| Variable | Description |
|---|---|
| `OCTO_BOT_TOKEN` | Bot token |
| `OCTO_API_URL` | API base URL |
| `DMWORK_CWD` | Working directory for Claude Code |

## License

MIT
