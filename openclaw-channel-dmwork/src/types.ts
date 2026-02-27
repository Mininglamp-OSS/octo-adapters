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

export interface BotEventsResp {
  status: number;
  results: BotEvent[];
}

export interface BotEvent {
  event_id: number;
  message?: BotMessage;
}

export interface BotMessage {
  message_id: number;
  message_seq: number;
  from_uid: string;
  channel_id?: string;
  channel_type?: ChannelType;
  timestamp: number;
  payload: MessagePayload;
}

export interface MessagePayload {
  type: MessageType;
  content?: string;
  url?: string;
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
}

/** Plugin config */
export interface DMWorkConfig {
  botToken: string;
  apiUrl: string;
  wsUrl?: string;
}

/** WuKongIM WebSocket protocol types */
export interface WKConnectPacket {
  type: 1; // CONNECT
  version: number;
  client_key: string;
  client_timestamp: string;
  uid: string;
  token: string;
}

export interface WKConnAckPacket {
  type: 2; // CONNACK
  time_diff: number;
  reason_code: number; // 0 = success
}

export interface WKRecvPacket {
  type: 5; // RECV
  setting: number;
  msg_key: string;
  from_uid: string;
  channel_id: string;
  channel_type: number;
  message_id: number;
  message_seq: number;
  timestamp: number;
  payload: string; // base64 encoded JSON
}

export interface WKRecvAckPacket {
  type: 6; // RECVACK
  message_id: number;
  message_seq: number;
}

export interface WKPingPacket {
  type: 3; // PING
}

export interface WKPongPacket {
  type: 4; // PONG
}
