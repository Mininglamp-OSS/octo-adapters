import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:util', async original => ({ ...await original<typeof import('node:util')>(), parseEnv: undefined }));
import { readProbeEnvironment, resolveProbeStateDir, resolveProbeToken } from './mcp-credentials.js';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

describe('MCP discovery credentials', () => {
  beforeEach(() => {
    vi.stubEnv('OPENCLAW_HOME', undefined);
    vi.stubEnv('OPENCLAW_STATE_DIR', resolve(tmpdir(), 'octo-test-absent-state'));
  });
  afterEach(() => vi.unstubAllEnvs());
  it('parses exported, quoted and commented trusted credentials without shell expansion on older Node', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'octo-env-fallback-'));
    try {
      vi.stubEnv('OPENCLAW_STATE_DIR', root);
      for (const key of ['OCTO_RC_A', 'OCTO_RC_B', 'OCTO_RC_C']) vi.stubEnv(key, undefined);
      writeFileSync(resolve(root, '.env'), `export OCTO_RC_A='bf_#quoted'\nOCTO_RC_B="bf_$(ignored)"\nOCTO_RC_C=bf_plain # comment\n`);
      const env = readProbeEnvironment({});
      expect([env.OCTO_RC_A, env.OCTO_RC_B, env.OCTO_RC_C]).toEqual(['bf_#quoted', 'bf_$(ignored)', 'bf_plain']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('loads managed gateway credentials only for the default state, with process env taking precedence', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'octo-managed-env-'));
    try {
      vi.stubEnv('OPENCLAW_HOME', root); vi.stubEnv('OPENCLAW_STATE_DIR', undefined); vi.stubEnv('OCTO_TEST_MANAGED_TOKEN', undefined);
      mkdirSync(resolve(root, '.config/openclaw'), { recursive: true });
      writeFileSync(resolve(root, '.config/openclaw/gateway.env'), 'OCTO_TEST_MANAGED_TOKEN=bf_managed\n');
      expect(readProbeEnvironment({}).OCTO_TEST_MANAGED_TOKEN).toBe('bf_managed');
      vi.stubEnv('OCTO_TEST_MANAGED_TOKEN', 'bf_process');
      expect(readProbeEnvironment({}).OCTO_TEST_MANAGED_TOKEN).toBe('bf_process');
      vi.stubEnv('OCTO_TEST_MANAGED_TOKEN', undefined); vi.stubEnv('OPENCLAW_STATE_DIR', resolve(root, 'separate'));
      expect(readProbeEnvironment({}).OCTO_TEST_MANAGED_TOKEN).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('supports host fallback templates and preserves unrelated dollar signs', () => {
    expect(resolveProbeToken('${OCTO_BOT_TOKEN:-bf_fallback}', {})).toBe('bf_fallback');
    expect(resolveProbeToken('${OCTO_BOT_TOKEN:-bf_fallback}', { OCTO_BOT_TOKEN: 'bf_configured' })).toBe('bf_configured');
    expect(resolveProbeToken('${OCTO_BOT_TOKEN:-bf_fallback}', { OCTO_BOT_TOKEN: '' })).toBe('bf_fallback');
    expect(resolveProbeToken('bf_$$literal', {})).toBe('bf_$$literal');
    expect(resolveProbeToken('$${OCTO_BOT_TOKEN:-bf_fallback}', {})).toBe('${OCTO_BOT_TOKEN:-bf_fallback}');
  });
  it('fills an empty inherited credential from config without replacing a populated value', () => {
    vi.stubEnv('OCTO_TEST_CONFIG_TOKEN', '');
    expect(readProbeEnvironment({ env: { vars: { OCTO_TEST_CONFIG_TOKEN: 'bf_config' } } }).OCTO_TEST_CONFIG_TOKEN).toBe('bf_config');
    vi.stubEnv('OCTO_TEST_CONFIG_TOKEN', 'bf_process');
    expect(readProbeEnvironment({ env: { vars: { OCTO_TEST_CONFIG_TOKEN: 'bf_config' } } }).OCTO_TEST_CONFIG_TOKEN).toBe('bf_process');
  });
  it('does not let workspace dotenv override trusted gateway credentials', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'octo-workspace-env-'));
    const cwd = process.cwd();
    try {
      vi.stubEnv('OPENCLAW_HOME', root); vi.stubEnv('OPENCLAW_STATE_DIR', undefined); vi.stubEnv('OPENCLAW_OCTO_TEST_TOKEN', undefined);
      mkdirSync(resolve(root, '.config/openclaw'), { recursive: true });
      writeFileSync(resolve(root, '.env'), 'OPENCLAW_OCTO_TEST_TOKEN=bf_workspace\n');
      writeFileSync(resolve(root, '.config/openclaw/gateway.env'), 'OPENCLAW_OCTO_TEST_TOKEN=bf_managed\n');
      process.chdir(root);
      expect(readProbeEnvironment({}).OPENCLAW_OCTO_TEST_TOKEN).toBe('bf_managed');
    } finally { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); }
  });
  it('expands home-relative OpenClaw state paths before loading dotenv', () => {
    vi.stubEnv('OPENCLAW_STATE_DIR', undefined);
    expect(resolveProbeStateDir('~/separate-state')).toBe(resolve(homedir(), 'separate-state'));
    expect(resolveProbeStateDir('~')).toBe(homedir());
    expect(resolveProbeStateDir(undefined)).toBe(resolve(homedir(), '.openclaw'));
  });
  it('resolves environment references without replacing them in source configuration', () => {
    const source = { botToken: '${OCTO_TEST_BOT_TOKEN}' };
    expect(resolveProbeToken(source.botToken, { OCTO_TEST_BOT_TOKEN: 'bf_actual' })).toBe('bf_actual');
    expect(source.botToken).toBe('${OCTO_TEST_BOT_TOKEN}');
  });
  it('does not leak values or unresolved references on missing environment variables', () => {
    expect(() => resolveProbeToken('${OCTO_TEST_MISSING}', {})).toThrow(/environment/i);
  });
  it('rejects empty and header-injection credentials after expansion', () => {
    for (const token of ['', 'bf_bad\r\nAuthorization: other']) {
      expect(() => resolveProbeToken('${OCTO_TEST_BOT_TOKEN}', { OCTO_TEST_BOT_TOKEN: token })).toThrow(/credential|environment/i);
    }
  });
  it('preserves literal credentials and escaped dollar signs', () => {
    expect(resolveProbeToken('bf_literal', {})).toBe('bf_literal');
    expect(resolveProbeToken('bf_$${LITERAL}', {})).toBe('bf_${LITERAL}');
  });
});
