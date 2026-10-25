import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { detectBrowser } from '../src/browser.js';
import { captureUrl, makeEnv, makeProject, type TestEnv } from './helpers.js';

const browser = await detectBrowser(true);

describe.skipIf(!browser.found)('WebSocket 不能绕过只读采集', () => {
  const sockets = new Set<Socket>();
  const connections: string[] = [];
  const messages: string[] = [];
  let target: Server;
  let fixture: Server;
  let targetPort: number;
  let fixturePort: number;
  let env: TestEnv | undefined;

  beforeAll(async () => {
    const track = (server: Server) => server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
    });
    target = createServer((_req, res) => res.end('controlled websocket fixture'));
    target.on('upgrade', (req, socket) => {
      connections.push(req.url ?? '');
      const accept = createHash('sha1')
        .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.on('data', (frame: Buffer) => {
        if ((frame[0]! & 15) !== 1 || frame.length < 6) return;
        const length = frame[1]! & 127;
        if (length >= 126 || frame.length < length + 6) return;
        const payload = Buffer.from(frame.subarray(6, 6 + length));
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ frame[2 + i % 4]!;
        messages.push(payload.toString());
        socket.end(Buffer.from([0x88, 0]));
      });
    });
    track(target);
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    targetPort = (target.address() as AddressInfo).port;
    fixture = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><title>WebSocket fixture</title></head><body><h1>本地受控页面</h1><script>
        const socket = new WebSocket('ws://127.0.0.1:${targetPort}/write-probe');
        socket.onopen = () => socket.send('controlled-mutation-message');
        socket.onerror = () => {};
      </script></body></html>`);
    });
    track(fixture);
    await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
    fixturePort = (fixture.address() as AddressInfo).port;
  });

  afterEach(() => { env?.cleanup(); env = undefined; });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, fixture].filter(Boolean).map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    })));
  });

  it.each([false, true])('白名单包含 WebSocket 目标:%s;不建立连接、不发送消息,并留下缺口', async allowTarget => {
    connections.length = 0;
    messages.length = 0;
    env = makeEnv();
    const domains = [`127.0.0.1:${fixturePort}`, ...(allowTarget ? [`127.0.0.1:${targetPort}`] : [])];
    const project = makeProject(env, domains);
    const capture = await captureUrl(env, project, `http://127.0.0.1:${fixturePort}/`);
    expect(connections).toEqual([]);
    expect(messages).toEqual([]);
    expect(capture.status).toBe('partial');
    expect(capture.evidenceId).not.toBeNull();
    expect(capture.notes.join(' ')).toContain('WebSocket');
    const gaps = env.repo.listGaps(project.id);
    expect(gaps.some(g => g.type === 'request_blocked' && /WebSocket/.test(g.description))).toBe(true);
    expect(gaps.some(g => g.type === 'out_of_scope')).toBe(!allowTarget);
  });
});
