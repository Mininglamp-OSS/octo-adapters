import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../src/session-store.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("SessionStore", () => {
  let store: SessionStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-test-"));
    store = new SessionStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates new session", () => {
    const session = store.getOrCreate("user1", "channel1", 1);
    expect(session.peerId).toBe("user1");
    expect(session.channelId).toBe("channel1");
    expect(session.messages).toEqual([]);
  });

  it("appends and persists messages", () => {
    const session = store.getOrCreate("user1", "channel1", 1);
    store.appendUser(session, "hello");
    store.appendAssistant(session, "hi there");
    store.save(session);

    const loaded = store.get("user1");
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0].role).toBe("user");
    expect(loaded!.messages[0].content).toBe("hello");
    expect(loaded!.messages[1].role).toBe("assistant");
    expect(loaded!.messages[1].content).toBe("hi there");
  });

  it("returns existing session on getOrCreate", () => {
    const session = store.getOrCreate("user1", "channel1", 1);
    store.appendUser(session, "first");
    store.save(session);

    const again = store.getOrCreate("user1", "channel1", 1);
    expect(again.messages).toHaveLength(1);
  });

  it("trims history beyond max limit", () => {
    const session = store.getOrCreate("user1", "channel1", 1);
    for (let i = 0; i < 50; i++) {
      store.appendUser(session, `msg-${i}`);
    }
    store.save(session);

    const loaded = store.get("user1");
    expect(loaded!.messages.length).toBeLessThanOrEqual(40);
    // Should keep the most recent messages
    expect(loaded!.messages[loaded!.messages.length - 1].content).toBe("msg-49");
  });

  it("returns null for nonexistent session", () => {
    expect(store.get("nonexistent")).toBeNull();
  });

  describe("buildHistoryPrefix", () => {
    it("returns empty string for no history", () => {
      const session = store.getOrCreate("user1", "channel1", 1);
      store.appendUser(session, "current");
      expect(store.buildHistoryPrefix(session)).toBe("");
    });

    it("builds history excluding last message", () => {
      const session = store.getOrCreate("user1", "channel1", 1);
      store.appendUser(session, "first");
      store.appendAssistant(session, "reply");
      store.appendUser(session, "current");

      const prefix = store.buildHistoryPrefix(session);
      expect(prefix).toContain("[Conversation history]");
      expect(prefix).toContain("User: first");
      expect(prefix).toContain("Assistant: reply");
      expect(prefix).toContain("[Current message]");
      expect(prefix).not.toContain("current");
    });
  });
});
