import { describe, it, expect } from "vitest";
import { GroupContext } from "../src/group-context.js";

describe("GroupContext", () => {
  it("caches messages and builds context", () => {
    const ctx = new GroupContext();
    ctx.pushMessage("g1", "u1", "hello everyone", 1000);
    ctx.pushMessage("g1", "u2", "hi there", 1001);

    const context = ctx.buildContext("g1");
    expect(context).toContain("[Group chat context");
    expect(context).toContain("hello everyone");
    expect(context).toContain("hi there");
  });

  it("returns empty context for unknown group", () => {
    const ctx = new GroupContext();
    expect(ctx.buildContext("unknown")).toBe("");
  });

  it("learns and resolves member names", () => {
    const ctx = new GroupContext();
    ctx.learnMember("g1", "uid123", "Alice");

    expect(ctx.getName("g1", "uid123")).toBe("Alice");
  });

  it("uses display names in context after learning", () => {
    const ctx = new GroupContext();
    ctx.learnMember("g1", "u1", "Alice");
    ctx.pushMessage("g1", "u1", "hello", 1000);

    const context = ctx.buildContext("g1");
    expect(context).toContain("Alice");
  });

  it("resolves @mentions in text to uids", () => {
    const ctx = new GroupContext();
    ctx.learnMember("g1", "uid1", "Alice");
    ctx.learnMember("g1", "uid2", "Bob");

    const uids = ctx.resolveMentions("g1", "Hey @Alice and @Bob");
    expect(uids).toContain("uid1");
    expect(uids).toContain("uid2");
  });

  it("is case-insensitive for mention resolution", () => {
    const ctx = new GroupContext();
    ctx.learnMember("g1", "uid1", "Alice");

    const uids = ctx.resolveMentions("g1", "@alice do this");
    expect(uids).toEqual(["uid1"]);
  });

  it("enforces sliding window on messages", () => {
    const ctx = new GroupContext();
    for (let i = 0; i < 50; i++) {
      ctx.pushMessage("g1", "u1", `msg-${i}`, 1000 + i);
    }

    const context = ctx.buildContext("g1", 20);
    // Should only include recent messages
    expect(context).toContain("msg-49");
    expect(context).not.toContain("msg-0");
  });
});
