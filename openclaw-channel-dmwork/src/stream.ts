import type { DMWorkAPI } from "./api.js";
import { ChannelType, MessageType } from "./types.js";

/**
 * Manages streaming message output for AI agents.
 * Handles stream/start → progressive sendMessage → stream/end lifecycle.
 */
export class StreamManager {
  private activeStreams = new Map<
    string,
    { channelId: string; channelType: ChannelType }
  >();

  constructor(private api: DMWorkAPI) {}

  /**
   * Start a new stream and return the stream_no.
   */
  async startStream(
    channelId: string,
    channelType: ChannelType,
    initialContent = "",
  ): Promise<string> {
    const payload = Buffer.from(
      JSON.stringify({
        type: MessageType.Text,
        content: initialContent,
      }),
    ).toString("base64");

    const resp = await this.api.streamStart({
      channel_id: channelId,
      channel_type: channelType,
      payload,
    });

    this.activeStreams.set(resp.stream_no, { channelId, channelType });
    return resp.stream_no;
  }

  /**
   * Send a chunk of streaming content.
   */
  async sendChunk(streamNo: string, content: string): Promise<void> {
    const stream = this.activeStreams.get(streamNo);
    if (!stream) throw new Error(`Unknown stream: ${streamNo}`);

    await this.api.sendMessage({
      channel_id: stream.channelId,
      channel_type: stream.channelType,
      stream_no: streamNo,
      payload: {
        type: MessageType.Text,
        content,
      },
    });
  }

  /**
   * End a stream.
   */
  async endStream(streamNo: string): Promise<void> {
    const stream = this.activeStreams.get(streamNo);
    if (!stream) return;

    await this.api.streamEnd({
      stream_no: streamNo,
      channel_id: stream.channelId,
      channel_type: stream.channelType,
    });

    this.activeStreams.delete(streamNo);
  }

  /**
   * Convenience: stream a full text response with chunking.
   * Splits by sentences/paragraphs and sends progressively.
   */
  async streamText(
    channelId: string,
    channelType: ChannelType,
    textIterator: AsyncIterable<string>,
  ): Promise<void> {
    const streamNo = await this.startStream(channelId, channelType);

    let accumulated = "";
    try {
      for await (const chunk of textIterator) {
        accumulated += chunk;
        await this.sendChunk(streamNo, accumulated);
      }
    } finally {
      await this.endStream(streamNo);
    }
  }
}
