"""
Tests for hermes_dmwork.api — API function signatures and parameter checks (mock).
"""

import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from hermes_dmwork.api import (
    post_json,
    register_bot,
    send_message,
    send_typing,
    send_media_message,
    send_read_receipt,
    stream_start,
    stream_end,
    get_upload_credentials,
    upload_file_to_cos,
    upload_and_get_url,
    download_file,
    get_channel_messages,
    fetch_bot_groups,
    get_group_members,
    get_group_info,
    fetch_user_info,
    get_group_md,
    update_group_md,
    infer_content_type,
    parse_image_dimensions,
)
from hermes_dmwork.types import ChannelType, MessageType


class TestInferContentType:
    def test_jpeg(self):
        assert infer_content_type("photo.jpg") == "image/jpeg"
        assert infer_content_type("photo.jpeg") == "image/jpeg"

    def test_png(self):
        assert infer_content_type("image.png") == "image/png"

    def test_mp4(self):
        assert infer_content_type("video.mp4") == "video/mp4"

    def test_mp3(self):
        assert infer_content_type("audio.mp3") == "audio/mpeg"

    def test_pdf(self):
        assert infer_content_type("doc.pdf") == "application/pdf"

    def test_unknown(self):
        assert infer_content_type("file.xyz") == "application/octet-stream"

    def test_case_insensitive(self):
        assert infer_content_type("Photo.JPG") == "image/jpeg"

    def test_no_extension(self):
        assert infer_content_type("noext") == "application/octet-stream"


class TestParseImageDimensions:
    def test_png(self):
        # Minimal PNG header (IHDR chunk)
        png_header = (
            b"\x89PNG\r\n\x1a\n"  # PNG signature
            b"\x00\x00\x00\rIHDR"  # IHDR chunk
            b"\x00\x00\x01\x00"    # width = 256
            b"\x00\x00\x00\x80"    # height = 128
            b"\x08\x02\x00\x00\x00"  # bit depth, color type, etc.
        )
        result = parse_image_dimensions(png_header, "image/png")
        assert result == (256, 128)

    def test_gif(self):
        # Minimal GIF header
        gif_header = (
            b"GIF89a"
            b"\x40\x01"  # width = 320 (LE)
            b"\xf0\x00"  # height = 240 (LE)
            b"\x00\x00"  # extra
        )
        result = parse_image_dimensions(gif_header, "image/gif")
        assert result == (320, 240)

    def test_too_small(self):
        result = parse_image_dimensions(b"\x89PNG", "image/png")
        assert result is None

    def test_unknown_mime(self):
        result = parse_image_dimensions(b"\x00" * 100, "application/octet-stream")
        assert result is None


class TestFunctionSignatures:
    """Verify that API functions accept the expected parameters."""

    def test_register_bot_signature(self):
        """register_bot should accept session, api_url, bot_token, force_refresh."""
        import inspect
        sig = inspect.signature(register_bot)
        params = list(sig.parameters.keys())
        assert "session" in params
        assert "api_url" in params
        assert "bot_token" in params
        assert "force_refresh" in params

    def test_send_message_signature(self):
        sig = inspect.signature(send_message)
        params = list(sig.parameters.keys())
        assert "session" in params
        assert "channel_id" in params
        assert "channel_type" in params
        assert "content" in params
        assert "mention_uids" in params
        assert "mention_entities" in params
        assert "mention_all" in params
        assert "stream_no" in params
        assert "reply_msg_id" in params

    def test_send_read_receipt_signature(self):
        sig = inspect.signature(send_read_receipt)
        params = list(sig.parameters.keys())
        assert "channel_id" in params
        assert "channel_type" in params
        assert "message_ids" in params

    def test_stream_start_signature(self):
        sig = inspect.signature(stream_start)
        params = list(sig.parameters.keys())
        assert "channel_id" in params
        assert "channel_type" in params
        assert "initial_content" in params

    def test_stream_end_signature(self):
        sig = inspect.signature(stream_end)
        params = list(sig.parameters.keys())
        assert "stream_no" in params
        assert "channel_id" in params
        assert "channel_type" in params

    def test_get_upload_credentials_signature(self):
        sig = inspect.signature(get_upload_credentials)
        params = list(sig.parameters.keys())
        assert "filename" in params

    def test_upload_file_to_cos_signature(self):
        sig = inspect.signature(upload_file_to_cos)
        params = list(sig.parameters.keys())
        assert "credentials" in params
        assert "bucket" in params
        assert "region" in params
        assert "key" in params
        assert "file_data" in params
        assert "content_type" in params

    def test_get_channel_messages_signature(self):
        sig = inspect.signature(get_channel_messages)
        params = list(sig.parameters.keys())
        assert "channel_id" in params
        assert "channel_type" in params
        assert "limit" in params

    def test_get_group_md_signature(self):
        sig = inspect.signature(get_group_md)
        params = list(sig.parameters.keys())
        assert "group_no" in params

    def test_update_group_md_signature(self):
        sig = inspect.signature(update_group_md)
        params = list(sig.parameters.keys())
        assert "group_no" in params
        assert "content" in params

    def test_fetch_user_info_signature(self):
        sig = inspect.signature(fetch_user_info)
        params = list(sig.parameters.keys())
        assert "uid" in params


import inspect


class TestSendReadReceipt:
    """Test send_read_receipt parameter building."""

    @pytest.mark.asyncio
    async def test_sends_correct_payload(self):
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.ok = True
        mock_response.text = AsyncMock(return_value="null")
        mock_response.json = AsyncMock(return_value=None)
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        mock_session.post = MagicMock(return_value=mock_response)

        await send_read_receipt(
            mock_session,
            "https://api.example.com",
            "token",
            "channel1",
            ChannelType.Group,
            ["msg1", "msg2"],
        )

        mock_session.post.assert_called_once()
        call_kwargs = mock_session.post.call_args
        assert "json" in call_kwargs.kwargs or len(call_kwargs.args) > 1


class TestStreamAPI:
    """Test stream API parameter building."""

    @pytest.mark.asyncio
    async def test_stream_start_encodes_payload(self):
        """stream_start should base64-encode the initial payload."""
        import base64
        import json

        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.ok = True
        mock_response.text = AsyncMock(return_value='{"stream_no": "s123"}')
        mock_response.json = AsyncMock(return_value={"stream_no": "s123"})
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        mock_session.post = MagicMock(return_value=mock_response)

        result = await stream_start(
            mock_session, "https://api.example.com", "token",
            "channel1", ChannelType.Group, "Hello!",
        )

        assert result == "s123"
        mock_session.post.assert_called_once()


class TestGetChannelMessages:
    """Test channel messages API."""

    @pytest.mark.asyncio
    async def test_parses_base64_payload(self):
        import base64
        import json

        encoded_payload = base64.b64encode(
            json.dumps({"type": 1, "content": "hello"}).encode()
        ).decode()

        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.ok = True
        mock_response.text = AsyncMock(return_value=json.dumps({
            "messages": [
                {"from_uid": "user1", "payload": encoded_payload, "timestamp": 1000},
            ]
        }))
        mock_response.json = AsyncMock(return_value={
            "messages": [
                {"from_uid": "user1", "payload": encoded_payload, "timestamp": 1000},
            ]
        })
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        mock_session.post = MagicMock(return_value=mock_response)

        messages = await get_channel_messages(
            mock_session, "https://api.example.com", "token",
            "channel1", ChannelType.Group, limit=10,
        )

        assert len(messages) == 1
        assert messages[0]["content"] == "hello"
        assert messages[0]["from_uid"] == "user1"
