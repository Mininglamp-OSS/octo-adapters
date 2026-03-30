import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Track mock WS instances created during tests
const mockWsInstances: any[] = [];

// Mock ws module — factory must not reference outer variables
vi.mock("ws", () => {
  class MockWS {
    static OPEN = 1;
    binaryType = "arraybuffer";
    readyState = 1;
    private handlers = new Map<string, Function[]>();

    constructor(public url: string) {
      // Push to the shared tracking array (imported via globalThis)
      (globalThis as any).__mockWsInstances?.push(this);
    }

    on(event: string, handler: Function) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event)!.push(handler);
    }

    send = vi.fn();

    close() {
      queueMicrotask(() => this.emit("close"));
    }

    emit(event: string, ...args: any[]) {
      const handlers = this.handlers.get(event);
      if (handlers) {
        for (const h of handlers) h(...args);
      }
    }
  }

  return { default: MockWS, WebSocket: MockWS };
});

// Mock curve25519-js to avoid real crypto in tests
vi.mock("curve25519-js", () => ({
  generateKeyPair: () => ({
    private: new Uint8Array(32),
    public: new Uint8Array(32),
  }),
  sharedKey: () => new Uint8Array(32),
}));

import { WKSocket } from "./socket.js";

describe("WKSocket reconnection", () => {
  let originalSetTimeout: typeof setTimeout;
  let setTimeoutCalls: { fn: Function; delay: number }[];

  beforeEach(() => {
    mockWsInstances.length = 0;
    (globalThis as any).__mockWsInstances = mockWsInstances;
    setTimeoutCalls = [];
    originalSetTimeout = global.setTimeout;

    global.setTimeout = vi.fn((fn: Function, delay?: number) => {
      setTimeoutCalls.push({ fn, delay: delay ?? 0 });
      return 999 as any;
    }) as any;
  });

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
    delete (globalThis as any).__mockWsInstances;
    vi.restoreAllMocks();
  });

  function createSocket(overrides: Partial<ConstructorParameters<typeof WKSocket>[0]> = {}) {
    return new WKSocket({
      wsUrl: "ws://test:5200",
      uid: "bot1",
      token: "tok1",
      onMessage: vi.fn(),
      ...overrides,
    });
  }

  describe("exponential backoff in scheduleReconnect", () => {
    it("should increase delay with each reconnect attempt", () => {
      const socket = createSocket();
      socket.connect();

      const ws = mockWsInstances[0];
      expect(ws).toBeDefined();

      for (let i = 0; i < 5; i++) {
        setTimeoutCalls = [];
        ws.emit("close");

        expect(setTimeoutCalls.length).toBe(1);
        const delay = setTimeoutCalls[0].delay;

        // Expected base: 3000 * 2^i, with ±25% jitter
        const expectedBase = 3000 * Math.pow(2, i);
        const minDelay = Math.floor(expectedBase * 0.75);
        const maxDelay = Math.floor(expectedBase * 1.25);
        expect(delay).toBeGreaterThanOrEqual(minDelay);
        expect(delay).toBeLessThanOrEqual(maxDelay);
      }
    });

    it("should cap delay at 60 seconds", () => {
      const socket = createSocket();
      socket.connect();

      const ws = mockWsInstances[0];

      // Simulate many reconnect attempts to exceed the cap
      for (let i = 0; i < 20; i++) {
        setTimeoutCalls = [];
        ws.emit("close");
      }

      // After 20 attempts, delay should be capped at 60000ms (with ±25% jitter)
      const lastDelay = setTimeoutCalls[0].delay;
      expect(lastDelay).toBeLessThanOrEqual(75000); // 60000 * 1.25
      expect(lastDelay).toBeGreaterThanOrEqual(45000); // 60000 * 0.75
    });
  });

  describe("stale WebSocket close event guard", () => {
    it("should ignore close events from a previous WebSocket instance", () => {
      const onDisconnected = vi.fn();
      const socket = createSocket({ onDisconnected });
      socket.connect();

      const oldWs = mockWsInstances[0];

      // Disconnect and reconnect — creates a new WS instance
      socket.disconnect();
      socket.connect();
      const newWs = mockWsInstances[1];
      expect(newWs).toBeDefined();
      expect(newWs).not.toBe(oldWs);

      // Fire close on the OLD WebSocket — should be ignored
      setTimeoutCalls = [];
      oldWs.emit("close");

      // No reconnect should be scheduled from the stale close event
      expect(setTimeoutCalls.length).toBe(0);
    });

    it("should process close events from the current WebSocket instance", () => {
      const socket = createSocket();
      socket.connect();

      const ws = mockWsInstances[0];

      setTimeoutCalls = [];
      ws.emit("close");

      expect(setTimeoutCalls.length).toBe(1);
    });
  });

  describe("reconnectAttempts reset on successful CONNACK", () => {
    it("should reset reconnect attempts counter after successful connection", () => {
      const onConnected = vi.fn();
      const socket = createSocket({ onConnected });
      socket.connect();

      const ws = mockWsInstances[0];

      // Build up reconnect attempts
      for (let i = 0; i < 5; i++) {
        ws.emit("close");
      }

      // Build a minimal CONNACK packet:
      // Header byte: (CONNACK=2 << 4) | 1 (hasServerVersion flag)
      const serverVersion = 4;
      const reasonCode = 1; // success
      const serverKey = Buffer.from(new Uint8Array(32)).toString("base64");
      const salt = "1234567890123456"; // 16 chars

      const body: number[] = [];
      body.push(serverVersion);
      // timeDiff (8 bytes)
      for (let i = 0; i < 8; i++) body.push(0);
      body.push(reasonCode);
      // serverKey as string (2-byte length prefix + data)
      const keyBytes = [...Buffer.from(serverKey)];
      body.push((keyBytes.length >> 8) & 0xff, keyBytes.length & 0xff);
      body.push(...keyBytes);
      // salt as string
      const saltBytes = [...Buffer.from(salt)];
      body.push((saltBytes.length >> 8) & 0xff, saltBytes.length & 0xff);
      body.push(...saltBytes);
      // nodeId (8 bytes for version >= 4)
      for (let i = 0; i < 8; i++) body.push(0);

      const header = (2 << 4) | 1; // CONNACK with hasServerVersion
      const packet = new Uint8Array([header, body.length, ...body]);

      // Trigger the open event first so DH keypair is generated
      ws.emit("open");

      // Now send CONNACK
      ws.emit("message", packet.buffer);

      expect(onConnected).toHaveBeenCalled();

      // After successful CONNACK, next close+reconnect should use base delay
      setTimeoutCalls = [];
      ws.emit("close");

      if (setTimeoutCalls.length > 0) {
        const delay = setTimeoutCalls[0].delay;
        // Should be around 3000ms (base delay, attempt 0) with ±25% jitter
        expect(delay).toBeGreaterThanOrEqual(2250);
        expect(delay).toBeLessThanOrEqual(3750);
      }
    });
  });
});
