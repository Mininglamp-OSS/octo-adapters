import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import * as nodeUtil from 'node:util';

function probeHome(): string {
  const override = process.env.OPENCLAW_HOME?.trim();
  return override ? resolve(override.replace(/^~(?=$|[/\\])/, homedir())) : homedir();
}
export function resolveProbeStateDir(value: string | undefined = process.env.OPENCLAW_STATE_DIR): string {
  return value?.trim() ? resolve(value.trim().replace(/^~(?=$|[/\\])/, probeHome())) : resolve(probeHome(), '.openclaw');
}

/** Probe-only resolution. Never write expanded credentials back into openclaw.json. */
export function resolveProbeToken(value: string, env: NodeJS.ProcessEnv): string {
  // Same simple fallback and escaping grammar as OpenClaw config templates.
  const token = value.replace(/(\$)?\$\{([A-Z_][A-Z0-9_]*)(?::-([^${}]*))?\}/g,
    (match, escaped: string | undefined, key: string, fallback: string | undefined) => {
      if (escaped) return match.slice(1);
      const resolved = env[key];
      if (resolved !== undefined && resolved !== '') return resolved;
      if (fallback !== undefined) return fallback;
      throw new Error('Octo MCP cannot resolve a Bot credential environment reference; use the same environment as OpenClaw.');
    });
  if (!token.trim() || /[\r\n]/.test(token)) throw new Error('Octo MCP discovery requires a valid Bot credential.');
  return token.trim();
}

/** Restricted dotenv grammar for supported Node 18/19, without shell execution or expansion. */
function parseCredentialEnv(source: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  const assignments = /(?:^|\n)[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:'([^']*)'|"([^"]*)"|`([^`]*)`|([^\n#]*))/g;
  for (const match of source.replace(/\r\n?/g, '\n').matchAll(assignments)) {
    result[match[1]] = match[2] ?? (match[3] !== undefined ? match[3].replace(/\\n/g, '\n').replace(/\\r/g, '\r') : undefined)
      ?? match[4] ?? match[5].trim();
  }
  return result;
}

export function readProbeEnvironment(config: Record<string, any>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Only trusted runtime sources are read. Workspace .env has a host-version-
  // dependent trust filter; never treat arbitrary project files as Bot credentials.
  // Hosts that use workspace credentials must export them into this process first.
  const parseEnv = (nodeUtil as typeof nodeUtil & { parseEnv?: (source: string) => Record<string, string> }).parseEnv ?? parseCredentialEnv;
  {
    const stateDir = resolveProbeStateDir();
    const files = [resolve(stateDir, '.env')];
    if (stateDir === resolve(probeHome(), '.openclaw')) files.push(resolve(probeHome(), '.config/openclaw/gateway.env'));
    for (const file of files) {
      let text: string;
      try { text = readFileSync(file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error('Octo MCP cannot read the OpenClaw credential environment.');
      }
      for (const [key, value] of Object.entries(parseEnv(text))) if (env[key] === undefined) env[key] = value;
    }
  }
  const configured = { ...(config.env?.vars ?? {}), ...config.env };
  for (const [key, value] of Object.entries(configured)) {
    if (!env[key]?.trim() && typeof value === 'string' && value.trim() && !value.includes('${')) env[key] = value;
  }
  return env;
}
