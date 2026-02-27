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
 * WuKongIM WebSocket client for bot connections.
 * Thin wrapper around wukongimjssdk — the SDK handles binary encoding,
 * DH key exchange, encryption, heartbeat, reconnect, and RECVACK.
 */
export class WKSocket extends EventEmitter {
  private statusListener: ((status: ConnectStatus, reasonCode?: number) => void) | null = null;
  private messageListener: ((message: Message) => void) | null = null;

  constructor(private opts: WKSocketOptions) {
    super();
  }

  /** Connect to WuKongIM WebSocket */
  connect(): void {
    const im = WKSDK.shared();
    im.config.addr = this.opts.wsUrl;
    im.config.uid = this.opts.uid;
    im.config.token = this.opts.token;
    im.config.deviceFlag = 0; // APP — 与服务端 bot 注册时使用的 device flag 一致

    // Listen for connection status changes
    this.statusListener = (status: ConnectStatus, reasonCode?: number) => {
      switch (status) {
        case ConnectStatus.Connected:
          this.opts.onConnected?.();
          break;
        case ConnectStatus.Disconnect:
          this.opts.onDisconnected?.();
          break;
        case ConnectStatus.ConnectFail:
          this.opts.onError?.(
            new Error(`Connect failed: reasonCode=${reasonCode ?? "unknown"}`),
          );
          break;
        case ConnectStatus.ConnectKick:
          this.opts.onError?.(new Error("Kicked by server"));
          this.opts.onDisconnected?.();
          break;
      }
    };
    im.connectManager.addConnectStatusListener(this.statusListener);

    // Listen for incoming messages — SDK auto-decrypts and sends RECVACK
    this.messageListener = (message: Message) => {
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

  /** Gracefully disconnect */
  disconnect(): void {
    const im = WKSDK.shared();
    if (this.statusListener) {
      im.connectManager.removeConnectStatusListener(this.statusListener);
      this.statusListener = null;
    }
    if (this.messageListener) {
      im.chatManager.removeMessageListener(this.messageListener);
      this.messageListener = null;
    }
    im.disconnect();
  }
}
