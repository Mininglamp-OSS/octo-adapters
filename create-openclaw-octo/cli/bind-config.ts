import { configureOctoMcp, normalizeBindingId, resolveMcpUrlOption } from './mcp-config.js';
import { RECOMMENDED_DM_SCOPE, ensureChannelConfigObject } from './utils.js';
import type { BindOptions } from './bind.js';

export function prepareBotBinding(source: Record<string, any>, opts: BindOptions): Record<string, any> {
  const cfg = structuredClone(source);
  const channel = ensureChannelConfigObject(cfg);
  const matches = Object.keys(channel.accounts).filter(key => key.toLowerCase() === opts.accountId.toLowerCase());
  if (matches.length > 1) throw new Error('Cannot bind an ambiguous Bot account; resolve case-colliding account IDs first.');
  const accountId = matches[0] ?? opts.accountId;
  const previousToken = channel.accounts[accountId]?.botToken;
  channel.accounts[accountId] = {
    ...channel.accounts[accountId], botToken: opts.botToken, apiUrl: opts.apiUrl,
  };
  if (previousToken !== opts.botToken) delete channel.accounts[accountId].name;
  cfg.session ??= {};
  cfg.session.dmScope ??= RECOMMENDED_DM_SCOPE;
  cfg.bindings ??= [];
  const existing = cfg.bindings.filter((binding: any) => binding.match?.channel === 'octo'
    && normalizeBindingId(binding.match.accountId) === normalizeBindingId(accountId));
  if (existing.length > 1) throw new Error('Cannot bind an ambiguous Bot routing configuration.');
  if (existing.length) existing[0].agentId = opts.agent;
  else cfg.bindings.push({ agentId: opts.agent, match: { channel: 'octo', accountId } });
  const result = configureOctoMcp(cfg, resolveMcpUrlOption(opts.mcpUrl), undefined, accountId);
  for (const warning of result.warnings ?? []) console.warn(warning);
  return result.config;
}
