/**
 * Shared @mention parsing utilities.
 * Ensures consistent mention detection across inbound and outbound code paths.
 *
 * Supports two formats:
 * - v1: @name (regex-based, positional pairing with uids)
 * - v2: @[uid:name] (structured, precise mapping via entities)
 *
 * Fixes: https://github.com/Mininglamp-OSS/octo-adapters/issues/31
 */

import type { MentionEntity, MentionPayload } from "./types.js";

/**
 * Regex pattern for matching @mentions in message content.
 *
 * 前置边界（lookbehind）：@ 前面必须是行首或非字母数字字符。
 * 使用黑名单方式 [^a-zA-Z0-9] 排除邮箱（与 v5 保持一致）。
 *
 * name 支持：字母、数字、下划线、CJK 字符、点号、连字符、重音字母。
 *
 * 捕获组说明：
 *   match[0] = 完整匹配（@name，lookbehind 不消耗字符）
 *   match[1] = name（不含 @）
 */
export const MENTION_PATTERN =
  /(?:^|(?<=\s|[^a-zA-Z0-9]))@([\w\u00C0-\u024F\u4e00-\u9fff\u3040-\u30FF\uAC00-\uD7AF.\-]+)/g;

/**
 * 匹配 @[uid:displayName] 格式（adapter↔LLM 内部使用）。
 *
 * uid 字符集：[\w.\-]+ — 覆盖 dmwork 已知的所有 uid 格式
 * name 字符集：[^\]\n]+ — 禁止方括号和换行，其余字符均允许
 */
export const STRUCTURED_MENTION_PATTERN = /@\[([\w.\-]+):([^\]\n]+)\]/g;

/**
 * Parse @mentions from message content.
 * Returns an array of mentioned names (without the @ prefix).
 *
 * @example
 * parseMentions("Hello @陈皮皮 and @bob_123!")
 * // Returns: ["陈皮皮", "bob_123"]
 */
export function parseMentions(content: string): string[] {
  const regex = new RegExp(MENTION_PATTERN.source, "g");
  const matches = content.match(regex) ?? [];
  return matches.map((m) => m.slice(1)); // Remove @ prefix
}

/**
 * Extract raw @mention matches including the @ prefix.
 * Useful when you need the full match text.
 *
 * @example
 * extractMentionMatches("Hello @陈皮皮!")
 * // Returns: ["@陈皮皮"]
 */
export function extractMentionMatches(content: string): string[] {
  const regex = new RegExp(MENTION_PATTERN.source, "g");
  return content.match(regex) ?? [];
}

// ── Structured Mention (@[uid:name]) ──────────────────────────────────────────

export interface StructuredMention {
  uid: string;
  name: string;
  /** @[uid:name] 在原始文本中的起始位置 */
  offset: number;
  /** @[uid:name] 的完整长度 */
  length: number;
}

/**
 * 解析文本中的 @[uid:name] 格式 mention。
 * 用于处理 LLM 回复中的结构化 mention。
 */
export function parseStructuredMentions(text: string): StructuredMention[] {
  const results: StructuredMention[] = [];
  const pattern = new RegExp(STRUCTURED_MENTION_PATTERN.source, "g");
  let match;
  while ((match = pattern.exec(text)) !== null) {
    results.push({
      uid: match[1],
      name: match[2],
      offset: match.index,
      length: match[0].length,
    });
  }
  return results;
}

// ── Convert @[uid:name] → @name (outbound: LLM reply → human readable) ──────

export interface ConvertResult {
  /** 人类可读的 content（@[uid:name] → @name） */
  content: string;
  /** 有效 mention 的精确位置信息 */
  entities: MentionEntity[];
  /** 有效 mention 的 uid 列表（按 offset 升序，与 entities 顺序一致） */
  uids: string[];
}

/**
 * 将文本中的 @[uid:name] 转换为 @name，同时构建 entities 和 uids。
 *
 * 使用增量构建算法：按 offset 升序逐段拼接输出字符串，自然追踪每个 mention
 * 在输出中的精确位置，避免 indexOf 重扫导致的同名 mention 绑错位置问题。
 */
export function convertStructuredMentions(
  text: string,
  mentions: StructuredMention[],
  validUids: Set<string>,
): ConvertResult {
  const sorted = [...mentions].sort((a, b) => a.offset - b.offset);

  const entities: MentionEntity[] = [];
  const uids: string[] = [];
  let content = "";
  let cursor = 0;

  for (const m of sorted) {
    content += text.substring(cursor, m.offset);

    const replacement = `@${m.name}`;
    const newOffset = content.length;
    content += replacement;

    if (validUids.has(m.uid)) {
      entities.push({
        uid: m.uid,
        offset: newOffset,
        length: replacement.length,
      });
      uids.push(m.uid);
    }

    cursor = m.offset + m.length;
  }

  content += text.substring(cursor);

  return { content, entities, uids };
}

// ── Build entities from plain @name (fallback path) ──────────────────────────

/**
 * 从纯 @name 格式的文本中构建 entities（fallback 路径）。
 * 通过 memberMap（displayName → uid）解析每个 @name 对应的 uid。
 *
 * 依赖 MENTION_PATTERN 的捕获组：match[1] 为 name（不含 @）。
 * lookbehind 不消耗字符，因此 match.index 直接指向 @ 的位置。
 */
export function buildEntitiesFromFallback(
  content: string,
  memberMap: Map<string, string>,
): { entities: MentionEntity[]; uids: string[] } {
  const entities: MentionEntity[] = [];
  const uids: string[] = [];

  const pattern = new RegExp(MENTION_PATTERN.source, "g");
  let match;

  while ((match = pattern.exec(content)) !== null) {
    const name = match[1];
    const uid = memberMap.get(name);

    if (!uid) continue;

    const atName = `@${name}`;
    entities.push({ uid, offset: match.index, length: atName.length });
    uids.push(uid);
  }

  return { entities, uids };
}

// ── Extract UIDs from MentionPayload (entities-first with fallback) ──────────

/**
 * 兼容提取 mention 中的 uid 列表。
 *
 * 优先级：
 * 1. entities 中有效条目的 uid → 使用
 * 2. entities 全部无效 → fallback 到 uids
 * 3. uids 也无效 → 返回空数组
 */
export function extractMentionUids(mention?: MentionPayload): string[] {
  if (!mention) return [];

  if (mention.entities && Array.isArray(mention.entities)) {
    const validUids = mention.entities
      .filter(
        (e): e is MentionEntity =>
          e != null &&
          typeof e === "object" &&
          !Array.isArray(e) &&
          typeof e.uid === "string",
      )
      .map((e) => e.uid);

    if (validUids.length > 0) return validUids;
  }

  if (mention.uids && Array.isArray(mention.uids)) {
    return mention.uids.filter((uid): uid is string => typeof uid === "string");
  }

  return [];
}

// ── Convert @name → @[uid:name] for LLM context ─────────────────────────────

/**
 * 将历史消息中的 @name 转换为 @[uid:name] 格式，供 LLM 理解 mention 语义。
 *
 * 路径优先级：
 * 1. entities 有效 → 精确替换（v2）
 * 2. entities 无效 / 不存在 → memberMap 查找（优先）或 uids 顺序配对（v1 fallback）
 * 3. 无 mention → 返回原始 content
 *
 * 替换从后向前进行，避免 offset 漂移。
 */
export function convertContentForLLM(
  content: string,
  mention?: MentionPayload,
  memberMap?: Map<string, string>,
): string {
  if (!mention) return content;

  // 尝试用 entities（v2）
  if (mention.entities && Array.isArray(mention.entities)) {
    const validEntities = mention.entities.filter(
      (e): e is MentionEntity =>
        e != null &&
        typeof e === "object" &&
        !Array.isArray(e) &&
        typeof e.uid === "string" &&
        typeof e.offset === "number" &&
        typeof e.length === "number" &&
        Number.isFinite(e.offset) &&
        Number.isFinite(e.length) &&
        e.offset >= 0 &&
        e.length > 0 &&
        e.offset + e.length <= content.length,
    );

    if (validEntities.length > 0) {
      const sorted = [...validEntities].sort((a, b) => b.offset - a.offset);
      let result = content;
      for (const entity of sorted) {
        const original = result.substring(
          entity.offset,
          entity.offset + entity.length,
        );
        if (!original.startsWith("@")) continue;
        const name = original.substring(1);
        const replacement = `@[${entity.uid}:${name}]`;
        result =
          result.substring(0, entity.offset) +
          replacement +
          result.substring(entity.offset + entity.length);
      }
      return result;
    }
  }

  // fallback（v1）: memberMap 查找优先，无 memberMap 时退回 uids 顺序配对
  const hasMemberMap = memberMap && memberMap.size > 0;
  const hasUids = mention.uids && Array.isArray(mention.uids) && mention.uids.length > 0;

  if (hasMemberMap || hasUids) {
    let result = content;
    const pattern = new RegExp(MENTION_PATTERN.source, "g");
    let match;
    let i = 0;
    const replacements: {
      start: number;
      end: number;
      replacement: string;
    }[] = [];

    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      let uid: string | undefined;

      if (hasMemberMap) {
        uid = memberMap!.get(name);
      } else if (hasUids && i < mention.uids!.length) {
        const candidate = mention.uids![i];
        uid = typeof candidate === "string" ? candidate : undefined;
        i++;
      }

      if (uid) {
        replacements.push({
          start: match.index,
          end: match.index + 1 + name.length,
          replacement: `@[${uid}:${name}]`,
        });
      }
    }

    for (let j = replacements.length - 1; j >= 0; j--) {
      const r = replacements[j];
      result =
        result.substring(0, r.start) +
        r.replacement +
        result.substring(r.end);
    }
    return result;
  }

  return content;
}

// ── Sender prefix utility ────────────────────────────────────────────────────

/**
 * Build a sender label in the format "displayName(uid)" for history context.
 * Falls back to just uid if no name is found.
 */
export function buildSenderPrefix(
  fromUid: string,
  uidToNameMap: Map<string, string>,
): string {
  const name = uidToNameMap.get(fromUid);
  return name ? `${name}(${fromUid})` : fromUid;
}
