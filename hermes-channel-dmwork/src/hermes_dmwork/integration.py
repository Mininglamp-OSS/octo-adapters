"""
Hermes Agent integration code snippets for DMWork platform.

This file contains all the code that needs to be added to the hermes-agent
repository to fully integrate the DMWork adapter. Each section corresponds
to a specific integration point from ADDING_A_PLATFORM.md.

Usage:
    Copy each snippet to the indicated file in the hermes-agent repo.
    Search for "# --- DMWork integration ---" comments in each snippet.

Reference: /tmp/hermes-agent/gateway/platforms/ADDING_A_PLATFORM.md
"""

# ═══════════════════════════════════════════════════════════════════════════════
# Integration Point A: Platform Enum
# File: gateway/config.py
# Location: Inside the `Platform` enum class
# ═══════════════════════════════════════════════════════════════════════════════

PLATFORM_ENUM_SNIPPET = '''
# --- DMWork integration (gateway/config.py) ---
# Add to the Platform enum:

class Platform(Enum):
    # ... existing platforms ...
    DMWORK = "dmwork"
'''

# ═══════════════════════════════════════════════════════════════════════════════
# Integration Point B: Environment Variable Overrides
# File: gateway/config.py
# Location: Inside `_apply_env_overrides()` function
# ═══════════════════════════════════════════════════════════════════════════════

ENV_OVERRIDES_SNIPPET = '''
# --- DMWork integration (gateway/config.py :: _apply_env_overrides) ---
# Add after the last platform's env var block:

# DMWork
dmwork_api_url = os.getenv("OCTO_API_URL")
dmwork_bot_token = os.getenv("OCTO_BOT_TOKEN")
if dmwork_bot_token:
    if Platform.DMWORK not in config.platforms:
        config.platforms[Platform.DMWORK] = PlatformConfig()
    config.platforms[Platform.DMWORK].enabled = True
    config.platforms[Platform.DMWORK].token = dmwork_bot_token
    if not config.platforms[Platform.DMWORK].extra:
        config.platforms[Platform.DMWORK].extra = {}
    config.platforms[Platform.DMWORK].extra["bot_token"] = dmwork_bot_token
    if dmwork_api_url:
        config.platforms[Platform.DMWORK].extra["api_url"] = dmwork_api_url
'''

# ═══════════════════════════════════════════════════════════════════════════════
# Integration Point C: Adapter Factory
# File: gateway/run.py
# Location: Inside `_create_adapter()` function
# ═══════════════════════════════════════════════════════════════════════════════

ADAPTER_FACTORY_SNIPPET = '''
# --- DMWork integration (gateway/run.py :: _create_adapter) ---
# Add as a new elif branch:

elif platform == Platform.DMWORK:
    from hermes_dmwork.adapter import DMWorkAdapter, check_dmwork_requirements
    if not check_dmwork_requirements():
        logger.warning("DMWork: dependencies not met (set OCTO_API_URL and OCTO_BOT_TOKEN)")
        return None
    return DMWorkAdapter(config)
'''

# ═══════════════════════════════════════════════════════════════════════════════
# Integration Point D: Authorization Maps
# File: gateway/run.py
# Location: Inside `_is_user_authorized()` function, in BOTH dicts
# ═══════════════════════════════════════════════════════════════════════════════

AUTHORIZATION_MAPS_SNIPPET = '''
# --- DMWork integration (gateway/run.py :: _is_user_authorized) ---
# Add to platform_env_map:
platform_env_map = {
    # ... existing platforms ...
    Platform.DMWORK: "DMWORK_ALLOWED_USERS",
}

# Add to platform_allow_all_map:
platform_allow_all_map = {
    # ... existing platforms ...
    Platform.DMWORK: "DMWORK_ALLOW_ALL_USERS",
}
'''

# ═══════════════════════════════════════════════════════════════════════════════
# Integration Point E: System Prompt Hints
# File: agent/prompt_builder.py
# Location: Inside the `PLATFORM_HINTS` dict
# ═══════════════════════════════════════════════════════════════════════════════

PROMPT_HINTS_SNIPPET = '''
# --- DMWork integration (agent/prompt_builder.py :: PLATFORM_HINTS) ---
PLATFORM_HINTS = {
    # ... existing platforms ...
    "dmwork": (
        "You are on DMWork, a WuKongIM-based team messaging platform. "
        "DMWork supports basic markdown (bold, italic, links), @mentions, "
        "images, files, voice messages, and video messages. "
        "Messages are limited to ~5000 characters. "
        "For @mentions, use the format @[uid:displayName] and the adapter "
        "will convert it to the correct protocol format. "
        "DMWork does NOT support markdown tables — use bullet lists instead. "
        "Streaming is supported for long responses."
    ),
}
'''

# ═══════════════════════════════════════════════════════════════════════════════
# Integration Point F: Toolset
# File: toolsets.py
# Location: Add new toolset entry + update hermes-gateway includes
# ═══════════════════════════════════════════════════════════════════════════════

TOOLSET_SNIPPET = '''
# --- DMWork integration (toolsets.py) ---

# Add a new toolset entry:
"hermes-dmwork": {
    "description": "DMWork (WuKongIM) bot toolset",
    "tools": _HERMES_CORE_TOOLS,
    "includes": []
},

# Add to hermes-gateway composite:
"hermes-gateway": {
    "includes": [
        # ... existing platform toolsets ...
        "hermes-dmwork",
    ]
}
'''

# ═══════════════════════════════════════════════════════════════════════════════
# Integration Point G: Cron Delivery
# File: cron/scheduler.py
# Location: Inside `_deliver_result()` → `platform_map`
# ═══════════════════════════════════════════════════════════════════════════════

CRON_DELIVERY_SNIPPET = '''
# --- DMWork integration (cron/scheduler.py :: _deliver_result) ---
# Add to platform_map:
platform_map = {
    # ... existing platforms ...
    "dmwork": Platform.DMWORK,
}
'''

# ═══════════════════════════════════════════════════════════════════════════════
# Integration Point H: Send Message Tool
# File: tools/send_message_tool.py
# Location: Inside `send_message_tool()` → `platform_map`,
#           and add `_send_dmwork()` function
# ═══════════════════════════════════════════════════════════════════════════════

SEND_MESSAGE_TOOL_SNIPPET = '''
# --- DMWork integration (tools/send_message_tool.py) ---

# Add to platform_map in send_message_tool():
platform_map = {
    # ... existing platforms ...
    "dmwork": Platform.DMWORK,
}

# Add routing in _send_to_platform():
elif platform == Platform.DMWORK:
    return await _send_dmwork(pconfig, chat_id, message)

# Add standalone send function:
async def _send_dmwork(pconfig: PlatformConfig, chat_id: str, message: str) -> dict:
    """Send a message to DMWork without requiring the full adapter."""
    import aiohttp
    from hermes_dmwork.api import send_message as dmwork_send, ChannelType

    extra = pconfig.extra or {}
    api_url = extra.get("api_url") or os.getenv("OCTO_API_URL", "")
    bot_token = extra.get("bot_token") or pconfig.token or os.getenv("OCTO_BOT_TOKEN", "")

    if not api_url or not bot_token:
        return {"error": "OCTO_API_URL and OCTO_BOT_TOKEN must be configured"}

    async with aiohttp.ClientSession() as session:
        try:
            await dmwork_send(
                session, api_url, bot_token,
                channel_id=chat_id,
                channel_type=ChannelType.Group,
                content=message,
            )
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}
'''

# ═══════════════════════════════════════════════════════════════════════════════
# Integration Point I: Cronjob Tool Schema
# File: tools/cronjob_tools.py
# Location: Update `deliver` parameter description
# ═══════════════════════════════════════════════════════════════════════════════

CRONJOB_TOOL_SCHEMA_SNIPPET = '''
# --- DMWork integration (tools/cronjob_tools.py) ---
# Update the `deliver` parameter description to include "dmwork":
#
# Before: "telegram", "discord", "whatsapp", "slack", "signal"
# After:  "telegram", "discord", "whatsapp", "slack", "signal", "dmwork"
'''

# ═══════════════════════════════════════════════════════════════════════════════
# Integration Point J: Channel Directory
# File: gateway/channel_directory.py
# Location: Session-based discovery list
# ═══════════════════════════════════════════════════════════════════════════════

CHANNEL_DIRECTORY_SNIPPET = '''
# --- DMWork integration (gateway/channel_directory.py) ---
# Add "dmwork" to the session-based discovery list:

for plat_name in ("telegram", "whatsapp", "signal", "dmwork"):
    # ... existing session-based discovery logic ...
'''

# ═══════════════════════════════════════════════════════════════════════════════
# Integration Point K: Status Display
# File: hermes_cli/status.py
# Location: Inside the `platforms` dict in the Messaging Platforms section
# ═══════════════════════════════════════════════════════════════════════════════

STATUS_DISPLAY_SNIPPET = '''
# --- DMWork integration (hermes_cli/status.py) ---
# Add to the platforms dict:

platforms = {
    # ... existing platforms ...
    "DMWork": ("OCTO_BOT_TOKEN", "DMWORK_HOME_CHANNEL"),
}
'''

# ═══════════════════════════════════════════════════════════════════════════════
# Integration Point L: Gateway Setup Wizard
# File: hermes_cli/gateway.py
# Location: Inside the `_PLATFORMS` list
# ═══════════════════════════════════════════════════════════════════════════════

GATEWAY_SETUP_WIZARD_SNIPPET = '''
# --- DMWork integration (hermes_cli/gateway.py) ---
# Add to the _PLATFORMS list:

{
    "key": "dmwork",
    "label": "DMWork",
    "emoji": "💬",
    "token_var": "OCTO_BOT_TOKEN",
    "setup_instructions": [
        "1. Go to your DMWork admin panel",
        "2. Create a new Bot and note the Bot Token",
        "3. Note your API server URL (usually https://api.example.com or self-hosted)",
    ],
    "vars": [
        {"key": "OCTO_BOT_TOKEN", "label": "Bot Token", "secret": True},
        {"key": "OCTO_API_URL", "label": "API URL", "default": "https://api.example.com"},
    ],
}
'''

# ═══════════════════════════════════════════════════════════════════════════════
# Integration Point M: Documentation
# ═══════════════════════════════════════════════════════════════════════════════

DOCUMENTATION_SNIPPET = '''
# --- DMWork integration: Documentation ---
#
# Files to update:
#   README.md — Add DMWork to platform list and feature table
#   AGENTS.md — Add DMWork env vars: OCTO_API_URL, OCTO_BOT_TOKEN,
#               DMWORK_ALLOWED_USERS, DMWORK_ALLOW_ALL_USERS
#   website/docs/user-guide/messaging/dmwork.md — NEW: Full setup guide
#   website/docs/user-guide/messaging/index.md — Add DMWork to architecture diagram
#   website/docs/reference/environment-variables.md — Add all DMWork env vars
'''

# ═══════════════════════════════════════════════════════════════════════════════
# Integration Point N: Tests
# ═══════════════════════════════════════════════════════════════════════════════

TESTS_SNIPPET = '''
# --- DMWork integration: Tests ---
#
# Create tests/gateway/test_dmwork.py with:
#   - Platform enum exists: Platform.DMWORK == "dmwork"
#   - Config loading from OCTO_API_URL / OCTO_BOT_TOKEN env vars
#   - Adapter init: config parsing, default values
#   - Helper functions: mention parsing, content resolution
#   - Send message tool routing: platform in platform_map
#   - Authorization: platform in allowlist maps
#   - COS upload credential handling (mock)
#   - Stream API lifecycle (mock)
'''

# ═══════════════════════════════════════════════════════════════════════════════
# Summary: All integration points for quick reference
# ═══════════════════════════════════════════════════════════════════════════════

INTEGRATION_SUMMARY = {
    "a_platform_enum": {
        "file": "gateway/config.py",
        "change": "Add DMWORK = 'dmwork' to Platform enum",
    },
    "b_env_overrides": {
        "file": "gateway/config.py",
        "change": "Add OCTO_API_URL, OCTO_BOT_TOKEN loading in _apply_env_overrides()",
    },
    "c_adapter_factory": {
        "file": "gateway/run.py",
        "change": "Add DMWorkAdapter branch in _create_adapter()",
    },
    "d_authorization_maps": {
        "file": "gateway/run.py",
        "change": "Add DMWORK_ALLOWED_USERS and DMWORK_ALLOW_ALL_USERS",
    },
    "e_prompt_hints": {
        "file": "agent/prompt_builder.py",
        "change": "Add DMWork platform formatting hints",
    },
    "f_toolset": {
        "file": "toolsets.py",
        "change": "Add hermes-dmwork toolset + update hermes-gateway includes",
    },
    "g_cron_delivery": {
        "file": "cron/scheduler.py",
        "change": "Add 'dmwork': Platform.DMWORK to platform_map",
    },
    "h_send_message_tool": {
        "file": "tools/send_message_tool.py",
        "change": "Add dmwork routing + _send_dmwork() function",
    },
    "i_cronjob_schema": {
        "file": "tools/cronjob_tools.py",
        "change": "Add 'dmwork' to deliver parameter description",
    },
    "j_channel_directory": {
        "file": "gateway/channel_directory.py",
        "change": "Add 'dmwork' to session-based discovery list",
    },
    "k_status_display": {
        "file": "hermes_cli/status.py",
        "change": "Add DMWork to platforms dict",
    },
    "l_gateway_wizard": {
        "file": "hermes_cli/gateway.py",
        "change": "Add DMWork setup config to _PLATFORMS list",
    },
    "m_documentation": {
        "files": [
            "README.md", "AGENTS.md",
            "website/docs/user-guide/messaging/dmwork.md",
            "website/docs/user-guide/messaging/index.md",
            "website/docs/reference/environment-variables.md",
        ],
        "change": "Add DMWork documentation",
    },
    "n_tests": {
        "file": "tests/gateway/test_dmwork.py",
        "change": "Add DMWork adapter test suite",
    },
}


def print_integration_guide() -> None:
    """Print a human-readable integration guide."""
    print("=" * 80)
    print("DMWork → Hermes Agent Integration Guide")
    print("=" * 80)
    print()
    for key, info in INTEGRATION_SUMMARY.items():
        label = key.upper()
        files = info.get("files", [info.get("file", "")])
        change = info["change"]
        print(f"  [{label}] {change}")
        for f in files:
            print(f"         → {f}")
        print()
    print("=" * 80)
    print("Copy snippets from this file to the indicated locations in hermes-agent.")
    print("Each snippet is marked with '# --- DMWork integration ---' comments.")
    print("=" * 80)


if __name__ == "__main__":
    print_integration_guide()
