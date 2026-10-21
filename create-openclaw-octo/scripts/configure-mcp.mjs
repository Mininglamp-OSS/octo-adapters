import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** The release supplies the endpoint once; end users inherit it in the shipped tool. */
export function configureMcpBuild(root, value) {
  let endpoint;
  if (value?.trim()) {
    let url;
    try { url = new URL(value.trim()); } catch { throw new Error('Invalid deployment OCTO_MCP_URL.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
      || url.username || url.password || url.search || url.hash) {
      throw new Error('Deployment OCTO_MCP_URL must use HTTPS or loopback HTTP without credentials, query or fragment.');
    }
    endpoint = url.href;
  }
  writeFileSync(resolve(root, 'cli/mcp-deployment.ts'),
    '// Deployment default. The build injects OCTO_MCP_URL when it is provided.\n'
    + `export const BUNDLED_MCP_URL: string | undefined = ${endpoint ? JSON.stringify(endpoint) : 'undefined'};\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  configureMcpBuild(fileURLToPath(new URL('../', import.meta.url)), process.env.OCTO_MCP_URL);
}
