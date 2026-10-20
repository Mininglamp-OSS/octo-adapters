/** Pure, idempotent migration shared by install/update/bind/quickstart. */
import { BUNDLED_MCP_URL } from './mcp-deployment.js';
export const OCTO_MCP_SERVER_NAME = 'octo-mcp';
type Config = Record<string, any>;

/** Retire the prerelease service name while preserving its endpoint and policy. */
function migrateServiceName(config: Config): void {
  const legacy = 'octo-business';
  const servers = config.mcp?.servers;
  if (servers && Object.hasOwn(servers, legacy)) {
    if (Object.hasOwn(servers, OCTO_MCP_SERVER_NAME)) {
      throw new Error('Both octo-business and octo-mcp are configured; resolve the conflicting service entries before migration.');
    }
    servers[OCTO_MCP_SERVER_NAME] = servers[legacy];
    delete servers[legacy];
  }
  const names = ['get_skill', 'execute', 'search_ops', 'describe_op', 'call_op'];
  const matches = (pattern: string, name: string) => new RegExp('^' + pattern.trim().toLowerCase()
    .split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(name);
  const visit = (value: unknown, policy = false): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (policy && ['allow', 'deny', 'alsoAllow'].includes(key) && Array.isArray(entry)) {
        const renamed = entry.map(pattern => typeof pattern === 'string' && pattern.trim().toLowerCase().startsWith(legacy + '__')
          ? OCTO_MCP_SERVER_NAME + pattern.trim().slice(legacy.length) : pattern);
        // A wildcard such as *business* must not silently stop denying this service.
        for (const pattern of entry) if (typeof pattern === 'string') {
          for (const name of names) if (matches(pattern, legacy + '__' + name)
            && !renamed.some(next => typeof next === 'string' && matches(next, OCTO_MCP_SERVER_NAME + '__' + name))) {
            renamed.push(OCTO_MCP_SERVER_NAME + '__' + name);
          }
        }
        (value as Config)[key] = [...new Set(renamed)];
      } else visit(entry, policy || key === 'tools' || key === 'toolsBySender');
    }
  };
  visit(config);
}

function coversMcpNamespace(entry: string): boolean {
  const pattern = entry.trim().toLowerCase();
  if (['*', 'bundle-mcp', 'group:plugins'].includes(pattern)) return true;
  if (!pattern.endsWith('*')) return false;
  const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(OCTO_MCP_SERVER_NAME + '__') || new RegExp(`^${escaped}$`).test('bundle-mcp');
}

const MCP_FACADES = [['get_skill', 'execute'], ['search_ops', 'describe_op', 'call_op']];
function matchesMcpTool(patternValue: string, tool: string, denial = false): boolean {
  const pattern = patternValue.trim().toLowerCase();
  if (['bundle-mcp', 'group:plugins'].includes(pattern)) return true;
  const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(OCTO_MCP_SERVER_NAME + '__' + tool) || (denial && new RegExp(`^${escaped}$`).test('bundle-mcp'));
}
function facadesFor(discovered?: string[]): string[][] {
  return discovered ? MCP_FACADES.filter(names => names.every(name => discovered.includes(name))) : MCP_FACADES;
}
export function normalizeBindingId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 64) : '';
}
export function normalizeMcpAccountId(raw: unknown): string {
  const id = normalizeBindingId(raw);
  return ['__proto__', 'prototype', 'constructor'].includes(id) ? '' : id;
}
/** Same canonical account identity used by native routing; never borrow another account. */
export function resolveMcpAccount(config: Config, rawId: unknown): Config | undefined {
  const id = normalizeMcpAccountId(rawId);
  if (!id) return;
  const channel = config.channels?.octo;
  const entries = Object.entries(channel?.accounts ?? {});
  if (!entries.length) return id === 'default' ? channel : undefined;
  const matches = entries.filter(([key]) => normalizeMcpAccountId(key) === id);
  if (matches.length > 1) throw new Error('Octo MCP binding references ambiguous canonical account IDs.');
  return matches[0]?.[1] as Config | undefined;
}
export function policyList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) throw new Error('Malformed tool policy; expected a list of strings. No changes written.');
  return value;
}
export function resolveBoundAgent(config: Config, rawId: unknown): Config {
  const id = normalizeBindingId(rawId);
  if (id === 'main' && !Object.hasOwn(config.agents ?? {}, 'entries') && !Object.hasOwn(config.agents ?? {}, 'list')) return {};
  const keyed = Object.entries(config.agents?.entries ?? {})
    .filter(([key]) => normalizeBindingId(key) === id).map(([, entry]) => entry as Config);
  const listed = (config.agents?.list ?? []).filter((entry: Config) => normalizeBindingId(entry.id) === id);
  const matches = [...keyed, ...listed];
  if (!id || matches.length === 0) throw new Error('Octo MCP binding references an Agent missing from the configured roster.');
  if (matches.length !== 1) throw new Error('Octo MCP found ambiguous Agent IDs or roster formats.');
  return matches[0];
}

export function assertMcpGlobalToolPolicy(config: Config, discovered?: string[]): void {
  const allow = policyList(config.tools?.allow);
  policyList(config.tools?.deny); policyList(config.tools?.alsoAllow);
  if (!Array.isArray(allow) || !allow.length) return;
  if (!facadesFor(discovered).some(names => names.every(tool => allow.some(pattern => matchesMcpTool(pattern, tool))))) {
    throw new Error('Octo MCP is excluded by the global tools.allow policy; the operator must permit the deployed MCP facade before migrating bound Agents.');
  }
}

export function assertMcpAgentDenials(config: Config, discovered: string[]): void {
  const channel = config.channels?.octo;
  if (channel?.enabled === false) return;
  for (const binding of config.bindings ?? []) {
    if (binding.match?.channel !== 'octo') continue;
    const account = resolveMcpAccount(config, binding.match.accountId);
    if (!account || account.enabled === false) continue;
    const agent = resolveBoundAgent(config, binding.agentId);
    for (const key of ['allow', 'deny', 'alsoAllow']) policyList(agent?.tools?.[key]);
    assertAgentProfile(config, agent, discovered);
    const deny: string[] = [...policyList(config.tools?.deny), ...policyList(agent?.tools?.deny)];
    if (!facadesFor(discovered).some(names => names.every(tool => !deny.some(pattern => matchesMcpTool(pattern, tool, true))))) {
      throw new Error('Octo MCP facade tools are explicitly denied for a bound Agent; no permissions were overridden.');
    }
  }
}

/** Built-in host profiles that include bundle-mcp (OpenClaw 2026.10.5). */
export function profileIncludesMcp(profile: unknown): boolean {
  return profile === undefined || ['full', 'coding', 'messaging'].includes(String(profile));
}

function assertAgentProfile(config: Config, agent: Config | undefined, discovered?: string[]): void {
  const profile = agent?.tools?.profile ?? config.tools?.profile;
  if (!profileIncludesMcp(profile) && Array.isArray(agent?.tools?.allow) && agent.tools.allow.length > 0) {
    const extras = policyList(config.tools?.alsoAllow);
    if (!facadesFor(discovered).some(names => names.every(tool => extras.some(pattern => matchesMcpTool(pattern, tool))))) {
      throw new Error('Octo MCP is excluded by a restrictive tool profile combined with an explicit Agent allow list. The operator must adjust that policy; migration will not replace the profile.');
    }
  }
}

/** Installation-time public endpoint; persisted so a daemon need not inherit shell env. */
export function resolveMcpUrlOption(explicit?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return explicit ?? (env.OCTO_MCP_URL?.trim() || undefined);
}

export function validateMcpUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('MCP URL must be an absolute HTTPS URL (or loopback HTTP).'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.hash || url.search) {
    throw new Error('MCP URL requires HTTPS (loopback HTTP is allowed), without credentials, query or fragment.');
  }
  return url.href;
}

export function configureOctoMcp(source: Config, mcpUrl?: string, bundledUrl = BUNDLED_MCP_URL, accountScope?: string): {
  config: Config; changed: boolean; enabled: boolean; agentIds: string[]; warnings?: string[];
} {
  const config: Config = structuredClone(source);
  migrateServiceName(config);
  if (config.channels?.octo?.enabled === false) return { config, changed: JSON.stringify(config) !== JSON.stringify(source), enabled: false, agentIds: [] };
  const oldServer = config.mcp?.servers?.[OCTO_MCP_SERVER_NAME];
  if (mcpUrl === undefined && ((!oldServer && !bundledUrl) || oldServer?.enabled === false)) {
    return { config, changed: JSON.stringify(config) !== JSON.stringify(source), enabled: false, agentIds: [] };
  }
  if (oldServer && ['headers', 'auth', 'oauth', 'command', 'args', 'env', 'type', 'clientCert', 'clientKey'].some(key => key in oldServer) || oldServer?.sslVerify === false) {
    throw new Error('Octo MCP has static credentials or another transport configuration; remove them before migration.');
  }
  const destination = mcpUrl ?? oldServer?.url ?? bundledUrl;
  if (typeof destination !== 'string') throw new Error('Octo MCP has no deployment URL configured.');
  const url = validateMcpUrl(destination);
  const useBundledDeclaration = mcpUrl === undefined && oldServer === undefined && !!bundledUrl;
  const channel = config.channels?.octo ?? {};
  assertMcpGlobalToolPolicy(config);
  const ids: string[] = [];
  const warnings: string[] = [];
  for (const binding of config.bindings ?? []) {
    if (binding.match?.channel !== 'octo') continue;
    if (accountScope !== undefined && normalizeMcpAccountId(binding.match.accountId) !== normalizeMcpAccountId(accountScope)) continue;
    if (channel.enabled === false) continue;
    const accountId = binding.match.accountId;
    if (typeof accountId !== 'string' || !accountId.trim()) {
      throw new Error('Octo MCP requires explicit account IDs in Bot bindings.');
    }
    const account = resolveMcpAccount(config, accountId);
    if (!account) {
      warnings.push('Skipped an Octo binding whose account no longer exists; remove the stale binding with doctor --fix.');
      continue;
    }
    if (account.enabled === false) continue;
    if (typeof account.botToken !== 'string' || !account.botToken.trim() || /[\r\n]/.test(account.botToken)) {
      throw new Error('Octo MCP requires each bound account to have its own Bot token.');
    }
    const agentId = binding.agentId;
    // Agent tools are not supported under agents.defaults. Materialize only
    // the implicit main roster and let it continue inheriting all defaults.
    if (normalizeBindingId(agentId) === 'main' && !Object.hasOwn(config.agents ?? {}, 'entries') && !Object.hasOwn(config.agents ?? {}, 'list')) {
      config.agents ??= {}; config.agents.entries = { main: {} };
    }
    const agent = resolveBoundAgent(config, agentId);
    for (const key of ['allow', 'deny', 'alsoAllow']) policyList(agent?.tools?.[key]);
    assertAgentProfile(config, agent);
    const deny = [...policyList(config.tools?.deny), ...policyList(agent.tools?.deny)];
    const blocksMcp = deny.some(coversMcpNamespace);
    if (blocksMcp) {
      throw new Error('Octo MCP is explicitly denied by tool policy; resolve the policy before migration.');
    }
    agent.tools ??= {};
    // Empty allow is unrestricted in the host; turning it into a nonempty
    // MCP-only allow list would remove existing tools. Keep profile semantics.
    if (Array.isArray(agent.tools.allow) && agent.tools.allow.length === 0) delete agent.tools.allow;
    // The host rejects allow + alsoAllow in one scope. Extend an explicit
    // allow list in place; otherwise add the bundle to the additive list.
    const permissionKey = Array.isArray(agent.tools.allow) ? 'allow' : 'alsoAllow';
    if (permissionKey === 'allow' || agent.tools.alsoAllow !== undefined) {
      const previous = policyList(agent.tools[permissionKey]);
      if (!previous.includes('bundle-mcp')) warnings.push(`Agent ${JSON.stringify(agentId)}: adding bundle-mcp also grants other host MCP servers; review their tool filters.`);
      agent.tools[permissionKey] = [...new Set([...previous, 'bundle-mcp'])];
    } else {
      // Do not shadow inherited global additions or revocations with a local copy.
      const inherited = policyList(config.tools?.alsoAllow);
      if (!profileIncludesMcp(agent.tools.profile ?? config.tools?.profile)
        && !facadesFor().some(names => names.every(tool => inherited.some(pattern => matchesMcpTool(pattern, tool))))) {
        throw new Error('Octo MCP needs an operator grant in the restrictive inherited tool policy; migration will not shadow global alsoAllow.');
      }
    }
    if (!ids.includes(agentId)) ids.push(agentId);
  }
  // Do not pin a release default into user config: the next plugin release may
  // change the deployment URL. Native manifest declaration follows that release.
  if (!useBundledDeclaration) {
    config.mcp ??= {};
    config.mcp.servers ??= {};
    config.mcp.servers[OCTO_MCP_SERVER_NAME] = {
      ...oldServer, enabled: true, transport: 'streamable-http', url,
    };
  }
  return { config, changed: JSON.stringify(config) !== JSON.stringify(source), enabled: true, agentIds: ids, ...(warnings.length ? { warnings } : {}) };
}
