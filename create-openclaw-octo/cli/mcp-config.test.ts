import { describe, expect, it } from 'vitest';
import { assertMcpGlobalToolPolicy, configureOctoMcp, resolveMcpUrlOption } from './mcp-config.js';

const config = () => ({
  channels: { octo: { accounts: { bot_a: { botToken: 'bf_a', wsUrl: 'ws://localhost/ws' }, bot_b: { botToken: 'bf_b' } } } },
  agents: { entries: { alice: { tools: { allow: ['read'] } }, bob: {}, other: {} } },
  bindings: [
    { agentId: 'alice', match: { channel: 'octo', accountId: 'bot_a' } },
    { agentId: 'bob', match: { channel: 'octo', accountId: 'bot_b' } },
  ],
  mcp: { servers: { other: { transport: 'stdio', command: 'other' } } },
});
describe('existing and new Bot MCP configuration', () => {
  it('automatically migrates to the bundled deployment endpoint without any user flags', () => {
    const result = configureOctoMcp(config(), undefined, 'https://deployment.test/');
    expect(result.enabled).toBe(true);
    expect(result.config.mcp.servers['octo-mcp']).toBeUndefined();
    expect(result.config.agents.entries.alice.tools.allow).toContain('bundle-mcp');
    expect(result.config.agents.entries.alice.tools.alsoAllow).toBeUndefined();
    const next = configureOctoMcp(result.config, undefined, 'https://new-default.test/');
    expect(next.changed).toBe(false);
    expect(next.config.mcp.servers['octo-mcp']).toBeUndefined();
  });
  it('resolves explicit flag before environment, ignoring an empty environment value', () => {
    expect(resolveMcpUrlOption('https://flag.test/', { OCTO_MCP_URL: 'https://env.test/' })).toBe('https://flag.test/');
    expect(resolveMcpUrlOption(undefined, { OCTO_MCP_URL: ' https://env.test/ ' })).toBe('https://env.test/');
    expect(resolveMcpUrlOption(undefined, { OCTO_MCP_URL: ' ' })).toBeUndefined();
  });
  it('preserves all identities, bindings and other services, scopes tool permission to bound Agents', () => {
    const cfg = config(); const before = structuredClone(cfg);
    const result = configureOctoMcp(cfg, 'https://mcp.example.test/');
    expect(result.config.channels).toEqual(before.channels);
    expect(result.config.bindings).toEqual(before.bindings);
    expect(result.config.mcp.servers.other).toEqual(before.mcp.servers.other);
    expect(result.config.mcp.servers['octo-mcp']).toEqual({ enabled: true, transport: 'streamable-http', url: 'https://mcp.example.test/' });
    expect(result.config.agents.entries.alice.tools.allow).toEqual(['read', 'bundle-mcp']);
    expect(result.config.agents.entries.alice.tools.alsoAllow).toBeUndefined();
    expect(result.config.agents.entries.other).toEqual({});
    expect(cfg).toEqual(before);
    expect(JSON.stringify(result.config.mcp)).not.toContain('bf_');
  });
  it('is idempotent and reuses the deployed endpoint for later bindings', () => {
    const first = configureOctoMcp(config(), 'https://mcp.example.test/');
    const second = configureOctoMcp(first.config);
    expect(second.config).toEqual(first.config); expect(second.changed).toBe(false);
    first.config.channels.octo.accounts.bot_c = { botToken: 'bf_c' };
    first.config.agents.entries.charlie = {};
    first.config.bindings.push({ agentId: 'charlie', match: { channel: 'octo', accountId: 'bot_c' } });
    expect(configureOctoMcp(first.config).config.agents.entries.charlie.tools.alsoAllow).toBeUndefined();
  });
  it('supports legacy array rosters and the explicit default account', () => {
    const cfg: any = config(); cfg.agents = { list: [{ id: 'alice' }] };
    cfg.channels.octo = { botToken: 'bf_legacy' };
    cfg.bindings = [{ agentId: 'alice', match: { channel: 'octo', accountId: 'default' } }];
    expect(configureOctoMcp(cfg, 'http://127.0.0.1:29861/').config.agents.list[0].tools.alsoAllow).toBeUndefined();
  });
  it('supports only the implicit main Agent when no roster is configured', () => {
    const cfg: any = config(); delete cfg.agents; cfg.bindings.forEach((b: any) => b.agentId = 'main');
    const result = configureOctoMcp(cfg, undefined, 'https://deployment.test/');
    expect(result.config.agents.entries).toEqual({ main: { tools: {} } });
    expect(result.config.agents.defaults).toBeUndefined();
    expect(configureOctoMcp(result.config, undefined, 'https://deployment.test/').changed).toBe(false);
    expect(result.config.agents.list).toBeUndefined();
    cfg.bindings[0].agentId = 'missing';
    expect(() => configureOctoMcp(cfg, 'https://mcp.test/')).toThrow(/Agent/i);
    cfg.bindings[0].agentId = 'main'; cfg.agents = { list: [] };
    expect(() => configureOctoMcp(cfg, 'https://mcp.test/')).toThrow(/Agent/i);
  });
  it('preserves implicit main defaults when materializing the Agent roster', () => {
    const cfg: any = config(); cfg.agents = { defaults: { model: 'deepseek/fixture', workspace: '/tmp/fixture' } };
    cfg.bindings.forEach((b: any) => b.agentId = 'main');
    const result = configureOctoMcp(cfg, 'https://mcp.test/');
    expect(result.config.agents.defaults).toEqual(cfg.agents.defaults);
    expect(result.config.agents.entries).toEqual({ main: { tools: {} } });
    expect(result.config.bindings).toEqual(cfg.bindings);
  });
  it.each(['bundle-*', 'bundle-m*'])('rejects ineffective global bundle glob %s while retaining tool globs', pattern => {
    const cfg: any = config(); cfg.tools = { allow: ['read', pattern] };
    expect(() => configureOctoMcp(cfg, 'https://mcp.test/')).toThrow(/global.*allow/i);
    cfg.tools.allow = ['read', 'octo-mcp__*'];
    expect(configureOctoMcp(cfg, 'https://mcp.test/').enabled).toBe(true);
  });
  it('reports stale bindings without blocking healthy Bots, but refuses ambiguous accounts', () => {
    const cfg: any = config(); cfg.bindings.push({ agentId: 'removed', match: { channel: 'octo', accountId: 'deleted' } });
    const result = configureOctoMcp(cfg, 'https://mcp.test/');
    expect(result.warnings).toContainEqual(expect.stringMatching(/stale binding/i));
    expect(result.warnings).toContainEqual(expect.stringMatching(/alice.*bundle-mcp.*other host MCP/i));
    expect(result.agentIds).toEqual(['alice', 'bob']);
    expect(result.config.bindings).toEqual(cfg.bindings);
    cfg.channels.octo.accounts.BOT_A = { botToken: 'bf_other' };
    expect(() => configureOctoMcp(cfg, 'https://mcp.test/')).toThrow(/ambiguous/i);
  });
  it('keeps legacy installations unchanged when the operator has not supplied a service', () => {
    const cfg = config(); expect(configureOctoMcp(cfg)).toEqual({ config: cfg, changed: false, enabled: false, agentIds: [] });
  });
  it.each(['http://remote.test/', 'https://user:password@mcp.test/', 'https://mcp.test/?token=abc', 'file:///tmp/mcp'])
    ('rejects unsafe endpoints before changing configuration: %s', (url) => {
      expect(() => configureOctoMcp(config(), url)).toThrow(/MCP/);
    });
  it('refuses existing static credentials and endpoint replacement without an explicit operator change', () => {
    const cfg: any = configureOctoMcp(config(), 'https://mcp.test/').config;
    cfg.mcp.servers['octo-mcp'].headers = { Authorization: 'Bearer wrong' };
    expect(() => configureOctoMcp(cfg)).toThrow(/static/i);
  });
  it.each([{ clientCert: '/fixture/cert.pem' }, { clientKey: '/fixture/key.pem' }, { sslVerify: false }])('rejects static TLS identities and disabled verification: %j', patch => {
    const cfg: any = configureOctoMcp(config(), 'https://mcp.test/').config;
    Object.assign(cfg.mcp.servers['octo-mcp'], patch);
    expect(() => configureOctoMcp(cfg)).toThrow(/static|TLS/i);
  });
  it('refuses absent accounts, missing Agent bindings and explicit tool denial', () => {
    const cfg: any = config(); cfg.bindings[0].match.accountId = 'missing';
    expect(configureOctoMcp(cfg, 'https://mcp.test/').warnings).toHaveLength(1);
    const noAgent: any = config(); delete noAgent.agents.entries.alice;
    expect(() => configureOctoMcp(noAgent, 'https://mcp.test/')).toThrow(/agent/i);
    const denied: any = config(); denied.agents.entries.alice.tools.deny = ['bundle-mcp'];
    expect(() => configureOctoMcp(denied, 'https://mcp.test/')).toThrow(/den/i);
  });
  it.each(['bundle-*', 'BUNDLE-M*', 'group:plugins', 'OCTO-BUSINESS__*', '*'])('respects host MCP namespace denial %s', (pattern) => {
    const cfg: any = config(); cfg.agents.entries.alice.tools.deny = [pattern];
    expect(() => configureOctoMcp(cfg, 'https://mcp.test/')).toThrow(/den/i);
  });
  it('does not report migration success when a global allow list filters out MCP', () => {
    const cfg: any = config(); cfg.tools = { allow: ['read', 'exec'] };
    expect(() => configureOctoMcp(cfg, 'https://mcp.test/')).toThrow(/global.*allow/i);
    cfg.tools.allow.push('bundle-mcp');
    expect(configureOctoMcp(cfg, 'https://mcp.test/').enabled).toBe(true);
  });
  it('accepts an explicit global allow list for a complete business facade', () => {
    const cfg: any = config(); cfg.tools = { allow: ['read', 'octo-mcp__get_skill', 'octo-mcp__execute'] };
    expect(configureOctoMcp(cfg, 'https://mcp.test/').enabled).toBe(true);
    expect(() => assertMcpGlobalToolPolicy(cfg, ['get_skill', 'execute'])).not.toThrow();
    expect(() => assertMcpGlobalToolPolicy(cfg, ['search_ops', 'describe_op', 'call_op'])).toThrow(/global.*allow/i);
  });
  it('preserves inherited profile extras when adding an Agent additive allow list', () => {
    const cfg: any = config(); delete cfg.agents.entries.alice.tools.allow;
    cfg.tools = { profile: 'coding', alsoAllow: ['octo_send_card'] };
    const result = configureOctoMcp(cfg, 'https://mcp.test/');
    expect(result.config.agents.entries.bob.tools.alsoAllow).toBeUndefined();
    expect(result.config.agents.entries.alice.tools.alsoAllow).toBeUndefined();
    cfg.agents.entries.bob.tools = { alsoAllow: ['custom_tool'] };
    expect(configureOctoMcp(cfg, 'https://mcp.test/').config.agents.entries.bob.tools.alsoAllow)
      .toEqual(['custom_tool', 'bundle-mcp']);
  });
  it('keeps an empty unrestricted Agent allow list unrestricted', () => {
    const cfg: any = config(); cfg.agents.entries.alice.tools.allow = [];
    const result = configureOctoMcp(cfg, 'https://mcp.test/');
    expect(result.config.agents.entries.alice.tools.allow).toBeUndefined();
    expect(result.config.agents.entries.alice.tools.alsoAllow).toBeUndefined();
  });
  it.each(['coding', 'messaging'])('preserves MCP-capable %s profiles with an explicit Agent allow list', profile => {
    const cfg: any = config(); cfg.agents.entries.alice.tools.profile = profile;
    const result = configureOctoMcp(cfg, 'https://mcp.test/');
    expect(result.config.agents.entries.alice.tools.profile).toBe(profile);
    expect(result.config.agents.entries.alice.tools.allow).toContain('bundle-mcp');
  });
  it('does not widen a restrictive profile combined with an explicit Agent allow list', () => {
    const cfg: any = config(); cfg.agents.entries.alice.tools.profile = 'minimal';
    expect(() => configureOctoMcp(cfg, 'https://mcp.test/')).toThrow(/restrictive.*profile/i);
    cfg.tools = { alsoAllow: ['bundle-mcp'] };
    expect(configureOctoMcp(cfg, 'https://mcp.test/').enabled).toBe(true);
  });
  it('matches host-normalized Agent IDs without rewriting existing bindings', () => {
    const cfg: any = config(); cfg.agents.entries.Alice = cfg.agents.entries.alice; delete cfg.agents.entries.alice;
    const result = configureOctoMcp(cfg, 'https://mcp.test/');
    expect(result.config.agents.entries.Alice.tools.allow).toContain('bundle-mcp');
    expect(result.config.bindings[0].agentId).toBe('alice');
    cfg.agents.entries.alice = {};
    expect(() => configureOctoMcp(cfg, 'https://mcp.test/')).toThrow(/ambiguous/i);
  });
  it('accepts canonical routing aliases already supported by the host', () => {
    const cfg: any = config(); cfg.agents.entries['alice-smith'] = cfg.agents.entries.alice; delete cfg.agents.entries.alice;
    cfg.bindings[0].agentId = 'Alice Smith'; cfg.bindings[0].match.accountId = ' Bot_A ';
    const result = configureOctoMcp(cfg, 'https://mcp.test/');
    expect(result.config.agents.entries['alice-smith'].tools.allow).toContain('bundle-mcp');
    expect(result.config.bindings[0]).toEqual(cfg.bindings[0]);
  });
  it('retains a deliberately disabled service unless the operator supplies a URL', () => {
    const cfg: any = configureOctoMcp(config(), 'https://mcp.test/').config;
    cfg.mcp.servers['octo-mcp'].enabled = false;
    expect(configureOctoMcp(cfg).enabled).toBe(false);
    expect(configureOctoMcp(cfg, 'https://mcp.test/').enabled).toBe(true);
  });
});

describe('Octo MCP service name migration', () => {
  it('preserves group sender denials and legacy wildcard restrictions', () => {
    const cfg: any = config();
    cfg.channels.octo.groups = { room: { toolsBySender: { 'id:123': { deny: ['octo-business__execute'] },
      '*': { deny: ['*business*'] } } } };
    const result=configureOctoMcp(cfg,'https://mcp.test/');
    const senders=result.config.channels.octo.groups.room.toolsBySender;
    expect(senders['id:123'].deny).toEqual(['octo-mcp__execute']);
    expect(senders['*'].deny).toContain('octo-mcp__execute');
    expect(senders['*'].deny).toContain('octo-mcp__call_op');
    expect(cfg.channels.octo.groups.room.toolsBySender['id:123'].deny).toEqual(['octo-business__execute']);
  });
  it('moves the old service and scoped policies without changing identities or filters', () => {
    const cfg: any = config();
    cfg.mcp.servers['octo-business'] = { transport: 'streamable-http', url: 'https://old.test/', toolFilter: { include: ['execute','get_skill'] } };
    cfg.tools = { allow: ['read','octo-business__*'] };
    cfg.agents.entries.alice.tools = { allow: ['octo-business__execute','octo-business__get_skill'], byProvider: { deepseek: { alsoAllow: ['octo-business__*'] } } };
    const before = structuredClone(cfg);
    const result = configureOctoMcp(cfg);
    expect(result.config.mcp.servers['octo-business']).toBeUndefined();
    expect(result.config.mcp.servers['octo-mcp']).toMatchObject(before.mcp.servers['octo-business']);
    expect(result.config.tools.allow).toEqual(['read','octo-mcp__*']);
    expect(result.config.agents.entries.alice.tools.allow).toContain('octo-mcp__execute');
    expect(result.config.agents.entries.alice.tools.byProvider.deepseek.alsoAllow).toEqual(['octo-mcp__*']);
    expect(result.config.channels).toEqual(before.channels);expect(cfg).toEqual(before);
    expect(configureOctoMcp(result.config).changed).toBe(false);
  });
  it('preserves a disabled old service during rename', () => {
    const cfg: any = config();cfg.mcp.servers['octo-business'] = { enabled: false };
    const result=configureOctoMcp(cfg,undefined,'https://default.test/');
    expect(result.enabled).toBe(false);expect(result.changed).toBe(true);
    expect(result.config.mcp.servers['octo-mcp']).toEqual({enabled:false});
    expect(result.config.mcp.servers['octo-business']).toBeUndefined();
  });
  it('does not choose between two explicitly configured service identities', () => {
    const cfg: any=config();cfg.mcp.servers['octo-business']={url:'https://old.test/'};
    cfg.mcp.servers['octo-mcp']={url:'https://new.test/'};
    expect(()=>configureOctoMcp(cfg)).toThrow(/both|ambiguous|conflict/i);
  });
});
