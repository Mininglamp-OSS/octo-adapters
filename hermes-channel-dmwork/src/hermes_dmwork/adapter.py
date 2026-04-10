"""
DMWork platform adapter for Hermes Agent.

Connects to DMWork (WuKongIM-based) messaging platform via WebSocket
binary protocol. Implements the BasePlatformAdapter interface for
message reception and sending.

Usage:
    Set OCTO_API_URL and OCTO_BOT_TOKEN environment variables,
    then register the adapter with the Hermes gateway.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import random
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional

import aiohttp
import websockets
import websockets.exceptions

from hermes_dmwork import api
from hermes_dmwork.mention import extract_mention_uids, convert_content_for_llm
from hermes_dmwork.protocol import (
    PROTO_VERSION,
    PacketType,
    aes_decrypt,
    compute_shared_secret,
    decode_packet,
    derive_aes_key,
    encode_connect_packet,
    encode_ping_packet,
    encode_recvack_packet,
    generate_device_id,
    generate_keypair,
    try_unpack_one,
)
from hermes_dmwork.types import (
    BotMessage,
    BotRegisterResp,
    ChannelType,
    MessagePayload,
    MessageType as DMWorkMessageType,
)

# Import Hermes base classes
# These are from the hermes-agent gateway package
try:
    from gateway.config import Platform, PlatformConfig
    from gateway.platforms.base import (
        BasePlatformAdapter,
        MessageEvent,
        MessageType,
        SendResult,
    )
    from gateway.session import SessionSource

    HERMES_AVAILABLE = True
except ImportError:
    HERMES_AVAILABLE = False
    # Provide stubs for standalone usage / testing
    Platform = None  # type: ignore[assignment, misc]
    PlatformConfig = None  # type: ignore[assignment, misc]
    BasePlatformAdapter = object  # type: ignore[assignment, misc]
    MessageEvent = None  # type: ignore[assignment, misc]
    MessageType = None  # type: ignore[assignment, misc]
    SendResult = None  # type: ignore[assignment, misc]
    SessionSource = None  # type: ignore[assignment, misc]

logger = logging.getLogger(__name__)

MAX_MESSAGE_LENGTH = 5000  # DMWork text message length limit

# Reconnect parameters
RECONNECT_BASE_DELAY = 3.0  # seconds
RECONNECT_MAX_DELAY = 60.0  # seconds
HEARTBEAT_INTERVAL = 60  # seconds (matches SDK default)
PING_MAX_RETRY = 3

# Cache parameters
GROUP_CACHE_EXPIRY_MS = 60 * 60 * 1000  # 1 hour
NAME_CACHE_MAX_SIZE = 1000  # LRU cache max entries

# History
DEFAULT_HISTORY_LIMIT = 20
DEFAULT_HISTORY_PROMPT_TEMPLATE = (
    "[Recent chat history ({count} messages)]\n{messages}\n---\n"
)


def check_dmwork_requirements() -> bool:
    """Check if DMWork dependencies are available and configured."""
    if not HERMES_AVAILABLE:
        return False
    api_url = os.getenv("OCTO_API_URL")
    bot_token = os.getenv("OCTO_BOT_TOKEN")
    if not api_url or not bot_token:
        return False
    return True


class LRUCache:
    """Simple LRU cache backed by OrderedDict."""

    def __init__(self, max_size: int = 1000) -> None:
        self._cache: OrderedDict[str, str] = OrderedDict()
        self._max_size = max_size

    def get(self, key: str) -> Optional[str]:
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        return None

    def set(self, key: str, value: str) -> None:
        if key in self._cache:
            self._cache.move_to_end(key)
        self._cache[key] = value
        while len(self._cache) > self._max_size:
            self._cache.popitem(last=False)

    def __contains__(self, key: str) -> bool:
        return key in self._cache

    def __len__(self) -> int:
        return len(self._cache)


class DMWorkAdapter(BasePlatformAdapter):
    """
    DMWork (WuKongIM) platform adapter.

    Connects to the DMWork messaging platform via:
    1. HTTP API for bot registration and message sending
    2. WuKongIM WebSocket binary protocol for real-time message reception

    Features:
    - ECDH key exchange (Curve25519) + AES-128-CBC encryption
    - Automatic heartbeat (PING/PONG)
    - Automatic reconnection with exponential backoff + jitter
    - Sticky packet handling for WuKongIM binary frames
    - RECVACK for reliable message delivery
    - Media upload via COS (Phase 2)
    - Reply context parsing (Phase 2)
    - Group history injection (Phase 2)
    - Read receipts (Phase 2)
    - Streaming response support (Phase 2)
    - Sender name resolution with LRU cache (Phase 2)
    - GROUP.md support (Phase 3)
    - Multi-account support (Phase 3)
    """

    MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH

    def __init__(self, config: PlatformConfig) -> None:
        # Register as a custom platform — DMWORK is not in the standard
        # Hermes Platform enum, so we use the string-based approach
        super().__init__(config, Platform.DMWORK if hasattr(Platform, "DMWORK") else Platform.WEBHOOK)

        extra = config.extra or {}
        self._api_url: str = extra.get("api_url") or os.getenv("OCTO_API_URL", "")
        self._bot_token: str = extra.get("bot_token") or os.getenv("OCTO_BOT_TOKEN", "")

        # Connection state
        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._http_session: Optional[aiohttp.ClientSession] = None
        self._registration: Optional[BotRegisterResp] = None

        # Crypto state (set after CONNACK)
        self._aes_key: str = ""
        self._aes_iv: str = ""
        self._dh_private_key: Optional[bytes] = None
        self._server_version: int = 0

        # Tasks
        self._recv_task: Optional[asyncio.Task] = None
        self._heartbeat_task: Optional[asyncio.Task] = None

        # Reconnection
        self._need_reconnect: bool = True
        self._reconnect_attempts: int = 0
        self._connected: bool = False

        # Heartbeat
        self._ping_retry_count: int = 0

        # Sticky packet buffer
        self._temp_buffer: bytearray = bytearray()

        # Bot identity (populated after registration)
        self._robot_id: str = ""

        # ── Phase 2: Sender name resolution ──
        self._name_cache = LRUCache(max_size=NAME_CACHE_MAX_SIZE)
        # uid → displayName reverse map for group member lookup
        self._uid_to_name: dict[str, str] = {}
        # displayName → uid for mention resolution
        self._member_map: dict[str, str] = {}
        # group_no → last_fetched_at (ms)
        self._group_cache_timestamps: dict[str, int] = {}

        # ── Phase 2: Group history ──
        # channel_id → list of history entries
        self._group_histories: dict[str, list[dict[str, Any]]] = {}
        # channel_id → True if history has been fetched from API at least once
        self._history_fetched: set[str] = set()

        # ── Phase 2: Streaming config ──
        self._stream_threshold: int = extra.get("stream_threshold", 500)

        # ── Phase 3: GROUP.md cache ──
        # channel_id → {content: str, version: int}
        self._group_md_cache: dict[str, dict[str, Any]] = {}
        # channel_id → True if GROUP.md has been checked this session
        self._group_md_checked: set[str] = set()

        # ── Phase 2: History config ──
        self._history_limit: int = extra.get("history_limit", DEFAULT_HISTORY_LIMIT)
        self._require_mention: bool = extra.get("require_mention", True)

    @property
    def name(self) -> str:
        return "DMWork"

    # ── Connection Lifecycle ──────────────────────────────────────────────

    async def connect(self) -> bool:
        """
        Connect to DMWork.

        Steps:
        1. Create HTTP session
        2. Call registerBot API to get ws_url and im_token
        3. Establish WebSocket connection
        4. Send CONNECT frame with ECDH public key
        5. Wait for CONNACK (derives AES key from shared secret)
        6. Start heartbeat and message receive loops
        """
        if not self._api_url or not self._bot_token:
            logger.error("[%s] OCTO_API_URL and OCTO_BOT_TOKEN must be set", self.name)
            return False

        self._http_session = aiohttp.ClientSession()
        self._need_reconnect = True

        try:
            return await self._do_connect()
        except Exception as e:
            logger.error("[%s] Connection failed: %s", self.name, e)
            return False

    async def _do_connect(self) -> bool:
        """Internal connection logic. Returns True on success."""
        if not self._http_session:
            self._http_session = aiohttp.ClientSession()

        # Step 1: Register bot
        try:
            self._registration = await api.register_bot(
                self._http_session,
                self._api_url,
                self._bot_token,
                force_refresh=(self._reconnect_attempts > 0),
            )
            self._robot_id = self._registration.robot_id
            logger.info(
                "[%s] Bot registered: robot_id=%s",
                self.name,
                self._robot_id,
            )
        except Exception as e:
            logger.error("[%s] Bot registration failed: %s", self.name, e)
            raise

        # Step 2: Connect WebSocket
        ws_url = self._registration.ws_url
        try:
            self._ws = await websockets.connect(
                ws_url,
                max_size=None,
                ping_interval=None,  # We handle heartbeat ourselves
                ping_timeout=None,
            )
        except Exception as e:
            logger.error("[%s] WebSocket connection failed: %s", self.name, e)
            raise

        # Step 3: Send CONNECT frame with ECDH key exchange
        self._temp_buffer = bytearray()
        priv_key, pub_key = generate_keypair()
        self._dh_private_key = priv_key
        pub_key_b64 = base64.b64encode(pub_key).decode("ascii")

        device_id = generate_device_id() + "W"
        connect_packet = encode_connect_packet(
            version=PROTO_VERSION,
            device_flag=0,  # 0 = app/bot
            device_id=device_id,
            uid=self._registration.robot_id,
            token=self._registration.im_token,
            client_timestamp=int(time.time() * 1000),
            client_key=pub_key_b64,
        )
        await self._ws.send(connect_packet)

        # Step 4: Wait for CONNACK
        connack_success = False

        try:
            raw = await asyncio.wait_for(self._ws.recv(), timeout=10.0)
        except asyncio.TimeoutError:
            logger.error("[%s] Timeout waiting for CONNACK", self.name)
            await self._ws.close()
            raise RuntimeError("CONNACK timeout")

        data = raw if isinstance(raw, bytes) else raw.encode("latin-1")
        self._temp_buffer.extend(data)

        # Process buffered data
        while self._temp_buffer:
            frame, self._temp_buffer = try_unpack_one(self._temp_buffer)
            if frame is None:
                break

            pkt_type, result = decode_packet(frame)
            if pkt_type == PacketType.CONNACK:
                if result.reason_code == 1:
                    # Success — derive AES key
                    server_pub_key = base64.b64decode(result.server_key)
                    shared_secret = compute_shared_secret(self._dh_private_key, server_pub_key)
                    self._aes_key = derive_aes_key(shared_secret)
                    salt = result.salt
                    self._aes_iv = salt[:16] if salt and len(salt) > 16 else salt
                    self._server_version = result.server_version

                    self._connected = True
                    self._ping_retry_count = 0
                    self._reconnect_attempts = 0
                    connack_success = True
                    logger.info(
                        "[%s] Connected (server_version=%d)",
                        self.name,
                        self._server_version,
                    )
                elif result.reason_code == 0:
                    logger.error("[%s] Kicked by server", self.name)
                    self._need_reconnect = False
                    raise RuntimeError("Kicked by server")
                else:
                    logger.error("[%s] Connect failed: reasonCode=%d", self.name, result.reason_code)
                    raise RuntimeError(f"Connect failed: reasonCode={result.reason_code}")

        if not connack_success:
            raise RuntimeError("CONNACK not received")

        # Step 5: Start heartbeat and receive loops
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        self._recv_task = asyncio.create_task(self._receive_loop())

        self._mark_connected()
        return True

    async def disconnect(self) -> None:
        """Disconnect from DMWork and clean up resources."""
        self._need_reconnect = False
        self._connected = False

        # Cancel tasks
        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            self._heartbeat_task = None

        if self._recv_task and not self._recv_task.done():
            self._recv_task.cancel()
            try:
                await self._recv_task
            except asyncio.CancelledError:
                pass
            self._recv_task = None

        # Close WebSocket
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None

        # Close HTTP session
        if self._http_session:
            await self._http_session.close()
            self._http_session = None

        self._mark_disconnected()
        logger.info("[%s] Disconnected", self.name)

    # ── Sender Name Resolution (Phase 2) ──────────────────────────────────

    async def _resolve_sender_name(self, uid: str, channel_id: Optional[str] = None) -> str:
        """
        Resolve a UID to a display name.

        Priority:
        1. uid→name reverse map (populated from group member cache)
        2. LRU name cache
        3. /v1/bot/user/info API call
        4. Return uid as fallback

        Results are cached in the LRU cache.
        """
        # Check reverse map first (populated by group member fetch)
        name = self._uid_to_name.get(uid)
        if name:
            return name

        # Check LRU cache
        cached = self._name_cache.get(uid)
        if cached is not None:
            return cached if cached else uid  # empty string = negative cache

        # API lookup
        if self._http_session:
            info = await api.fetch_user_info(
                self._http_session, self._api_url, self._bot_token, uid
            )
            if info and info.get("name"):
                self._name_cache.set(uid, info["name"])
                self._uid_to_name[uid] = info["name"]
                return info["name"]
            else:
                # Negative cache — avoid repeated API calls
                self._name_cache.set(uid, "")

        return uid

    async def _refresh_group_member_cache(self, group_no: str, force: bool = False) -> bool:
        """
        Refresh group member cache if expired or forced.

        Returns True if cache was refreshed.
        """
        if not self._http_session:
            return False

        now = int(time.time() * 1000)
        last_fetched = self._group_cache_timestamps.get(group_no, 0)
        is_expired = (now - last_fetched) > GROUP_CACHE_EXPIRY_MS

        if not force and not is_expired and last_fetched > 0:
            return False

        try:
            members = await api.get_group_members(
                self._http_session, self._api_url, self._bot_token, group_no
            )
            if members:
                for m in members:
                    if m.name and m.uid:
                        self._member_map[m.name] = m.uid
                        self._uid_to_name[m.uid] = m.name
                        self._name_cache.set(m.uid, m.name)
                self._group_cache_timestamps[group_no] = now
                logger.info(
                    "[%s] Group member cache refreshed: %s (%d members)",
                    self.name, group_no, len(members),
                )
                return True
            else:
                # Backoff 30s on empty result
                self._group_cache_timestamps[group_no] = now - GROUP_CACHE_EXPIRY_MS + 30000
                return False
        except Exception as e:
            logger.error("[%s] Group member cache refresh failed: %s", self.name, e)
            self._group_cache_timestamps[group_no] = now - GROUP_CACHE_EXPIRY_MS + 30000
            return False

    # ── Group History (Phase 2) ───────────────────────────────────────────

    async def _fetch_and_inject_history(
        self, channel_id: str, bot_uid: str
    ) -> str:
        """
        Fetch group history and format as context prefix.

        On first encounter, fetches from API.
        Subsequently, uses cached in-memory history.

        Returns:
            Formatted history string, or empty string if none.
        """
        entries = self._group_histories.get(channel_id, [])

        # On first encounter, fetch from API
        if channel_id not in self._history_fetched and self._http_session:
            self._history_fetched.add(channel_id)
            try:
                api_messages = await api.get_channel_messages(
                    self._http_session,
                    self._api_url,
                    self._bot_token,
                    channel_id=channel_id,
                    channel_type=ChannelType.Group,
                    limit=min(self._history_limit, 100),
                )
                # Filter out bot's own messages and format
                entries = [
                    {
                        "sender": m.get("from_uid", "unknown"),
                        "body": m.get("content", ""),
                        "timestamp": m.get("timestamp", 0),
                    }
                    for m in api_messages
                    if m.get("from_uid") != bot_uid and m.get("content")
                ][-self._history_limit:]
                if entries:
                    self._group_histories[channel_id] = entries
                    logger.info(
                        "[%s] Fetched %d history messages from API for %s",
                        self.name, len(entries), channel_id,
                    )
            except Exception as e:
                logger.error("[%s] History fetch failed: %s", self.name, e)

        if not entries:
            return ""

        # Resolve sender names
        formatted_entries = []
        for e in entries[-self._history_limit:]:
            sender_uid = e.get("sender", "unknown")
            sender_name = self._uid_to_name.get(sender_uid, sender_uid)
            formatted_entries.append({
                "sender": f"{sender_name}({sender_uid})" if sender_name != sender_uid else sender_uid,
                "body": e.get("body", ""),
            })

        messages_json = json.dumps(formatted_entries, ensure_ascii=False, indent=2)
        return DEFAULT_HISTORY_PROMPT_TEMPLATE.format(
            messages=messages_json, count=len(formatted_entries)
        )

    def _record_history_entry(
        self, channel_id: str, from_uid: str, body: str
    ) -> None:
        """Record a message in the group history buffer."""
        if channel_id not in self._group_histories:
            self._group_histories[channel_id] = []
        entries = self._group_histories[channel_id]
        entries.append({
            "sender": from_uid,
            "body": body,
            "timestamp": int(time.time() * 1000),
        })
        while len(entries) > self._history_limit:
            entries.pop(0)

    # ── GROUP.md (Phase 3) ────────────────────────────────────────────────

    async def _ensure_group_md(self, channel_id: str) -> None:
        """
        Ensure GROUP.md is fetched and cached for a group.
        Only fetches once per session per group.
        """
        if channel_id in self._group_md_checked:
            return
        self._group_md_checked.add(channel_id)

        if not self._http_session:
            return

        try:
            md_data = await api.get_group_md(
                self._http_session, self._api_url, self._bot_token, channel_id
            )
            if md_data and md_data.get("content"):
                self._group_md_cache[channel_id] = {
                    "content": md_data["content"],
                    "version": md_data.get("version", 0),
                }
                logger.info(
                    "[%s] GROUP.md cached for %s (v%d)",
                    self.name, channel_id, md_data.get("version", 0),
                )
        except Exception as e:
            logger.debug("[%s] GROUP.md fetch failed for %s: %s", self.name, channel_id, e)

    def _handle_group_md_event(self, channel_id: str, event_type: str) -> None:
        """Handle GROUP.md update/delete events."""
        if event_type == "group_md_deleted":
            self._group_md_cache.pop(channel_id, None)
            self._group_md_checked.discard(channel_id)
            logger.info("[%s] GROUP.md cache cleared for %s", self.name, channel_id)
        elif event_type == "group_md_updated":
            # Force re-fetch on next message
            self._group_md_checked.discard(channel_id)
            logger.info("[%s] GROUP.md will be re-fetched for %s", self.name, channel_id)

    # ── Message Reception ─────────────────────────────────────────────────

    async def _receive_loop(self) -> None:
        """Main WebSocket message receive loop."""
        try:
            while self._connected and self._ws:
                try:
                    raw = await self._ws.recv()
                except websockets.exceptions.ConnectionClosed as e:
                    logger.warning("[%s] WebSocket closed: %s", self.name, e)
                    break
                except Exception as e:
                    logger.error("[%s] WebSocket recv error: %s", self.name, e)
                    break

                data = raw if isinstance(raw, bytes) else raw.encode("latin-1")
                self._temp_buffer.extend(data)

                # Process all complete frames in buffer (sticky packet handling)
                try:
                    while self._temp_buffer:
                        frame, self._temp_buffer = try_unpack_one(self._temp_buffer)
                        if frame is None:
                            break
                        await self._handle_frame(frame)
                except Exception as e:
                    logger.error("[%s] Frame decode error: %s", self.name, e)
                    self._temp_buffer = bytearray()
                    break

        except asyncio.CancelledError:
            return
        finally:
            if self._connected:
                self._connected = False
                if self._need_reconnect:
                    asyncio.create_task(self._schedule_reconnect())

    async def _handle_frame(self, frame: bytes) -> None:
        """Handle a single decoded frame."""
        pkt_type, result = decode_packet(frame)

        if pkt_type == PacketType.PONG:
            self._ping_retry_count = 0

        elif pkt_type == PacketType.RECV:
            await self._handle_recv(result)

        elif pkt_type == PacketType.DISCONNECT:
            logger.warning("[%s] Server sent DISCONNECT: %s", self.name, result)
            self._connected = False
            self._need_reconnect = False

        elif pkt_type == PacketType.CONNACK:
            logger.debug("[%s] Unexpected CONNACK", self.name)

    async def _handle_recv(self, recv: Any) -> None:
        """
        Handle a RECV packet: decrypt payload, build MessageEvent, dispatch.

        Sends RECVACK immediately, then processes the message.
        """
        # Send RECVACK immediately
        if self._ws:
            try:
                ack = encode_recvack_packet(recv.message_id, recv.message_seq)
                await self._ws.send(ack)
            except Exception as e:
                logger.debug("[%s] Failed to send RECVACK: %s", self.name, e)

        # Decrypt payload
        try:
            decrypted = aes_decrypt(recv.encrypted_payload, self._aes_key, self._aes_iv)
            payload_str = decrypted.decode("utf-8")
            payload_dict = json.loads(payload_str)
        except Exception as e:
            logger.debug("[%s] Payload decrypt/parse error: %s", self.name, e)
            return

        payload = MessagePayload.from_dict(payload_dict)

        # Build BotMessage
        msg = BotMessage(
            message_id=recv.message_id,
            message_seq=recv.message_seq,
            from_uid=recv.from_uid,
            channel_id=recv.channel_id,
            channel_type=recv.channel_type,
            timestamp=recv.timestamp,
            payload=payload,
        )

        # Skip messages from self
        if msg.from_uid == self._robot_id:
            return

        is_group = msg.channel_type == ChannelType.Group

        # ── Handle GROUP.md events (Phase 3) ──
        event_type = None
        if payload.event and isinstance(payload.event, dict):
            event_type = payload.event.get("type")
        if event_type in ("group_md_updated", "group_md_deleted") and msg.channel_id:
            self._handle_group_md_event(msg.channel_id, event_type)
            # Also refresh memory cache immediately for updated events
            if event_type == "group_md_updated" and self._http_session:
                asyncio.create_task(self._refresh_group_md(msg.channel_id))
            return  # Don't pass event messages to LLM

        # ── Send read receipt (Phase 2) ──
        if self._http_session:
            channel_for_receipt = msg.channel_id if is_group else msg.from_uid
            channel_type_for_receipt = ChannelType.Group if is_group else ChannelType.DM
            asyncio.create_task(self._send_read_receipt_safe(
                channel_for_receipt, channel_type_for_receipt,
                [msg.message_id] if msg.message_id else [],
            ))

        # Resolve content based on message type
        content = self._resolve_content(payload)
        if not content:
            logger.debug("[%s] Skipping empty/unsupported message type=%d", self.name, payload.type)
            return

        # ── Refresh group member cache (Phase 2) ──
        if is_group and msg.channel_id:
            await self._refresh_group_member_cache(msg.channel_id)

        # ── Resolve sender name (Phase 2) ──
        sender_name = await self._resolve_sender_name(msg.from_uid, msg.channel_id)

        # ── Build reply context (Phase 2) ──
        reply_to_id = None
        reply_text = None
        if payload.reply:
            reply_from = payload.reply.from_name or payload.reply.from_uid or "unknown"
            reply_content = ""
            if payload.reply.payload and isinstance(payload.reply.payload, dict):
                reply_content = payload.reply.payload.get("content", "")
            if reply_content:
                reply_text = f"[Quoted message from {reply_from}]: {reply_content}"
            # Cache reply sender name
            if payload.reply.from_uid and payload.reply.from_name:
                self._uid_to_name[payload.reply.from_uid] = payload.reply.from_name
                self._name_cache.set(payload.reply.from_uid, payload.reply.from_name)

        # ── Ensure GROUP.md is cached (Phase 3) ──
        if is_group and msg.channel_id:
            asyncio.create_task(self._ensure_group_md(msg.channel_id))

        # ── Convert mentions for LLM context (Phase 2) ──
        llm_content = content
        if payload.mention:
            member_map_copy = dict(self._member_map)
            llm_content = convert_content_for_llm(content, payload.mention, member_map_copy)

        # ── Group history (Phase 2) ──
        history_prefix = ""
        if is_group and msg.channel_id:
            # Record this message in history
            self._record_history_entry(msg.channel_id, msg.from_uid, content)

            # Build history context
            history_prefix = await self._fetch_and_inject_history(
                msg.channel_id, self._robot_id
            )

        # Build final content with prefixes
        final_content = ""
        if reply_text:
            final_content += reply_text + "\n---\n"
        if history_prefix:
            final_content += history_prefix
        final_content += llm_content

        # Build Hermes MessageEvent
        if HERMES_AVAILABLE:
            chat_type = "dm" if msg.channel_type == ChannelType.DM else "group"

            source = self.build_source(
                chat_id=msg.channel_id if is_group else msg.from_uid,
                chat_type=chat_type,
                user_id=msg.from_uid,
                user_name=sender_name,
            )

            # Determine MessageType from payload
            hermes_msg_type = MessageType.TEXT
            media_urls: list[str] = []
            media_types: list[str] = []
            if payload.type == DMWorkMessageType.Image:
                hermes_msg_type = MessageType.PHOTO
                if payload.url:
                    media_urls.append(payload.url)
                    media_types.append("image/jpeg")
            elif payload.type == DMWorkMessageType.Voice:
                hermes_msg_type = MessageType.VOICE
                if payload.url:
                    media_urls.append(payload.url)
                    media_types.append("audio/ogg")
            elif payload.type == DMWorkMessageType.Video:
                hermes_msg_type = MessageType.VIDEO
                if payload.url:
                    media_urls.append(payload.url)
                    media_types.append("video/mp4")
            elif payload.type == DMWorkMessageType.File:
                hermes_msg_type = MessageType.DOCUMENT
                if payload.url:
                    media_urls.append(payload.url)
                    media_types.append("application/octet-stream")

            event = MessageEvent(
                text=final_content,
                message_type=hermes_msg_type,
                source=source,
                message_id=msg.message_id,
                timestamp=msg.timestamp,
                media_urls=media_urls,
                media_types=media_types,
                reply_to_message_id=reply_to_id,
                reply_to_text=reply_text,
            )

            # Inject GROUP.md as metadata
            if is_group and msg.channel_id:
                group_md = self._group_md_cache.get(msg.channel_id)
                if group_md and group_md.get("content"):
                    # Store in raw_message for the gateway to pick up
                    event.raw_message = {
                        "group_system_prompt": group_md["content"],
                        "channel_id": msg.channel_id,
                        "channel_type": msg.channel_type,
                    }

            # Dispatch to handler
            await self.handle_message(event)

    def _resolve_content(self, payload: MessagePayload) -> str:
        """Resolve message payload to text content for the LLM."""
        if payload.type == DMWorkMessageType.Text:
            return payload.content or ""
        elif payload.type == DMWorkMessageType.Image:
            url = payload.url or ""
            return f"[图片]\n{url}".strip()
        elif payload.type == DMWorkMessageType.GIF:
            url = payload.url or ""
            return f"[GIF]\n{url}".strip()
        elif payload.type == DMWorkMessageType.Voice:
            url = payload.url or ""
            return f"[语音消息]\n{url}".strip()
        elif payload.type == DMWorkMessageType.Video:
            url = payload.url or ""
            return f"[视频]\n{url}".strip()
        elif payload.type == DMWorkMessageType.File:
            name = payload.name or "未知文件"
            url = payload.url or ""
            return f"[文件: {name}]\n{url}".strip()
        elif payload.type == DMWorkMessageType.Location:
            return "[位置信息]"
        elif payload.type == DMWorkMessageType.Card:
            name = payload.name or "未知"
            return f"[名片: {name}]"
        elif payload.type == DMWorkMessageType.MultipleForward:
            return "[合并转发]"
        else:
            return payload.content or ""

    async def _send_read_receipt_safe(
        self, channel_id: str, channel_type: ChannelType, message_ids: list[str]
    ) -> None:
        """Send read receipt, logging errors but not raising."""
        if not self._http_session:
            return
        try:
            await api.send_read_receipt(
                self._http_session, self._api_url, self._bot_token,
                channel_id, channel_type, message_ids,
            )
        except Exception as e:
            logger.debug("[%s] Read receipt failed: %s", self.name, e)

    async def _refresh_group_md(self, channel_id: str) -> None:
        """Refresh GROUP.md cache for a specific group."""
        if not self._http_session:
            return
        try:
            md_data = await api.get_group_md(
                self._http_session, self._api_url, self._bot_token, channel_id
            )
            if md_data and md_data.get("content"):
                self._group_md_cache[channel_id] = {
                    "content": md_data["content"],
                    "version": md_data.get("version", 0),
                }
                logger.info(
                    "[%s] GROUP.md refreshed for %s (v%d)",
                    self.name, channel_id, md_data.get("version", 0),
                )
            else:
                self._group_md_cache.pop(channel_id, None)
        except Exception as e:
            logger.debug("[%s] GROUP.md refresh failed for %s: %s", self.name, channel_id, e)

    # ── Heartbeat ─────────────────────────────────────────────────────────

    async def _heartbeat_loop(self) -> None:
        """Send periodic PING packets to keep the connection alive."""
        try:
            while self._connected:
                await asyncio.sleep(HEARTBEAT_INTERVAL)

                self._ping_retry_count += 1
                if self._ping_retry_count > PING_MAX_RETRY:
                    logger.warning("[%s] Ping timeout, reconnecting...", self.name)
                    self._connected = False
                    if self._ws:
                        try:
                            await self._ws.close()
                        except Exception:
                            pass
                    break

                if self._ws:
                    try:
                        await self._ws.send(encode_ping_packet())
                    except Exception as e:
                        logger.debug("[%s] Ping send failed: %s", self.name, e)
                        break
        except asyncio.CancelledError:
            return

    # ── Reconnection ──────────────────────────────────────────────────────

    async def _schedule_reconnect(self) -> None:
        """Schedule a reconnection attempt with exponential backoff + jitter."""
        if not self._need_reconnect:
            return

        base_delay = RECONNECT_BASE_DELAY
        exponential_delay = min(
            base_delay * (2 ** self._reconnect_attempts),
            RECONNECT_MAX_DELAY,
        )
        # Add ±25% random jitter
        jitter = exponential_delay * (0.75 + random.random() * 0.5)
        delay = jitter

        self._reconnect_attempts += 1
        logger.info(
            "[%s] Reconnecting in %.1fs (attempt %d)...",
            self.name,
            delay,
            self._reconnect_attempts,
        )

        await asyncio.sleep(delay)

        if not self._need_reconnect:
            return

        try:
            # Clean up old connection
            if self._ws:
                try:
                    await self._ws.close()
                except Exception:
                    pass
                self._ws = None

            self._temp_buffer = bytearray()
            await self._do_connect()
        except Exception as e:
            logger.error("[%s] Reconnection failed: %s", self.name, e)
            if self._need_reconnect:
                asyncio.create_task(self._schedule_reconnect())

    # ── Sending ───────────────────────────────────────────────────────────

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """
        Send a text message to a chat.

        Long messages are automatically split into chunks.
        Supports optional streaming for long messages.
        """
        if not self._http_session:
            return SendResult(success=False, error="Not connected")

        # Determine channel type from metadata or default to Group
        channel_type = ChannelType.Group
        if metadata and metadata.get("channel_type"):
            channel_type = ChannelType(metadata["channel_type"])

        # ── Streaming for long messages (Phase 2) ──
        if len(content) > self._stream_threshold and not (metadata and metadata.get("no_stream")):
            return await self._send_with_stream(chat_id, content, channel_type, reply_to)

        # Split long messages
        chunks = self.truncate_message(content, MAX_MESSAGE_LENGTH)

        try:
            for chunk in chunks:
                await api.send_message(
                    self._http_session,
                    self._api_url,
                    self._bot_token,
                    channel_id=chat_id,
                    channel_type=channel_type,
                    content=chunk,
                    reply_msg_id=reply_to,
                )
            return SendResult(success=True)
        except Exception as e:
            logger.error("[%s] Send failed: %s", self.name, e)
            return SendResult(
                success=False,
                error=str(e),
                retryable="connect" in str(e).lower() or "timeout" in str(e).lower(),
            )

    async def _send_with_stream(
        self,
        chat_id: str,
        content: str,
        channel_type: ChannelType,
        reply_to: Optional[str] = None,
    ) -> SendResult:
        """
        Send a long message using stream API for progressive rendering.

        Falls back to normal send if stream fails.
        """
        if not self._http_session:
            return SendResult(success=False, error="Not connected")

        try:
            # Start stream with initial chunk
            chunk_size = MAX_MESSAGE_LENGTH
            initial = content[:chunk_size]

            stream_no = await api.stream_start(
                self._http_session, self._api_url, self._bot_token,
                chat_id, channel_type, initial,
            )
            if not stream_no:
                # Fallback to normal send
                logger.warning("[%s] Stream start returned no stream_no, falling back", self.name)
                return await self._send_normal(chat_id, content, channel_type, reply_to)

            # Send remaining chunks
            offset = chunk_size
            while offset < len(content):
                chunk = content[offset:offset + chunk_size]
                # Accumulate content for stream updates
                accumulated = content[:offset + len(chunk)]
                await api.send_message(
                    self._http_session, self._api_url, self._bot_token,
                    channel_id=chat_id, channel_type=channel_type,
                    content=accumulated, stream_no=stream_no,
                )
                offset += len(chunk)

            # End stream
            await api.stream_end(
                self._http_session, self._api_url, self._bot_token,
                stream_no, chat_id, channel_type,
            )
            return SendResult(success=True)

        except Exception as e:
            logger.error("[%s] Stream send failed, falling back: %s", self.name, e)
            return await self._send_normal(chat_id, content, channel_type, reply_to)

    async def _send_normal(
        self,
        chat_id: str,
        content: str,
        channel_type: ChannelType,
        reply_to: Optional[str] = None,
    ) -> SendResult:
        """Normal (non-streaming) message send with chunking."""
        if not self._http_session:
            return SendResult(success=False, error="Not connected")

        chunks = self.truncate_message(content, MAX_MESSAGE_LENGTH)
        try:
            for chunk in chunks:
                await api.send_message(
                    self._http_session, self._api_url, self._bot_token,
                    channel_id=chat_id, channel_type=channel_type,
                    content=chunk, reply_msg_id=reply_to,
                )
            return SendResult(success=True)
        except Exception as e:
            return SendResult(success=False, error=str(e))

    async def send_typing(self, chat_id: str, metadata: Any = None) -> None:
        """Send typing indicator to a channel."""
        if not self._http_session:
            return

        channel_type = ChannelType.Group
        if metadata and isinstance(metadata, dict) and metadata.get("channel_type"):
            channel_type = ChannelType(metadata["channel_type"])

        try:
            await api.send_typing(
                self._http_session,
                self._api_url,
                self._bot_token,
                channel_id=chat_id,
                channel_type=channel_type,
            )
        except Exception as e:
            logger.debug("[%s] send_typing failed: %s", self.name, e)

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Send an image message to a channel."""
        if not self._http_session:
            return SendResult(success=False, error="Not connected")

        channel_type = ChannelType.Group
        if metadata and metadata.get("channel_type"):
            channel_type = ChannelType(metadata["channel_type"])

        try:
            # If it's a remote URL, download and re-upload to COS
            final_url = image_url
            width, height = None, None
            if image_url.startswith(("http://", "https://")):
                try:
                    file_data, content_type, filename = await api.download_file(
                        self._http_session, image_url, max_size=20 * 1024 * 1024
                    )
                    # Parse dimensions
                    dims = api.parse_image_dimensions(file_data, content_type)
                    if dims:
                        width, height = dims
                    # Upload to COS
                    final_url = await api.upload_and_get_url(
                        self._http_session, self._api_url, self._bot_token,
                        filename, file_data, content_type,
                    )
                except Exception as upload_err:
                    logger.warning("[%s] Image upload failed, using original URL: %s", self.name, upload_err)

            await api.send_media_message(
                self._http_session, self._api_url, self._bot_token,
                channel_id=chat_id, channel_type=channel_type,
                msg_type=DMWorkMessageType.Image, url=final_url,
                width=width, height=height,
            )

            # Send caption as separate text message if present
            if caption:
                await api.send_message(
                    self._http_session, self._api_url, self._bot_token,
                    channel_id=chat_id, channel_type=channel_type,
                    content=caption,
                )

            return SendResult(success=True)
        except Exception as e:
            logger.error("[%s] send_image failed: %s", self.name, e)
            return SendResult(success=False, error=str(e))

    async def send_document(
        self,
        chat_id: str,
        file_path: str,
        caption: Optional[str] = None,
        file_name: Optional[str] = None,
        reply_to: Optional[str] = None,
        **kwargs: Any,
    ) -> SendResult:
        """
        Send a document/file to a channel.

        Downloads from URL or reads from local path, uploads to COS,
        then sends as a file message.
        """
        if not self._http_session:
            return SendResult(success=False, error="Not connected")

        channel_type = ChannelType.Group
        metadata = kwargs.get("metadata")
        if metadata and isinstance(metadata, dict) and metadata.get("channel_type"):
            channel_type = ChannelType(metadata["channel_type"])

        try:
            if file_path.startswith(("http://", "https://")):
                file_data, content_type, filename = await api.download_file(
                    self._http_session, file_path
                )
            else:
                import aiofiles
                filename = file_name or os.path.basename(file_path)
                content_type = api.infer_content_type(filename)
                async with aiofiles.open(file_path, "rb") as f:
                    file_data = await f.read()

            if file_name:
                filename = file_name

            # Upload to COS
            uploaded_url = await api.upload_and_get_url(
                self._http_session, self._api_url, self._bot_token,
                filename, file_data, content_type,
            )

            await api.send_media_message(
                self._http_session, self._api_url, self._bot_token,
                channel_id=chat_id, channel_type=channel_type,
                msg_type=DMWorkMessageType.File, url=uploaded_url,
                name=filename, size=len(file_data),
            )

            if caption:
                await api.send_message(
                    self._http_session, self._api_url, self._bot_token,
                    channel_id=chat_id, channel_type=channel_type,
                    content=caption,
                )

            return SendResult(success=True)
        except Exception as e:
            logger.error("[%s] send_document failed: %s", self.name, e)
            return SendResult(success=False, error=str(e))

    async def send_voice(
        self,
        chat_id: str,
        audio_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        **kwargs: Any,
    ) -> SendResult:
        """
        Send a voice message to a channel.

        Uploads audio to COS and sends as voice message type.
        """
        if not self._http_session:
            return SendResult(success=False, error="Not connected")

        channel_type = ChannelType.Group
        metadata = kwargs.get("metadata")
        if metadata and isinstance(metadata, dict) and metadata.get("channel_type"):
            channel_type = ChannelType(metadata["channel_type"])

        try:
            if audio_path.startswith(("http://", "https://")):
                file_data, content_type, filename = await api.download_file(
                    self._http_session, audio_path
                )
            else:
                filename = os.path.basename(audio_path)
                content_type = api.infer_content_type(filename)
                with open(audio_path, "rb") as f:
                    file_data = f.read()

            # Upload to COS
            uploaded_url = await api.upload_and_get_url(
                self._http_session, self._api_url, self._bot_token,
                filename, file_data, content_type,
            )

            await api.send_media_message(
                self._http_session, self._api_url, self._bot_token,
                channel_id=chat_id, channel_type=channel_type,
                msg_type=DMWorkMessageType.Voice, url=uploaded_url,
                name=filename,
            )

            return SendResult(success=True)
        except Exception as e:
            logger.error("[%s] send_voice failed: %s", self.name, e)
            return SendResult(success=False, error=str(e))

    async def send_video(
        self,
        chat_id: str,
        video_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        **kwargs: Any,
    ) -> SendResult:
        """
        Send a video to a channel.

        Uploads video to COS and sends as video message type.
        """
        if not self._http_session:
            return SendResult(success=False, error="Not connected")

        channel_type = ChannelType.Group
        metadata = kwargs.get("metadata")
        if metadata and isinstance(metadata, dict) and metadata.get("channel_type"):
            channel_type = ChannelType(metadata["channel_type"])

        try:
            if video_path.startswith(("http://", "https://")):
                file_data, content_type, filename = await api.download_file(
                    self._http_session, video_path
                )
            else:
                filename = os.path.basename(video_path)
                content_type = api.infer_content_type(filename)
                with open(video_path, "rb") as f:
                    file_data = f.read()

            # Upload to COS
            uploaded_url = await api.upload_and_get_url(
                self._http_session, self._api_url, self._bot_token,
                filename, file_data, content_type,
            )

            await api.send_media_message(
                self._http_session, self._api_url, self._bot_token,
                channel_id=chat_id, channel_type=channel_type,
                msg_type=DMWorkMessageType.Video, url=uploaded_url,
                name=filename,
            )

            if caption:
                await api.send_message(
                    self._http_session, self._api_url, self._bot_token,
                    channel_id=chat_id, channel_type=channel_type,
                    content=caption,
                )

            return SendResult(success=True)
        except Exception as e:
            logger.error("[%s] send_video failed: %s", self.name, e)
            return SendResult(success=False, error=str(e))

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        """Get information about a chat/channel."""
        if not self._http_session:
            return {"name": chat_id, "type": "group", "chat_id": chat_id}

        try:
            info = await api.get_group_info(
                self._http_session,
                self._api_url,
                self._bot_token,
                group_no=chat_id,
            )
            return {
                "name": info.name,
                "type": "group",
                "chat_id": info.group_no,
                **info.extra,
            }
        except Exception as e:
            logger.debug("[%s] get_chat_info failed: %s", self.name, e)
            return {"name": chat_id, "type": "unknown", "chat_id": chat_id}
