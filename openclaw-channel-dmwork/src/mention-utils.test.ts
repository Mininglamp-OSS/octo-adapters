import { describe, it, expect } from "vitest";
import {
  parseMentions,
  extractMentionMatches,
  MENTION_PATTERN,
  STRUCTURED_MENTION_PATTERN,
  parseStructuredMentions,
  convertStructuredMentions,
  buildEntitiesFromFallback,
  extractMentionUids,
  convertContentForLLM,
  buildSenderPrefix,
  tryLongestMemberMatch,
} from "./mention-utils.js";
import type { MentionPayload } from "./types.js";

/**
 * Tests for shared @mention parsing utilities.
 * Verifies consistent behavior across different mention formats.
 *
 * Fixes: https://github.com/Mininglamp-OSS/octo-adapters/issues/31
 */
describe("parseMentions", () => {
  it("should parse English alphanumeric mentions", () => {
    const result = parseMentions("Hello @user123 and @test_user!");
    expect(result).toEqual(["user123", "test_user"]);
  });

  it("should parse Chinese character mentions", () => {
    const result = parseMentions("你好 @陈皮皮 请回复");
    expect(result).toEqual(["陈皮皮"]);
  });

  it("should parse mixed Chinese and English mentions", () => {
    const result = parseMentions("@陈皮皮 @bob_123 @托马斯");
    expect(result).toEqual(["陈皮皮", "bob_123", "托马斯"]);
  });

  it("should parse mentions with dots", () => {
    const result = parseMentions("Hi @thomas.ford how are you?");
    expect(result).toEqual(["thomas.ford"]);
  });

  it("should parse mentions with hyphens", () => {
    const result = parseMentions("CC @user-name please");
    expect(result).toEqual(["user-name"]);
  });

  it("should parse complex mixed mentions", () => {
    const result = parseMentions("@陈皮皮_test @user.name-123 @普通用户");
    expect(result).toEqual(["陈皮皮_test", "user.name-123", "普通用户"]);
  });

  it("should return empty array for no mentions", () => {
    const result = parseMentions("Hello world! No mentions here.");
    expect(result).toEqual([]);
  });

  it("should handle @all-like patterns", () => {
    const result = parseMentions("@all please check @everyone");
    expect(result).toEqual(["all", "everyone"]);
  });

  it("should handle mentions at start and end", () => {
    const result = parseMentions("@start middle @end");
    expect(result).toEqual(["start", "end"]);
  });

  it("should NOT match email addresses", () => {
    const result = parseMentions("Send to user@company.com");
    expect(result).toEqual([]);
  });

  it("行首的 @mention 应正常匹配", () => {
    const result = parseMentions("@陈皮皮 你好");
    expect(result).toEqual(["陈皮皮"]);
  });

  it("空白后的 @mention 应正常匹配", () => {
    const result = parseMentions("你好 @Bob 请看");
    expect(result).toEqual(["Bob"]);
  });
});

describe("extractMentionMatches", () => {
  it("should return matches with @ prefix", () => {
    const result = extractMentionMatches("Hello @陈皮皮 and @bob!");
    expect(result).toEqual(["@陈皮皮", "@bob"]);
  });

  it("should return empty array for no mentions", () => {
    const result = extractMentionMatches("No mentions");
    expect(result).toEqual([]);
  });
});

describe("MENTION_PATTERN", () => {
  it("should be a valid regex", () => {
    expect(MENTION_PATTERN).toBeInstanceOf(RegExp);
  });

  it("should have global flag", () => {
    expect(MENTION_PATTERN.flags).toContain("g");
  });

  it("should match Chinese characters (CJK range)", () => {
    const testStr = "@中文名字";
    const regex = new RegExp(MENTION_PATTERN.source, "g");
    const match = testStr.match(regex);
    expect(match).toEqual(["@中文名字"]);
  });

  it("should match underscores", () => {
    const testStr = "@user_name_123";
    const regex = new RegExp(MENTION_PATTERN.source, "g");
    const match = testStr.match(regex);
    expect(match).toEqual(["@user_name_123"]);
  });
});

describe("parseStructuredMentions", () => {
  it("应解析 @[uid:name] 格式", () => {
    const text = "Hi @[uid_bob:Bob] and @[uid_chen:陈皮皮]";
    const result = parseStructuredMentions(text);
    expect(result).toEqual([
      { uid: "uid_bob", name: "Bob", offset: 3, length: 14 },
      { uid: "uid_chen", name: "陈皮皮", offset: 22, length: 15 },
    ]);
    expect(text.substring(3, 3 + 14)).toBe("@[uid_bob:Bob]");
    expect(text.substring(22, 22 + 15)).toBe("@[uid_chen:陈皮皮]");
  });

  it("应处理含点号和连字符的 uid", () => {
    const text = "@[thomas.ford-1:Thomas Ford]";
    const result = parseStructuredMentions(text);
    expect(result).toEqual([
      {
        uid: "thomas.ford-1",
        name: "Thomas Ford",
        offset: 0,
        length: 28,
      },
    ]);
  });

  it("应处理32位十六进制 uid", () => {
    const text = "@[11be65096f214886b69ef9d8fcfa5c55:张三]";
    const result = parseStructuredMentions(text);
    expect(result).toHaveLength(1);
    expect(result[0].uid).toBe("11be65096f214886b69ef9d8fcfa5c55");
    expect(result[0].name).toBe("张三");
    expect(result[0].offset).toBe(0);
    expect(result[0].length).toBe(38);
  });

  it("无匹配时返回空数组", () => {
    const result = parseStructuredMentions("Hello @Bob no structured");
    expect(result).toEqual([]);
  });

  it("不应匹配含换行的格式", () => {
    const result = parseStructuredMentions("@[uid:name\nmore]");
    expect(result).toEqual([]);
  });
});

describe("convertStructuredMentions", () => {
  it("应正确转换单个 mention", () => {
    const text = "Hi @[uid_bob:Bob]!";
    const mentions = parseStructuredMentions(text);
    const result = convertStructuredMentions(text, mentions);

    expect(result.content).toBe("Hi @Bob!");
    expect(result.entities).toEqual([
      { uid: "uid_bob", offset: 3, length: 4 },
    ]);
    expect(result.uids).toEqual(["uid_bob"]);
    expect(result.content.substring(3, 7)).toBe("@Bob");
  });

  it("应处理多个 mention", () => {
    const text = "@[uid_a:Alice] and @[uid_b:Bob]";
    const mentions = parseStructuredMentions(text);
    const result = convertStructuredMentions(text, mentions);

    expect(result.content).toBe("@Alice and @Bob");
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toEqual({ uid: "uid_a", offset: 0, length: 6 });
    expect(result.entities[1]).toEqual({ uid: "uid_b", offset: 11, length: 4 });
    expect(result.content.substring(0, 6)).toBe("@Alice");
    expect(result.content.substring(11, 15)).toBe("@Bob");
  });

  it("should generate entities for all structured mentions including unknown uids", () => {
    const text = "@[fake:Bob] and @[uid_bob:Bob]";
    const mentions = parseStructuredMentions(text);
    const result = convertStructuredMentions(text, mentions);

    expect(result.content).toBe("@Bob and @Bob");
    expect(result.entities).toEqual([
      { uid: "fake", offset: 0, length: 4 },
      { uid: "uid_bob", offset: 9, length: 4 },
    ]);
    expect(result.uids).toEqual(["fake", "uid_bob"]);
  });

  it("应处理中文用户名", () => {
    const text = "你好 @[uid_chen:陈皮皮] 和 @[uid_bob:Bob]";
    const mentions = parseStructuredMentions(text);
    const result = convertStructuredMentions(text, mentions);

    expect(result.content).toBe("你好 @陈皮皮 和 @Bob");
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toEqual({ uid: "uid_chen", offset: 3, length: 4 });
    expect(result.entities[1]).toEqual({ uid: "uid_bob", offset: 10, length: 4 });
    expect(result.content.substring(3, 7)).toBe("@陈皮皮");
    expect(result.content.substring(10, 14)).toBe("@Bob");
  });
});

describe("buildEntitiesFromFallback", () => {
  it("应从 memberMap 解析 @name", () => {
    const memberMap = new Map([
      ["陈皮皮", "uid_chen"],
      ["Bob", "uid_bob"],
    ]);
    const { entities, uids } = buildEntitiesFromFallback(
      "你好 @陈皮皮 和 @Bob",
      memberMap,
    );

    expect(uids).toEqual(["uid_chen", "uid_bob"]);
    expect(entities).toHaveLength(2);
    expect(entities[0]).toEqual({ uid: "uid_chen", offset: 3, length: 4 });
    expect(entities[1]).toEqual({ uid: "uid_bob", offset: 10, length: 4 });
  });

  it("应忽略 memberMap 中不存在的 @name", () => {
    const memberMap = new Map([["Bob", "uid_bob"]]);
    const { entities, uids } = buildEntitiesFromFallback(
      "@Unknown @Bob",
      memberMap,
    );

    expect(uids).toEqual(["uid_bob"]);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toEqual({ uid: "uid_bob", offset: 9, length: 4 });
  });

  it("空 memberMap 返回空结果", () => {
    const { entities, uids } = buildEntitiesFromFallback(
      "@Bob @陈皮皮",
      new Map(),
    );
    expect(uids).toEqual([]);
    expect(entities).toEqual([]);
  });
});

describe("extractMentionUids", () => {
  it("应从 entities 提取 uid", () => {
    const mention: MentionPayload = {
      entities: [
        { uid: "uid_a", offset: 0, length: 4 },
        { uid: "uid_b", offset: 5, length: 4 },
      ],
      uids: ["uid_old"],
    };
    expect(extractMentionUids(mention)).toEqual(["uid_a", "uid_b"]);
  });

  it("entities 全部无效时应 fallback 到 uids", () => {
    const mention: MentionPayload = {
      entities: [{} as any, null as any],
      uids: ["bot_uid"],
    };
    expect(extractMentionUids(mention)).toEqual(["bot_uid"]);
  });

  it("无 entities 时应使用 uids", () => {
    const mention: MentionPayload = {
      uids: ["uid_a", "uid_b"],
    };
    expect(extractMentionUids(mention)).toEqual(["uid_a", "uid_b"]);
  });

  it("均无时返回空数组", () => {
    expect(extractMentionUids(undefined)).toEqual([]);
    expect(extractMentionUids({})).toEqual([]);
  });

  it("应过滤非 string 类型的 uid", () => {
    const mention: MentionPayload = {
      uids: ["uid_a", 123 as any, null as any, "uid_b"],
    };
    expect(extractMentionUids(mention)).toEqual(["uid_a", "uid_b"]);
  });
});

describe("convertContentForLLM", () => {
  it("entities 路径：应将 @name 转换为 @[uid:name]", () => {
    const content = "你好 @陈皮皮 和 @Bob 请看下";
    const mention: MentionPayload = {
      uids: ["uid_chen", "uid_bob"],
      entities: [
        { uid: "uid_chen", offset: 3, length: 4 },
        { uid: "uid_bob", offset: 10, length: 4 },
      ],
    };
    const result = convertContentForLLM(content, mention);
    expect(result).toBe("你好 @[uid_chen:陈皮皮] 和 @[uid_bob:Bob] 请看下");
  });

  it("entities 无效时应 fallback 到 uids", () => {
    const content = "@Alice @Bob";
    const mention: MentionPayload = {
      entities: [{} as any],
      uids: ["uid_a", "uid_b"],
    };
    const result = convertContentForLLM(content, mention);
    expect(result).toBe("@[uid_a:Alice] @[uid_b:Bob]");
  });

  it("entities offset 越界应跳过", () => {
    const content = "Hi @Bob";
    const mention: MentionPayload = {
      entities: [
        { uid: "uid_bob", offset: 3, length: 4 },
        { uid: "uid_x", offset: 100, length: 5 },
      ],
    };
    const result = convertContentForLLM(content, mention);
    expect(result).toBe("Hi @[uid_bob:Bob]");
  });

  it("无 mention 返回原始 content", () => {
    expect(convertContentForLLM("Hello world")).toBe("Hello world");
    expect(convertContentForLLM("Hello world", undefined)).toBe("Hello world");
  });

  it("同名用户不同 uid 应正确转换", () => {
    const content = "请 @陈皮皮 和 @陈皮皮 一起看下";
    const mention: MentionPayload = {
      uids: ["uid_chen_a", "uid_chen_b"],
      entities: [
        { uid: "uid_chen_a", offset: 2, length: 4 },
        { uid: "uid_chen_b", offset: 9, length: 4 },
      ],
    };
    const result = convertContentForLLM(content, mention);
    expect(result).toContain("@[uid_chen_a:陈皮皮]");
    expect(result).toContain("@[uid_chen_b:陈皮皮]");
  });

  it("v1 with memberMap: known names resolved, unknown left as-is", () => {
    const content = "@Angie 你好 @阿达西不在家";
    const mention: MentionPayload = { uids: ["angie_bot", "unknown_uid"] };
    const memberMap = new Map([["Angie", "angie_bot"]]);
    const result = convertContentForLLM(content, mention, memberMap);
    expect(result).toBe("@[angie_bot:Angie] 你好 @阿达西不在家");
  });

  it("v1 without memberMap: backward compat positional pairing", () => {
    const content = "@Alice @Bob";
    const mention: MentionPayload = { uids: ["uid_a", "uid_b"] };
    const result = convertContentForLLM(content, mention);
    expect(result).toBe("@[uid_a:Alice] @[uid_b:Bob]");
  });

  it("v1 with email in content: email NOT matched, mentions correctly resolved", () => {
    const content = "发给xinyi@mininglamp.com 然后找 @Angie";
    const mention: MentionPayload = { uids: ["angie_bot"] };
    const memberMap = new Map([["Angie", "angie_bot"]]);
    const result = convertContentForLLM(content, mention, memberMap);
    expect(result).toContain("@[angie_bot:Angie]");
    // Email should remain unchanged (not converted to @[...] format)
    expect(result).toContain("xinyi@mininglamp.com");
    expect(result).toBe("发给xinyi@mininglamp.com 然后找 @[angie_bot:Angie]");
  });

  it("v1 with empty memberMap: no replacements", () => {
    const content = "@Alice @Bob";
    const mention: MentionPayload = { uids: ["uid_a", "uid_b"] };
    const emptyMap = new Map<string, string>();
    const result = convertContentForLLM(content, mention, emptyMap);
    // Empty memberMap means hasMemberMap is false, falls back to uids
    expect(result).toBe("@[uid_a:Alice] @[uid_b:Bob]");
  });

  it("v1 with empty uids and no memberMap: returns original", () => {
    const content = "@Alice @Bob";
    const mention: MentionPayload = { uids: [] };
    const result = convertContentForLLM(content, mention);
    expect(result).toBe("@Alice @Bob");
  });
});

describe("buildSenderPrefix", () => {
  it("should return name(uid) when name is found", () => {
    const map = new Map([["uid1", "Alice"]]);
    expect(buildSenderPrefix("uid1", map)).toBe("Alice(uid1)");
  });

  it("should return uid when name is not found", () => {
    const map = new Map<string, string>();
    expect(buildSenderPrefix("uid1", map)).toBe("uid1");
  });
});

describe("边界情况", () => {
  it("entity.offset 超出 content 长度", () => {
    const result = convertContentForLLM("Hi", {
      entities: [{ uid: "uid", offset: 100, length: 4 }],
    });
    expect(result).toBe("Hi");
  });

  it("entity.length 为 0", () => {
    const result = convertContentForLLM("@Bob", {
      entities: [{ uid: "uid", offset: 0, length: 0 }],
    });
    expect(result).toBe("@Bob");
  });

  it("entity.offset 为负数", () => {
    const result = convertContentForLLM("@Bob", {
      entities: [{ uid: "uid", offset: -1, length: 4 }],
    });
    expect(result).toBe("@Bob");
  });

  it("entity.offset 或 length 为 NaN", () => {
    const result = convertContentForLLM("@Bob", {
      entities: [{ uid: "uid", offset: NaN, length: 4 }],
    });
    expect(result).toBe("@Bob");
  });

  it("entity.offset 或 length 为 Infinity", () => {
    const result = convertContentForLLM("@Bob", {
      entities: [{ uid: "uid", offset: 0, length: Infinity }],
    });
    expect(result).toBe("@Bob");
  });

  it("entities 数组包含 null", () => {
    const uids = extractMentionUids({
      entities: [null as any, { uid: "valid_uid", offset: 0, length: 4 }],
    });
    expect(uids).toEqual(["valid_uid"]);
  });

  it("content 在 entity.offset 处不以 @ 开头", () => {
    const result = convertContentForLLM("Hello world", {
      entities: [{ uid: "uid", offset: 0, length: 5 }],
    });
    expect(result).toBe("Hello world");
  });

  it("Emoji 用户名：UTF-16 offset/length 正确", () => {
    const content = "@张三🐱 你好";
    const mention: MentionPayload = {
      entities: [{ uid: "uid_zhang", offset: 0, length: 5 }],
    };
    const result = convertContentForLLM(content, mention);
    expect(result).toBe("@[uid_zhang:张三🐱] 你好");
  });

  it("混合 v2 + fallback 后 uids 顺序", () => {
    const text = "Hi @[uid_chen:Chen] and @Bob";
    const structured = parseStructuredMentions(text);
    const converted = convertStructuredMentions(text, structured);

    const memberMap = new Map([["Bob", "uid_bob"]]);
    const remaining = buildEntitiesFromFallback(converted.content, memberMap);

    const allEntities = [...converted.entities, ...remaining.entities];
    allEntities.sort((a, b) => a.offset - b.offset);
    const uids = allEntities.map((e) => e.uid);

    expect(uids).toEqual(["uid_chen", "uid_bob"]);
    expect(allEntities[0]).toEqual({ uid: "uid_chen", offset: 3, length: 5 });
    expect(allEntities[1]).toEqual({ uid: "uid_bob", offset: 13, length: 4 });
  });
});

// --- extractBaseUid & resolveSenderName ---
import { extractBaseUid, resolveSenderName } from "./mention-utils.js";

describe("extractBaseUid", () => {
  it("strips space prefix", () => {
    expect(extractBaseUid("s14_abc123")).toBe("abc123");
  });

  it("handles multi-digit space id", () => {
    expect(extractBaseUid("s1234_user456")).toBe("user456");
  });

  it("returns uid unchanged when no space prefix", () => {
    expect(extractBaseUid("abc123")).toBe("abc123");
  });

  it("returns uid unchanged for 's' without underscore", () => {
    expect(extractBaseUid("system")).toBe("system");
  });

  it("does not strip non-numeric space prefix (e.g. service_bot)", () => {
    expect(extractBaseUid("service_bot")).toBe("service_bot");
    expect(extractBaseUid("support_team")).toBe("support_team");
  });
});

describe("resolveSenderName", () => {
  it("returns direct match", () => {
    const map = new Map([["s14_abc", "Alice"]]);
    expect(resolveSenderName("s14_abc", map)).toBe("Alice");
  });

  it("returns undefined when no match", () => {
    const map = new Map([["s14_abc", "Alice"]]);
    expect(resolveSenderName("s14_xyz", map)).toBeUndefined();
  });

  it("falls back to base uid (non-space entry)", () => {
    const map = new Map([["abc", "Alice"]]);
    expect(resolveSenderName("s14_abc", map)).toBe("Alice");
  });

  it("falls back to cross-space variant", () => {
    // User known as s10_abc in one space, DM from s14_abc
    const map = new Map([["s10_abc", "Alice"]]);
    expect(resolveSenderName("s14_abc", map)).toBe("Alice");
  });

  it("does not cross-space fallback for non-prefixed uid", () => {
    // uid "abc" without space prefix should not scan
    const map = new Map([["s10_abc", "Alice"]]);
    expect(resolveSenderName("abc", map)).toBeUndefined();
  });

  it("prefers direct match over cross-space", () => {
    const map = new Map([["s14_abc", "Alice-14"], ["s10_abc", "Alice-10"]]);
    expect(resolveSenderName("s14_abc", map)).toBe("Alice-14");
  });
});

describe("buildSenderPrefix with cross-space", () => {
  it("shows name(uid) for cross-space hit", () => {
    const map = new Map([["s10_abc", "Alice"]]);
    expect(buildSenderPrefix("s14_abc", map)).toBe("Alice(s14_abc)");
  });

  it("shows raw uid when no match", () => {
    const map = new Map([["s10_xyz", "Bob"]]);
    expect(buildSenderPrefix("s14_abc", map)).toBe("s14_abc");
  });
});

// ── Space-name @mention support ──────────────────────────────────────────────

describe("buildEntitiesFromFallback — 空格昵称支持", () => {
  it("应匹配含空格的昵称 @Anyang Su", () => {
    const memberMap = new Map([
      ["Anyang Su", "uid_anyang"],
      ["Bob", "uid_bob"],
    ]);
    const { entities, uids } = buildEntitiesFromFallback(
      "Hello @Anyang Su and @Bob",
      memberMap,
    );
    expect(uids).toEqual(["uid_anyang", "uid_bob"]);
    expect(entities).toHaveLength(2);
    expect(entities[0]).toEqual({ uid: "uid_anyang", offset: 6, length: 10 });
    expect(entities[1]).toEqual({ uid: "uid_bob", offset: 21, length: 4 });
  });

  it("应优先匹配最长名称", () => {
    const memberMap = new Map([
      ["Anyang", "uid_short"],
      ["Anyang Su", "uid_full"],
    ]);
    const { entities, uids } = buildEntitiesFromFallback(
      "@Anyang Su hello",
      memberMap,
    );
    expect(uids).toEqual(["uid_full"]);
    expect(entities[0]).toEqual({ uid: "uid_full", offset: 0, length: 10 });
  });

  it("不应跨词误匹配 @Anyang Superman", () => {
    const memberMap = new Map([["Anyang Su", "uid_anyang"]]);
    const { entities, uids } = buildEntitiesFromFallback(
      "@Anyang Superman",
      memberMap,
    );
    expect(uids).toEqual([]);
    expect(entities).toEqual([]);
  });

  it("应处理多个空格昵称", () => {
    const memberMap = new Map([
      ["Anyang Su", "uid_anyang"],
      ["Li Wei", "uid_li"],
    ]);
    const { entities, uids } = buildEntitiesFromFallback(
      "@Anyang Su @Li Wei",
      memberMap,
    );
    expect(uids).toEqual(["uid_anyang", "uid_li"]);
    expect(entities).toHaveLength(2);
    expect(entities[0]).toEqual({ uid: "uid_anyang", offset: 0, length: 10 });
    expect(entities[1]).toEqual({ uid: "uid_li", offset: 11, length: 7 });
  });

  it("无空格名称时行为不变", () => {
    const memberMap = new Map([["Bob", "uid_bob"]]);
    const { entities, uids } = buildEntitiesFromFallback("@Bob hi", memberMap);
    expect(uids).toEqual(["uid_bob"]);
    expect(entities[0]).toEqual({ uid: "uid_bob", offset: 0, length: 4 });
  });
});

describe("buildEntitiesFromFallback — @all 跳过", () => {
  it("@all 不应生成 entity", () => {
    const memberMap = new Map([["Bob", "uid_bob"]]);
    const { entities, uids } = buildEntitiesFromFallback("@all @Bob", memberMap);
    expect(uids).toEqual(["uid_bob"]);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toEqual({ uid: "uid_bob", offset: 5, length: 4 });
  });

  it("@All (大小写) 也不应生成 entity", () => {
    const memberMap = new Map([["Bob", "uid_bob"]]);
    const { entities, uids } = buildEntitiesFromFallback("@All @Bob", memberMap);
    expect(uids).toEqual(["uid_bob"]);
    expect(entities).toHaveLength(1);
  });

  it("@ALL 全大写不应生成 entity", () => {
    const memberMap = new Map<string, string>();
    const { entities, uids } = buildEntitiesFromFallback("@ALL please check", memberMap);
    expect(uids).toEqual([]);
    expect(entities).toEqual([]);
  });

  it("@all 单独出现也不应生成 entity", () => {
    const memberMap = new Map<string, string>();
    const { entities, uids } = buildEntitiesFromFallback("@all", memberMap);
    expect(uids).toEqual([]);
    expect(entities).toEqual([]);
  });

  it("@所有人 不应生成 entity", () => {
    const memberMap = new Map([["Bob", "uid_bob"]]);
    const { entities, uids } = buildEntitiesFromFallback("@所有人 @Bob", memberMap);
    expect(uids).toEqual(["uid_bob"]);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toEqual({ uid: "uid_bob", offset: 5, length: 4 });
  });

  it("@所有人 单独出现也不应生成 entity", () => {
    const memberMap = new Map<string, string>();
    const { entities, uids } = buildEntitiesFromFallback("@所有人", memberMap);
    expect(uids).toEqual([]);
    expect(entities).toEqual([]);
  });

  it("混合 @all 和 @所有人 都不应生成 entity", () => {
    const memberMap = new Map([["Bob", "uid_bob"]]);
    const { entities, uids } = buildEntitiesFromFallback("@all @所有人 @Bob", memberMap);
    expect(uids).toEqual(["uid_bob"]);
    expect(entities).toHaveLength(1);
  });
});

describe("convertContentForLLM — 空格昵称支持", () => {
  it("v1 memberMap 路径应匹配空格昵称", () => {
    const content = "@Anyang Su 你好";
    const mention: MentionPayload = { uids: ["uid_anyang"] };
    const memberMap = new Map([["Anyang Su", "uid_anyang"]]);
    const result = convertContentForLLM(content, mention, memberMap);
    expect(result).toBe("@[uid_anyang:Anyang Su] 你好");
  });
});

describe("inbound text fallback regex", () => {
  // Must mirror the regex in inbound.ts text fallback block exactly.
  // Lookbehind: more conservative than MENTION_PATTERN — also excludes CJK
  // and extended Latin to avoid false-positive bot activations.
  function buildFallbackRegex(botName: string): RegExp {
    const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(?<=^|[^\\w\\u4e00-\\u9fff\\u3040-\\u30FF\\uAC00-\\uD7AF\\u00C0-\\u024F])@${escaped}(?![\\w\\u4e00-\\u9fff\\u3040-\\u30FF\\uAC00-\\uD7AF\\u00C0-\\u024F.\\-])`
    );
  }

  // --- positive cases ---
  it("matches @BotName at start of message", () => {
    expect(buildFallbackRegex("Jeff").test("@Jeff 你好")).toBe(true);
  });

  it("matches @BotName after whitespace", () => {
    expect(buildFallbackRegex("Jeff").test("嗨 @Jeff 能帮我吗")).toBe(true);
  });

  it("matches @BotName followed by punctuation", () => {
    expect(buildFallbackRegex("Jeff").test("@Jeff，帮我看一下")).toBe(true);
  });

  it("matches @BotName followed by !", () => {
    expect(buildFallbackRegex("Jeff").test("Hello @Jeff!")).toBe(true);
  });

  it("matches CJK bot name", () => {
    expect(buildFallbackRegex("张三").test("@张三 你好")).toBe(true);
  });

  it("matches @BotName at end of string", () => {
    expect(buildFallbackRegex("Jeff").test("hey @Jeff")).toBe(true);
  });

  // --- negative: lookbehind ---
  it("does NOT match when CJK char immediately precedes @ (intentional conservative)", () => {
    expect(buildFallbackRegex("Jeff").test("你好@Jeff")).toBe(false);
  });

  it("does NOT match when underscore precedes @", () => {
    expect(buildFallbackRegex("Jeff").test("foo_@Jeff")).toBe(false);
  });

  it("does NOT match email-like foo@BotName", () => {
    expect(buildFallbackRegex("Jeff").test("foo@Jeff")).toBe(false);
  });

  // --- negative: lookahead ---
  it("does NOT match @BotName followed by word char (@Jefferson)", () => {
    expect(buildFallbackRegex("Jeff").test("@Jefferson")).toBe(false);
  });

  it("does NOT match @BotName followed by CJK", () => {
    expect(buildFallbackRegex("Jeff").test("@Jeff你好")).toBe(false);
  });

  it("does NOT match @BotName followed by dot (domain-like)", () => {
    expect(buildFallbackRegex("Jeff").test("@Jeff.com")).toBe(false);
  });

  it("does NOT match CJK bot name followed by CJK", () => {
    expect(buildFallbackRegex("小助手").test("@小助手好")).toBe(false);
  });
});
