/**
 * DMWork Management agent tool.
 *
 * Registered via `agentTools` on the channel plugin, this tool gives the LLM
 * direct access to DMWork group management operations without going through
 * the `message` tool action routing (which only supports a fixed whitelist of
 * action names in OpenClaw core).
 *
 * Operations: list-groups, group-info, group-members, group-md-read, group-md-update
 */

import {
  listDmworkAccountIds,
  resolveDmworkAccount,
  resolveDefaultDmworkAccountId,
} from "./accounts.js";
import {
  fetchBotGroups,
  getGroupInfo,
  getGroupMembers,
  getGroupMd,
  updateGroupMd,
  createGroup,
  updateGroup,
  addGroupMembers,
  removeGroupMembers,
  searchSpaceMembers,
  createThread,
  listThreads,
  getThread,
  deleteThread,
  listThreadMembers,
  joinThread,
  leaveThread,
} from "./api-fetch.js";
import { broadcastGroupMdUpdate } from "./group-md.js";

import type { OpenClawConfig } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
}

type LogSink = {
  info?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createDmworkManagementTools(params: {
  cfg?: OpenClawConfig;
}): any[] {
  const cfg = params.cfg;
  if (!cfg) return [];

  // Check if any account is configured
  try {
    const ids = listDmworkAccountIds(cfg);
    const hasConfigured = ids.some((id) => {
      const acct = resolveDmworkAccount({ cfg, accountId: id });
      return acct.enabled && acct.configured && !!acct.config.botToken;
    });
    if (!hasConfigured) return [];
  } catch {
    return [];
  }

  return [
    {
      name: "dmwork_management",
      label: "DMWork Management",
      description:
        "Manage DMWork groups: list groups the bot belongs to, get group info/members, read or update GROUP.md (group rules/context). " +
        "Use this tool for any DMWork group management operations.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "list-groups",
              "group-info",
              "group-members",
              "group-md-read",
              "group-md-update",
              "search-members",
              "create-group",
              "update-group",
              "add-members",
              "remove-members",
              "create-thread",
              "list-threads",
              "get-thread",
              "delete-thread",
              "list-thread-members",
              "join-thread",
              "leave-thread",
            ],
            description:
              "The management action to perform.",
          },
          groupId: {
            type: "string",
            description:
              "The group_no (group ID). Required for all actions except list-groups.",
          },
          content: {
            type: "string",
            description:
              "The new GROUP.md content. Required for group-md-update.",
          },
          keyword: {
            type: "string",
            description:
              "Search keyword for search-members action. Fuzzy matches user names in the bot's Space.",
          },
          members: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of member UIDs. Required for create-group, add-members, remove-members.",
          },
          name: {
            type: "string",
            description:
              "Group name. Optional for create-group, update-group.",
          },
          notice: {
            type: "string",
            description:
              "Group notice/announcement. Optional for update-group.",
          },
          creator: {
            type: "string",
            description:
              "UID of the user who requested group creation (becomes group owner). Required for create-group.",
          },
          threadName: {
            type: "string",
            description:
              "Thread name. Required for create-thread.",
          },
          shortId: {
            type: "string",
            description:
              "Thread short ID. Required for get-thread, delete-thread, list-thread-members, join-thread, leave-thread.",
          },
          accountId: {
            type: "string",
            description:
              "DMWork account ID (optional, defaults to the primary configured account).",
          },
        },
        required: ["action"],
      },

      execute: async (
        _toolCallId: string,
        args: Record<string, unknown>,
      ): Promise<ToolResult> => {
        const action = args.action as string;
        const groupId = (args.groupId ?? args.group_id ?? args.target) as
          | string
          | undefined;
        const content = (args.content ?? args.message) as string | undefined;
        const requestedAccountId = args.accountId as string | undefined;

        // Resolve account — multi-bot setups require explicit accountId
        const defaultAccountId = resolveDefaultDmworkAccountId(cfg);
        const accountId = requestedAccountId ?? defaultAccountId;

        if (!accountId) {
          return makeError(
            "accountId is required. Check your agent.md for your assigned accountId."
          );
        }

        const account = resolveDmworkAccount({ cfg, accountId });

        if (!account.config.botToken) {
          return makeError("DMWork botToken is not configured for this account");
        }

        const apiUrl = account.config.apiUrl;
        const botToken = account.config.botToken;

        try {
          switch (action) {
            case "list-groups":
              return await handleListGroups({ apiUrl, botToken });

            case "group-info":
              if (!groupId)
                return makeError("groupId is required for group-info");
              return await handleGroupInfo({ apiUrl, botToken, groupId });

            case "group-members":
              if (!groupId)
                return makeError("groupId is required for group-members");
              return await handleGroupMembers({ apiUrl, botToken, groupId });

            case "group-md-read":
              if (!groupId)
                return makeError("groupId is required for group-md-read");
              return await handleGroupMdRead({ apiUrl, botToken, groupId });

            case "group-md-update":
              if (!groupId)
                return makeError("groupId is required for group-md-update");
              if (!content)
                return makeError("content is required for group-md-update");
              return await handleGroupMdUpdate({
                apiUrl,
                botToken,
                groupId,
                content,
                accountId,
              });

            case "search-members": {
              const keyword = (args.keyword ?? args.name ?? args.content) as string | undefined;
              const results = await searchSpaceMembers({
                apiUrl,
                botToken,
                keyword: keyword || undefined,
              });
              return makeSuccess({ members: results });
            }

            case "create-group": {
              const members = args.members as string[] | undefined;
              if (!members?.length)
                return makeError("members is required for create-group");
              const creatorUid = (args.creator ?? args.creatorUid) as string | undefined;
              if (!creatorUid)
                return makeError("creator is required for create-group");
              const result = await createGroup({
                apiUrl,
                botToken,
                name: (args.name as string | undefined) ?? undefined,
                members,
                creator: creatorUid,
              });
              return makeSuccess(result);
            }

            case "update-group": {
              if (!groupId)
                return makeError("groupId is required for update-group");
              await updateGroup({
                apiUrl,
                botToken,
                groupNo: groupId,
                name: args.name as string | undefined,
                notice: args.notice as string | undefined,
              });
              return makeSuccess({ updated: true, groupId });
            }

            case "add-members": {
              if (!groupId)
                return makeError("groupId is required for add-members");
              const members = args.members as string[] | undefined;
              if (!members?.length)
                return makeError("members is required for add-members");
              const result = await addGroupMembers({
                apiUrl,
                botToken,
                groupNo: groupId,
                members,
              });
              return makeSuccess(result);
            }

            case "remove-members": {
              if (!groupId)
                return makeError("groupId is required for remove-members");
              const members = args.members as string[] | undefined;
              if (!members?.length)
                return makeError("members is required for remove-members");
              const result = await removeGroupMembers({
                apiUrl,
                botToken,
                groupNo: groupId,
                members,
              });
              return makeSuccess(result);
            }

            // ========== Thread Actions ==========

            case "create-thread": {
              if (!groupId)
                return makeError("groupId is required for create-thread");
              const threadName = (args.threadName ?? args.name) as string | undefined;
              if (!threadName)
                return makeError("threadName is required for create-thread");
              const result = await createThread({
                apiUrl,
                botToken,
                groupNo: groupId,
                name: threadName,
              });
              return makeSuccess(result);
            }

            case "list-threads": {
              if (!groupId)
                return makeError("groupId is required for list-threads");
              const threads = await listThreads({ apiUrl, botToken, groupNo: groupId });
              return makeSuccess({ threads });
            }

            case "get-thread": {
              if (!groupId)
                return makeError("groupId is required for get-thread");
              const shortId = args.shortId as string | undefined;
              if (!shortId)
                return makeError("shortId is required for get-thread");
              const thread = await getThread({ apiUrl, botToken, groupNo: groupId, shortId });
              return makeSuccess(thread);
            }

            case "delete-thread": {
              if (!groupId)
                return makeError("groupId is required for delete-thread");
              const shortId = args.shortId as string | undefined;
              if (!shortId)
                return makeError("shortId is required for delete-thread");
              await deleteThread({ apiUrl, botToken, groupNo: groupId, shortId });
              return makeSuccess({ deleted: true, groupId, shortId });
            }

            case "list-thread-members": {
              if (!groupId)
                return makeError("groupId is required for list-thread-members");
              const shortId = args.shortId as string | undefined;
              if (!shortId)
                return makeError("shortId is required for list-thread-members");
              const members = await listThreadMembers({ apiUrl, botToken, groupNo: groupId, shortId });
              return makeSuccess({ members });
            }

            case "join-thread": {
              if (!groupId)
                return makeError("groupId is required for join-thread");
              const shortId = args.shortId as string | undefined;
              if (!shortId)
                return makeError("shortId is required for join-thread");
              await joinThread({ apiUrl, botToken, groupNo: groupId, shortId });
              return makeSuccess({ joined: true, groupId, shortId });
            }

            case "leave-thread": {
              if (!groupId)
                return makeError("groupId is required for leave-thread");
              const shortId = args.shortId as string | undefined;
              if (!shortId)
                return makeError("shortId is required for leave-thread");
              await leaveThread({ apiUrl, botToken, groupNo: groupId, shortId });
              return makeSuccess({ left: true, groupId, shortId });
            }

            default:
              return makeError(`Unknown action: ${action}`);
          }
        } catch (err) {
          return makeError(
            `${action} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleListGroups(params: {
  apiUrl: string;
  botToken: string;
}): Promise<ToolResult> {
  const groups = await fetchBotGroups({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
  });
  return makeSuccess({ groups });
}

async function handleGroupInfo(params: {
  apiUrl: string;
  botToken: string;
  groupId: string;
}): Promise<ToolResult> {
  const info = await getGroupInfo({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    groupNo: params.groupId,
  });
  return makeSuccess(info);
}

async function handleGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupId: string;
}): Promise<ToolResult> {
  const members = await getGroupMembers({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    groupNo: params.groupId,
  });
  return makeSuccess({ members });
}

async function handleGroupMdRead(params: {
  apiUrl: string;
  botToken: string;
  groupId: string;
}): Promise<ToolResult> {
  const md = await getGroupMd({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    groupNo: params.groupId,
  });
  return makeSuccess(md);
}

async function handleGroupMdUpdate(params: {
  apiUrl: string;
  botToken: string;
  groupId: string;
  content: string;
  accountId: string;
}): Promise<ToolResult> {
  const result = await updateGroupMd({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    groupNo: params.groupId,
    content: params.content,
  });

  // Update disk cache for all agents that have this group
  broadcastGroupMdUpdate({
    accountId: params.accountId,
    groupNo: params.groupId,
    content: params.content,
    version: result.version,
  });

  return makeSuccess({ updated: true, version: result.version });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSuccess(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function makeError(error: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error }, null, 2) }],
    details: { error },
  };
}
