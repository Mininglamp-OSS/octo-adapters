/** DMWork Bot API types */

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

export interface MentionPayload {
  uids?: string[];
  all?: boolean | number; // true or 1 = @all (API returns either depending on version)
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
    type: string;       // "group_md_updated" | "group_md_deleted"
    version?: number;
    updated_by?: string;
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
  message_id: number;
  message_seq: number;
}

/** Channel types */
export enum ChannelType {
  DM = 1,
  Group = 2,
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


