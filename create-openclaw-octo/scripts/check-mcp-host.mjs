/** Pure-memory regression against an explicitly supplied, installed public host package. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureOctoMcp, assertMcpGlobalToolPolicy } from '../dist/cli/mcp-config.js';
import { assertProviderMcpPolicy } from '../dist/cli/mcp-policy.js';

if (!process.argv[2]) throw new Error('Usage: npm run check:mcp-host -- /path/to/installed/openclaw');
const root = resolve(process.argv[2]);
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(metadata.name, 'openclaw');
const { validateConfigObjectRaw } = await import(pathToFileURL(join(root, 'dist/config/config.js')).href);
// Official bundled filenames are hashed. Locate their named-export wrappers,
// avoiding a dependency on one build hash or aliases in the private chunks.
async function hostExport(prefix, name) {
  for (const file of await readdir(join(root, 'dist'))) {
    if (!file.startsWith(prefix) || !file.endsWith('.mjs')) continue;
    const source = await readFile(join(root, 'dist', file), 'utf8');
    if (!new RegExp(`export \\{[^}]*\\b${name}\\b[, }]`).test(source)) continue;
    const loaded = await import(pathToFileURL(join(root, 'dist', file)).href);
    if (typeof loaded[name] === 'function') return loaded[name];
  }
  throw new Error(`Host does not expose ${name} in a named-export wrapper.`);
}
const expand = await hostExport('tool-policy-', 'expandPolicyWithPluginGroups');
const filter = await hostExport('tool-policy-match-', 'filterToolsByPolicy');
const source = {
  channels: { octo: { accounts: { bot: { botToken: 'bf_synthetic' } } } },
  bindings: [{ agentId: 'main', match: { channel: 'octo', accountId: 'bot' } }],
};
assert.equal(validateConfigObjectRaw(source).ok, true, 'source fixture must be host-valid');
const result = configureOctoMcp(source, undefined, 'https://mcp.example.com/');
const validation = validateConfigObjectRaw(result.config);
assert.equal(validation.ok, true, JSON.stringify(validation.issues));
const defaults = { model: 'deepseek/fixture', workspace: '/tmp/octo-mcp-host-fixture' };
const withDefaults = configureOctoMcp({ ...source, agents: { defaults } }, undefined, 'https://mcp.example.com/');
assert.equal(validateConfigObjectRaw(withDefaults.config).ok, true);
assert.deepEqual(withDefaults.config.agents.defaults, defaults);
assert.deepEqual(result.config.bindings, source.bindings);
assert.equal(configureOctoMcp(result.config, undefined, 'https://mcp.example.com/').changed, false);
const names = ['octo-mcp__get_skill', 'octo-mcp__execute'];
const groups = { all: names, byPlugin: new Map([['bundle-mcp', names]]) };
for (const pattern of ['bundle-*', 'bundle-m*', 'bundle-mcp', 'octo-mcp__*', 'group:plugins', '*']) {
  const policy = { allow: ['read', pattern] };
  const native = filter(names.map(name => ({ name })), expand(policy, groups)).length === 2;
  let global = true, provider = true;
  try { assertMcpGlobalToolPolicy({ tools: policy }, ['get_skill', 'execute']); } catch { global = false; }
  try { assertProviderMcpPolicy({ ...withDefaults.config, tools: { byProvider: { deepseek: policy } } }, ['get_skill', 'execute']); } catch { provider = false; }
  assert.equal(global, native, `global allow diverges from host: ${pattern}`);
  assert.equal(provider, native, `provider allow diverges from host: ${pattern}`);
}
console.log(`OpenClaw ${metadata.version}: migrated implicit-main schema and 6 native policy controls passed; synthetic inputs only.`);
