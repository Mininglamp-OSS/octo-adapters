import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./openclaw-cli.js', () => ({ getOpenClawVersion: vi.fn(() => '2026.9.8'), readConfigFromFile: vi.fn(), writeConfigAtomic: vi.fn(), gatewayStatus: vi.fn(() => ({running:true})), gatewayRestart: vi.fn(() => true) }));
vi.mock('./mcp-probe.js', () => ({ probeOctoMcp: vi.fn(async () => ({ tools: ['get_skill', 'execute'] })) }));
import { readConfigFromFile, writeConfigAtomic, gatewayRestart, gatewayStatus, getOpenClawVersion } from './openclaw-cli.js';
import { probeOctoMcp } from './mcp-probe.js';
import { checkMcpConfig, runMcpMigration } from './mcp.js';

const config = () => ({
  channels: { octo: { accounts: { bot: { botToken: 'bf_fixture' } } } },
  agents: { entries: { alice: { tools: { allow: ['read'] } } } },
  bindings: [{ agentId: 'alice', match: { channel: 'octo', accountId: 'bot' } }],
  mcp: { servers: { 'octo-mcp': { enabled: true, url: 'https://mcp.test/', transport: 'streamable-http' } } },
});
describe('MCP migration checks', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it.each(['2026.9.7', null])('rejects unsupported or unknown MCP host %s before probing or saving', async version => {
    vi.mocked(readConfigFromFile).mockReturnValue(config());
    vi.mocked(getOpenClawVersion).mockReturnValueOnce(version);
    await expect(runMcpMigration()).rejects.toThrow(/MCP.*2026.9.8/i);
    expect(probeOctoMcp).not.toHaveBeenCalled(); expect(writeConfigAtomic).not.toHaveBeenCalled();
  });
  it('scopes binding probes to the selected account and labels a failed probe', async () => {
    const cfg: any = config(); cfg.channels.octo.accounts.other = { botToken: '${UNSET_RC_TOKEN}' };
    cfg.bindings.push({ agentId: 'alice', match: { channel: 'octo', accountId: 'other' } });
    await expect(checkMcpConfig(cfg, 'bot')).resolves.toBeUndefined();
    expect(probeOctoMcp).toHaveBeenCalledOnce();
    vi.mocked(probeOctoMcp).mockRejectedValueOnce(new Error('Octo MCP initialize failed: HTTP 401.'));
    await expect(checkMcpConfig(cfg, 'bot')).rejects.toThrow(/account.*bot.*HTTP 401/i);
  });
  it('restarts a running Gateway after saved MCP changes, but not for check-only', async () => {
    vi.mocked(readConfigFromFile).mockReturnValue(config());
    await runMcpMigration();
    expect(writeConfigAtomic).toHaveBeenCalledOnce();
    expect(gatewayRestart).toHaveBeenCalledOnce();
    expect(vi.mocked(writeConfigAtomic).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(gatewayRestart).mock.invocationCallOrder[0]);
    vi.clearAllMocks();
    const cfg=config();cfg.agents.entries.alice.tools.allow.push('bundle-mcp');vi.mocked(readConfigFromFile).mockReturnValue(cfg);
    await runMcpMigration({checkOnly:true});expect(gatewayRestart).not.toHaveBeenCalled();
  });
  it('reports saved configuration and recovery steps when restart fails', async () => {
    vi.mocked(readConfigFromFile).mockReturnValue(config());vi.mocked(gatewayRestart).mockReturnValueOnce(false);
    await expect(runMcpMigration()).rejects.toThrow(/saved.*restart.*do not.*bind/i);
    expect(writeConfigAtomic).toHaveBeenCalledOnce();
  });
  it('reports unknown Gateway status without claiming it is stopped', async () => {
    vi.mocked(readConfigFromFile).mockReturnValue(config());
    vi.mocked(gatewayStatus).mockReturnValueOnce({ running: false, stateUnknown: true });
    await expect(runMcpMigration()).rejects.toThrow(/saved.*status.*unknown/i);
    expect(writeConfigAtomic).toHaveBeenCalledOnce();
    expect(gatewayRestart).not.toHaveBeenCalled();
  });
  it('defers refresh when the Gateway is confirmed stopped', async () => {
    vi.mocked(readConfigFromFile).mockReturnValue(config());
    vi.mocked(gatewayStatus).mockReturnValueOnce({ running: false });
    await runMcpMigration();
    expect(gatewayRestart).not.toHaveBeenCalled();
  });
  it('writes a disabled legacy rename without probing or enabling the service', async () => {
    const cfg: any=config();delete cfg.mcp.servers['octo-mcp'];cfg.mcp.servers['octo-business']={enabled:false};
    vi.mocked(readConfigFromFile).mockReturnValue(cfg);
    await runMcpMigration();
    expect(probeOctoMcp).not.toHaveBeenCalled();
    expect(writeConfigAtomic).toHaveBeenCalledWith(expect.objectContaining({mcp:{servers:{'octo-mcp':{enabled:false}}}}), cfg);
  });
  it('reports unsaved permission migration as pending in check-only mode', async () => {
    vi.mocked(readConfigFromFile).mockReturnValue(config());
    await expect(runMcpMigration({ checkOnly: true })).rejects.toThrow(/pending/i);
    expect(writeConfigAtomic).not.toHaveBeenCalled();
  });
  it('checks an already migrated configuration without writing', async () => {
    const cfg = config(); cfg.agents.entries.alice.tools.allow.push('bundle-mcp');
    vi.mocked(readConfigFromFile).mockReturnValue(cfg);
    await expect(runMcpMigration({ checkOnly: true })).resolves.toBeUndefined();
    expect(writeConfigAtomic).not.toHaveBeenCalled();
  });
  it('does not probe unbound stale accounts', async () => {
    const cfg: any = config(); cfg.channels.octo.accounts.orphan = { botToken: '${OCTO_RC_UNSET_TOKEN}' };
    await expect(checkMcpConfig(cfg)).resolves.toBeUndefined();
    expect(probeOctoMcp).toHaveBeenCalledOnce();
  });
  it('resolves an environment-backed token for discovery but preserves the reference', async () => {
    const cfg = config(); cfg.channels.octo.accounts.bot.botToken = '${OCTO_TEST_BOT_TOKEN}';
    vi.stubEnv('OCTO_TEST_BOT_TOKEN', 'bf_resolved');
    await checkMcpConfig(cfg);
    expect(probeOctoMcp).toHaveBeenCalledWith('https://mcp.test/', 'bf_resolved');
    expect(cfg.channels.octo.accounts.bot.botToken).toBe('${OCTO_TEST_BOT_TOKEN}');
  });
  it('rejects per-tool denials for the actual discovered facade', async () => {
    const cfg: any = config(); cfg.agents.entries.alice.tools.deny = ['octo-mcp__execute'];
    await expect(checkMcpConfig(cfg)).rejects.toThrow(/denied/i);
  });
  it('applies saved server tool filters before checking the remote facade', async () => {
    const cfg: any = config(); cfg.mcp.servers['octo-mcp'].toolFilter = { exclude: ['execute'] };
    await expect(checkMcpConfig(cfg)).rejects.toThrow(/filters/i);
  });
  it('honors the bound Agent provider policy during the protocol check', async () => {
    const cfg: any = config(); cfg.agents.entries.alice.model = 'openai/model';
    cfg.tools = { byProvider: { openai: { deny: ['bundle-mcp'] } } };
    await expect(checkMcpConfig(cfg)).rejects.toThrow(/provider/i);
  });
});
