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

        // Resolve account
        const accountId =
          requestedAccountId ?? resolveDefaultDmworkAccountId(cfg);
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
