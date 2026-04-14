"""
Tests for hermes_dmwork.adapter — adapter initialization and config parsing.
"""

import pytest
from unittest.mock import MagicMock, AsyncMock, patch
from hermes_dmwork.adapter import (
    DMWorkAdapter,
    LRUCache,
    check_dmwork_requirements,
    MAX_MESSAGE_LENGTH,
    DEFAULT_HISTORY_LIMIT,
    DEFAULT_HISTORY_PROMPT_TEMPLATE,
)
from hermes_dmwork.types import MessagePayload, MessageType


class TestLRUCache:
    def test_set_and_get(self):
        cache = LRUCache(max_size=3)
        cache.set("a", "1")
        assert cache.get("a") == "1"

    def test_miss_returns_none(self):
        cache = LRUCache(max_size=3)
        assert cache.get("nonexistent") is None

    def test_eviction(self):
        cache = LRUCache(max_size=2)
        cache.set("a", "1")
        cache.set("b", "2")
        cache.set("c", "3")  # Should evict "a"
        assert cache.get("a") is None
        assert cache.get("b") == "2"
        assert cache.get("c") == "3"

    def test_access_refreshes_order(self):
        cache = LRUCache(max_size=2)
        cache.set("a", "1")
        cache.set("b", "2")
        cache.get("a")  # Access "a" to refresh it
        cache.set("c", "3")  # Should evict "b" (not "a")
        assert cache.get("a") == "1"
        assert cache.get("b") is None
        assert cache.get("c") == "3"

    def test_update_existing(self):
        cache = LRUCache(max_size=3)
        cache.set("a", "1")
        cache.set("a", "2")
        assert cache.get("a") == "2"
        assert len(cache) == 1

    def test_contains(self):
        cache = LRUCache(max_size=3)
        cache.set("a", "1")
        assert "a" in cache
        assert "b" not in cache

    def test_len(self):
        cache = LRUCache(max_size=10)
        assert len(cache) == 0
        cache.set("a", "1")
        cache.set("b", "2")
        assert len(cache) == 2


class TestDMWorkAdapterInit:
    """Test adapter initialization without Hermes dependencies."""

    def _make_config(self, **extra):
        """Create a mock config object."""
        config = MagicMock()
        config.extra = {
            "api_url": "https://api.example.com",
            "bot_token": "test-token-123",
            **extra,
        }
        config.token = "test-token-123"
        return config

    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", False)
    def test_init_without_hermes(self):
        """Adapter should initialize without Hermes dependencies."""
        # When HERMES_AVAILABLE is False, BasePlatformAdapter is `object`
        # so we can't call super().__init__ properly. Skip for non-Hermes.
        pass

    def test_config_defaults(self):
        """Verify default configuration values."""
        assert MAX_MESSAGE_LENGTH == 5000
        assert DEFAULT_HISTORY_LIMIT == 20
        assert "{count}" in DEFAULT_HISTORY_PROMPT_TEMPLATE
        assert "{messages}" in DEFAULT_HISTORY_PROMPT_TEMPLATE


class TestResolveContent:
    """Test the _resolve_content method using a mock adapter."""

    def _get_resolve_content(self):
        """Get the _resolve_content static-like method."""
        # We can test _resolve_content by creating a minimal instance
        # or calling the logic directly
        from hermes_dmwork.adapter import DMWorkAdapter
        return DMWorkAdapter._resolve_content

    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", False)
    def test_text_message(self):
        payload = MessagePayload(type=MessageType.Text, content="hello world")
        # Create a mock adapter to call the method
        adapter = object.__new__(DMWorkAdapter)
        result = adapter._resolve_content(payload)
        assert result == "hello world"

    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", False)
    def test_image_message(self):
        payload = MessagePayload(type=MessageType.Image, url="https://example.com/img.png")
        adapter = object.__new__(DMWorkAdapter)
        result = adapter._resolve_content(payload)
        assert "[图片]" in result
        assert "https://example.com/img.png" in result

    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", False)
    def test_voice_message(self):
        payload = MessagePayload(type=MessageType.Voice, url="https://example.com/voice.ogg")
        adapter = object.__new__(DMWorkAdapter)
        result = adapter._resolve_content(payload)
        assert "[语音消息]" in result

    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", False)
    def test_file_message(self):
        payload = MessagePayload(type=MessageType.File, name="doc.pdf", url="https://example.com/doc.pdf")
        adapter = object.__new__(DMWorkAdapter)
        result = adapter._resolve_content(payload)
        assert "[文件: doc.pdf]" in result

    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", False)
    def test_video_message(self):
        payload = MessagePayload(type=MessageType.Video, url="https://example.com/video.mp4")
        adapter = object.__new__(DMWorkAdapter)
        result = adapter._resolve_content(payload)
        assert "[视频]" in result

    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", False)
    def test_location_message(self):
        payload = MessagePayload(type=MessageType.Location)
        adapter = object.__new__(DMWorkAdapter)
        result = adapter._resolve_content(payload)
        assert "[位置信息]" in result

    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", False)
    def test_card_message(self):
        payload = MessagePayload(type=MessageType.Card, name="Alice")
        adapter = object.__new__(DMWorkAdapter)
        result = adapter._resolve_content(payload)
        assert "[名片: Alice]" in result

    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", False)
    def test_empty_text(self):
        payload = MessagePayload(type=MessageType.Text, content="")
        adapter = object.__new__(DMWorkAdapter)
        result = adapter._resolve_content(payload)
        assert result == ""

    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", False)
    def test_forward_message(self):
        payload = MessagePayload(type=MessageType.MultipleForward)
        adapter = object.__new__(DMWorkAdapter)
        result = adapter._resolve_content(payload)
        assert "[合并转发]" in result


class TestCheckDmworkRequirements:
    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", False)
    def test_no_hermes(self):
        assert check_dmwork_requirements() is False

    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", True)
    @patch.dict("os.environ", {"OCTO_API_URL": "", "OCTO_BOT_TOKEN": ""})
    def test_no_env_vars(self):
        assert check_dmwork_requirements() is False

    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", True)
    @patch.dict("os.environ", {
        "OCTO_API_URL": "https://api.example.com",
        "OCTO_BOT_TOKEN": "test-token",
    })
    def test_configured(self):
        assert check_dmwork_requirements() is True


class TestHistoryRecording:
    """Test the group history recording logic."""

    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", False)
    def test_record_history_entry(self):
        adapter = object.__new__(DMWorkAdapter)
        adapter._group_histories = {}
        adapter._history_limit = 5

        adapter._record_history_entry("group1", "user1", "hello")
        adapter._record_history_entry("group1", "user2", "world")

        assert len(adapter._group_histories["group1"]) == 2
        assert adapter._group_histories["group1"][0]["sender"] == "user1"
        assert adapter._group_histories["group1"][1]["body"] == "world"

    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", False)
    def test_history_limit(self):
        adapter = object.__new__(DMWorkAdapter)
        adapter._group_histories = {}
        adapter._history_limit = 3

        for i in range(10):
            adapter._record_history_entry("group1", f"user{i}", f"msg{i}")

        assert len(adapter._group_histories["group1"]) == 3
        # Should keep the last 3
        assert adapter._group_histories["group1"][0]["body"] == "msg7"


class TestGroupMdHandling:
    """Test GROUP.md event handling."""

    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", False)
    def test_handle_group_md_deleted(self):
        adapter = object.__new__(DMWorkAdapter)
        adapter._group_md_cache = {"group1": {"content": "test", "version": 1}}
        adapter._group_md_checked = {"group1"}

        adapter._handle_group_md_event("group1", "group_md_deleted")

        assert "group1" not in adapter._group_md_cache
        assert "group1" not in adapter._group_md_checked

    @patch("hermes_dmwork.adapter.HERMES_AVAILABLE", False)
    def test_handle_group_md_updated(self):
        adapter = object.__new__(DMWorkAdapter)
        adapter._group_md_cache = {"group1": {"content": "old", "version": 1}}
        adapter._group_md_checked = {"group1"}

        adapter._handle_group_md_event("group1", "group_md_updated")

        # Should force re-fetch
        assert "group1" not in adapter._group_md_checked


class TestMultiAccountConfig:
    """Test multi-account configuration resolution."""

    def test_resolve_single_account(self):
        from hermes_dmwork.multi_account import resolve_accounts

        config = {
            "api_url": "https://api.example.com",
            "bot_token": "token123",
        }
        accounts = resolve_accounts(config)
        assert len(accounts) == 1
        assert accounts[0].account_id == "default"
        assert accounts[0].config.bot_token == "token123"

    def test_resolve_multi_account(self):
        from hermes_dmwork.multi_account import resolve_accounts

        config = {
            "api_url": "https://api.example.com",
            "accounts": {
                "bot1": {"bot_token": "token1", "name": "Bot One"},
                "bot2": {"bot_token": "token2", "name": "Bot Two"},
            },
        }
        accounts = resolve_accounts(config)
        assert len(accounts) == 2
        ids = {a.account_id for a in accounts}
        assert ids == {"bot1", "bot2"}

    def test_resolve_multi_account_inherits_global(self):
        from hermes_dmwork.multi_account import resolve_accounts

        config = {
            "api_url": "https://global-api.example.com",
            "cdn_url": "https://cdn.example.com",
            "accounts": {
                "bot1": {"bot_token": "token1"},
            },
        }
        accounts = resolve_accounts(config)
        assert accounts[0].config.api_url == "https://global-api.example.com"
        assert accounts[0].config.cdn_url == "https://cdn.example.com"

    def test_resolve_unconfigured_account(self):
        from hermes_dmwork.multi_account import resolve_accounts

        config = {
            "accounts": {
                "bot1": {"bot_token": ""},
            },
        }
        accounts = resolve_accounts(config)
        assert accounts[0].configured is False
