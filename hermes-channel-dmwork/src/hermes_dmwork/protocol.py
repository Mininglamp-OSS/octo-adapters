"""
WuKongIM binary protocol encoder/decoder.

Strict translation from openclaw-channel-dmwork/src/socket.ts.
Implements CONNECT/CONNACK/RECV/RECVACK/PING/PONG frame encoding/decoding,
ECDH key exchange (Curve25519), and AES-CBC encryption.

Protocol version: 4
Wire format: Big-endian binary over WebSocket.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import struct
import time
import uuid
from dataclasses import dataclass
from enum import IntEnum
from typing import Any, Optional

from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7

logger = logging.getLogger(__name__)

# ─── WuKongIM Binary Protocol Constants ─────────────────────────────────────

PROTO_VERSION = 4


class PacketType(IntEnum):
    """WuKongIM packet types."""
    CONNECT = 1
    CONNACK = 2
    SEND = 3
    SENDACK = 4
    RECV = 5
    RECVACK = 6
    PING = 7
    PONG = 8
    DISCONNECT = 9


# ─── Binary Encoder / Decoder ───────────────────────────────────────────────


class Encoder:
    """Binary encoder matching the TS Encoder class byte-for-byte."""

    def __init__(self) -> None:
        self._buf = bytearray()

    def write_byte(self, b: int) -> None:
        self._buf.append(b & 0xFF)

    def write_bytes(self, data: bytes | bytearray | list[int]) -> None:
        self._buf.extend(data)

    def write_int16(self, v: int) -> None:
        """Big-endian unsigned 16-bit integer."""
        self._buf.extend(struct.pack(">H", v & 0xFFFF))

    def write_int32(self, v: int) -> None:
        """Big-endian unsigned 32-bit integer."""
        self._buf.extend(struct.pack(">I", v & 0xFFFFFFFF))

    def write_int64(self, v: int) -> None:
        """Big-endian unsigned 64-bit integer."""
        self._buf.extend(struct.pack(">Q", v & 0xFFFFFFFFFFFFFFFF))

    def write_string(self, s: str) -> None:
        """Length-prefixed UTF-8 string (2-byte big-endian length prefix)."""
        if s:
            encoded = s.encode("utf-8")
            self.write_int16(len(encoded))
            self._buf.extend(encoded)
        else:
            self.write_int16(0)

    def to_bytes(self) -> bytes:
        return bytes(self._buf)


class Decoder:
    """Binary decoder matching the TS Decoder class byte-for-byte."""

    def __init__(self, data: bytes | bytearray) -> None:
        self._data = data if isinstance(data, (bytes, bytearray)) else bytes(data)
        self._offset = 0

    @property
    def remaining(self) -> int:
        return len(self._data) - self._offset

    def read_byte(self) -> int:
        b = self._data[self._offset]
        self._offset += 1
        return b

    def read_int16(self) -> int:
        """Big-endian unsigned 16-bit integer."""
        v = struct.unpack_from(">H", self._data, self._offset)[0]
        self._offset += 2
        return v

    def read_int32(self) -> int:
        """Big-endian unsigned 32-bit integer."""
        v = struct.unpack_from(">I", self._data, self._offset)[0]
        self._offset += 4
        return v

    def read_int64_string(self) -> str:
        """Read 8 bytes as big-endian unsigned 64-bit integer, return as string."""
        v = struct.unpack_from(">Q", self._data, self._offset)[0]
        self._offset += 8
        return str(v)

    def read_int64(self) -> int:
        """Read 8 bytes as big-endian unsigned 64-bit integer."""
        v = struct.unpack_from(">Q", self._data, self._offset)[0]
        self._offset += 8
        return v

    def read_string(self) -> str:
        """Read a length-prefixed UTF-8 string."""
        length = self.read_int16()
        if length <= 0:
            return ""
        raw = self._data[self._offset : self._offset + length]
        self._offset += length
        return raw.decode("utf-8")

    def read_remaining(self) -> bytes:
        """Read all remaining bytes."""
        data = self._data[self._offset :]
        self._offset = len(self._data)
        return data

    def read_variable_length(self) -> int:
        """Read MQTT-style variable-length integer."""
        multiplier = 0
        value = 0
        while multiplier < 27:
            b = self.read_byte()
            value |= (b & 127) << multiplier
            if (b & 128) == 0:
                break
            multiplier += 7
        return value


# ─── Variable-Length Encoding ────────────────────────────────────────────────


def encode_variable_length(length: int) -> bytes:
    """Encode an integer as MQTT-style variable-length bytes."""
    if length == 0:
        return b"\x00"
    result = bytearray()
    while length > 0:
        digit = length % 0x80
        length //= 0x80
        if length > 0:
            digit |= 0x80
        result.append(digit)
    return bytes(result)


# ─── AES-CBC Encryption Helpers ─────────────────────────────────────────────

# These match the TS aesEncrypt/aesDecrypt functions exactly.
# The TS version uses CryptoJS which:
#   - Key: UTF-8 encoded, first 16 bytes (128-bit AES)
#   - IV: UTF-8 encoded, first 16 bytes
#   - Mode: CBC
#   - Padding: PKCS7
#   - Input for decrypt: Base64 string → raw bytes
#   - Output for encrypt: Base64 string


def aes_encrypt(plaintext: str, aes_key: str, aes_iv: str) -> str:
    """
    AES-128-CBC encrypt, matching CryptoJS behavior.

    Args:
        plaintext: UTF-8 string to encrypt.
        aes_key: 16-char string used as AES key.
        aes_iv: 16-char string used as IV.

    Returns:
        Base64-encoded ciphertext string.
    """
    key_bytes = aes_key.encode("utf-8")[:16]
    iv_bytes = aes_iv.encode("utf-8")[:16]

    # PKCS7 padding
    padder = PKCS7(128).padder()
    padded = padder.update(plaintext.encode("utf-8")) + padder.finalize()

    cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv_bytes))
    encryptor = cipher.encryptor()
    ciphertext = encryptor.update(padded) + encryptor.finalize()

    return base64.b64encode(ciphertext).decode("ascii")


def aes_decrypt(data: bytes, aes_key: str, aes_iv: str) -> bytes:
    """
    AES-128-CBC decrypt, matching CryptoJS behavior.

    The TS version interprets the input bytes as a raw string, then
    base64-parses that to get the actual ciphertext. We replicate this:
    the encrypted payload bytes are themselves a Base64-encoded string.

    Args:
        data: Raw bytes from the RECV frame (Base64-encoded ciphertext).
        aes_key: 16-char string used as AES key.
        aes_iv: 16-char string used as IV.

    Returns:
        Decrypted plaintext bytes.
    """
    key_bytes = aes_key.encode("utf-8")[:16]
    iv_bytes = aes_iv.encode("utf-8")[:16]

    # The encrypted payload is a Base64 string encoded as raw bytes
    b64_str = data.decode("latin-1")  # byte-to-char mapping (same as TS String.fromCharCode)
    ciphertext = base64.b64decode(b64_str)

    cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv_bytes))
    decryptor = cipher.decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()

    # Remove PKCS7 padding
    unpadder = PKCS7(128).unpadder()
    plaintext = unpadder.update(padded) + unpadder.finalize()
    return plaintext


# ─── ECDH Key Exchange (Curve25519) ─────────────────────────────────────────


def generate_keypair() -> tuple[bytes, bytes]:
    """
    Generate an X25519 key pair for ECDH.

    Returns:
        (private_key_bytes, public_key_bytes) — both 32 bytes.

    Note: The TS version uses curve25519-js with a random seed.
    We use cryptography's X25519 which generates secure random keys directly.
    """
    private_key = X25519PrivateKey.generate()
    public_key = private_key.public_key()

    # Extract raw bytes
    priv_bytes = private_key.private_bytes_raw()
    pub_bytes = public_key.public_bytes_raw()

    return priv_bytes, pub_bytes


def compute_shared_secret(private_key_bytes: bytes, server_public_key_bytes: bytes) -> bytes:
    """
    Compute the X25519 shared secret.

    Args:
        private_key_bytes: 32-byte private key.
        server_public_key_bytes: 32-byte server public key.

    Returns:
        32-byte shared secret.
    """
    private_key = X25519PrivateKey.from_private_bytes(private_key_bytes)
    server_pub = X25519PublicKey.from_public_bytes(server_public_key_bytes)
    return private_key.exchange(server_pub)


def derive_aes_key(shared_secret: bytes) -> str:
    """
    Derive the AES key from the ECDH shared secret.

    Process (matching TS):
    1. Base64-encode the shared secret
    2. MD5 hash the base64 string
    3. Take first 16 characters as AES key

    Returns:
        16-character hex string used as AES key.
    """
    secret_b64 = base64.b64encode(shared_secret).decode("ascii")
    md5_hash = hashlib.md5(secret_b64.encode("utf-8")).hexdigest()
    return md5_hash[:16]


# ─── Packet Encoding ────────────────────────────────────────────────────────


def encode_connect_packet(
    version: int,
    device_flag: int,
    device_id: str,
    uid: str,
    token: str,
    client_timestamp: int,
    client_key: str,
) -> bytes:
    """
    Encode a CONNECT packet.

    Matches encodeConnectPacket() in socket.ts byte-for-byte.

    Args:
        version: Protocol version (4).
        device_flag: Device type flag (0 = app/bot).
        device_id: Unique device identifier.
        uid: Bot user ID.
        token: IM authentication token.
        client_timestamp: Current timestamp in milliseconds.
        client_key: Base64-encoded public key for ECDH.

    Returns:
        Complete CONNECT frame as bytes.
    """
    body = Encoder()
    body.write_byte(version)
    body.write_byte(device_flag)
    body.write_string(device_id)
    body.write_string(uid)
    body.write_string(token)
    body.write_int64(client_timestamp)
    body.write_string(client_key)
    body_bytes = body.to_bytes()

    frame = Encoder()
    # Header: packetType << 4 | flags
    frame.write_byte((PacketType.CONNECT << 4) | 0)
    frame.write_bytes(encode_variable_length(len(body_bytes)))
    frame.write_bytes(body_bytes)
    return frame.to_bytes()


def encode_ping_packet() -> bytes:
    """Encode a PING packet (single byte)."""
    return bytes([(PacketType.PING << 4) | 0])


def encode_recvack_packet(message_id: str, message_seq: int) -> bytes:
    """
    Encode a RECVACK packet.

    Matches encodeRecvackPacket() in socket.ts byte-for-byte.

    Args:
        message_id: Message ID as decimal string (from RECV).
        message_seq: Message sequence number.

    Returns:
        Complete RECVACK frame as bytes.
    """
    body = Encoder()
    body.write_int64(int(message_id))
    body.write_int32(message_seq)
    body_bytes = body.to_bytes()

    frame = Encoder()
    frame.write_byte((PacketType.RECVACK << 4) | 0)
    frame.write_bytes(encode_variable_length(len(body_bytes)))
    frame.write_bytes(body_bytes)
    return frame.to_bytes()


# ─── Setting Flags (from RECV header) ───────────────────────────────────────


@dataclass
class SettingFlags:
    """Parsed setting byte from RECV packet."""
    receipt_enabled: bool
    topic: bool
    stream_on: bool


def parse_setting_byte(v: int) -> SettingFlags:
    """Parse the setting byte from a RECV packet header."""
    return SettingFlags(
        receipt_enabled=((v >> 7) & 0x01) > 0,
        topic=((v >> 3) & 0x01) > 0,
        stream_on=((v >> 1) & 0x01) > 0,
    )


# ─── Packet Parsing Results ─────────────────────────────────────────────────


@dataclass
class ConnackResult:
    """Parsed CONNACK packet."""
    reason_code: int
    server_key: str  # Base64-encoded server public key
    salt: str  # Salt for AES IV
    server_version: int
    time_diff: int  # Server time difference
    node_id: int  # Node ID (proto v4+)


@dataclass
class RecvResult:
    """Parsed RECV packet (before payload decryption)."""
    setting: SettingFlags
    msg_key: str
    from_uid: str
    channel_id: str
    channel_type: int
    client_msg_no: str
    message_id: str
    message_seq: int
    timestamp: int
    encrypted_payload: bytes


# ─── Packet Decoder ─────────────────────────────────────────────────────────


def decode_packet(data: bytes) -> tuple[int, Any]:
    """
    Decode a single WuKongIM packet.

    Handles CONNACK, RECV, DISCONNECT, PONG, and PING.
    Matches onPacket() in socket.ts.

    Args:
        data: Complete frame bytes (header + variable-length + body).

    Returns:
        (packet_type, parsed_result) where parsed_result type depends on packet_type.

    Raises:
        ValueError: If the packet is malformed.
    """
    if not data:
        raise ValueError("Empty packet data")

    first_byte = data[0]
    packet_type = first_byte >> 4

    # PONG is a single byte
    if packet_type == PacketType.PONG:
        return PacketType.PONG, None

    # PING is a single byte
    if packet_type == PacketType.PING:
        return PacketType.PING, None

    has_server_version = (first_byte & 0x01) > 0

    dec = Decoder(data)
    dec.read_byte()  # header byte

    if packet_type not in (PacketType.PING, PacketType.PONG):
        dec.read_variable_length()  # remaining length

    if packet_type == PacketType.CONNACK:
        return PacketType.CONNACK, _decode_connack(dec, has_server_version)
    elif packet_type == PacketType.RECV:
        return PacketType.RECV, _decode_recv(dec, first_byte)
    elif packet_type == PacketType.DISCONNECT:
        return PacketType.DISCONNECT, _decode_disconnect(dec)
    elif packet_type == PacketType.SENDACK:
        return PacketType.SENDACK, None
    else:
        return packet_type, None


def _decode_connack(dec: Decoder, has_server_version: bool) -> ConnackResult:
    """Decode CONNACK body. Matches onConnack() in socket.ts."""
    server_version = 0
    if has_server_version:
        server_version = dec.read_byte()

    time_diff = dec.read_int64()
    reason_code = dec.read_byte()
    server_key = dec.read_string()
    salt = dec.read_string()

    node_id = 0
    if server_version >= 4:
        node_id = dec.read_int64()

    return ConnackResult(
        reason_code=reason_code,
        server_key=server_key,
        salt=salt,
        server_version=server_version,
        time_diff=time_diff,
        node_id=node_id,
    )


def _decode_recv(dec: Decoder, first_byte: int) -> RecvResult:
    """Decode RECV body. Matches onRecv() in socket.ts."""
    setting_byte = dec.read_byte()
    setting = parse_setting_byte(setting_byte)

    msg_key = dec.read_string()
    from_uid = dec.read_string()
    channel_id = dec.read_string()
    channel_type = dec.read_byte()

    # server_version >= 3: expire field
    # We always read it since PROTO_VERSION=4
    _expire = dec.read_int32()

    client_msg_no = dec.read_string()
    message_id = dec.read_int64_string()
    message_seq = dec.read_int32()
    timestamp = dec.read_int32()

    if setting.topic:
        _topic = dec.read_string()

    encrypted_payload = dec.read_remaining()

    return RecvResult(
        setting=setting,
        msg_key=msg_key,
        from_uid=from_uid,
        channel_id=channel_id,
        channel_type=channel_type,
        client_msg_no=client_msg_no,
        message_id=message_id,
        message_seq=message_seq,
        timestamp=timestamp,
        encrypted_payload=encrypted_payload,
    )


def _decode_disconnect(dec: Decoder) -> dict[str, Any]:
    """Decode DISCONNECT body."""
    reason_code = dec.read_byte()
    reason = dec.read_string()
    return {"reason_code": reason_code, "reason": reason}


# ─── Frame Unpacking (Sticky Packet Handling) ────────────────────────────────


def try_unpack_one(buf: bytearray) -> tuple[Optional[bytes], bytearray]:
    """
    Try to extract one complete frame from the buffer.

    Handles MQTT-style variable-length framing and sticky packets
    (multiple frames concatenated in one WebSocket message).

    Matches unpackOne() in socket.ts.

    Args:
        buf: Buffer of accumulated bytes.

    Returns:
        (frame_bytes, remaining_buffer) — frame_bytes is None if
        the buffer doesn't contain a complete frame yet.
    """
    if not buf:
        return None, buf

    header = buf[0]
    packet_type = header >> 4

    # PONG and PING are single-byte frames
    if packet_type == PacketType.PONG or packet_type == PacketType.PING:
        return bytes([header]), bytearray(buf[1:])

    length = len(buf)
    fixed_header_length = 1
    pos = fixed_header_length
    rem_length = 0
    multiplier = 1
    rem_length_full = True

    while True:
        if pos > length - 1:
            rem_length_full = False
            break
        digit = buf[pos]
        pos += 1
        rem_length += (digit & 127) * multiplier
        multiplier *= 128
        if (digit & 0x80) == 0:
            break

    if not rem_length_full:
        return None, buf  # Incomplete variable-length header

    total_length = fixed_header_length + (pos - fixed_header_length) + rem_length

    if total_length > length:
        return None, buf  # Incomplete packet body

    frame = bytes(buf[:total_length])
    remaining = bytearray(buf[total_length:])
    return frame, remaining


# ─── Device ID Generation ───────────────────────────────────────────────────


def generate_device_id() -> str:
    """
    Generate a random device ID matching the TS generateDeviceID() format.

    Format: xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx (UUID v4 style hex string).
    """
    return uuid.uuid4().hex
