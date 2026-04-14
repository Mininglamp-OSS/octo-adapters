"""
DMWork Bot API types.

Translated from openclaw-channel-dmwork/src/types.ts.
Defines channel types, message types, and payload structures used
by the DMWork Bot API and WuKongIM protocol.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Optional


class ChannelType(IntEnum):
    """DMWork channel types."""
    DM = 1
    Group = 2


class MessageType(IntEnum):
    """DMWork message content types."""
    Text = 1
    Image = 2
    GIF = 3
    Voice = 4
    Video = 5
    Location = 6
    Card = 7
    File = 8
    MultipleForward = 11


@dataclass
class MentionEntity:
    """
    Precise position of a single @mention.

    offset/length units are UTF-16 code units (matching JS string.length).
    """
    uid: str
    offset: int
    length: int


@dataclass
class MentionPayload:
    """Mention metadata attached to a message."""
    uids: Optional[list[str]] = None
    entities: Optional[list[MentionEntity]] = None
    all: Optional[bool] = None  # True or 1 = @all


@dataclass
class ReplyPayload:
    """Reply context for a message."""
    payload: Optional[dict[str, Any]] = None
    from_uid: Optional[str] = None
    from_name: Optional[str] = None


@dataclass
class MessagePayload:
    """
    DMWork message payload.

    The `type` field determines which other fields are populated.
    Additional unknown fields are captured in `extra`.
    """
    type: MessageType = MessageType.Text
    content: Optional[str] = None
    url: Optional[str] = None
    name: Optional[str] = None
    mention: Optional[MentionPayload] = None
    reply: Optional[ReplyPayload] = None
    event: Optional[dict[str, Any]] = None
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> MessagePayload:
        """Parse a MessagePayload from a raw dict (e.g. from JSON)."""
        known_keys = {"type", "content", "url", "name", "mention", "reply", "event"}
        extra = {k: v for k, v in data.items() if k not in known_keys}

        mention = None
        if "mention" in data and data["mention"]:
            m = data["mention"]
            entities = None
            if m.get("entities"):
                entities = [
                    MentionEntity(uid=e["uid"], offset=e["offset"], length=e["length"])
                    for e in m["entities"]
                    if isinstance(e, dict) and "uid" in e
                ]
            mention = MentionPayload(
                uids=m.get("uids"),
                entities=entities,
                all=m.get("all"),
            )

        reply = None
        if "reply" in data and data["reply"]:
            r = data["reply"]
            reply = ReplyPayload(
                payload=r.get("payload"),
                from_uid=r.get("from_uid"),
                from_name=r.get("from_name"),
            )

        return cls(
            type=MessageType(data.get("type", 1)),
            content=data.get("content"),
            url=data.get("url"),
            name=data.get("name"),
            mention=mention,
            reply=reply,
            event=data.get("event"),
            extra=extra,
        )


@dataclass
class BotMessage:
    """
    Incoming message received via WuKongIM WebSocket.

    Represents a fully decoded RECV packet with decrypted payload.
    """
    message_id: str
    message_seq: int
    from_uid: str
    channel_id: str
    channel_type: int
    timestamp: int
    payload: MessagePayload


@dataclass
class BotRegisterResp:
    """Response from /v1/bot/register API."""
    robot_id: str
    im_token: str
    ws_url: str
    api_url: str
    owner_uid: str
    owner_channel_id: str


@dataclass
class SendMessageResult:
    """Response from /v1/bot/sendMessage API."""
    message_id: int
    message_seq: int


@dataclass
class GroupMember:
    """A member of a DMWork group."""
    uid: str
    name: str
    role: Optional[str] = None  # admin/member
    robot: Optional[bool] = None


@dataclass
class GroupInfo:
    """Basic group information."""
    group_no: str
    name: str
    extra: dict[str, Any] = field(default_factory=dict)
