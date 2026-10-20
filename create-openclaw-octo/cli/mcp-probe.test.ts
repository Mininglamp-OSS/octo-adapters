import { describe, expect, it, vi } from 'vitest';
import { probeOctoMcp } from './mcp-probe.js';

describe('Streamable HTTP MCP binding checks', () => {
  it.each([['get_skill', 'execute'], ['search_ops', 'describe_op', 'call_op']])
    ('initializes and discovers facade %j without mutations', async (...names: any[]) => {
      const tools = names.flat(); const requests: any[] = [];
      const fetcher = vi.fn(async (_url: any, init: any) => {
        requests.push(init); const req = JSON.parse(init.body);
        if (!('id' in req)) return new Response(null, { status: 202 });
        const result = req.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'octo-cli', version: 'test' } }
          : { tools: tools.map((name: string) => ({ name })) };
        return Response.json({ jsonrpc: '2.0', id: req.id, result }, { headers: { 'Mcp-Session-Id': 'session-a' } });
      });
      const result = await probeOctoMcp('http://127.0.0.1:29861/', 'bf_a', fetcher as any);
      expect(result.tools).toEqual(tools);
      expect(requests.filter(x => x.method === 'POST').map(x => JSON.parse(x.body).method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
      expect(requests.every(x => x.redirect === 'error')).toBe(true);
      expect(requests[2].headers['Mcp-Session-Id']).toBe('session-a');
      expect(requests[2].headers.Authorization).toBe('Bearer bf_a');
    });
  it('discovers over chunked SSE with notifications and multiline data', async () => {
    const fetcher = vi.fn(async (_: any, init: any) => {
      const req = JSON.parse(init.body);
      if (!('id' in req)) return new Response(null, { status: 202 });
      const result = req.method === 'initialize'
        ? { protocolVersion: '2025-06-18', serverInfo: { name: 'octo-cli' } }
        : { tools: [{ name: 'get_skill' }, { name: 'execute' }] };
      const wire = 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n'
        + `data: {"jsonrpc":"2.0","id":${req.id},\r\ndata: "result":${JSON.stringify(result)}}\r\n\r\n`;
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ start(controller) {
        for (let i = 0; i < wire.length; i += 3) controller.enqueue(encoder.encode(wire.slice(i, i + 3)));
        controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    });
    await expect(probeOctoMcp('https://mcp.test/', 'bf_fixture', fetcher as any)).resolves.toEqual({ tools: ['get_skill', 'execute'] });
  });
  it('bounds oversized SSE responses', async () => {
    const fetcher = vi.fn(async () => new Response('data: ' + 'x'.repeat(1024 * 1024), { headers: { 'content-type': 'text/event-stream' } }));
    await expect(probeOctoMcp('https://mcp.test/', 'bf_fixture', fetcher as any)).rejects.toThrow(/too large/i);
  });
  it('normalizes response stream aborts without exposing raw transport errors', async () => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.error(new DOMException('raw fixture transport detail', 'TimeoutError'));
    } }), { headers: { 'content-type': 'text/event-stream' } }));
    await expect(probeOctoMcp('https://mcp.test/', 'bf_fixture', fetcher as any)).rejects.toThrow(/connection failed or timed out/i);
  });
  it('does not expose server error bodies or credentials', async () => {
    const fetcher = vi.fn(async () => new Response('secret bf_a', { status: 401 }));
    await expect(probeOctoMcp('https://mcp.test/', 'bf_a', fetcher as any)).rejects.toThrow('HTTP 401');
    await expect(probeOctoMcp('https://mcp.test/', 'bf_a', fetcher as any)).rejects.not.toThrow('bf_a');
  });
  it('refuses an unrelated MCP service', async () => {
    const fetcher = vi.fn(async (_: any, init: any) => {
      const req = JSON.parse(init.body);
      return Response.json({ jsonrpc: '2.0', id: req.id, result: { serverInfo: { name: 'other' }, tools: [{ name: 'shell' }] } });
    });
    await expect(probeOctoMcp('https://mcp.test/', 'bf_a', fetcher as any)).rejects.toThrow(/Octo/);
  });
});

describe('bounded catalog pagination', () => {
  function paged(pages: any[]) {
    let page = 0; const cursors: any[] = [];
    const fetcher = async (_: any, init: any) => {
      const req = JSON.parse(init.body);
      if (!('id' in req)) return new Response(null, { status: 202 });
      const result = req.method === 'initialize'
        ? { protocolVersion: '2025-06-18', serverInfo: { name: 'octo-cli' } }
        : (cursors.push(req.params), pages[Math.min(page++, pages.length - 1)]);
      return Response.json({ jsonrpc: '2.0', id: req.id, result });
    };
    return { fetcher, cursors };
  }
  it('collects a facade split over pages and forwards opaque cursors', async () => {
    const { fetcher, cursors } = paged([{ tools: [{ name: 'get_skill' }], nextCursor: 'opaque+/=' }, { tools: [{ name: 'execute' }] }]);
    await expect(probeOctoMcp('https://mcp.test/', 'bf_fixture', fetcher)).resolves.toEqual({ tools: ['get_skill', 'execute'] });
    expect(cursors).toEqual([{}, { cursor: 'opaque+/=' }]);
  });
  it('rejects cursor loops even when the first page contains a complete facade', async () => {
    const { fetcher } = paged([{ tools: [{ name: 'get_skill' }, { name: 'execute' }], nextCursor: 'repeat' }]);
    await expect(probeOctoMcp('https://mcp.test/', 'bf_fixture', fetcher)).rejects.toThrow(/cursor|pagination/i);
  });
  it('bounds unique pages and total tools', async () => {
    const { fetcher } = paged(Array.from({ length: 101 }, (_, i) => ({ tools: [{ name: 'get_skill' }, { name: 'execute' }], nextCursor: String(i) })));
    await expect(probeOctoMcp('https://mcp.test/', 'bf_fixture', fetcher)).rejects.toThrow(/limit|pagination/i);
    const oversized = paged([{ tools: Array.from({ length: 10001 }, () => ({ name: 'get_skill' })) }]);
    await expect(probeOctoMcp('https://mcp.test/', 'bf_fixture', oversized.fetcher)).rejects.toThrow(/limit|large/i);
  });
});

describe('probe session cleanup', () => {
  it.each([false, true])('terminates an allocated session after success or discovery failure (failure=%s)', async failure => {
    const deletes: any[] = [];
    const fetcher = async (_: any, init: any) => {
      if (init.method === 'DELETE') { deletes.push(init); return new Response(null, { status: 405 }); }
      const req = JSON.parse(init.body);
      if (!('id' in req)) return new Response(null, { status: 202 });
      if (req.method === 'tools/list' && failure) return new Response('private server body', { status: 500 });
      return Response.json({ jsonrpc: '2.0', id: req.id, result: req.method === 'initialize'
        ? { protocolVersion: '2025-06-18', serverInfo: { name: 'octo-cli' } }
        : { tools: [{ name: 'get_skill' }, { name: 'execute' }] } }, { headers: { 'Mcp-Session-Id': 'session-fixture' } });
    };
    const running = probeOctoMcp('https://mcp.test/', 'bf_fixture', fetcher);
    if (failure) await expect(running).rejects.toThrow('HTTP 500');
    else await expect(running).resolves.toEqual({ tools: ['get_skill', 'execute'] });
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer bf_fixture', 'Mcp-Session-Id': 'session-fixture', 'MCP-Protocol-Version': '2025-06-18' } });
    expect(deletes[0].body).toBeUndefined();
    expect(deletes[0].signal).toBeInstanceOf(AbortSignal);
  });
  it('does not replace a successful probe with a cleanup transport error', async () => {
    const fetcher = async (_: any, init: any) => {
      if (init.method === 'DELETE') throw new Error('secret transport failure');
      const req = JSON.parse(init.body);
      if (!('id' in req)) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: '2.0', id: req.id, result: req.method === 'initialize'
        ? { protocolVersion: '2025-06-18', serverInfo: { name: 'octo-cli' } }
        : { tools: [{ name: 'get_skill' }, { name: 'execute' }] } }, { headers: { 'Mcp-Session-Id': 'session-fixture' } });
    };
    await expect(probeOctoMcp('https://mcp.test/', 'bf_fixture', fetcher)).resolves.toEqual({ tools: ['get_skill', 'execute'] });
  });
});
