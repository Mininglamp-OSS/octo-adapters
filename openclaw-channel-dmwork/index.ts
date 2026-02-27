/**
 * openclaw-channel-dmwork
 *
 * OpenClaw channel plugin for DMWork (唐僧叨叨) messaging platform.
 * Connects via WuKongIM WebSocket for real-time messaging.
 *
 * Usage:
 *   1. Create a bot via BotFather in DMWork
 *   2. Configure this plugin with the bot token and server URL
 *   3. The plugin auto-registers, connects WebSocket, and handles messages
 */

import { DMWorkAPI } from "./src/api.js";
import { WKSocket } from "./src/socket.js";
import { StreamManager } from "./src/stream.js";
import {
  ChannelType,
  MessageType,
  type BotMessage,
  type BotRegisterResp,
  type DMWorkConfig,
} from "./src/types.js";

export { DMWorkAPI } from "./src/api.js";
export { WKSocket } from "./src/socket.js";
export { StreamManager } from "./src/stream.js";
export * from "./src/types.js";

/** OpenClaw plugin API interface (simplified) */
interface PluginAPI {
  onMessage(
    handler: (ctx: InboundContext) => void | Promise<void>,
  ): void;
  getConfig(): DMWorkConfig;
  log: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
}

/** Inbound message context */
interface InboundContext {
  /** Raw platform message */
  raw: BotMessage;
  /** Sender ID */
  senderId: string;
  /** Conversation/channel ID */
  conversationId: string;
  /** Whether this is a group message */
  isGroup: boolean;
  /** Text content (if text message) */
  text?: string;
  /** Reply with text */
  reply(text: string): Promise<void>;
  /** Reply with streaming text */
  replyStream(textIterator: AsyncIterable<string>): Promise<void>;
  /** Send typing indicator */
  sendTyping(): Promise<void>;
  /** Send read receipt */
  sendReadReceipt(): Promise<void>;
}

/**
 * Plugin entry point.
 * Called by OpenClaw when the plugin is loaded.
 */
export async function register(api: PluginAPI): Promise<void> {
  const config = api.getConfig();
  const log = api.log;

  // 1. Create API client
  const dmworkApi = new DMWorkAPI(config);

  // 2. Register bot and get credentials
  log.info("Registering bot with DMWork server...");
  let credentials: BotRegisterResp;
  try {
    credentials = await dmworkApi.register();
  } catch (err) {
    log.error("Failed to register bot:", err);
    throw err;
  }
  log.info(`Bot registered: ${credentials.robot_id}`);

  // 3. Determine WebSocket URL
  const wsUrl = config.wsUrl || credentials.ws_url;

  // 4. Create stream manager
  const streamManager = new StreamManager(dmworkApi);

  // 5. Set up message handler registry
  let messageHandler: ((ctx: InboundContext) => void | Promise<void>) | null =
    null;

  api.onMessage((ctx) => {
    if (messageHandler) {
      messageHandler(ctx);
    }
  });

  // 6. Connect WebSocket
  const socket = new WKSocket({
    wsUrl,
    uid: credentials.robot_id,
    token: credentials.im_token,

    onMessage: (msg: BotMessage) => {
      // Skip messages from self
      if (msg.from_uid === credentials.robot_id) return;

      // Skip non-text messages for now (can be extended)
      if (!msg.payload || msg.payload.type !== MessageType.Text) return;

      const channelId = msg.channel_id || msg.from_uid;
      const channelType =
        msg.channel_type === ChannelType.Group
          ? ChannelType.Group
          : ChannelType.DM;
      const isGroup = channelType === ChannelType.Group;

      // Build inbound context
      const ctx: InboundContext = {
        raw: msg,
        senderId: msg.from_uid,
        conversationId: channelId,
        isGroup,
        text: msg.payload.content,

        async reply(text: string) {
          await dmworkApi.sendMessage({
            channel_id: isGroup ? channelId : msg.from_uid,
            channel_type: channelType,
            payload: { type: MessageType.Text, content: text },
          });
        },

        async replyStream(textIterator: AsyncIterable<string>) {
          const targetId = isGroup ? channelId : msg.from_uid;
          await streamManager.streamText(targetId, channelType, textIterator);
        },

        async sendTyping() {
          await dmworkApi.sendTyping({
            channel_id: isGroup ? channelId : msg.from_uid,
            channel_type: channelType,
          });
        },

        async sendReadReceipt() {
          await dmworkApi.sendReadReceipt({
            channel_id: isGroup ? channelId : msg.from_uid,
            channel_type: channelType,
          });
        },
      };

      // Dispatch to registered handler
      if (messageHandler) {
        Promise.resolve(messageHandler(ctx)).catch((err) => {
          log.error("Message handler error:", err);
        });
      }
    },

    onConnected: () => {
      log.info(`WebSocket connected to ${wsUrl}`);

      // Send greeting to owner
      dmworkApi
        .sendMessage({
          channel_id: credentials.owner_channel_id,
          channel_type: ChannelType.DM,
          payload: {
            type: MessageType.Text,
            content: "I'm online and ready!",
          },
        })
        .catch((err) => log.warn("Failed to send greeting:", err));
    },

    onDisconnected: () => {
      log.warn("WebSocket disconnected, will reconnect...");
    },

    onError: (err: Error) => {
      log.error("WebSocket error:", err.message);
    },
  });

  socket.connect();

  // Override onMessage to capture the handler
  const originalOnMessage = api.onMessage.bind(api);
  api.onMessage = (handler) => {
    messageHandler = handler;
    originalOnMessage(handler);
  };

  log.info("DMWork channel plugin initialized");
}
