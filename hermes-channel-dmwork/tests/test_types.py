"""
Tests for hermes_dmwork.types — type serialization/deserialization.
"""

import pytest
from hermes_dmwork.types import (
    ChannelType,
    MessageType,
    MentionEntity,
    MentionPayload,
    ReplyPayload,
    MessagePayload,
    BotMessage,
    BotRegisterResp,
    GroupMember,
    GroupInfo,
)


class TestChannelType:
    def test_dm_value(self):
        assert ChannelType.DM == 1

    def test_group_value(self):
        assert ChannelType.Group == 2

    def test_from_int(self):
        assert ChannelType(1) == ChannelType.DM
        assert ChannelType(2) == ChannelType.Group


class TestMessageType:
    def test_text(self):
        assert MessageType.Text == 1

    def test_image(self):
        assert MessageType.Image == 2

    def test_file(self):
        assert MessageType.File == 8

    def test_all_types(self):
        expected = {1, 2, 3, 4, 5, 6, 7, 8, 11}
        actual = {mt.value for mt in MessageType}
        assert actual == expected


class TestMentionEntity:
    def test_creation(self):
        e = MentionEntity(uid="user123", offset=5, length=10)
        assert e.uid == "user123"
        assert e.offset == 5
        assert e.length == 10


class TestMentionPayload:
    def test_default_none(self):
        mp = MentionPayload()
        assert mp.uids is None
        assert mp.entities is None
        assert mp.all is None

    def test_with_uids(self):
        mp = MentionPayload(uids=["u1", "u2"])
        assert mp.uids == ["u1", "u2"]

    def test_with_all(self):
        mp = MentionPayload(all=True)
        assert mp.all is True


class TestReplyPayload:
    def test_default_none(self):
        rp = ReplyPayload()
        assert rp.payload is None
        assert rp.from_uid is None
        assert rp.from_name is None

    def test_with_data(self):
        rp = ReplyPayload(
            payload={"content": "hello"},
            from_uid="user1",
            from_name="Alice",
        )
        assert rp.from_name == "Alice"
        assert rp.payload["content"] == "hello"


class TestMessagePayload:
    def test_default_text(self):
        mp = MessagePayload()
        assert mp.type == MessageType.Text
        assert mp.content is None

    def test_from_dict_text(self):
        data = {"type": 1, "content": "hello world"}
        mp = MessagePayload.from_dict(data)
        assert mp.type == MessageType.Text
        assert mp.content == "hello world"

    def test_from_dict_image(self):
        data = {"type": 2, "url": "https://example.com/img.png"}
        mp = MessagePayload.from_dict(data)
        assert mp.type == MessageType.Image
        assert mp.url == "https://example.com/img.png"

    def test_from_dict_with_mention(self):
        data = {
            "type": 1,
            "content": "@Alice hello",
            "mention": {
                "uids": ["uid1"],
                "entities": [
                    {"uid": "uid1", "offset": 0, "length": 6},
                ],
            },
        }
        mp = MessagePayload.from_dict(data)
        assert mp.mention is not None
        assert mp.mention.uids == ["uid1"]
        assert len(mp.mention.entities) == 1
        assert mp.mention.entities[0].uid == "uid1"

    def test_from_dict_with_reply(self):
        data = {
            "type": 1,
            "content": "reply text",
            "reply": {
                "from_uid": "user1",
                "from_name": "Alice",
                "payload": {"content": "original"},
            },
        }
        mp = MessagePayload.from_dict(data)
        assert mp.reply is not None
        assert mp.reply.from_uid == "user1"
        assert mp.reply.from_name == "Alice"
        assert mp.reply.payload["content"] == "original"

    def test_from_dict_extra_fields(self):
        data = {
            "type": 1,
            "content": "hello",
            "custom_field": "custom_value",
            "another": 42,
        }
        mp = MessagePayload.from_dict(data)
        assert mp.extra["custom_field"] == "custom_value"
        assert mp.extra["another"] == 42

    def test_from_dict_empty_mention(self):
        data = {"type": 1, "content": "hello", "mention": {}}
        mp = MessagePayload.from_dict(data)
        # Empty dict is falsy in Python — from_dict treats it as None
        assert mp.mention is None

    def test_from_dict_none_mention(self):
        data = {"type": 1, "content": "hello", "mention": None}
        mp = MessagePayload.from_dict(data)
        assert mp.mention is None

    def test_from_dict_invalid_entities(self):
        data = {
            "type": 1,
            "content": "hello",
            "mention": {
                "entities": ["not_a_dict", {"uid": "u1", "offset": 0, "length": 5}],
            },
        }
        mp = MessagePayload.from_dict(data)
        # Only valid entities should be parsed
        assert len(mp.mention.entities) == 1

    def test_from_dict_event(self):
        data = {
            "type": 1,
            "event": {"type": "group_md_updated"},
        }
        mp = MessagePayload.from_dict(data)
        assert mp.event == {"type": "group_md_updated"}


class TestBotMessage:
    def test_creation(self):
        payload = MessagePayload(type=MessageType.Text, content="test")
        msg = BotMessage(
            message_id="123",
            message_seq=1,
            from_uid="user1",
            channel_id="group1",
            channel_type=2,
            timestamp=1000000,
            payload=payload,
        )
        assert msg.message_id == "123"
        assert msg.from_uid == "user1"
        assert msg.channel_type == 2


class TestBotRegisterResp:
    def test_creation(self):
        resp = BotRegisterResp(
            robot_id="bot1",
            im_token="token123",
            ws_url="wss://ws.example.com",
            api_url="https://api.example.com",
            owner_uid="owner1",
            owner_channel_id="ch1",
        )
        assert resp.robot_id == "bot1"
        assert resp.ws_url == "wss://ws.example.com"


class TestGroupMember:
    def test_creation(self):
        m = GroupMember(uid="u1", name="Alice")
        assert m.uid == "u1"
        assert m.name == "Alice"
        assert m.role is None
        assert m.robot is None

    def test_with_role(self):
        m = GroupMember(uid="u1", name="Alice", role="admin", robot=False)
        assert m.role == "admin"
        assert m.robot is False


class TestGroupInfo:
    def test_creation(self):
        gi = GroupInfo(group_no="g1", name="Test Group")
        assert gi.group_no == "g1"
        assert gi.name == "Test Group"
        assert gi.extra == {}

    def test_with_extra(self):
        gi = GroupInfo(group_no="g1", name="Test", extra={"description": "test group"})
        assert gi.extra["description"] == "test group"
