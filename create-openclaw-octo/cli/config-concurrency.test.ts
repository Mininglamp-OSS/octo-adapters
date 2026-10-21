import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('node:child_process', () => ({ execSync: vi.fn(() => ''), execFileSync: vi.fn() }));
import { execFileSync } from 'node:child_process';
import { writeConfigAtomic } from './openclaw-cli.js';
let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
it('rejects a stale snapshot without overwriting a concurrent config edit', () => {
  root = mkdtempSync(join(tmpdir(), 'octo-config-cas-'));
  const path = join(root, 'openclaw.json');
  vi.mocked(execFileSync).mockReturnValue(path);
  const source = { tools: { deny: ['exec'] } };
  const concurrent = { ...source, unrelated: 'concurrent edit' };
  writeFileSync(path, JSON.stringify(concurrent));
  expect(() => writeConfigAtomic({ ...source, migrated: true }, source)).toThrow(/changed.*retry/i);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(concurrent);
});
it('writes an unchanged snapshot and retains a backup', () => {
  root = mkdtempSync(join(tmpdir(), 'octo-config-cas-'));
  const path = join(root, 'openclaw.json');
  vi.mocked(execFileSync).mockReturnValue(path);
  const source = { other: 'retained' }; writeFileSync(path, JSON.stringify(source));
  writeConfigAtomic({ ...source, migrated: true }, source);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ other: 'retained', migrated: true });
  expect(JSON.parse(readFileSync(path + '.bak', 'utf8'))).toEqual(source);
});

it('accepts reordered object keys while retaining array order protection', () => {
  root = mkdtempSync(join(tmpdir(), 'octo-config-cas-'));
  const path = join(root, 'openclaw.json'); vi.mocked(execFileSync).mockReturnValue(path);
  const source = { tools: { allow: ['read', 'exec'], profile: 'full' }, other: true };
  writeFileSync(path, JSON.stringify({ other: true, tools: { profile: 'full', allow: ['read', 'exec'] } }));
  expect(() => writeConfigAtomic({ ...source, migrated: true }, source)).not.toThrow();
  expect(JSON.parse(readFileSync(path, 'utf8')).migrated).toBe(true);
  writeFileSync(path, JSON.stringify({ ...source, tools: { ...source.tools, allow: ['exec', 'read'] } }));
  expect(() => writeConfigAtomic(source, source)).toThrow(/changed/);
});
