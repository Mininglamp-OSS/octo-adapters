import { describe, expect, it } from 'vitest';
import { prepareBotBinding } from './bind-config.js';

describe('Bot binding with MCP migration', () => {
  it.each(['empty token', 'missing Agent', 'denied policy'])('keeps unrelated %s from blocking a target binding', scenario => {
    const other: any = { botToken: 'bf_other' };
    const otherAgent: any = { tools: { allow: ['read'] } };
    const cfg: any = {
      channels: { octo: { accounts: { other } } },
      agents: { entries: { target: {}, unrelated: otherAgent } },
      bindings: [{ agentId: 'unrelated', match: { channel: 'octo', accountId: 'other' } }],
      mcp: { servers: { 'octo-mcp': { url: 'https://mcp.test/', transport: 'streamable-http' } } },
    };
    if (scenario === 'empty token') other.botToken = '';
    if (scenario === 'missing Agent') delete cfg.agents.entries.unrelated;
    if (scenario === 'denied policy') otherAgent.tools.deny = ['bundle-mcp'];
    const result = prepareBotBinding(cfg, { accountId: 'new_bot', agent: 'target', botToken: 'bf_target', apiUrl: 'https://api.test/' });
    expect(result.channels.octo.accounts.new_bot.botToken).toBe('bf_target');
    expect(result.channels.octo.accounts.other).toEqual(other);
    expect(result.agents.entries.unrelated).toEqual(cfg.agents.entries.unrelated);
    expect(result.bindings).toHaveLength(2);
  });
  it('preserves existing WS/settings and unrelated bindings while refreshing credentials', () => {
    const cfg = { channels: { octo: { accounts: { Bot_A: {
      botToken: 'bf_old', wsUrl: 'ws://localhost/ws', docTasks: false,
    } } } }, bindings: [{ agentId: 'old', match: { channel: 'octo', accountId: 'Bot_A' } }],
    agents: { entries: { alice: {} } } };
    const result = prepareBotBinding(cfg, {
      accountId: 'bot_a', agent: 'alice', apiUrl: 'https://api.test/', botToken: 'bf_new', mcpUrl: 'https://mcp.test/',
    });
    expect(result.channels.octo.accounts.Bot_A).toEqual({ botToken: 'bf_new', apiUrl: 'https://api.test/', wsUrl: 'ws://localhost/ws', docTasks: false });
    expect(Object.keys(result.channels.octo.accounts)).toEqual(['Bot_A']);
    expect(result.bindings).toEqual([{ agentId: 'alice', match: { channel: 'octo', accountId: 'Bot_A' } }]);
    expect(result.mcp.servers['octo-mcp'].transport).toBe('streamable-http');
    expect(cfg.channels.octo.accounts.Bot_A.botToken).toBe('bf_old');
  });
  it('clears a previous Bot name when rotating identity but retains it for the same token', () => {
    const cfg = { channels: { octo: { accounts: { bot: { botToken: 'bf_old', name: 'Old Bot', wsUrl: 'ws://localhost/ws' } } } } };
    const opts = { accountId: 'bot', agent: 'main', apiUrl: 'https://api.test/', botToken: 'bf_new' };
    expect(prepareBotBinding(cfg, opts).channels.octo.accounts.bot.name).toBeUndefined();
    expect(prepareBotBinding(cfg, { ...opts, botToken: 'bf_old' }).channels.octo.accounts.bot.name).toBe('Old Bot');
  });
  it('automatically configures the newly bound Agent using the existing MCP service', () => {
    const cfg = { mcp: { servers: { 'octo-business': { url: 'https://mcp.test/', transport: 'streamable-http' } } }, agents: { entries: { next: {} } } };
    const result = prepareBotBinding(cfg, { accountId: 'bot_new', agent: 'next', botToken: 'bf_new', apiUrl: 'https://api.test/' });
    expect(result.agents.entries.next.tools.alsoAllow).toBeUndefined();
    expect(result.channels.octo.accounts.bot_new.botToken).toBe('bf_new');
  });
  it('rejects ambiguous case aliases before any registration or configuration mutation', () => {
    const cfg = { channels: { octo: { accounts: { Bot_A: {}, bot_a: {} } } } };
    expect(() => prepareBotBinding(cfg, { accountId: 'bot_a', agent: 'next', botToken: 'bf_new', apiUrl: 'https://api.test/' })).toThrow(/ambiguous/i);
  });
});
