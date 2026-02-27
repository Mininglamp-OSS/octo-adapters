import WebSocket from "ws";
import { EventEmitter } from "events";
import type {
  WKRecvPacket,
  BotMessage,
  MessagePayload,
} from "./types.js";

const PACKET_TYPE = {
  CONNECT: 1,
  CONNACK: 2,
  PING: 3,
  PONG: 4,
  RECV: 5,
  RECVACK: 6,
} as const;

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
 * Handles connect, ping/pong, message receive, and auto-reconnect.
 */
export class WKSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;
  private closed = false;

  constructor(private opts: WKSocketOptions) {
    super();
  }

  /** Connect to WuKongIM WebSocket */
  connect(): void {
    this.closed = false;
    this.reconnectAttempts = 0;
    this._connect();
  }

  /** Gracefully disconnect */
  disconnect(): void {
    this.closed = true;
    this._cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private _connect(): void {
    if (this.closed) return;

    try {
      this.ws = new WebSocket(this.opts.wsUrl);
      this.ws.binaryType = "arraybuffer";

      this.ws.on("open", () => {
        this.reconnectAttempts = 0;
        this._sendConnect();
      });

      this.ws.on("message", (data: Buffer | ArrayBuffer) => {
        this._handleMessage(data);
      });

      this.ws.on("close", () => {
        this._cleanup();
        this.opts.onDisconnected?.();
        this._scheduleReconnect();
      });

      this.ws.on("error", (err: Error) => {
        this.opts.onError?.(err);
      });
    } catch (err) {
      this.opts.onError?.(err as Error);
      this._scheduleReconnect();
    }
  }

  private _sendConnect(): void {
    // WuKongIM CONNECT packet (JSON-based protocol for WebSocket)
    const connectPacket = {
      type: PACKET_TYPE.CONNECT,
      version: 1,
      client_key: "bot_" + Date.now(),
      client_timestamp: String(Math.floor(Date.now() / 1000)),
      uid: this.opts.uid,
      token: this.opts.token,
    };
    this.ws?.send(JSON.stringify(connectPacket));
  }

  private _handleMessage(data: Buffer | ArrayBuffer): void {
    try {
      const text =
        data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : data.toString();
      const packet = JSON.parse(text);

      switch (packet.type) {
        case PACKET_TYPE.CONNACK:
          if (packet.reason_code === 0) {
            this._startPing();
            this.opts.onConnected?.();
          } else {
            this.opts.onError?.(
              new Error(`CONNACK failed: reason_code=${packet.reason_code}`),
            );
          }
          break;

        case PACKET_TYPE.PONG:
          // heartbeat response, no action needed
          break;

        case PACKET_TYPE.RECV:
          this._handleRecv(packet as WKRecvPacket);
          break;

        default:
          // ignore unknown packet types
          break;
      }
    } catch {
      // ignore parse errors
    }
  }

  private _handleRecv(packet: WKRecvPacket): void {
    // send RECVACK
    const ack = {
      type: PACKET_TYPE.RECVACK,
      message_id: packet.message_id,
      message_seq: packet.message_seq,
    };
    this.ws?.send(JSON.stringify(ack));

    // decode payload
    let payload: MessagePayload;
    try {
      const decoded = Buffer.from(packet.payload, "base64").toString("utf-8");
      payload = JSON.parse(decoded);
    } catch {
      return; // skip undecodable payloads
    }

    // emit as BotMessage
    const msg: BotMessage = {
      message_id: packet.message_id,
      message_seq: packet.message_seq,
      from_uid: packet.from_uid,
      channel_id: packet.channel_id,
      channel_type: packet.channel_type,
      timestamp: packet.timestamp,
      payload,
    };
    this.opts.onMessage(msg);
  }

  private _startPing(): void {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: PACKET_TYPE.PING }));
      }
    }, 30_000); // ping every 30 seconds
  }

  private _stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private _cleanup(): void {
    this._stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private _scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.opts.onError?.(new Error("Max reconnect attempts reached"));
      return;
    }
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this._connect(), delay);
  }
}
