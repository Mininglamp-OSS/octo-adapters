import { EventEmitter } from "events";
import WKSDK, { ConnectStatus, type Message } from "wukongimjssdk";
import type { BotMessage, MessagePayload } from "./types.js";

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
 * Module-level singleton tracking — ensures only one set of SDK listeners
 * exists at any time, even if startAccount is called multiple times
 * (e.g. during auto-restart).
 */
let activeSocket: WKSocket | null = null;

/**
 * WuKongIM WebSocket client for bot connections.
 * Thin wrapper around wukongimjssdk — the SDK handles binary encoding,
 * DH key exchange, encryption, heartbeat, reconnect, and RECVACK.
 *
 * Only one WKSocket can be active at a time (WKSDK is a singleton).
 * Creating a new connection automatically cleans up the previous one.
 */
export class WKSocket extends EventEmitter {
  private statusListener: ((status: ConnectStatus, reasonCode?: number) => void) | null = null;
  private messageListener: ((message: Message) => void) | null = null;
  private connected = false;

  constructor(private opts: WKSocketOptions) {
    super();
  }

  /** Connect to WuKongIM WebSocket */
  connect(): void {
    // If another WKSocket was active, fully clean it up first
    if (activeSocket && activeSocket !== this) {
      activeSocket.disconnect();
    }
    activeSocket = this;

    const im = WKSDK.shared();

    // Ensure clean state — disconnect any prior SDK session
    try { im.disconnect(); } catch { /* ignore */ }

    im.config.addr = this.opts.wsUrl;
    im.config.uid = this.opts.uid;
    im.config.token = this.opts.token;
    im.config.deviceFlag = 0;

    // Remove own stale listeners (safety — should already be null)
    if (this.statusListener) {
      im.connectManager.removeConnectStatusListener(this.statusListener);
      this.statusListener = null;
    }
    if (this.messageListener) {
      im.chatManager.removeMessageListener(this.messageListener);
      this.messageListener = null;
    }

    // Register exactly one status listener
    this.statusListener = (status: ConnectStatus, reasonCode?: number) => {
      // Ignore events if we're no longer the active socket
      if (activeSocket !== this) return;

      switch (status) {
        case ConnectStatus.Connected:
          this.connected = true;
          this.opts.onConnected?.();
          break;
        case ConnectStatus.Disconnect:
          if (this.connected) {
            this.connected = false;
            this.opts.onDisconnected?.();
          }
          break;
        case ConnectStatus.ConnectFail:
          this.connected = false;
          this.opts.onError?.(
            new Error(`Connect failed: reasonCode=${reasonCode ?? "unknown"}`),
          );
          break;
        case ConnectStatus.ConnectKick:
          this.connected = false;
          this.opts.onError?.(new Error("Kicked by server"));
          this.opts.onDisconnected?.();
          break;
      }
    };
    im.connectManager.addConnectStatusListener(this.statusListener);

    // Register exactly one message listener
    this.messageListener = (message: Message) => {
      if (activeSocket !== this) return;

      const content = message.content;
      const payload: MessagePayload = {
        type: content?.contentType ?? 0,
        content: content?.conversationDigest ?? content?.contentObj?.content,
        ...content?.contentObj,
      };

      const msg: BotMessage = {
        message_id: String(message.messageID),
        message_seq: message.messageSeq,
        from_uid: message.fromUID,
        channel_id: message.channel?.channelID,
        channel_type: message.channel?.channelType,
        timestamp: message.timestamp,
        payload,
      };
      this.opts.onMessage(msg);
    };
    im.chatManager.addMessageListener(this.messageListener);

    im.connect();
  }

  /** Update credentials for reconnection (e.g. after token refresh) */
  updateCredentials(uid: string, token: string): void {
    this.opts.uid = uid;
    this.opts.token = token;
  }

  /** Gracefully disconnect */
  disconnect(): void {
    const im = WKSDK.shared();
    this.connected = false;
    if (activeSocket === this) {
      activeSocket = null;
    }
    if (this.statusListener) {
      im.connectManager.removeConnectStatusListener(this.statusListener);
      this.statusListener = null;
    }
    if (this.messageListener) {
      im.chatManager.removeMessageListener(this.messageListener);
      this.messageListener = null;
    }
    try { im.disconnect(); } catch { /* ignore */ }
  }
}
