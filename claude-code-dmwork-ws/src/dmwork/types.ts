/** DMWork Bot API types — extracted from openclaw-channel-dmwork */

export interface BotRegisterResp {
  robot_id: string;
  im_token: string;
  ws_url: string;
  api_url: string;
  owner_uid: string;
  owner_channel_id: string;
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
  all?: boolean | number;
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
  [key: string]: unknown;
}

export enum ChannelType {
  DM = 1,
  Group = 2,
}

export enum MessageType {
  Text = 1,
  Image = 2,
  GIF = 3,
  Voice = 4,
  Video = 5,
  Location = 6,
  Card = 7,
  File = 8,
}
