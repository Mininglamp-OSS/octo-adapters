import { PLUGIN_VERSION } from './version.js';
import { validateMcpUrl } from './mcp-config.js';

/** Read-only protocol check. This does not prove runtime Bot identity or business ACLs. */
export async function probeOctoMcp(url: string, token: string, fetcher = fetch): Promise<{ tools: string[] }> {
  url = validateMcpUrl(url);
  let session: string | undefined;
  let protocol = '2025-06-18';
  let id = 0;
  const signal = AbortSignal.timeout(15_000);
  async function rpc(method: string, params: unknown = {}, notification = false): Promise<any> {
    const requestId = ++id;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST', redirect: 'error', signal,
        headers: {
          Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(session ? { 'Mcp-Session-Id': session } : {}),
          ...(method !== 'initialize' ? { 'MCP-Protocol-Version': protocol } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method, params }),
      });
    } catch { throw new Error('Octo MCP connection failed or timed out; configuration was not verified.'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Octo MCP ${method} failed: HTTP ${response.status}.`); }
    session = response.headers.get('Mcp-Session-Id') ?? session;
    if (notification) { await response.body?.cancel(); return; }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Octo MCP returned no response.');
    const sse = response.headers.get('content-type')?.includes('text/event-stream');
    const decoder = new TextDecoder(); let text = ''; let size = 0; let pendingCR = false; let searchStart = 0;
    try {
      while (true) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try { next = await reader.read(); }
        catch { throw new Error('Octo MCP connection failed or timed out; configuration was not verified.'); }
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 1024 * 1024) throw new Error('Octo MCP discovery response is too large.');
        let chunk = decoder.decode(next.value, { stream: true });
        if (sse) {
          if (pendingCR) chunk = '\r' + chunk;
          pendingCR = chunk.endsWith('\r');
          if (pendingCR) chunk = chunk.slice(0, -1);
          text += chunk.replace(/\r\n/g, '\n');
          let end: number;
          while ((end = text.indexOf('\n\n', searchStart)) >= 0) {
            const event = text.slice(0, end); text = text.slice(end + 2); searchStart = 0;
            const payload = event.split('\n').filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).trimStart()).join('\n');
            if (!payload) continue;
            let parsed: any;
            try { parsed = JSON.parse(payload); } catch { throw new Error('Octo MCP returned invalid JSON.'); }
            if (parsed.id === requestId) return unwrap(parsed, requestId);
          }
          searchStart = Math.max(0, text.length - 1);
        } else text += chunk;
      }
      if (sse) throw new Error('Octo MCP stream ended without the requested result.');
      let parsed: any;
      try { parsed = JSON.parse(text + decoder.decode()); } catch { throw new Error('Octo MCP returned invalid JSON.'); }
      return unwrap(parsed, requestId);
    } finally { try { await reader.cancel(); } catch { /* Preserve the bounded primary error. */ } }
  }
  function unwrap(reply: any, requestId: number): any {
    if (reply?.jsonrpc !== '2.0' || reply.id !== requestId || reply.error || !reply.result) {
      throw new Error('Octo MCP returned an invalid or failed JSON-RPC result.');
    }
    return reply.result;
  }
  try {
    const initialized = await rpc('initialize', {
      protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'create-openclaw-octo', version: PLUGIN_VERSION },
    });
    if (initialized.serverInfo?.name !== 'octo-cli' || typeof initialized.protocolVersion !== 'string') {
      throw new Error('Configured MCP endpoint is not an Octo CLI MCP service.');
    }
    protocol = initialized.protocolVersion;
    await rpc('notifications/initialized', {}, true);
    const names: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 100) throw new Error('Octo MCP discovery pagination limit exceeded.');
      const listed = await rpc('tools/list', cursor === undefined ? {} : { cursor });
      if (!Array.isArray(listed.tools) || listed.tools.some((tool: any) => typeof tool?.name !== 'string')) {
        throw new Error('Octo MCP returned an invalid tools catalog.');
      }
      if (names.length + listed.tools.length > 10_000) throw new Error('Octo MCP discovery tool count limit exceeded.');
      names.push(...listed.tools.map((tool: any) => tool.name));
      if (listed.nextCursor == null) break;
      if (typeof listed.nextCursor !== 'string' || seen.has(listed.nextCursor)) {
        throw new Error('Octo MCP discovery returned an invalid or repeated pagination cursor.');
      }
      cursor = listed.nextCursor; seen.add(listed.nextCursor);
    }
    const two = ['get_skill', 'execute']; const three = ['search_ops', 'describe_op', 'call_op'];
    if (!(two.every(name => names.includes(name)) || three.every(name => names.includes(name)))) {
      throw new Error('Octo MCP discovery did not return a supported business tool facade.');
    }
    return { tools: names };
  } finally {
    if (session) {
      // A probe owns only its protocol session. Termination is best effort;
      // unsupported DELETE (405) and cleanup failures never mask the check.
      try {
        const response = await fetcher(url, {
          method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(2_000),
          headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': session, 'MCP-Protocol-Version': protocol },
        });
        await response.body?.cancel();
      } catch { /* Keep the primary success or sanitized failure. */ }
    }
  }
}
