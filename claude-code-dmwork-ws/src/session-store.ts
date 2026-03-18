import fs from "fs";
import path from "path";

export interface MsgRecord {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface Session {
  peerId: string;
  channelId: string;
  channelType: number;
  messages: MsgRecord[];
  updatedAt: number;
}

const MAX_HISTORY = 40;

export class SessionStore {
  private dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "sessions");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Session key: for DM it's the peer uid, for group it's channel_id */
  private sessionPath(key: string): string {
    // Sanitize key for filesystem
    const safe = key.replace(/[^a-zA-Z0-9_\-]/g, "_");
    return path.join(this.dir, `${safe}.json`);
  }

  get(key: string): Session | null {
    try {
      return JSON.parse(fs.readFileSync(this.sessionPath(key), "utf-8"));
    } catch {
      return null;
    }
  }

  save(session: Session): void {
    session.messages = session.messages.slice(-MAX_HISTORY);
    session.updatedAt = Date.now();
    fs.writeFileSync(this.sessionPath(session.peerId), JSON.stringify(session, null, 2), "utf-8");
  }

  getOrCreate(peerId: string, channelId: string, channelType: number): Session {
    const existing = this.get(peerId);
    if (existing) return existing;
    return {
      peerId,
      channelId,
      channelType,
      messages: [],
      updatedAt: Date.now(),
    };
  }

  appendUser(session: Session, content: string): void {
    session.messages.push({ role: "user", content, timestamp: Date.now() });
  }

  appendAssistant(session: Session, content: string): void {
    session.messages.push({ role: "assistant", content: content.trim(), timestamp: Date.now() });
  }

  /** Build history prefix for prompt (inject recent history as context) */
  buildHistoryPrefix(session: Session, maxRecent = 20): string {
    const history = session.messages.slice(0, -1).slice(-maxRecent);
    if (history.length === 0) return "";
    const lines = history.map(
      (m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 800)}`
    );
    return (
      "[Conversation history]\n" +
      lines.join("\n\n") +
      "\n\n[Current message]\n"
    );
  }
}
