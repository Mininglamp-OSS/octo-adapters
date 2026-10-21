import { resolveMcpAccount, policyList, profileIncludesMcp, OCTO_MCP_SERVER_NAME, resolveBoundAgent } from './mcp-config.js';
type Config = Record<string, any>;
const FACADES = [['get_skill', 'execute'], ['search_ops', 'describe_op', 'call_op']];

function glob(pattern: string, value: string): boolean {
  const escaped = pattern.trim().split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(value);
}
export function filterMcpCatalog(tools: string[], filter?: { include?: string[]; exclude?: string[] }): string[] {
  const include = filter?.include?.map(value => value.trim()).filter(Boolean) ?? [];
  const exclude = filter?.exclude?.map(value => value.trim()).filter(Boolean) ?? [];
  return tools.filter(name => (!include.length || include.some(pattern => glob(pattern, name)))
    && !exclude.some(pattern => glob(pattern, name)));
}
function policyMatches(pattern: string, name: string, denial = false): boolean {
  const normalized = pattern.trim().toLowerCase();
  return ['bundle-mcp', 'group:plugins'].includes(normalized) || (denial && glob(normalized, 'bundle-mcp')) || glob(normalized, OCTO_MCP_SERVER_NAME + '__' + name);
}
function entryFor(entries: Config | undefined, reference: string): Config | undefined {
  if (!entries) return;
  const normalized = Object.fromEntries(Object.entries(entries).map(([key, value]) => [key.trim().toLowerCase(), value]));
  return normalized[reference.toLowerCase()] ?? normalized[reference.split('/')[0].toLowerCase()];
}
function modelReferences(config: Config, agent: Config): string[] {
  const primary = (value: any) => typeof value === 'string' ? value : value?.primary;
  const configured = primary(agent.model) ?? primary(config.agents?.defaults?.model);
  const unresolved = () => new Error('Octo MCP cannot statically resolve the provider policy; configure an explicit provider/model reference before migration.');
  if (!configured) throw unresolved();
  const fallbacks = agent.model?.fallbacks ?? (primary(agent.model) ? [] : config.agents?.defaults?.model?.fallbacks ?? []);
  const models = { ...(config.agents?.defaults?.models ?? {}), ...(agent.models ?? {}) };
  return [configured, ...fallbacks].map((raw: string) => {
    const reference = raw.trim();
    const aliases = [...Object.entries(agent.models ?? {}), ...Object.entries(config.agents?.defaults?.models ?? {})
      .filter(([key]) => !Object.hasOwn(agent.models?.[key] ?? {}, 'alias'))];
    const localMatches = Object.entries(agent.models ?? {})
      .filter(([, value]) => (value as Config).alias?.toLowerCase() === reference.toLowerCase());
    const matches = localMatches.length ? localMatches : aliases
      .filter(([, value]) => (value as Config).alias?.toLowerCase() === reference.toLowerCase());
    // Host versions differ in duplicate alias precedence. Never validate a
    // different provider from the one the Agent may actually select.
    if (matches.length > 1) throw unresolved();
    const alias = matches[0];
    if (alias?.[0].includes('/')) return alias[0];
    if (reference.includes('/')) return reference;
    const candidates = new Set(Object.keys(models).filter(key => key.slice(key.indexOf('/') + 1) === reference && key.includes('/')));
    for (const [provider, entry] of Object.entries(config.models?.providers ?? {})) {
      const catalog = (entry as Config)?.models;
      if (catalog !== undefined && !Array.isArray(catalog)) throw unresolved();
      if (catalog?.some((model: Config) => model?.id === reference)) candidates.add(provider + '/' + reference);
    }
    if (candidates.size === 1) return [...candidates][0];
    // The implicit provider and catalog aliases vary across host versions/plugins.
    // Refuse an uncertain static result instead of reporting a false policy pass.
    throw unresolved();
  });
}
/** Static configured provider/model checks; runtime/session restrictions still need a real Agent task. */
export function assertProviderMcpPolicy(config: Config, discovered: string[]): void {
  const channel = config.channels?.octo;
  if (channel?.enabled === false) return;
  for (const binding of config.bindings ?? []) {
    if (binding.match?.channel !== 'octo') continue;
    const account = resolveMcpAccount(config, binding.match.accountId);
    if (!account || account.enabled === false) continue;
    const agent = resolveBoundAgent(config, binding.agentId);
    if (!config.tools?.byProvider && !agent.tools?.byProvider) continue;
    for (const model of modelReferences(config, agent)) {
      const global = entryFor(config.tools?.byProvider, model);
      const local = entryFor(agent.tools?.byProvider, model);
      const profile = local?.profile ?? global?.profile;
      const extras: string[] = policyList(local?.alsoAllow ?? global?.alsoAllow);
      const permits = (name: string) => [global, local].every(policy => {
        if (!policy) return true;
        if (policyList(policy.deny).some((pattern: string) => policyMatches(pattern, name, true))) return false;
        const allow = policyList(policy.allow);
        return !allow.length || [...allow, ...policyList(policy.alsoAllow)]
          .some((pattern: string) => policyMatches(pattern, name));
      }) && (profileIncludesMcp(profile) || extras.some(pattern => policyMatches(pattern, name)));
      if (!FACADES.some(names => names.every(name => discovered.includes(name) && permits(name)))) {
        throw new Error('Octo MCP facade is excluded by a configured provider/model tool policy; no restrictions were overridden.');
      }
    }
  }
}
