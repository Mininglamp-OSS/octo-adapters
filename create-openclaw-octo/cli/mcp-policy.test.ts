import { describe, expect, it } from 'vitest';
import { filterMcpCatalog, assertProviderMcpPolicy } from './mcp-policy.js';
const tools = ['get_skill', 'execute'];
describe('host-side MCP restrictions', () => {
  it.each([false, true])('refuses ambiguous aliases instead of guessing provider policy (reverse=%s)', reverse => {
    const entries: [string, any][] = [['openai/allowed', { alias: 'current' }], ['anthropic/blocked', { alias: 'current' }]];
    const cfg: any = { agents: { entries: { alice: {} } }, channels: { octo: { accounts: { bot: { botToken: 'bf_fixture' } } } }, bindings: [{ agentId: 'alice', match: { channel: 'octo', accountId: 'bot' } }] };
    cfg.agents.entries.alice.model = 'current';
    cfg.agents.entries.alice.models = Object.fromEntries(reverse ? entries.reverse() : entries);
    cfg.tools = { byProvider: { anthropic: { deny: ['bundle-mcp'] } } };
    expect(() => assertProviderMcpPolicy(cfg, ['get_skill', 'execute'])).toThrow(/statically resolve/i);
  });
  it('applies server includes and excludes to raw discovered names', () => {
    expect(filterMcpCatalog(tools, { exclude: ['execute'] })).toEqual(['get_skill']);
    expect(filterMcpCatalog(tools, { include: ['get_*'] })).toEqual(['get_skill']);
    expect(filterMcpCatalog(tools, { include: [' ', ''] })).toEqual(tools);
  });
  it.each(['coding', 'messaging', 'minimal'])('respects provider %s profile with an explicit MCP allow', profile => {
    const cfg: any = { tools: { byProvider: { openai: {profile, allow:['bundle-mcp']} } }, agents:{entries:{alice:{model:'openai/model'}}}, channels:{octo:{accounts:{bot:{botToken:'bf_fixture'}}}}, bindings:[{agentId:'alice',match:{channel:'octo',accountId:'bot'}}] };
    if (profile === 'minimal') expect(() => assertProviderMcpPolicy(cfg, tools)).toThrow(/provider/);
    else expect(() => assertProviderMcpPolicy(cfg, tools)).not.toThrow();
  });
  it('checks the active provider, including Agent-level policy', () => {
    const cfg: any = { tools: { byProvider: { anthropic: { deny: ['octo-mcp__execute'] } } },
      agents: { entries: { alice: { model: 'anthropic/model' } } },
      channels: { octo: { accounts: { bot: { botToken: 'bf_fixture' } } } },
      bindings: [{ agentId: 'alice', match: { channel: 'octo', accountId: 'bot' } }] };
    expect(() => assertProviderMcpPolicy(cfg, tools)).toThrow(/provider/i);
    cfg.agents.entries.alice.model = 'openai/model';
    expect(() => assertProviderMcpPolicy(cfg, tools)).not.toThrow();
    cfg.agents.entries.alice.tools = { byProvider: { openai: { deny: ['octo-mcp__execute'] } } };
    expect(() => assertProviderMcpPolicy(cfg, tools)).toThrow(/provider/i);
  });
  it('resolves local aliases and uniquely configured bare model names before checking provider policies', () => {
    const cfg: any = { tools: { byProvider: { openai: { deny: ['bundle-mcp'] } } },
      agents: { entries: { alice: { model: 'local', models: { 'openai/custom': { alias: 'local' } } } } },
      channels: { octo: { accounts: { bot: { botToken: 'bf_fixture' } } } },
      bindings: [{ agentId: 'alice', match: { channel: 'octo', accountId: 'bot' } }] };
    expect(() => assertProviderMcpPolicy(cfg, tools)).toThrow(/provider/i);
    cfg.agents.entries.alice.model = 'custom';
    expect(() => assertProviderMcpPolicy(cfg, tools)).toThrow(/provider/i);
    cfg.agents.entries.alice.models = {};
    cfg.models = { providers: { openai: { models: [{ id: 'custom' }] } } };
    expect(() => assertProviderMcpPolicy(cfg, tools)).toThrow(/provider/i);
  });
  it('prefers Agent-local aliases and does not inherit default fallbacks for an owned primary', () => {
    const cfg: any = { tools: { byProvider: { anthropic: { deny: ['bundle-mcp'] } } },
      agents: { defaults: { model: { primary: 'openai/allowed', fallbacks: ['anthropic/blocked'] }, models: { 'openai/allowed': { alias: 'current' } } },
        entries: { alice: { model: 'current', models: { 'anthropic/blocked': { alias: 'current' } } } } },
      channels: { octo: { accounts: { bot: { botToken: 'bf_fixture' } } } },
      bindings: [{ agentId: 'alice', match: { channel: 'octo', accountId: 'bot' } }] };
    expect(() => assertProviderMcpPolicy(cfg, tools)).toThrow(/provider/i);
    cfg.agents.entries.alice.model = 'openai/allowed';
    expect(() => assertProviderMcpPolicy(cfg, tools)).not.toThrow();
  });
  it('honors fallback-only overrides and inherited aliases on local parameter entries', () => {
    const cfg: any = { tools: { byProvider: { anthropic: { deny: ['bundle-mcp'] } } },
      agents: { defaults: { model: { primary: 'openai/allowed' }, models: { 'openai/allowed': { alias: 'current' } } },
        entries: { alice: { model: { fallbacks: ['anthropic/blocked'] } } } },
      channels: { octo: { accounts: { bot: { botToken: 'bf_fixture' } } } },
      bindings: [{ agentId: 'alice', match: { channel: 'octo', accountId: 'bot' } }] };
    expect(() => assertProviderMcpPolicy(cfg, tools)).toThrow(/provider/i);
    cfg.agents.entries.alice.model = { fallbacks: [] };
    expect(() => assertProviderMcpPolicy(cfg, tools)).not.toThrow();
    cfg.agents.entries.alice.model = 'current';
    cfg.agents.entries.alice.models = { 'openai/allowed': { params: { temperature: 0.2 } } };
    expect(() => assertProviderMcpPolicy(cfg, tools)).not.toThrow();
  });
  it('does not guess a host-version-dependent default when provider policy exists', () => {
    const cfg: any = { tools: { byProvider: { openai: { deny: ['bundle-mcp'] } } },
      agents: { entries: { alice: {} } },
      channels: { octo: { accounts: { bot: { botToken: 'bf_fixture' } } } },
      bindings: [{ agentId: 'alice', match: { channel: 'octo', accountId: 'bot' } }] };
    expect(() => assertProviderMcpPolicy(cfg, tools)).toThrow(/explicit.*model/i);
  });
  it('prefers model-specific policy and checks explicitly configured fallbacks', () => {
    const cfg: any = { tools: { byProvider: { anthropic: { deny: ['bundle-mcp'] }, 'anthropic/allowed': { allow: ['bundle-mcp'] } } },
      agents: { entries: { alice: { model: { primary: 'anthropic/allowed', fallbacks: ['anthropic/blocked'] } } } },
      channels: { octo: { accounts: { bot: { botToken: 'bf_fixture' } } } },
      bindings: [{ agentId: 'alice', match: { channel: 'octo', accountId: 'bot' } }] };
    expect(() => assertProviderMcpPolicy(cfg, tools)).toThrow(/provider/i);
    cfg.agents.entries.alice.model.fallbacks = [];
    expect(() => assertProviderMcpPolicy(cfg, tools)).not.toThrow();
  });
});

describe('provider catalog and bundle wildcard readiness', () => {
  const config = () => ({ tools: { byProvider: { openai: { allow: ['read', 'bundle-*'] } } },
    agents: { entries: { alice: { model: 'openai/fixture' } } },
    channels: { octo: { accounts: { bot: { botToken: 'bf_fixture' } } } },
    bindings: [{ agentId: 'alice', match: { channel: 'octo', accountId: 'bot' } }] });
  it('does not expand a plugin ID glob as an allow grant', () => {
    const cfg = config();
    expect(() => assertProviderMcpPolicy(cfg, tools)).toThrow(/provider/i);
    cfg.tools.byProvider.openai.allow = ['read', 'bundle-mcp'];
    expect(() => assertProviderMcpPolicy(cfg, tools)).not.toThrow();
    cfg.tools.byProvider.openai.allow = ['octo-mcp__*'];
    expect(() => assertProviderMcpPolicy(cfg, tools)).not.toThrow();
  });
  it.each([{}, 'invalid', 1])('rejects malformed provider model catalogs with actionable diagnostics: %j', models => {
    const cfg: any = config(); cfg.agents.entries.alice.model = 'fixture';
    cfg.models = { providers: { openai: { models } } };
    expect(() => assertProviderMcpPolicy(cfg, tools)).toThrow(/statically resolve/i);
  });
});
