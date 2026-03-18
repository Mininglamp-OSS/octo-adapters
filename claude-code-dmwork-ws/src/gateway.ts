/**
 * Gateway: DMWork WebSocket ←→ Claude Agent SDK
 *
 * Receives messages from DMWork via WuKongIM WebSocket,
 * routes them to Claude Code for processing,
 * sends replies back via DMWork REST API.
 */

import { query as agentQuery } from "@anthropic-ai/claude-agent-sdk";
import { WKSocket } from "./dmwork/socket.js";
import { registerBot, sendMessage, sendTyping, sendHeartbeat, streamStart, streamSend, streamEnd } from "./dmwork/api.js";
import { ChannelType, MessageType } from "./dmwork/types.js";
import type { BotMessage } from "./dmwork/types.js";
import { parseMentions } from "./dmwork/mentions.js";
import { SessionStore } from "./session-store.js";
import { GroupContext } from "./group-context.js";
import type { BotConfig } from "./config.js";
import fs from "fs";
import path from "path";

export class Gateway {
  private config: BotConfig;
  private sessions: SessionStore;
  private groupCtx: GroupContext;
  private socket: WKSocket | null = null;
  private robotId = "";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private processing = new Set<string>(); // prevent concurrent processing per peer
  private startedAt = 0; // ignore messages older than this
  private isRefreshingToken = false; // guard against concurrent refreshes
  private hasRefreshedToken = false; // only refresh token once per session

  constructor(config: BotConfig) {
    this.config = config;
    this.sessions = new SessionStore(config.dataDir);
    this.groupCtx = new GroupContext();
    fs.mkdirSync(config.dataDir, { recursive: true });
  }

  async start(): Promise<void> {
    // Prevent multiple instances (same bot can't have 2 WS connections)
    const lockFile = path.join(this.config.dataDir, ".gateway.lock");
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    if (fs.existsSync(lockFile)) {
      const pid = fs.readFileSync(lockFile, "utf-8").trim();
      try {
        process.kill(Number(pid), 0); // check if alive
        console.error(`[gateway] Another instance running (PID ${pid}). Exiting.`);
        process.exit(1);
      } catch {
        // stale lock, continue
      }
    }
    fs.writeFileSync(lockFile, String(process.pid));
    process.on("exit", () => { try { fs.unlinkSync(lockFile); } catch {} });

    console.log("[gateway] Registering bot...");
    const reg = await registerBot({
      apiUrl: this.config.apiUrl,
      botToken: this.config.botToken,
    });

    this.robotId = reg.robot_id;
    console.log(`[gateway] Registered as ${this.robotId}`);

    // Connect WebSocket
    this.socket = new WKSocket({
      wsUrl: reg.ws_url,
      uid: reg.robot_id,
      token: reg.im_token,
      onMessage: (msg) => this.onMessage(msg),
      onConnected: () => {
        console.log("[gateway] WebSocket connected, draining old messages for 3s...");
        this.startedAt = Math.floor(Date.now() / 1000) + 3;
        this.startHeartbeat();
      },
      onDisconnected: () => console.log("[gateway] WebSocket disconnected"),
      onError: async (err) => {
        console.error("[gateway] WebSocket error:", err.message);
        // Kicked or connect failed: refresh IM token once (match openclaw adapter pattern)
        if (!this.hasRefreshedToken && !this.isRefreshingToken &&
            (err.message.includes("Kicked") || err.message.includes("Connect failed"))) {
          this.isRefreshingToken = true;
          this.hasRefreshedToken = true;
          console.log("[gateway] Connection rejected — refreshing IM token...");
          try {
            const fresh = await registerBot({
              apiUrl: this.config.apiUrl,
              botToken: this.config.botToken,
              forceRefresh: true,
            });
            this.robotId = fresh.robot_id;
            console.log("[gateway] Got fresh IM token, reconnecting WS...");
            this.socket!.disconnect();
            this.socket!.updateCredentials(fresh.robot_id, fresh.im_token);
            this.socket!.connect();
          } catch (refreshErr) {
            console.error("[gateway] Token refresh failed:", refreshErr);
            this.hasRefreshedToken = false; // allow retry on next error
          } finally {
            this.isRefreshingToken = false;
          }
        }
      },
    });

    this.socket.connect();

    console.log("[gateway] Running. Press Ctrl+C to stop.");
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.socket?.disconnect();
    console.log("[gateway] Stopped.");
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.heartbeatTimer = setInterval(() => {
      sendHeartbeat({ apiUrl: this.config.apiUrl, botToken: this.config.botToken });
    }, 30_000);
  }

  private async onMessage(msg: BotMessage): Promise<void> {
    // Drop old/offline messages — prevent storm on reconnect
    if (msg.timestamp < this.startedAt) return;

    console.log(`[gateway] Message from=${msg.from_uid} type=${msg.payload.type} channel=${msg.channel_id ?? "DM"}`);

    // Skip own messages
    if (msg.from_uid === this.robotId) return;

    // Only handle text messages for now
    if (msg.payload.type !== MessageType.Text) {
      console.log(`[gateway] Skipping non-text message type=${msg.payload.type}`);
      return;
    }

    const content = msg.payload.content?.trim();
    if (!content) return;

    const channelType = msg.channel_type ?? ChannelType.DM;
    const channelId = msg.channel_id ?? msg.from_uid;

    // Group chat: cache ALL messages as context, only process @mentioned
    if (channelType === ChannelType.Group) {
      // Learn member names from message metadata
      if (msg.payload.mention?.uids && msg.payload.content) {
        const mentionNames = parseMentions(msg.payload.content);
        const mentionUids = msg.payload.mention.uids;
        for (let i = 0; i < Math.min(mentionNames.length, mentionUids.length); i++) {
          this.groupCtx.learnMember(channelId, mentionUids[i], mentionNames[i]);
        }
      }

      // Cache every group message for context
      this.groupCtx.pushMessage(channelId, msg.from_uid, content, msg.timestamp);

      // Only respond when @mentioned
      const mentioned = msg.payload.mention?.uids?.includes(this.robotId)
        || msg.payload.mention?.all;
      if (!mentioned) return;

      // Refresh member list in background (cached, won't fetch every time)
      this.groupCtx.refreshMembers(channelId, this.config.apiUrl, this.config.botToken).catch(() => {});
    }

    // Session key: DM → peer uid, Group → channelId:peerUid
    const sessionKey = channelType === ChannelType.DM
      ? msg.from_uid
      : `${channelId}:${msg.from_uid}`;

    // Prevent concurrent processing for same peer
    if (this.processing.has(sessionKey)) return;
    this.processing.add(sessionKey);

    try {
      console.log(`[gateway] Processing: session=${sessionKey}`);
      await this.handleMessage(sessionKey, msg, channelId, channelType, content);
      console.log(`[gateway] Done: session=${sessionKey}`);
    } finally {
      this.processing.delete(sessionKey);
    }
  }

  private async handleMessage(
    sessionKey: string,
    msg: BotMessage,
    channelId: string,
    channelType: ChannelType,
    content: string,
  ): Promise<void> {
    // Send typing indicator
    sendTyping({
      apiUrl: this.config.apiUrl,
      botToken: this.config.botToken,
      channelId,
      channelType,
    });

    // Strip @mention from content if group
    let cleanContent = content;
    if (channelType === ChannelType.Group) {
      cleanContent = content.replace(new RegExp(`@${this.robotId}\\s*`, "g"), "").trim();
      if (!cleanContent) cleanContent = content; // fallback if only @mention
    }

    // Load/create session, append user message
    const session = this.sessions.getOrCreate(sessionKey, channelId, channelType);
    this.sessions.appendUser(session, cleanContent);

    // Build prompt with history + group context
    const groupContext = channelType === ChannelType.Group
      ? this.groupCtx.buildContext(channelId)
      : "";
    const historyPrefix = this.sessions.buildHistoryPrefix(session);
    const prompt = groupContext + historyPrefix + cleanContent;

    // Call Claude Agent SDK with streaming output
    console.log(`[gateway] Calling Claude SDK, prompt length=${prompt.length}`);
    const reply = await this.queryAgentStreaming(prompt, channelId, channelType);
    console.log(`[gateway] Done, reply length=${reply.length}`);

    // Save assistant reply
    this.sessions.appendAssistant(session, reply);
    this.sessions.save(session);
  }

  /**
   * Query Claude Agent SDK with streaming output to DMWork.
   *
   * Uses DMWork's stream API: start → send chunks → end.
   * The user sees text appearing incrementally in real-time,
   * instead of waiting for the full response.
   */
  private async queryAgentStreaming(
    prompt: string,
    channelId: string,
    channelType: ChannelType,
  ): Promise<string> {
    const allChunks: string[] = [];
    let streamNo = "";

    // Periodic typing indicator while processing (before stream starts)
    const typingTimer = setInterval(() => {
      sendTyping({
        apiUrl: this.config.apiUrl,
        botToken: this.config.botToken,
        channelId,
        channelType,
      });
    }, 5000);

    // Stream sends full accumulated text each time (not incremental)
    const FLUSH_INTERVAL_MS = 800;
    let lastFlushedLength = 0;
    let flushTimer: ReturnType<typeof setInterval> | null = null;

    const startStreamIfNeeded = async (): Promise<void> => {
      if (streamNo) return;
      try {
        streamNo = await streamStart({
          apiUrl: this.config.apiUrl,
          botToken: this.config.botToken,
          channelId,
          channelType,
        });
      } catch {
        console.log("[gateway] Stream API unavailable, using fallback sendMessage");
      }
    };

    const flushToStream = async (): Promise<void> => {
      const fullSoFar = allChunks.join("");
      if (!streamNo || fullSoFar.length === lastFlushedLength) return;
      lastFlushedLength = fullSoFar.length;
      try {
        await streamSend({
          apiUrl: this.config.apiUrl,
          botToken: this.config.botToken,
          streamNo,
          channelId,
          channelType,
          content: fullSoFar,
        });
      } catch (err) {
        console.debug("[gateway] Stream send failed:", err);
      }
    };

    try {
      const sdk = this.config.sdk;
      const stream = agentQuery({
        prompt,
        options: {
          cwd: this.config.cwd,
          systemPrompt: sdk.systemPrompt || this.getSystemPrompt(),
          settingSources: sdk.settingSources,
          allowedTools: sdk.allowedTools,
          permissionMode: sdk.permissionMode,
          ...(sdk.maxTurns ? { maxTurns: sdk.maxTurns } : {}),
          ...(process.env.CLAUDECODE ? { env: { ...process.env, CLAUDECODE: "" } } : {}),
          stderr: (data: string) => console.error("[claude-stderr]", data.trim()),
        },
      });

      for await (const message of stream) {
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if ("text" in block && block.text) {
              allChunks.push(block.text);

              // Start stream on first text chunk
              await startStreamIfNeeded();

              // Start periodic flushing
              if (!flushTimer && streamNo) {
                flushTimer = setInterval(() => { flushToStream(); }, FLUSH_INTERVAL_MS);
              }
            }
          }
        }
        if (message.type === "result") {
          if (message.subtype === "success" && allChunks.length === 0 && message.result) {
            allChunks.push(message.result);
          }
          if (message.subtype !== "success") {
            const errMsg = message.errors?.join(", ") || "Processing failed";
            allChunks.length = 0;
            allChunks.push(`[Error] ${errMsg}`);
          }
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Agent query failed";
      allChunks.length = 0;
      allChunks.push(`[Error] ${errMsg}`);
    } finally {
      if (flushTimer) clearInterval(flushTimer);
      clearInterval(typingTimer);
    }

    // Final flush + end stream
    const fullText = allChunks.join("") || "[No response]";

    if (streamNo) {
      // Final flush with complete text
      await flushToStream();
      await streamEnd({
        apiUrl: this.config.apiUrl,
        botToken: this.config.botToken,
        streamNo,
        channelId,
        channelType,
      }).catch(() => {});
    } else {
      // Stream API unavailable — fall back to regular message(s)
      await this.sendFallback(channelId, channelType, fullText);
    }

    return fullText;
  }

  private getSystemPrompt(): string {
    return `You are an AI assistant connected to DMWork messaging.
You receive messages from users via instant messaging and reply conversationally.

Guidelines:
- Be concise. This is chat, not email.
- Use short messages and natural language.
- If you're unsure about something, ask.
- You can use tools to help answer questions when needed.

Today: ${new Date().toISOString().slice(0, 10)}`;
  }

  /** Fallback: send as regular message(s) when streaming is unavailable */
  private async sendFallback(
    channelId: string,
    channelType: ChannelType,
    text: string,
  ): Promise<void> {
    const MAX_LEN = 3500;
    const parts = splitMessage(text, MAX_LEN);

    const mentionUids = channelType === ChannelType.Group
      ? this.groupCtx.resolveMentions(channelId, text)
      : undefined;

    for (const part of parts) {
      await sendMessage({
        apiUrl: this.config.apiUrl,
        botToken: this.config.botToken,
        channelId,
        channelType,
        content: part,
        mentionUids,
      });
    }
  }
}

/** Split long text into chunks at natural boundaries */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Try to split at paragraph, then sentence, then word boundary
    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    if (splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;

    parts.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) parts.push(remaining);
  return parts;
}
