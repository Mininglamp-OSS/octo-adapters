"""
@mention parsing and conversion utilities.

Translated from openclaw-channel-dmwork/src/mention-utils.ts.
Provides consistent mention detection across inbound and outbound code paths.

Supports two formats:
  - v1: @name (regex-based, positional pairing with uids)
  - v2: @[uid:name] (structured, precise mapping via entities)
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from hermes_dmwork.types import MentionEntity, MentionPayload

# ─── Regex Patterns ──────────────────────────────────────────────────────────

# Matches @mentions in message content.
# Boundary: @ must be preceded by start-of-string or non-alphanumeric.
# Name chars: word chars, CJK, accented letters, dots, hyphens.
MENTION_PATTERN = re.compile(
    r"(?:^|(?<=\s|[^a-zA-Z0-9]))"
    r"@([\w\u00C0-\u024F\u4e00-\u9fff\u3040-\u30FF\uAC00-\uD7AF.\-]+)"
)

# Matches @[uid:displayName] format (adapter↔LLM internal use).
STRUCTURED_MENTION_PATTERN = re.compile(r"@\[([\w.\-]+):([^\]\n]+)\]")


# ─── Extract UIDs from MentionPayload ────────────────────────────────────────


def extract_mention_uids(mention: Optional[MentionPayload]) -> list[str]:
    """
    Extract mention UIDs from a MentionPayload, preferring entities over uids.

    Priority:
    1. entities with valid uid → use those
    2. entities all invalid → fallback to uids list
    3. no uids → return empty list
    """
    if not mention:
        return []

    if mention.entities:
        valid_uids = [
            e.uid
            for e in mention.entities
            if isinstance(e, MentionEntity) and e.uid
        ]
        if valid_uids:
            return valid_uids

    if mention.uids:
        return [uid for uid in mention.uids if isinstance(uid, str)]

    return []


# ─── Convert @name → @[uid:name] for LLM Context ────────────────────────────


def convert_content_for_llm(
    content: str,
    mention: Optional[MentionPayload] = None,
    member_map: Optional[dict[str, str]] = None,
) -> str:
    """
    Convert @mentions in message content to @[uid:name] format for LLM context.

    Path priority:
    1. entities valid → precise replacement (v2)
    2. entities invalid / not present → member_map lookup or uids positional pairing (v1)
    3. no mention → return original content

    Replacement proceeds from back to front to avoid offset drift.
    """
    if not mention:
        return content

    # Try entities (v2) — precise offset-based replacement
    if mention.entities:
        valid_entities = [
            e
            for e in mention.entities
            if (
                isinstance(e, MentionEntity)
                and e.uid
                and isinstance(e.offset, int)
                and isinstance(e.length, int)
                and e.offset >= 0
                and e.length > 0
                and e.offset + e.length <= len(content)
            )
        ]

        if valid_entities:
            sorted_entities = sorted(valid_entities, key=lambda e: e.offset, reverse=True)
            result = content
            for entity in sorted_entities:
                original = result[entity.offset : entity.offset + entity.length]
                if not original.startswith("@"):
                    continue
                name = original[1:]
                replacement = f"@[{entity.uid}:{name}]"
                result = result[: entity.offset] + replacement + result[entity.offset + entity.length :]
            return result

    # Fallback (v1): member_map lookup or uids positional pairing
    has_member_map = member_map and len(member_map) > 0
    has_uids = mention.uids and len(mention.uids) > 0

    if has_member_map or has_uids:
        result = content
        uid_index = 0
        replacements: list[tuple[int, int, str]] = []  # (start, end, replacement)

        # Sort member names by length descending for longest-match-first
        sorted_names = sorted(member_map.keys(), key=len, reverse=True) if has_member_map else []

        for match in MENTION_PATTERN.finditer(content):
            name = match.group(1)
            uid: Optional[str] = None
            matched_name = name

            if has_member_map and member_map:
                # Try longest prefix match (supports names with spaces)
                longer = _try_longest_member_match(content, match.start(), member_map, sorted_names)
                if longer:
                    uid = longer["uid"]
                    matched_name = longer["name"]
                else:
                    uid = member_map.get(name)
            elif has_uids and mention.uids and uid_index < len(mention.uids):
                candidate = mention.uids[uid_index]
                uid = candidate if isinstance(candidate, str) else None
                uid_index += 1

            if uid:
                replacements.append((
                    match.start(),
                    match.start() + 1 + len(matched_name),
                    f"@[{uid}:{matched_name}]",
                ))

        # Apply replacements from back to front
        for start, end, replacement in reversed(replacements):
            result = result[:start] + replacement + result[end:]

        return result

    return content


# ─── Build Entities from Plain @name ─────────────────────────────────────────


def build_entities_from_fallback(
    content: str,
    member_map: dict[str, str],
) -> tuple[list[MentionEntity], list[str]]:
    """
    Build mention entities from plain @name text using member_map (displayName → uid).

    This is the fallback path when structured @[uid:name] is not available.
    Uses longest-match-first to handle names with special characters.

    Returns:
        (entities, uids) — lists of MentionEntity and corresponding UIDs.
    """
    entities: list[MentionEntity] = []
    uids: list[str] = []

    sorted_names = sorted(member_map.keys(), key=len, reverse=True)

    for match in MENTION_PATTERN.finditer(content):
        name = match.group(1)

        # Skip @all / @All
        if name.lower() == "all" or name == "所有人":
            continue

        uid: Optional[str] = None
        matched_name = name

        # Try longest prefix match first
        longer = _try_longest_member_match(content, match.start(), member_map, sorted_names)
        if longer:
            uid = longer["uid"]
            matched_name = longer["name"]
        else:
            uid = member_map.get(name)

        if not uid:
            continue

        at_name = f"@{matched_name}"
        entities.append(MentionEntity(uid=uid, offset=match.start(), length=len(at_name)))
        uids.append(uid)

    return entities, uids


# ─── Internal Helpers ────────────────────────────────────────────────────────

# Name character class — mirrors MENTION_PATTERN's inner char set
_NAME_CHAR_RE = re.compile(r"[\w\u00C0-\u024F\u4e00-\u9fff\u3040-\u30FF\uAC00-\uD7AF.\-]")


def _try_longest_member_match(
    text: str,
    at_pos: int,
    member_map: dict[str, str],
    sorted_names: list[str],
) -> Optional[dict[str, str]]:
    """
    From @at_pos, try to match the longest name in member_map.
    sorted_names must be sorted by length descending.

    Boundary check: character after matched name must be a terminator
    (non-name character), preventing partial matches.
    """
    after = text[at_pos + 1 :]  # text after @
    for candidate in sorted_names:
        if after.startswith(candidate):
            # Check boundary
            next_char_pos = at_pos + 1 + len(candidate)
            if next_char_pos >= len(text) or not _NAME_CHAR_RE.match(text[next_char_pos]):
                uid = member_map.get(candidate)
                if uid:
                    return {"name": candidate, "uid": uid}
    return None
