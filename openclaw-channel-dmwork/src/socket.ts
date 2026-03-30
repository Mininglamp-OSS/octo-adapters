import { EventEmitter } from "events";
import WebSocket from "ws";
import { generateKeyPair, sharedKey } from "curve25519-js";
import { Buffer } from "buffer";
import CryptoJS from "crypto-js";
import { Md5 } from "md5-typescript";
import type { BotMessage, MessagePayload } from "./types.js";

// ─── WuKongIM Binary Protocol Constants ─────────────────────────────────────

const enum PacketType {
  CONNECT = 1,
  CONNACK = 2,
  SEND = 3,
  SENDACK = 4,
  RECV = 5,
  RECVACK = 6,
  PING = 7,
  PONG = 8,
  DISCONNECT = 9,
}

const PROTO_VERSION = 4;

// ─── Binary Encoder / Decoder ───────────────────────────────────────────────

class Encoder {
  private w: number[] = [];
  writeByte(b: number) { this.w.push(b & 0xff); }
  writeBytes(b: number[]) { this.w.push(...b); }
  writeInt16(b: number) { this.w.push((b >> 8) & 0xff, b & 0xff); }
  writeInt32(b: number) { this.w.push((b >> 24) & 0xff, (b >> 16) & 0xff, (b >> 8) & 0xff, b & 0xff); }
  writeInt64(n: bigint) {
    const hi = Number(n >> 32n);
    const lo = Number(n & 0xffffffffn);
    this.writeInt32(hi);
    this.writeInt32(lo);
  }
  writeString(s: string) {
    if (s && s.length > 0) {
      const arr = stringToUint(s);
      this.writeInt16(arr.length);
      this.w.push(...arr);
    } else {
      this.writeInt16(0);
    }
  }
  toUint8Array(): Uint8Array { return new Uint8Array(this.w); }
}

class Decoder {
  private offset = 0;
  constructor(private data: Uint8Array) {}

  readByte(): number { return this.data[this.offset++]; }

  readInt16(): number {
    const v = (this.data[this.offset] << 8) | this.data[this.offset + 1];
    this.offset += 2;
    return v;
  }

  readInt32(): number {
    const v =
      (this.data[this.offset] << 24) |
      (this.data[this.offset + 1] << 16) |
      (this.data[this.offset + 2] << 8) |
      this.data[this.offset + 3];
    this.offset += 4;
    return v >>> 0; // unsigned
  }

  readInt64String(): string {
    // Read 8 bytes as a big-endian unsigned integer string
    let n = BigInt(0);
    for (let i = 0; i < 8; i++) {
      n = (n << 8n) | BigInt(this.data[this.offset + i]);
    }
    this.offset += 8;
    return n.toString();
  }

  readInt64BigInt(): bigint {
    let n = BigInt(0);
    for (let i = 0; i < 8; i++) {
      n = (n << 8n) | BigInt(this.data[this.offset + i]);
    }
    this.offset += 8;
    return n;
  }

  readString(): string {
    const len = this.readInt16();
    if (len <= 0) return "";
    const slice = this.data.slice(this.offset, this.offset + len);
    this.offset += len;
    return uintToString(Array.from(slice));
  }

  readRemaining(): Uint8Array {
    const d = this.data.slice(this.offset);
    this.offset = this.data.length;
    return d;
  }

  readVariableLength(): number {
    let multiplier = 0;
    let rLength = 0;
    while (multiplier < 27) {
      const b = this.readByte();
      rLength = rLength | ((b & 127) << multiplier);
      if ((b & 128) === 0) break;
      multiplier += 7;
    }
    return rLength;
  }
}

function stringToUint(str: string): number[] {
  const encoded = unescape(encodeURIComponent(str));
  const arr: number[] = [];
  for (let i = 0; i < encoded.length; i++) arr.push(encoded.charCodeAt(i));
  return arr;
}

function uintToString(array: number[]): string {
  const encoded = String.fromCharCode(...array);
  return decodeURIComponent(escape(encoded));
}

function encodeVariableLength(len: number): number[] {
  const ret: number[] = [];
  while (len > 0) {
    let digit = len % 0x80;
    len = Math.floor(len / 0x80);
    if (len > 0) digit |= 0x80;
    ret.push(digit);
  }
  return ret;
}

// ─── AES-CBC Encryption Helpers ─────────────────────────────────────────────

function aesDecrypt(data: Uint8Array, aesKey: string, aesIV: string): Uint8Array {
  const str = String.fromCharCode(...Array.from(data));
  const ciphertext = CryptoJS.enc.Base64.parse(str);
  const decrypted = CryptoJS.AES.decrypt(
    CryptoJS.enc.Base64.stringify(ciphertext),
    CryptoJS.enc.Utf8.parse(aesKey),
    {
      keySize: 128 / 8,
      iv: CryptoJS.enc.Utf8.parse(aesIV),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    },
  );
  return Uint8Array.from(Buffer.from(decrypted.toString(CryptoJS.enc.Utf8)));
}

function aesEncrypt(message: string, aesKey: string, aesIV: string): string {
  return CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(message),
    CryptoJS.enc.Utf8.parse(aesKey),
    {
      keySize: 128 / 8,
      iv: CryptoJS.enc.Utf8.parse(aesIV),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    },
  ).toString();
}

// ─── Packet Encoding / Decoding ─────────────────────────────────────────────

function encodeConnectPacket(opts: {
  version: number;
  deviceFlag: number;
  deviceID: string;
  uid: string;
  token: string;
  clientTimestamp: number;
  clientKey: string;
}): Uint8Array {
  const body = new Encoder();
  body.writeByte(opts.version);
  body.writeByte(opts.deviceFlag);
  body.writeString(opts.deviceID);
  body.writeString(opts.uid);
  body.writeString(opts.token);
  body.writeInt64(BigInt(opts.clientTimestamp));
  body.writeString(opts.clientKey);
  const bodyBytes = Array.from(body.toUint8Array());

  const frame = new Encoder();
  // header: packetType << 4 | flags (noPersist bit0 = hasServerVersion for CONNACK)
  frame.writeByte((PacketType.CONNECT << 4) | 0);
  frame.writeBytes(encodeVariableLength(bodyBytes.length));
  frame.writeBytes(bodyBytes);
  return frame.toUint8Array();
}

function encodePingPacket(): Uint8Array {
  return new Uint8Array([(PacketType.PING << 4) | 0]);
}

function encodeRecvackPacket(messageID: string, messageSeq: number): Uint8Array {
  const body = new Encoder();
  body.writeInt64(BigInt(messageID));
  body.writeInt32(messageSeq);
  const bodyBytes = Array.from(body.toUint8Array());

  const frame = new Encoder();
  frame.writeByte((PacketType.RECVACK << 4) | 0);
  frame.writeBytes(encodeVariableLength(bodyBytes.length));
  frame.writeBytes(bodyBytes);
  return frame.toUint8Array();
}

interface SettingFlags {
  receiptEnabled: boolean;
  topic: boolean;
  streamOn: boolean;
}

function parseSettingByte(v: number): SettingFlags {
  return {
    receiptEnabled: ((v >> 7) & 0x01) > 0,
    topic: ((v >> 3) & 0x01) > 0,
    streamOn: ((v >> 1) & 0x01) > 0,
  };
}

// ─── WKSocket — Independent WebSocket Connection ────────────────────────────

interface WKSocketOptions {
  wsUrl: string;
  uid: string;
  token: string;
  onMessage: (msg: BotMessage) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (err: Error) => void;
}

/**
 * WuKongIM WebSocket client for bot connections.
 *
 * Implements the WuKongIM binary protocol directly over WebSocket,
 * with per-instance DH key exchange, AES encryption, heartbeat,
 * reconnect, and RECVACK.
 *
 * Each WKSocket instance maintains its own independent connection,
 * enabling multiple bot accounts to run simultaneously.
 */
export class WKSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private connected = false;
  private needReconnect = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartTimer: ReturnType<typeof setInterval> | null = null;
  private pingRetryCount = 0;
  private readonly pingMaxRetry = 3;
  private reconnectAttempts = 0;

  // Per-instance crypto state (set after CONNACK)
  private aesKey = "";
  private aesIV = "";
  private dhPrivateKey: Uint8Array | null = null;
  private serverVersion = 0;

  // Buffer for handling packet fragmentation (sticky packets)
  private tempBuffer: number[] = [];

  constructor(private opts: WKSocketOptions) {
    super();
  }

  /** Connect to WuKongIM WebSocket */
  connect(): void {
    this.needReconnect = true;
    this.doConnect();
  }

  /** Update credentials for reconnection (e.g. after token refresh) */
  updateCredentials(uid: string, token: string): void {
    this.opts.uid = uid;
    this.opts.token = token;
  }

  /** Gracefully disconnect */
  disconnect(): void {
    this.needReconnect = false;
    this.connected = false;
    this.stopHeart();
    this.stopReconnectTimer();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  // ─── Internal Connection Logic ──────────────────────────────────────────

  private doConnect(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }

    this.tempBuffer = [];
    const ws = new WebSocket(this.opts.wsUrl);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.on("open", () => {
      this.tempBuffer = [];
      // Generate DH key pair
      const seed = Uint8Array.from(stringToUint(generateDeviceID()));
      const keyPair = generateKeyPair(seed);
      this.dhPrivateKey = keyPair.private;
      const pubKey = Buffer.from(keyPair.public).toString("base64");

      const deviceID = generateDeviceID() + "W";
      const packet = encodeConnectPacket({
        version: PROTO_VERSION,
        deviceFlag: 0, // 0 = app/bot
        deviceID,
        uid: this.opts.uid,
        token: this.opts.token,
        clientTimestamp: Date.now(),
        clientKey: pubKey,
      });
      ws.send(packet);
    });

    ws.on("message", (data: ArrayBuffer | Buffer) => {
      const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer);
      this.handleRawData(bytes);
    });

    ws.on("close", () => {
      // Ignore close events from stale WebSocket instances.
      // When onError triggers disconnect()+connect(), the old WS close event
      // fires asynchronously and must not trigger a phantom reconnect.
      if (this.ws !== ws) return;

      if (this.connected) {
        this.connected = false;
        this.opts.onDisconnected?.();
      }
      this.stopHeart();
      if (this.needReconnect) {
        this.scheduleReconnect();
      }
    });

    ws.on("error", (err) => {
      console.debug("[WKSocket] ws error:", err.message);
      // The 'close' event will follow, which handles reconnect
    });
  }

  private scheduleReconnect(): void {
    this.stopReconnectTimer();
    const baseDelay = 3000;
    const maxDelay = 60000;
    const exponentialDelay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay);
    // Add ±25% random jitter to prevent thundering herd
    const jitter = exponentialDelay * (0.75 + Math.random() * 0.5);
    const delay = Math.floor(jitter);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      if (this.needReconnect) {
        this.doConnect();
      }
    }, delay);
  }

  private stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ─── Heartbeat ──────────────────────────────────────────────────────────

  private restartHeart(): void {
    this.stopHeart();
    this.pingRetryCount = 0;
    this.heartTimer = setInterval(() => {
      this.pingRetryCount++;
      if (this.pingRetryCount > this.pingMaxRetry) {
        console.debug("[WKSocket] ping timeout, reconnecting...");
        this.stopHeart();
        if (this.ws) {
          try { this.ws.close(); } catch { /* ignore */ }
          this.ws = null;
        }
        if (this.connected) {
          this.connected = false;
          this.opts.onDisconnected?.();
        }
        if (this.needReconnect) {
          this.scheduleReconnect();
        }
        return;
      }
      this.sendRaw(encodePingPacket());
    }, 60_000); // 60s heartbeat interval (matches SDK default)
  }

  private stopHeart(): void {
    if (this.heartTimer) {
      clearInterval(this.heartTimer);
      this.heartTimer = null;
    }
  }

  // ─── Raw Data & Packet Framing ──────────────────────────────────────────

  private sendRaw(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private handleRawData(data: Uint8Array): void {
    this.tempBuffer.push(...Array.from(data));

    try {
      let lenBefore: number;
      let lenAfter: number;
      do {
        lenBefore = this.tempBuffer.length;
        this.tempBuffer = this.unpackOne(this.tempBuffer);
        lenAfter = this.tempBuffer.length;
      } while (lenBefore !== lenAfter && lenAfter >= 1);
    } catch (err) {
      console.debug("[WKSocket] decode error:", err);
      // Reset buffer and reconnect
      this.tempBuffer = [];
      if (this.ws) {
        try { this.ws.close(); } catch { /* ignore */ }
      }
    }
  }

  private unpackOne(data: number[]): number[] {
    if (data.length === 0) return data;

    const header = data[0];
    const packetType = header >> 4;

    // PONG is a single byte
    if (packetType === PacketType.PONG) {
      this.onPong();
      return data.slice(1);
    }
    // PING from server (shouldn't happen but handle gracefully)
    if (packetType === PacketType.PING) {
      return data.slice(1);
    }

    const length = data.length;
    const fixedHeaderLength = 1;
    let pos = fixedHeaderLength;
    let remLength = 0;
    let multiplier = 1;
    let hasMore = false;
    let remLengthFull = true;

    do {
      if (pos > length - 1) {
        remLengthFull = false;
        break;
      }
      const digit = data[pos++];
      remLength += (digit & 127) * multiplier;
      multiplier *= 128;
      hasMore = (digit & 0x80) !== 0;
    } while (hasMore);

    if (!remLengthFull) return data; // Incomplete frame

    const remLengthLength = pos - fixedHeaderLength;
    const totalLength = fixedHeaderLength + remLengthLength + remLength;

    if (totalLength > length) return data; // Incomplete packet

    // Extract one complete packet
    const packetData = new Uint8Array(data.slice(0, totalLength));
    this.onPacket(packetData);
    return data.slice(totalLength);
  }

  // ─── Packet Handling ────────────────────────────────────────────────────

  private onPong(): void {
    this.pingRetryCount = 0;
  }

  private onPacket(data: Uint8Array): void {
    const firstByte = data[0];
    const packetType = firstByte >> 4;
    const hasServerVersion = (firstByte & 0x01) > 0;
    const noPersist = (firstByte & 0x01) > 0;
    const reddot = ((firstByte >> 1) & 0x01) > 0;

    // Skip the header and variable-length bytes to get body
    const dec = new Decoder(data);
    dec.readByte(); // header byte
    if (packetType !== PacketType.PING && packetType !== PacketType.PONG) {
      dec.readVariableLength(); // remaining length
    }

    switch (packetType) {
      case PacketType.CONNACK:
        this.onConnack(dec, hasServerVersion);
        break;
      case PacketType.RECV:
        this.onRecv(dec, noPersist, reddot);
        break;
      case PacketType.DISCONNECT:
        this.onDisconnect(dec);
        break;
      case PacketType.SENDACK:
        // We don't send messages via WS, ignore
        break;
    }
  }

  private onConnack(dec: Decoder, hasServerVersion: boolean): void {
    if (hasServerVersion) {
      this.serverVersion = dec.readByte();
    }
    const _timeDiff = dec.readInt64BigInt();
    const reasonCode = dec.readByte();
    const serverKey = dec.readString();
    const salt = dec.readString();
    if (this.serverVersion >= 4) {
      const _nodeId = dec.readInt64BigInt();
    }

    if (reasonCode === 1) {
      // Success — derive AES key from DH shared secret
      const serverPubKey = Uint8Array.from(Buffer.from(serverKey, "base64"));
      const secret = sharedKey(this.dhPrivateKey!, serverPubKey);
      const secretBase64 = Buffer.from(secret).toString("base64");
      const aesKeyFull = Md5.init(secretBase64);
      this.aesKey = aesKeyFull.substring(0, 16);
      this.aesIV = salt && salt.length > 16 ? salt.substring(0, 16) : salt;

      this.connected = true;
      this.reconnectAttempts = 0;
      this.restartHeart();
      this.opts.onConnected?.();
    } else if (reasonCode === 0) {
      // Kicked
      this.connected = false;
      this.needReconnect = false;
      this.opts.onError?.(new Error("Kicked by server"));
      this.opts.onDisconnected?.();
    } else {
      // Connect failed
      this.connected = false;
      this.needReconnect = false;
      this.opts.onError?.(new Error(`Connect failed: reasonCode=${reasonCode}`));
    }
  }

  private onRecv(dec: Decoder, _noPersist: boolean, _reddot: boolean): void {
    const settingByte = dec.readByte();
    const setting = parseSettingByte(settingByte);
    const _msgKey = dec.readString();
    const fromUID = dec.readString();
    const channelID = dec.readString();
    const channelType = dec.readByte();
    if (this.serverVersion >= 3) {
      const _expire = dec.readInt32();
    }
    const _clientMsgNo = dec.readString();
    const messageID = dec.readInt64String();
    const messageSeq = dec.readInt32();
    const timestamp = dec.readInt32();
    if (setting.topic) {
      const _topic = dec.readString();
    }
    const encryptedPayload = dec.readRemaining();

    // Send RECVACK immediately
    this.sendRaw(encodeRecvackPacket(messageID, messageSeq));

    // Decrypt payload
    let payloadObj: Record<string, any> | undefined;
    try {
      const decryptedBytes = aesDecrypt(encryptedPayload, this.aesKey, this.aesIV);
      const payloadStr = uintToString(Array.from(decryptedBytes));
      payloadObj = JSON.parse(payloadStr);
    } catch (err) {
      console.debug("[WKSocket] payload decrypt/parse error:", err);
      return;
    }

    // Build MessagePayload (same shape as SDK's contentObj-based output)
    const payload: MessagePayload = {
      type: payloadObj?.type ?? 0,
      content: payloadObj?.content,
      ...payloadObj,
    };

    const msg: BotMessage = {
      message_id: messageID,
      message_seq: messageSeq,
      from_uid: fromUID,
      channel_id: channelID,
      channel_type: channelType,
      timestamp,
      payload,
    };

    this.opts.onMessage(msg);
  }

  private onDisconnect(dec: Decoder): void {
    const reasonCode = dec.readByte();
    const _reason = dec.readString();

    this.connected = false;
    this.needReconnect = false;
    this.stopHeart();
    this.opts.onError?.(new Error("Kicked by server"));
    this.opts.onDisconnected?.();
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function generateDeviceID(): string {
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
