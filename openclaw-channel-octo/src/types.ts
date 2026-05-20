/** Octo Bot API types (legacy DMWorkGroupConfig type name kept for internal use) */

export interface BotRegisterReq {
  name?: string;
}

export interface BotRegisterResp {
  robot_id: string;
  im_token: string;
  ws_url: string;
  api_url: string;
  owner_uid: string;
  owner_channel_id: string;
}

export interface BotSendMessageReq {
  channel_id: string;
  channel_type: ChannelType;
  stream_no?: string;
  payload: MessagePayload;
  /**
   * OBO (On-Behalf-Of) attribution. When set, the server attributes the
   * outbound message to this uid (the grantor) instead of the calling
   * bot. Adapter populates this from `account.config.onBehalfOf` for
   * configured accounts; api-fetch maps the field to the over-the-wire
   * `on_behalf_of` JSON key (see `api-fetch.ts`).
   */
  on_behalf_of?: string;
}

export interface BotTypingReq {
  channel_id: string;
  channel_type: ChannelType;
}

export interface BotReadReceiptReq {
  channel_id: string;
  channel_type: ChannelType;
}

export interface BotEventsReq {
  event_id: number;
  limit?: number;
}



export interface BotMessage {
  message_id: string;
  message_seq: number;
  from_uid: string;
  channel_id?: string;
  channel_type?: ChannelType;
  timestamp: number;
  payload: MessagePayload;
}

/**
 * 单个 mention 的精确位置描述。
 * offset/length 的单位为 UTF-16 code units（与 JS string.length 一致）。
 */
export interface MentionEntity {
  /** 被 @ 用户的唯一标识符 */
  uid: string;
  /** @name 在 content 中的起始位置（包括 @ 符号） */
  offset: number;
  /** @name 的完整长度（包括 @ 符号） */
  length: number;
}

export interface MentionPayload {
  uids?: string[];
  entities?: MentionEntity[];
  /**
   * Legacy "@all" flag. Server outbound double-writes this for legacy clients
   * even after the three-state split landed (server-side semantic: `all=1`
   * means "@所有人" → humans only, NOT ais). The adapter therefore treats
   * `all=1` as a humans-only signal: it does NOT wake bots on its own and
   * MUST be folded into the humans bucket, not the ais bucket. This matches
   * the server's authoritative decision (see `inbound.ts` mention three-state
   * read block).
   */
  all?: boolean | number; // true or 1 = @所有人 (humans-only; API returns either depending on version)
  /**
   * Three-state mention (server-authoritative, PR-A landed on octo-server #94).
   * `humans=1` → "@所有人", `ais=1` → "@所有AI". Both can co-exist.
   * Adapter only reads these; it never decides semantics — server is the
   * source of truth and rewrites legacy `all=1` into the canonical form
   * before adapter sees it.
   */
  humans?: boolean | number;
  ais?: boolean | number;
}

export interface ReplyPayload {
  payload?: MessagePayload;
  from_uid?: string;
  from_name?: string;
}

export interface MessagePayload {
  type: MessageType;
  content?: string;
  url?: string;
  name?: string;
  mention?: MentionPayload;
  reply?: ReplyPayload;
  event?: {
    type: string;       // "group_md_updated" | "group_md_deleted" | "thread_md_updated" | "thread_md_deleted"
    version?: number;
    updated_by?: string;
    group_no?: string;   // thread_md_* events only
    short_id?: string;   // thread_md_* events only
  };
  [key: string]: unknown;
}

export interface BotStreamStartReq {
  channel_id: string;
  channel_type: ChannelType;
  payload: string; // base64 encoded
}

export interface BotStreamStartResp {
  stream_no: string;
}

export interface BotStreamEndReq {
  stream_no: string;
  channel_id: string;
  channel_type: ChannelType;
}

export interface SendMessageResult {
  message_id: string;  // string due to int64 protection in postJson
  client_msg_no: string;
  message_seq: number;
}

/** Channel types */
export enum ChannelType {
  DM = 1,
  Group = 2,
  CommunityTopic = 5, // Thread/子区
}

/** Message content types */
export enum MessageType {
  Text = 1,
  Image = 2,
  GIF = 3,
  Voice = 4,
  Video = 5,
  Location = 6,
  Card = 7,
  File = 8,
  MultipleForward = 11,
}

/** Plugin config */
export interface DMWorkGroupConfig {
  requireMention?: boolean;
  enabled?: boolean;
}

/** Minimal logger interface used across modules. */
export type LogSink = {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
};
