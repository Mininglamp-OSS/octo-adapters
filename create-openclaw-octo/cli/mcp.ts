import { readConfigFromFile, writeConfigAtomic, gatewayStatus, gatewayRestart, getOpenClawVersion } from './openclaw-cli.js';
import { assertMcpAgentDenials, assertMcpGlobalToolPolicy, configureOctoMcp, normalizeMcpAccountId, resolveMcpAccount, OCTO_MCP_SERVER_NAME, resolveMcpUrlOption } from './mcp-config.js';
import { probeOctoMcp } from './mcp-probe.js';
import { BUNDLED_MCP_URL } from './mcp-deployment.js';
import { readProbeEnvironment, resolveProbeToken } from './mcp-credentials.js';
import { assertProviderMcpPolicy, filterMcpCatalog } from './mcp-policy.js';

export async function checkMcpConfig(config: Record<string, any>, accountId?: string): Promise<void> {
  const server = config.mcp?.servers?.[OCTO_MCP_SERVER_NAME]
    ?? (BUNDLED_MCP_URL ? { enabled: true, url: BUNDLED_MCP_URL } : undefined);
  if (!server || server.enabled === false) return;
  const channel = config.channels?.octo;
  if (!channel || channel.enabled === false) return;
  const hostVersion = getOpenClawVersion();
  const parts = hostVersion?.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  if (!parts || parts[0] < 2026 || (parts[0] === 2026 && (parts[1] < 9 || (parts[1] === 9 && parts[2] < 8)))) {
    throw new Error('Octo MCP requires OpenClaw >= 2026.9.8 with native MCP account resolution; upgrade the intended host. MCP compatibility was not verified.');
  }
  const bound = new Set((config.bindings ?? []).filter((binding: any) => binding.match?.channel === 'octo')
    .map((binding: any) => normalizeMcpAccountId(binding.match.accountId)));
  const accounts = Object.keys(channel.accounts ?? {}).length
    ? Object.entries(channel.accounts).filter(([id]) => bound.has(normalizeMcpAccountId(id))).map(([id, account]) => ({ id, account }))
    : bound.has('default') ? [{ id: 'default', account: channel }] : [];
  let environment: NodeJS.ProcessEnv | undefined;
  for (const { id, account } of accounts as { id: string; account: Record<string, any> }[]) {
    if (accountId !== undefined && normalizeMcpAccountId(id) !== normalizeMcpAccountId(accountId)) continue;
    if (!normalizeMcpAccountId(id)) throw new Error('Octo MCP account ID cannot be routed by the host.');
    if (resolveMcpAccount(config, id) !== account) throw new Error('Octo MCP account identity is ambiguous.');
    if (account.enabled === false || !account.botToken) continue;
    let discovered: { tools: string[] };
    try {
      const token = resolveProbeToken(account.botToken,
        account.botToken.includes('${') ? environment ??= readProbeEnvironment(config) : process.env);
      discovered = await probeOctoMcp(server.url, token);
    } catch (cause) {
      // Probe and credential helpers return fixed, sanitized messages only.
      throw new Error(`Octo MCP account ${JSON.stringify(id)}: ${cause instanceof Error ? cause.message : 'probe failed.'}`);
    }
    const tools = filterMcpCatalog(discovered.tools, server.toolFilter);
    if (!(['get_skill', 'execute'].every(name => tools.includes(name))
      || ['search_ops', 'describe_op', 'call_op'].every(name => tools.includes(name)))) {
      throw new Error('Octo MCP server tool filters exclude the deployed business facade; no filters were overridden.');
    }
    assertMcpGlobalToolPolicy(config, tools);
    const scoped = { ...config, bindings: (config.bindings ?? []).filter((binding: any) => binding.match?.channel === 'octo' && normalizeMcpAccountId(binding.match.accountId) === normalizeMcpAccountId(id)) };
    assertMcpAgentDenials(scoped, tools);
    assertProviderMcpPolicy(scoped, tools);
  }
}

/** Called after plugin update and by the explicit MCP migration command. */
export async function runMcpMigration(opts: { mcpUrl?: string; checkOnly?: boolean; refreshGateway?: boolean } = {}): Promise<void> {
  const source = readConfigFromFile();
  if (!source) throw new Error('Cannot read OpenClaw configuration; no MCP settings were written.');
  const result = configureOctoMcp(source, resolveMcpUrlOption(opts.mcpUrl));
  for (const warning of result.warnings ?? []) console.warn(warning);
  if (!result.enabled) {
    if (result.changed) {
      if (opts.checkOnly) throw new Error('Octo MCP service-name migration is pending; no configuration was written.');
      writeConfigAtomic(result.config, source);
    }
    console.log('Octo MCP deployment endpoint is not configured in this release, or the service is disabled. Existing Bot bindings remain available; deployment operators must configure the release.');
    return;
  }
  await checkMcpConfig(result.config);
  if (opts.checkOnly && result.changed) {
    throw new Error('Octo MCP protocol is reachable, but configuration migration changes are pending and were not written. Run the normal update or mcp migration before using Agent tools.');
  }
  if (result.changed && !opts.checkOnly) writeConfigAtomic(result.config, source);
  if (!opts.checkOnly && (result.changed || opts.refreshGateway !== false)) refreshMcpGateway(result.config);
  console.log(opts.checkOnly ? 'Octo MCP configuration and protocol checks passed (no configuration written).'
    : 'Octo MCP configured with streamable-http; existing Bot credentials and bindings preserved.');
  console.log('These are static configuration/protocol checks, not runtime readiness. Session/group/sandbox policy, Agent credential routing and WebSocket health require a real Bot task after reload.');
}

/** Use the supported host lifecycle command rather than patching its connection cache. */
export function refreshMcpGateway(config: Record<string, any>): void {
  const server = config.mcp?.servers?.[OCTO_MCP_SERVER_NAME];
  if (config.channels?.octo?.enabled === false || server?.enabled === false
    || (!server && !BUNDLED_MCP_URL)) return;
  const status = gatewayStatus();
  if (status.stateUnknown) throw new Error('Configuration is saved, but Gateway status is unknown. Run openclaw gateway status, then restart the intended Gateway if needed, mcp --check and a real Bot task. Do not rerun bind or quickstart to recreate Bots.');
  if (!status.running) {
    console.log('Gateway is not running; saved MCP configuration will apply on its next start.');
    return;
  }
  console.log('Restarting Gateway to refresh Octo MCP connections; active Bot connections may briefly reconnect.');
  if (!gatewayRestart()) throw new Error('Configuration is saved, but Gateway restart failed. Run openclaw gateway restart, then mcp --check and a real Bot task. Do not rerun bind or quickstart to recreate Bots.');
  console.log('Gateway restart command completed; verify the new connection with a real Bot task.');
}
