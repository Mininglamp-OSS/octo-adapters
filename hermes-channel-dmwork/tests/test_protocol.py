"""
Tests for hermes_dmwork.protocol — encoder/decoder round-trip and frame building.
"""

import base64
import pytest
from hermes_dmwork.protocol import (
    PROTO_VERSION,
    PacketType,
    Encoder,
    Decoder,
    encode_variable_length,
    aes_encrypt,
    aes_decrypt,
    generate_keypair,
    compute_shared_secret,
    derive_aes_key,
    encode_connect_packet,
    encode_ping_packet,
    encode_recvack_packet,
    decode_packet,
    try_unpack_one,
    generate_device_id,
    parse_setting_byte,
)


class TestEncoder:
    def test_write_byte(self):
        enc = Encoder()
        enc.write_byte(0xFF)
        assert enc.to_bytes() == b"\xff"

    def test_write_int16(self):
        enc = Encoder()
        enc.write_int16(0x1234)
        assert enc.to_bytes() == b"\x12\x34"

    def test_write_int32(self):
        enc = Encoder()
        enc.write_int32(0x12345678)
        assert enc.to_bytes() == b"\x12\x34\x56\x78"

    def test_write_int64(self):
        enc = Encoder()
        enc.write_int64(0x0102030405060708)
        assert enc.to_bytes() == b"\x01\x02\x03\x04\x05\x06\x07\x08"

    def test_write_string(self):
        enc = Encoder()
        enc.write_string("hi")
        data = enc.to_bytes()
        assert data[:2] == b"\x00\x02"  # length prefix
        assert data[2:] == b"hi"

    def test_write_empty_string(self):
        enc = Encoder()
        enc.write_string("")
        assert enc.to_bytes() == b"\x00\x00"

    def test_write_utf8_string(self):
        enc = Encoder()
        enc.write_string("你好")
        data = enc.to_bytes()
        # "你好" is 6 bytes in UTF-8
        assert data[:2] == b"\x00\x06"
        assert data[2:] == "你好".encode("utf-8")


class TestDecoder:
    def test_read_byte(self):
        dec = Decoder(b"\x42")
        assert dec.read_byte() == 0x42

    def test_read_int16(self):
        dec = Decoder(b"\x12\x34")
        assert dec.read_int16() == 0x1234

    def test_read_int32(self):
        dec = Decoder(b"\x12\x34\x56\x78")
        assert dec.read_int32() == 0x12345678

    def test_read_int64_string(self):
        dec = Decoder(b"\x00\x00\x00\x00\x00\x00\x00\x2A")
        assert dec.read_int64_string() == "42"

    def test_read_string(self):
        dec = Decoder(b"\x00\x02hi")
        assert dec.read_string() == "hi"

    def test_read_empty_string(self):
        dec = Decoder(b"\x00\x00")
        assert dec.read_string() == ""

    def test_remaining(self):
        dec = Decoder(b"\x01\x02\x03")
        dec.read_byte()
        assert dec.remaining == 2

    def test_read_remaining(self):
        dec = Decoder(b"\x01\x02\x03")
        dec.read_byte()
        assert dec.read_remaining() == b"\x02\x03"

    def test_read_variable_length_single_byte(self):
        dec = Decoder(b"\x0A")
        assert dec.read_variable_length() == 10

    def test_read_variable_length_multi_byte(self):
        # 128 = 0x80 | 0x00 (first byte), 0x01 (second byte)
        dec = Decoder(b"\x80\x01")
        assert dec.read_variable_length() == 128


class TestEncoderDecoderRoundTrip:
    def test_string_round_trip(self):
        enc = Encoder()
        enc.write_string("hello world")
        dec = Decoder(enc.to_bytes())
        assert dec.read_string() == "hello world"

    def test_mixed_types_round_trip(self):
        enc = Encoder()
        enc.write_byte(42)
        enc.write_int16(1000)
        enc.write_int32(100000)
        enc.write_string("test")

        dec = Decoder(enc.to_bytes())
        assert dec.read_byte() == 42
        assert dec.read_int16() == 1000
        assert dec.read_int32() == 100000
        assert dec.read_string() == "test"


class TestVariableLength:
    def test_small_value(self):
        assert encode_variable_length(10) == b"\x0A"

    def test_128(self):
        assert encode_variable_length(128) == b"\x80\x01"

    def test_large_value(self):
        result = encode_variable_length(16383)
        assert len(result) == 2

    def test_very_large_value(self):
        result = encode_variable_length(2097151)
        assert len(result) == 3


class TestAESEncryptDecrypt:
    def test_round_trip(self):
        key = "1234567890abcdef"
        iv = "abcdef1234567890"
        plaintext = "Hello, WuKongIM!"

        encrypted = aes_encrypt(plaintext, key, iv)
        assert encrypted != plaintext
        assert isinstance(encrypted, str)

        # For decrypt, the input is Base64-encoded ciphertext as bytes
        encrypted_bytes = encrypted.encode("latin-1")
        decrypted = aes_decrypt(encrypted_bytes, key, iv)
        assert decrypted.decode("utf-8") == plaintext

    def test_unicode_round_trip(self):
        key = "1234567890abcdef"
        iv = "abcdef1234567890"
        plaintext = '{"type":1,"content":"你好世界"}'

        encrypted = aes_encrypt(plaintext, key, iv)
        encrypted_bytes = encrypted.encode("latin-1")
        decrypted = aes_decrypt(encrypted_bytes, key, iv)
        assert decrypted.decode("utf-8") == plaintext

    def test_key_truncation(self):
        """Keys longer than 16 bytes should be truncated."""
        key = "1234567890abcdefEXTRA"
        iv = "abcdef1234567890EXTRA"
        plaintext = "test"

        encrypted = aes_encrypt(plaintext, key, iv)
        encrypted_bytes = encrypted.encode("latin-1")
        decrypted = aes_decrypt(encrypted_bytes, key, iv)
        assert decrypted.decode("utf-8") == plaintext


class TestECDH:
    def test_generate_keypair(self):
        priv, pub = generate_keypair()
        assert len(priv) == 32
        assert len(pub) == 32

    def test_shared_secret_agreement(self):
        """Two parties should derive the same shared secret."""
        priv_a, pub_a = generate_keypair()
        priv_b, pub_b = generate_keypair()

        secret_a = compute_shared_secret(priv_a, pub_b)
        secret_b = compute_shared_secret(priv_b, pub_a)

        assert secret_a == secret_b
        assert len(secret_a) == 32

    def test_derive_aes_key(self):
        priv, pub = generate_keypair()
        # Self-exchange for testing
        secret = compute_shared_secret(priv, pub)
        aes_key = derive_aes_key(secret)
        assert len(aes_key) == 16
        # Should be hex characters
        assert all(c in "0123456789abcdef" for c in aes_key)


class TestPacketEncoding:
    def test_ping_packet(self):
        ping = encode_ping_packet()
        assert len(ping) == 1
        assert (ping[0] >> 4) == PacketType.PING

    def test_recvack_packet(self):
        ack = encode_recvack_packet("12345", 1)
        assert len(ack) > 1
        assert (ack[0] >> 4) == PacketType.RECVACK

    def test_connect_packet_structure(self):
        packet = encode_connect_packet(
            version=4,
            device_flag=0,
            device_id="test-device",
            uid="bot-uid",
            token="test-token",
            client_timestamp=1000000,
            client_key="dGVzdA==",
        )
        assert len(packet) > 0
        assert (packet[0] >> 4) == PacketType.CONNECT


class TestPacketDecoding:
    def test_decode_ping(self):
        ping = encode_ping_packet()
        pkt_type, result = decode_packet(ping)
        assert pkt_type == PacketType.PING
        assert result is None

    def test_decode_pong(self):
        pong = bytes([(PacketType.PONG << 4) | 0])
        pkt_type, result = decode_packet(pong)
        assert pkt_type == PacketType.PONG
        assert result is None

    def test_decode_empty_raises(self):
        with pytest.raises(ValueError, match="Empty packet"):
            decode_packet(b"")


class TestSettingFlags:
    def test_all_off(self):
        flags = parse_setting_byte(0)
        assert flags.receipt_enabled is False
        assert flags.topic is False
        assert flags.stream_on is False

    def test_receipt_enabled(self):
        flags = parse_setting_byte(0b10000000)
        assert flags.receipt_enabled is True

    def test_topic(self):
        flags = parse_setting_byte(0b00001000)
        assert flags.topic is True

    def test_stream_on(self):
        flags = parse_setting_byte(0b00000010)
        assert flags.stream_on is True


class TestFrameUnpacking:
    def test_empty_buffer(self):
        frame, remaining = try_unpack_one(bytearray())
        assert frame is None
        assert remaining == bytearray()

    def test_ping_frame(self):
        buf = bytearray([(PacketType.PING << 4) | 0])
        frame, remaining = try_unpack_one(buf)
        assert frame is not None
        assert len(remaining) == 0

    def test_pong_frame(self):
        buf = bytearray([(PacketType.PONG << 4) | 0])
        frame, remaining = try_unpack_one(buf)
        assert frame is not None
        assert len(remaining) == 0

    def test_sticky_packets(self):
        """Two frames concatenated should be unpacked one at a time."""
        ping = bytearray([(PacketType.PING << 4) | 0])
        pong = bytearray([(PacketType.PONG << 4) | 0])
        buf = ping + pong

        frame1, remaining = try_unpack_one(buf)
        assert frame1 is not None
        assert len(remaining) == 1

        frame2, remaining = try_unpack_one(remaining)
        assert frame2 is not None
        assert len(remaining) == 0

    def test_incomplete_frame(self):
        """Incomplete frame should return None and keep buffer."""
        # Create a RECVACK packet and chop it
        ack = encode_recvack_packet("123", 1)
        incomplete = bytearray(ack[:len(ack) - 2])
        frame, remaining = try_unpack_one(incomplete)
        assert frame is None
        assert remaining == incomplete


class TestDeviceId:
    def test_format(self):
        device_id = generate_device_id()
        assert len(device_id) == 32  # UUID hex without dashes
        assert all(c in "0123456789abcdef" for c in device_id)

    def test_uniqueness(self):
        id1 = generate_device_id()
        id2 = generate_device_id()
        assert id1 != id2
