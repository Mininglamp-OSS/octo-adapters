"""
Multi-account support for DMWork adapter.

Allows configuring multiple bot tokens, each with independent
WebSocket connections and message processing.

Reference: openclaw-channel-dmwork/src/accounts.ts
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclass
class DMWorkAccountConfig:
    """Configuration for a single DMWork bot account."""
    account_id: str
    bot_token: str
    api_url: str = ""
    name: Optional[str] = None
    enabled: bool = True
    require_mention: bool = True
    history_limit: int = 20
    stream_threshold: int = 500
    cdn_url: Optional[str] = None


@dataclass
class ResolvedAccount:
    """Resolved account configuration with all defaults applied."""
    account_id: str
    name: Optional[str]
    enabled: bool
    configured: bool
    config: AccountSettings


@dataclass
class AccountSettings:
    """Resolved settings for an account."""
    bot_token: str
    api_url: str
    cdn_url: Optional[str] = None
    require_mention: bool = True
    history_limit: int = 20
    stream_threshold: int = 500


DEFAULT_API_URL = "http://localhost:8090"
DEFAULT_ACCOUNT_ID = "default"


def resolve_accounts(config: dict[str, Any]) -> list[ResolvedAccount]:
    """
    Resolve account configurations from a config dict.

    Supports two formats:
    1. Single account: {api_url, bot_token, ...}
    2. Multi-account: {accounts: {id1: {bot_token, ...}, id2: {...}}}

    Returns:
        List of resolved accounts.
    """
    accounts_config = config.get("accounts")

    if accounts_config and isinstance(accounts_config, dict):
        # Multi-account mode
        results = []
        global_api_url = config.get("api_url", DEFAULT_API_URL)
        global_cdn_url = config.get("cdn_url")

        for account_id, acct_cfg in accounts_config.items():
            if not isinstance(acct_cfg, dict):
                continue

            bot_token = acct_cfg.get("bot_token", "")
            api_url = acct_cfg.get("api_url", global_api_url)

            results.append(ResolvedAccount(
                account_id=account_id,
                name=acct_cfg.get("name"),
                enabled=acct_cfg.get("enabled", True),
                configured=bool(bot_token),
                config=AccountSettings(
                    bot_token=bot_token,
                    api_url=api_url,
                    cdn_url=acct_cfg.get("cdn_url", global_cdn_url),
                    require_mention=acct_cfg.get("require_mention", True),
                    history_limit=acct_cfg.get("history_limit", 20),
                    stream_threshold=acct_cfg.get("stream_threshold", 500),
                ),
            ))
        return results

    # Single account mode
    bot_token = config.get("bot_token") or os.getenv("OCTO_BOT_TOKEN", "")
    api_url = config.get("api_url") or os.getenv("OCTO_API_URL", DEFAULT_API_URL)

    return [ResolvedAccount(
        account_id=DEFAULT_ACCOUNT_ID,
        name=config.get("name"),
        enabled=config.get("enabled", True),
        configured=bool(bot_token),
        config=AccountSettings(
            bot_token=bot_token,
            api_url=api_url,
            cdn_url=config.get("cdn_url"),
            require_mention=config.get("require_mention", True),
            history_limit=config.get("history_limit", 20),
            stream_threshold=config.get("stream_threshold", 500),
        ),
    )]


class MultiAccountManager:
    """
    Manages multiple DMWork bot accounts.

    Each account gets its own DMWorkAdapter instance with independent
    WebSocket connection and message processing.
    """

    def __init__(self) -> None:
        self._adapters: dict[str, Any] = {}  # account_id → DMWorkAdapter
        self._accounts: dict[str, ResolvedAccount] = {}

    @property
    def accounts(self) -> dict[str, ResolvedAccount]:
        return dict(self._accounts)

    @property
    def adapters(self) -> dict[str, Any]:
        return dict(self._adapters)

    async def start(self, config: dict[str, Any]) -> int:
        """
        Start all configured accounts.

        Returns:
            Number of successfully connected accounts.
        """
        from hermes_dmwork.adapter import DMWorkAdapter

        accounts = resolve_accounts(config)
        connected = 0

        for account in accounts:
            if not account.enabled or not account.configured:
                logger.info(
                    "DMWork account %s: skipped (enabled=%s, configured=%s)",
                    account.account_id, account.enabled, account.configured,
                )
                continue

            self._accounts[account.account_id] = account

            try:
                # Create a PlatformConfig-like object for the adapter
                adapter_config = type("PlatformConfig", (), {
                    "extra": {
                        "api_url": account.config.api_url,
                        "bot_token": account.config.bot_token,
                        "require_mention": account.config.require_mention,
                        "history_limit": account.config.history_limit,
                        "stream_threshold": account.config.stream_threshold,
                    },
                    "token": account.config.bot_token,
                    "enabled": True,
                })()

                adapter = DMWorkAdapter(adapter_config)
                success = await adapter.connect()

                if success:
                    self._adapters[account.account_id] = adapter
                    connected += 1
                    logger.info(
                        "DMWork account %s (%s): connected",
                        account.account_id, account.name or "unnamed",
                    )
                else:
                    logger.error(
                        "DMWork account %s: connection failed",
                        account.account_id,
                    )
            except Exception as e:
                logger.error(
                    "DMWork account %s: startup error: %s",
                    account.account_id, e,
                )

        return connected

    async def stop(self) -> None:
        """Stop all running accounts."""
        for account_id, adapter in self._adapters.items():
            try:
                await adapter.disconnect()
                logger.info("DMWork account %s: disconnected", account_id)
            except Exception as e:
                logger.error("DMWork account %s: disconnect error: %s", account_id, e)

        self._adapters.clear()
        self._accounts.clear()

    def get_adapter(self, account_id: str = DEFAULT_ACCOUNT_ID) -> Optional[Any]:
        """Get the adapter for a specific account."""
        return self._adapters.get(account_id)
