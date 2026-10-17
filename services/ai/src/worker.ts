// worksuite-ai-engine: llama.cpp, alone in its own process and systemd unit, so a crash or running out of memory
// ends this process and not the service, it can be stopped to give the memory back, and it runs with no network
// (RestrictAddressFamilies=AF_UNIX, PrivateNetwork=yes) and with memory and CPU limits. It reads only the model file
// the control service names, after that service has checked the file's SHA-256. Nothing it is asked is logged.
import { createServer, type Socket } from 'node:net';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { LocalAIEngine, isOutOfMemory } from './engine.ts';
import { readLines, writeLine } from './lines.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

const MAX_LINE = 2 * 1024 * 1024;

export function serveEngine(path: string, engine = new LocalAIEngine()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const running = new Map<string, AbortController>();
  let peer: Socket | null = null;
  const send = (m: FromWorker) => { if (peer) writeLine(peer, m); };
  const code = (e: unknown, fallback: string) => (isOutOfMemory(e) ? 'out_of_memory' : /^[a-z_]{3,40}$/.test(String((e as Error)?.message)) ? (e as Error).message : fallback);

  const onMessage = (msg: ToWorker) => {
    switch (msg.type) {
      case 'ping': send({ type: 'pong', n: msg.n }); return;
      case 'init':
        engine.init(msg.opts).then((info) => send({ type: 'ready', info }), (e: unknown) => send({ type: 'error', op: 'init', code: code(e, 'engine_failed') }));
        return;
      case 'load':
        engine.load(msg.path).then((r) => send({ type: 'loaded', path: msg.path, contextLength: r.contextLength }), (e: unknown) => send({ type: 'error', op: 'load', code: code(e, 'load_failed') }));
        return;
      case 'unload': void engine.unload().then(() => send({ type: 'unloaded' })); return;
      case 'cancel': running.get(msg.id)?.abort(); return;
      case 'generate': {
        const ac = new AbortController();
        running.set(msg.req.id, ac);
        engine.generate(msg.req, (text) => send({ type: 'chunk', id: msg.req.id, text }), ac.signal)
          .then((r) => send({ type: 'done', id: msg.req.id, ...r }), (e: unknown) => send({ type: 'error', id: msg.req.id, code: code(e, 'generate_failed') }))
          .finally(() => running.delete(msg.req.id));
        return;
      }
    }
  };

  const server = createServer((sock) => {
    // One client: the control service. A second connection replaces the first.
    peer?.destroy();
    peer = sock;
    sock.on('error', () => {});
    sock.on('close', () => { if (peer === sock) { peer = null; for (const ac of running.values()) ac.abort(); } });
    readLines(sock, MAX_LINE, (line) => {
      let m: ToWorker;
      try { m = JSON.parse(line) as ToWorker; } catch { return; }
      if (m && typeof m === 'object' && typeof m.type === 'string') onMessage(m);
    }, () => sock.destroy());
  });
  // umask first, then chmod: the socket is never reachable by another user, not even for an instant.
  const old = process.umask(0o177);
  server.listen(path, () => { process.umask(old); chmodSync(path, 0o600); });
  return { server, engine };
}
