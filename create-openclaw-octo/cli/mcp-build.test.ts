import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureMcpBuild } from '../scripts/configure-mcp.mjs';

describe('release endpoint injection', () => {
  it('bakes in deployment URL, clears it on unconfigured builds, and rejects credential-bearing URLs', () => {
    const root = mkdtempSync(join(tmpdir(), 'octo-binding-build-'));
    try {
      mkdirSync(join(root, 'cli'));
      configureMcpBuild(root, 'https://deployment.test/mcp');
      const file = join(root, 'cli/mcp-deployment.ts'); const built = readFileSync(file, 'utf8');
      expect(built).toContain('https://deployment.test/mcp');
      configureMcpBuild(root, undefined); expect(readFileSync(file, 'utf8')).toContain('= undefined;');
      expect(() => configureMcpBuild(root, 'http://remote.test/')).toThrow(/OCTO_MCP_URL/);
      expect(readFileSync(file, 'utf8')).toContain('= undefined;');
      configureMcpBuild(root, ''); expect(readFileSync(file, 'utf8')).toContain('= undefined;');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
