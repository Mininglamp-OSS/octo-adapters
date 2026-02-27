import axios, { type AxiosInstance } from "axios";
import type {
  BotRegisterReq,
  BotRegisterResp,
  BotSendMessageReq,
  BotTypingReq,
  BotReadReceiptReq,
  BotEventsReq,
  BotEventsResp,
  BotStreamStartReq,
  BotStreamStartResp,
  BotStreamEndReq,
  SendMessageResult,
  DMWorkConfig,
} from "./types.js";

/**
 * DMWork Bot REST API client.
 */
export class DMWorkAPI {
  private client: AxiosInstance;

  constructor(
    private config: DMWorkConfig,
  ) {
    this.client = axios.create({
      baseURL: config.apiUrl,
      headers: {
        Authorization: `Bearer ${config.botToken}`,
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    });
  }

  /** Register bot and obtain credentials */
  async register(req?: BotRegisterReq): Promise<BotRegisterResp> {
    const { data } = await this.client.post<BotRegisterResp>(
      "/v1/bot/register",
      req ?? {},
    );
    return data;
  }

  /** Send a message */
  async sendMessage(req: BotSendMessageReq): Promise<SendMessageResult> {
    const { data } = await this.client.post<SendMessageResult>(
      "/v1/bot/sendMessage",
      req,
    );
    return data;
  }

  /** Send typing indicator */
  async sendTyping(req: BotTypingReq): Promise<void> {
    await this.client.post("/v1/bot/typing", req);
  }

  /** Send read receipt */
  async sendReadReceipt(req: BotReadReceiptReq): Promise<void> {
    await this.client.post("/v1/bot/readReceipt", req);
  }

  /** Poll for new events (REST mode) */
  async getEvents(req: BotEventsReq): Promise<BotEventsResp> {
    const { data } = await this.client.post<BotEventsResp>(
      "/v1/bot/events",
      req,
    );
    return data;
  }

  /** Acknowledge an event */
  async ackEvent(eventId: number): Promise<void> {
    await this.client.post(`/v1/bot/events/${eventId}/ack`);
  }

  /** Start a streaming message */
  async streamStart(req: BotStreamStartReq): Promise<BotStreamStartResp> {
    const { data } = await this.client.post<BotStreamStartResp>(
      "/v1/bot/stream/start",
      req,
    );
    return data;
  }

  /** End a streaming message */
  async streamEnd(req: BotStreamEndReq): Promise<void> {
    await this.client.post("/v1/bot/stream/end", req);
  }

  /** Send heartbeat (REST mode keep-alive) */
  async heartbeat(): Promise<void> {
    await this.client.post("/v1/bot/heartbeat");
  }
}
