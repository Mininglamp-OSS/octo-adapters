"""
DMWork Bot HTTP API client.

Translated from openclaw-channel-dmwork/src/api-fetch.ts.
All API calls use aiohttp with Bearer token authentication.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import struct
import time
from typing import Any, Optional
import re
from urllib.parse import quote

import aiohttp

from hermes_dmwork.types import (
    BotRegisterResp,
    ChannelType,
    GroupInfo,
    GroupMember,
    MentionEntity,
    MessageType,
)

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = aiohttp.ClientTimeout(total=30)

# ─── MIME Type Helpers ───────────────────────────────────────────────────────

_MIME_MAP: dict[str, str] = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".bmp": "image/bmp", ".ico": "image/x-icon",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".avi": "video/x-msvideo", ".mkv": "video/x-matroska",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".m4a": "audio/mp4", ".aac": "audio/aac", ".opus": "audio/opus",
    ".pdf": "application/pdf", ".zip": "application/zip",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".txt": "text/plain", ".md": "text/markdown",
    ".csv": "text/csv", ".html": "text/html",
    ".json": "application/json",
}


def infer_content_type(filename: str) -> str:
    """Infer MIME type from filename extension."""
    ext = os.path.splitext(filename)[1].lower()
    return _MIME_MAP.get(ext, "application/octet-stream")


def parse_image_dimensions(data: bytes, mime: str) -> Optional[tuple[int, int]]:
    """
    Parse image dimensions from buffer header bytes (PNG/JPEG/GIF/WebP).

    Returns:
        (width, height) or None if parsing fails.
    """
    try:
        if mime == "image/png" and len(data) > 24:
            width = struct.unpack(">I", data[16:20])[0]
            height = struct.unpack(">I", data[20:24])[0]
            return width, height
        if mime in ("image/jpeg", "image/jpg") and len(data) > 2:
            offset = 2
            while offset < len(data) - 8:
                if data[offset] != 0xFF:
                    break
                marker = data[offset + 1]
                if marker in (0xC0, 0xC2):
                    height = struct.unpack(">H", data[offset + 5:offset + 7])[0]
                    width = struct.unpack(">H", data[offset + 7:offset + 9])[0]
                    return width, height
                seg_len = struct.unpack(">H", data[offset + 2:offset + 4])[0]
                offset += 2 + seg_len
        if mime == "image/gif" and len(data) > 10:
            width = struct.unpack("<H", data[6:8])[0]
            height = struct.unpack("<H", data[8:10])[0]
            return width, height
        if mime == "image/webp" and len(data) > 30:
            if data[12:16] == b"VP8 " and len(data) > 29:
                width = struct.unpack("<H", data[26:28])[0] & 0x3FFF
                height = struct.unpack("<H", data[28:30])[0] & 0x3FFF
                return width, height
    except Exception:
        pass
    return None


# ─── Core HTTP Helpers ───────────────────────────────────────────────────────


async def post_json(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    path: str,
    payload: dict[str, Any],
) -> Optional[dict[str, Any]]:
    """
    POST JSON to a DMWork API endpoint with Bearer auth.

    Args:
        session: aiohttp client session.
        api_url: Base API URL (e.g. https://api.example.com).
        bot_token: Bot authentication token.
        path: API path (e.g. /v1/bot/sendMessage).
        payload: JSON body dict.

    Returns:
        Parsed JSON response dict, or None if empty response.

    Raises:
        aiohttp.ClientResponseError: On non-2xx responses.
    """
    url = f"{api_url.rstrip('/')}{path}"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {bot_token}",
    }
    async with session.post(url, json=payload, headers=headers, timeout=DEFAULT_TIMEOUT) as resp:
        if not resp.ok:
            text = await resp.text()
            raise aiohttp.ClientResponseError(
                resp.request_info,
                resp.history,
                status=resp.status,
                message=f"DMWork API {path} failed ({resp.status}): {text or resp.reason}",
            )
        text = await resp.text()
        if not text:
            return None
        return await resp.json(content_type=None)


async def get_json(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    path: str,
) -> Optional[dict[str, Any]]:
    """
    GET JSON from a DMWork API endpoint with Bearer auth.

    Returns:
        Parsed JSON response dict, or None on error.
    """
    url = f"{api_url.rstrip('/')}{path}"
    headers = {"Authorization": f"Bearer {bot_token}"}
    async with session.get(url, headers=headers, timeout=DEFAULT_TIMEOUT) as resp:
        if not resp.ok:
            text = await resp.text()
            raise aiohttp.ClientResponseError(
                resp.request_info,
                resp.history,
                status=resp.status,
                message=f"DMWork API {path} failed ({resp.status}): {text or resp.reason}",
            )
        text = await resp.text()
        if not text:
            return None
        return await resp.json(content_type=None)


# ─── Bot Registration ────────────────────────────────────────────────────────


async def register_bot(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    force_refresh: bool = False,
) -> BotRegisterResp:
    """
    Register bot and obtain WS connection credentials.

    Args:
        session: aiohttp client session.
        api_url: Base API URL.
        bot_token: Bot authentication token.
        force_refresh: If True, force token refresh.

    Returns:
        BotRegisterResp with ws_url, im_token, robot_id, etc.
    """
    path = "/v1/bot/register"
    if force_refresh:
        path += "?force_refresh=true"

    result = await post_json(session, api_url, bot_token, path, {})
    if not result:
        raise RuntimeError("DMWork bot registration returned empty response")

    return BotRegisterResp(
        robot_id=result["robot_id"],
        im_token=result["im_token"],
        ws_url=result["ws_url"],
        api_url=result.get("api_url", api_url),
        owner_uid=result["owner_uid"],
        owner_channel_id=result["owner_channel_id"],
    )


# ─── Message Sending ─────────────────────────────────────────────────────────


async def send_message(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    channel_id: str,
    channel_type: ChannelType,
    content: str,
    mention_uids: Optional[list[str]] = None,
    mention_entities: Optional[list[MentionEntity]] = None,
    mention_all: bool = False,
    stream_no: Optional[str] = None,
    reply_msg_id: Optional[str] = None,
) -> None:
    """
    Send a text message to a channel.

    Args:
        session: aiohttp client session.
        api_url: Base API URL.
        bot_token: Bot authentication token.
        channel_id: Target channel ID.
        channel_type: DM (1) or Group (2).
        content: Message text content.
        mention_uids: UIDs to @mention.
        mention_entities: Precise mention entities.
        mention_all: If True, @all.
        stream_no: Optional stream number for streaming messages.
        reply_msg_id: Optional message ID to reply to.
    """
    payload: dict[str, Any] = {
        "type": MessageType.Text,
        "content": content,
    }

    # Build mention field
    if mention_uids or mention_entities or mention_all:
        mention: dict[str, Any] = {}
        if mention_uids:
            mention["uids"] = mention_uids
        if mention_entities:
            mention["entities"] = [
                {"uid": e.uid, "offset": e.offset, "length": e.length}
                for e in mention_entities
            ]
        if mention_all:
            mention["all"] = 1
        payload["mention"] = mention

    # Add reply field
    if reply_msg_id:
        payload["reply"] = {"message_id": reply_msg_id}

    body: dict[str, Any] = {
        "channel_id": channel_id,
        "channel_type": channel_type,
        "payload": payload,
    }
    if stream_no:
        body["stream_no"] = stream_no

    await post_json(session, api_url, bot_token, "/v1/bot/sendMessage", body)


async def send_typing(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    channel_id: str,
    channel_type: ChannelType,
) -> None:
    """Send typing indicator to a channel."""
    await post_json(session, api_url, bot_token, "/v1/bot/typing", {
        "channel_id": channel_id,
        "channel_type": channel_type,
    })


async def send_media_message(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    channel_id: str,
    channel_type: ChannelType,
    msg_type: MessageType,
    url: str,
    name: Optional[str] = None,
    size: Optional[int] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
) -> None:
    """
    Send a media message (image, file, etc.) to a channel.

    Args:
        msg_type: MessageType.Image, MessageType.File, etc.
        url: Media file URL.
        name: Filename (for File type).
        size: File size in bytes (for File type).
        width: Image width (for Image type).
        height: Image height (for Image type).
    """
    payload: dict[str, Any] = {
        "type": msg_type,
        "url": url,
    }
    if msg_type == MessageType.Image:
        if width:
            payload["width"] = width
        if height:
            payload["height"] = height
    else:
        if name:
            payload["name"] = name
        if size is not None:
            payload["size"] = size

    await post_json(session, api_url, bot_token, "/v1/bot/sendMessage", {
        "channel_id": channel_id,
        "channel_type": channel_type,
        "payload": payload,
    })


async def send_read_receipt(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    channel_id: str,
    channel_type: ChannelType,
    message_ids: Optional[list[str]] = None,
) -> None:
    """
    Send a read receipt to a channel.

    Args:
        channel_id: Channel to mark as read.
        channel_type: DM or Group.
        message_ids: Optional specific message IDs to acknowledge.
    """
    body: dict[str, Any] = {
        "channel_id": channel_id,
        "channel_type": channel_type,
    }
    if message_ids:
        body["message_ids"] = message_ids
    await post_json(session, api_url, bot_token, "/v1/bot/readReceipt", body)


# ─── Stream API ──────────────────────────────────────────────────────────────


async def stream_start(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    channel_id: str,
    channel_type: ChannelType,
    initial_content: str,
) -> Optional[str]:
    """
    Start a streaming message.

    The initial content is sent as a base64-encoded JSON payload.

    Args:
        channel_id: Target channel.
        channel_type: DM or Group.
        initial_content: Initial text content.

    Returns:
        stream_no (stream identifier) or None on failure.
    """
    import json
    payload_b64 = base64.b64encode(
        json.dumps({"type": 1, "content": initial_content}).encode("utf-8")
    ).decode("ascii")

    result = await post_json(session, api_url, bot_token, "/v1/bot/stream/start", {
        "channel_id": channel_id,
        "channel_type": channel_type,
        "payload": payload_b64,
    })
    return result.get("stream_no") if result else None


async def stream_end(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    stream_no: str,
    channel_id: str,
    channel_type: ChannelType,
) -> None:
    """
    End a streaming message.

    Args:
        stream_no: Stream identifier from stream_start.
        channel_id: Target channel.
        channel_type: DM or Group.
    """
    await post_json(session, api_url, bot_token, "/v1/bot/stream/end", {
        "stream_no": stream_no,
        "channel_id": channel_id,
        "channel_type": channel_type,
    })


# ─── COS Upload ──────────────────────────────────────────────────────────────


async def get_upload_credentials(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    filename: str,
) -> dict[str, Any]:
    """
    Get STS temporary credentials for COS upload.

    Returns:
        Dict with bucket, region, key, credentials, startTime, expiredTime, cdnBaseUrl.

    Raises:
        RuntimeError: If the API returns incomplete data.
    """
    encoded_filename = quote(filename)
    url = f"{api_url.rstrip('/')}/v1/bot/upload/credentials?filename={encoded_filename}"
    headers = {"Authorization": f"Bearer {bot_token}"}

    async with session.get(url, headers=headers, timeout=DEFAULT_TIMEOUT) as resp:
        if not resp.ok:
            text = await resp.text()
            raise RuntimeError(
                f"DMWork API /v1/bot/upload/credentials failed ({resp.status}): {text or resp.reason}"
            )
        data = await resp.json()

    # Validate required fields
    for field in ("bucket", "region", "key", "credentials"):
        if not data.get(field):
            raise RuntimeError(
                f"DMWork API /v1/bot/upload/credentials returned incomplete response: missing {field}"
            )
    creds = data["credentials"]
    for field in ("tmpSecretId", "tmpSecretKey", "sessionToken"):
        if not creds.get(field):
            raise RuntimeError(
                f"DMWork API /v1/bot/upload/credentials returned incomplete credentials: missing {field}"
            )
    return data


_CD_UNSAFE_RE = re.compile(r'["\\\x00-\x1f\x7f;]')


def _build_content_disposition(
    filename: str,
    disposition_type: str = "attachment",
) -> str:
    """Build RFC 5987 Content-Disposition header value with safe ASCII fallback."""
    is_ascii_safe = bool(re.match(r'^[\x20-\x7e]+$', filename)) and not _CD_UNSAFE_RE.search(filename)
    encoded = quote(filename, safe='')

    if is_ascii_safe:
        return f'{disposition_type}; filename="{filename}"'

    ext = '.' + filename.rsplit('.', 1)[1] if '.' in filename else ''
    return f"{disposition_type}; filename=\"download{ext}\"; filename*=UTF-8''{encoded}"


async def upload_file_to_cos(
    session: aiohttp.ClientSession,
    credentials: dict[str, str],
    bucket: str,
    region: str,
    key: str,
    file_data: bytes,
    content_type: str,
    cdn_base_url: Optional[str] = None,
    filename: Optional[str] = None,
) -> str:
    """
    Upload a file to COS using STS temporary credentials via HTTP PUT.

    Uses direct HTTP PUT with authorization header instead of the COS SDK,
    keeping dependencies minimal.

    Args:
        session: aiohttp client session.
        credentials: Dict with tmpSecretId, tmpSecretKey, sessionToken.
        bucket: COS bucket name.
        region: COS region.
        key: Object key (path in bucket).
        file_data: File content bytes.
        content_type: MIME type of the file.
        cdn_base_url: Optional CDN base URL for the result URL.

    Returns:
        Public URL of the uploaded file.
    """
    secret_id = credentials["tmpSecretId"]
    secret_key = credentials["tmpSecretKey"]
    session_token = credentials["sessionToken"]

    # Build COS endpoint
    host = f"{bucket}.cos.{region}.myqcloud.com"
    url = f"https://{host}/{key}"

    # Generate authorization signature
    # COS uses a simplified HMAC-SHA1 signature for PUT requests
    now = int(time.time())
    sign_time = f"{now - 60};{now + 3600}"  # valid for 1 hour

    # Build string to sign (simplified COS auth)
    http_string = f"put\n/{key}\n\nhost={host.lower()}\n"
    sha1_content = hashlib.sha1(http_string.encode("utf-8")).hexdigest()
    string_to_sign = f"sha1\n{sign_time}\n{sha1_content}\n"

    # Sign
    sign_key = hmac.new(
        secret_key.encode("utf-8"),
        sign_time.encode("utf-8"),
        hashlib.sha1,
    ).hexdigest()
    signature = hmac.new(
        sign_key.encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha1,
    ).hexdigest()

    authorization = (
        f"q-sign-algorithm=sha1"
        f"&q-ak={secret_id}"
        f"&q-sign-time={sign_time}"
        f"&q-key-time={sign_time}"
        f"&q-header-list=host"
        f"&q-url-param-list="
        f"&q-signature={signature}"
    )

    headers = {
        "Host": host,
        "Content-Type": content_type,
        "Content-Length": str(len(file_data)),
        "Authorization": authorization,
        "x-cos-security-token": session_token,
    }
    if filename:
        if content_type.startswith("video/") or content_type.startswith("audio/"):
            headers["Content-Disposition"] = _build_content_disposition(filename, "inline")
        elif not content_type.startswith("image/"):
            headers["Content-Disposition"] = _build_content_disposition(filename, "attachment")

    upload_timeout = aiohttp.ClientTimeout(total=300)  # 5 min for large files
    async with session.put(url, data=file_data, headers=headers, timeout=upload_timeout) as resp:
        if not resp.ok:
            text = await resp.text()
            raise RuntimeError(f"COS upload failed ({resp.status}): {text[:500]}")

    # Build result URL
    if cdn_base_url:
        base = cdn_base_url.rstrip("/")
        # Re-encode path segments for CDN URL
        re_encoded_key = "/".join(quote(seg) for seg in key.split("/"))
        return f"{base}/{re_encoded_key}"
    else:
        return f"https://{host}/{key}"


async def upload_and_get_url(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    filename: str,
    file_data: bytes,
    content_type: str,
) -> str:
    """
    High-level: get credentials, upload to COS, return URL.

    Args:
        filename: Original filename.
        file_data: File content bytes.
        content_type: MIME type.

    Returns:
        Public URL of the uploaded file.
    """
    creds_data = await get_upload_credentials(session, api_url, bot_token, filename)

    return await upload_file_to_cos(
        session,
        credentials=creds_data["credentials"],
        bucket=creds_data["bucket"],
        region=creds_data["region"],
        key=creds_data["key"],
        file_data=file_data,
        content_type=content_type,
        cdn_base_url=creds_data.get("cdnBaseUrl"),
        filename=filename,
    )


async def download_file(
    session: aiohttp.ClientSession,
    url: str,
    max_size: int = 500 * 1024 * 1024,
    timeout_seconds: int = 300,
) -> tuple[bytes, str, str]:
    """
    Download a file from a URL.

    Args:
        url: URL to download.
        max_size: Maximum file size in bytes.
        timeout_seconds: Download timeout.

    Returns:
        (file_data, content_type, filename)

    Raises:
        RuntimeError: If file is too large or download fails.
    """
    dl_timeout = aiohttp.ClientTimeout(total=timeout_seconds)
    async with session.get(url, timeout=dl_timeout) as resp:
        if not resp.ok:
            raise RuntimeError(f"Download failed ({resp.status}): {url}")

        content_type = resp.headers.get("Content-Type", "application/octet-stream")

        # Extract filename from URL or Content-Disposition
        filename = "file"
        cd = resp.headers.get("Content-Disposition", "")
        if "filename=" in cd:
            filename = cd.split("filename=")[-1].strip('"').strip("'")
        else:
            try:
                from urllib.parse import urlparse, unquote
                path = urlparse(url).path
                filename = unquote(path.split("/")[-1]) or "file"
            except Exception:
                pass

        # Check size
        cl = resp.headers.get("Content-Length")
        if cl and int(cl) > max_size:
            raise RuntimeError(f"File too large ({cl} bytes, max {max_size})")

        data = bytearray()
        async for chunk in resp.content.iter_any():
            data.extend(chunk)
            if len(data) > max_size:
                raise RuntimeError(f"File too large (>{max_size} bytes)")

        return bytes(data), content_type, filename


# ─── Channel History ─────────────────────────────────────────────────────────


async def get_channel_messages(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    channel_id: str,
    channel_type: ChannelType,
    limit: int = 20,
    start_message_seq: int = 0,
    end_message_seq: int = 0,
) -> list[dict[str, Any]]:
    """
    Fetch channel history messages.

    Uses /v1/bot/messages/sync API. Payloads are base64-encoded JSON.

    Args:
        channel_id: Channel to fetch history from.
        channel_type: DM or Group.
        limit: Max messages to fetch (default 20).
        start_message_seq: Start sequence (0 = from beginning).
        end_message_seq: End sequence (0 = to latest).

    Returns:
        List of dicts with from_uid, content, timestamp, type, url, name, payload.
    """
    try:
        result = await post_json(session, api_url, bot_token, "/v1/bot/messages/sync", {
            "channel_id": channel_id,
            "channel_type": channel_type,
            "limit": limit,
            "start_message_seq": start_message_seq,
            "end_message_seq": end_message_seq,
            "pull_mode": 1,  # 1 = pull up (newer messages)
        })

        if not result:
            return []

        messages = result.get("messages", [])
        parsed = []
        for m in messages:
            payload: dict[str, Any] = {}
            raw_payload = m.get("payload")
            if raw_payload:
                try:
                    decoded = base64.b64decode(raw_payload).decode("utf-8")
                    import json
                    payload = json.loads(decoded)
                except Exception:
                    if isinstance(raw_payload, dict):
                        payload = raw_payload

            parsed.append({
                "from_uid": m.get("from_uid", "unknown"),
                "type": payload.get("type"),
                "url": payload.get("url"),
                "name": payload.get("name"),
                "content": payload.get("content", ""),
                "payload": payload,
                # API returns seconds, convert to ms
                "timestamp": (m.get("timestamp", int(time.time()))) * 1000,
            })
        return parsed
    except Exception as e:
        logger.error("dmwork: getChannelMessages error: %s", e)
        return []


# ─── Group API ────────────────────────────────────────────────────────────────


async def fetch_bot_groups(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
) -> list[dict[str, str]]:
    """
    Fetch the list of groups the bot belongs to.

    Returns:
        List of dicts with 'group_no' and 'name' keys.
    """
    url = f"{api_url.rstrip('/')}/v1/bot/groups"
    headers = {"Authorization": f"Bearer {bot_token}"}
    try:
        async with session.get(url, headers=headers, timeout=DEFAULT_TIMEOUT) as resp:
            if not resp.ok:
                logger.error("dmwork: fetchBotGroups failed: %d", resp.status)
                return []
            data = await resp.json()
            return data if isinstance(data, list) else []
    except Exception as e:
        logger.error("dmwork: fetchBotGroups error: %s", e)
        return []


async def get_group_members(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    group_no: str,
) -> list[GroupMember]:
    """
    Get members of a group.

    Args:
        group_no: Group ID (channel_id).

    Returns:
        List of GroupMember objects.
    """
    url = f"{api_url.rstrip('/')}/v1/bot/groups/{group_no}/members"
    headers = {"Authorization": f"Bearer {bot_token}"}
    try:
        async with session.get(url, headers=headers, timeout=DEFAULT_TIMEOUT) as resp:
            if not resp.ok:
                logger.error("dmwork: getGroupMembers failed: %d", resp.status)
                return []
            data = await resp.json()
            # Normalize: API may return {members: [...]} or bare [...]
            members_raw = data.get("members", data) if isinstance(data, dict) else data
            if not isinstance(members_raw, list):
                return []
            return [
                GroupMember(
                    uid=m.get("uid", ""),
                    name=m.get("name", ""),
                    role=m.get("role"),
                    robot=m.get("robot"),
                )
                for m in members_raw
            ]
    except Exception as e:
        logger.error("dmwork: getGroupMembers error: %s", e)
        return []


async def get_group_info(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    group_no: str,
) -> GroupInfo:
    """
    Get information about a group.

    Args:
        group_no: Group ID (channel_id).

    Returns:
        GroupInfo with group_no, name, and extra fields.

    Raises:
        RuntimeError: If the API call fails.
    """
    url = f"{api_url.rstrip('/')}/v1/bot/groups/{group_no}"
    headers = {"Authorization": f"Bearer {bot_token}"}
    async with session.get(url, headers=headers, timeout=DEFAULT_TIMEOUT) as resp:
        if not resp.ok:
            text = await resp.text()
            raise RuntimeError(f"getGroupInfo failed ({resp.status}): {text}")
        data = await resp.json()
        known_keys = {"group_no", "name"}
        return GroupInfo(
            group_no=data.get("group_no", group_no),
            name=data.get("name", ""),
            extra={k: v for k, v in data.items() if k not in known_keys},
        )


async def fetch_user_info(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    uid: str,
) -> Optional[dict[str, str]]:
    """
    Fetch user info by UID.

    Returns:
        Dict with uid, name, avatar keys, or None if unavailable.
    """
    url = f"{api_url.rstrip('/')}/v1/bot/user/info?uid={uid}"
    headers = {"Authorization": f"Bearer {bot_token}"}
    try:
        async with session.get(
            url, headers=headers, timeout=aiohttp.ClientTimeout(total=5)
        ) as resp:
            if resp.status == 404:
                return None
            if not resp.ok:
                logger.error("dmwork: fetchUserInfo(%s) failed: %d", uid, resp.status)
                return None
            data = await resp.json()
            if data and data.get("name"):
                return {
                    "uid": data.get("uid", uid),
                    "name": data["name"],
                    "avatar": data.get("avatar", ""),
                }
            return None
    except Exception as e:
        logger.error("dmwork: fetchUserInfo(%s) error: %s", uid, e)
        return None


# ─── GROUP.md API ─────────────────────────────────────────────────────────────


async def get_group_md(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    group_no: str,
) -> Optional[dict[str, Any]]:
    """
    Fetch GROUP.md content for a group.

    Returns:
        Dict with content, version, updated_at, updated_by, or None on 404.
    """
    url = f"{api_url.rstrip('/')}/v1/bot/groups/{group_no}/md"
    headers = {"Authorization": f"Bearer {bot_token}"}
    try:
        async with session.get(url, headers=headers, timeout=DEFAULT_TIMEOUT) as resp:
            if resp.status == 404:
                return None
            if not resp.ok:
                text = await resp.text()
                logger.error("dmwork: getGroupMd(%s) failed: %d %s", group_no, resp.status, text[:200])
                return None
            return await resp.json()
    except Exception as e:
        logger.error("dmwork: getGroupMd(%s) error: %s", group_no, e)
        return None


async def update_group_md(
    session: aiohttp.ClientSession,
    api_url: str,
    bot_token: str,
    group_no: str,
    content: str,
) -> Optional[dict[str, Any]]:
    """
    Update GROUP.md content for a group.

    Returns:
        Dict with version on success, or None on error.
    """
    url = f"{api_url.rstrip('/')}/v1/bot/groups/{group_no}/md"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {bot_token}",
    }
    import json
    async with session.put(
        url,
        data=json.dumps({"content": content}),
        headers=headers,
        timeout=DEFAULT_TIMEOUT,
    ) as resp:
        if not resp.ok:
            text = await resp.text()
            logger.error("dmwork: updateGroupMd(%s) failed: %d %s", group_no, resp.status, text[:200])
            return None
        return await resp.json()
