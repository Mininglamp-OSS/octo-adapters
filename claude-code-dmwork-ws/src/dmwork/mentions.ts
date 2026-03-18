/** @mention parsing — extracted from openclaw-channel-dmwork */

export const MENTION_PATTERN = /@[\w\u4e00-\u9fa5.\-]+/g;

export function parseMentions(content: string): string[] {
  const regex = new RegExp(MENTION_PATTERN.source, "g");
  const matches = content.match(regex) ?? [];
  return matches.map((m) => m.slice(1));
}

export function extractMentionMatches(content: string): string[] {
  const regex = new RegExp(MENTION_PATTERN.source, "g");
  return content.match(regex) ?? [];
}
