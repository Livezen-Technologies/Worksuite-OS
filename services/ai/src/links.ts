// How the control service reaches the engine. In the session: `systemctl --user start worksuite-ai-engine.service`,
// whose unit gives it no network and memory/CPU limits, then its 0600 socket. In development and the smoke test:
// the engine as a child process on the same kind of socket.
import { execFile, spawn } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { readLines, writeLine } from './lines.ts';
import type { FromWorker, ToWorker } from './protocol.ts';
import type { WorkerLink } from './runtime.ts';

const UNIT = 'worksuite-ai-engine.service';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(path: string, tries = 100): Promise<Socket> {
  for (let i = 0; ; i++) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const s = createConnection(path);
        s.once('connect', () => { s.removeListener('error', reject); resolve(s); });
        s.once('error', reject);
      });
    } catch (e) {
      if (i >= tries) throw e;
      await wait(100);
    }
  }
}

function socketLink(sock: Socket, kill: () => void, exitReason: () => Promise<'exit' | 'oom'>): WorkerLink {
  const listeners: ((m: FromWorker) => void)[] = [];
  readLines(sock, 4 * 1024 * 1024, (line) => {
    let m: FromWorker;
    try { m = JSON.parse(line) as FromWorker; } catch { return; }
    for (const l of listeners) l(m);
  }, () => sock.destroy());
  sock.on('error', () => {});
  return {
    post: (m: ToWorker) => writeLine(sock, m),
    onMessage: (cb) => { listeners.push(cb); },
    onExit: (cb) => { sock.once('close', () => void exitReason().then(cb, () => cb('exit'))); },
    kill: () => { kill(); sock.destroy(); },
  };
}

const systemctl = (...args: string[]) => new Promise<string>((resolve, reject) => execFile('systemctl', ['--user', ...args], { timeout: 30_000 }, (e, out) => (e ? reject(e) : resolve(out))));

export function systemdEngine(socketPath: string): () => Promise<WorkerLink> {
  return async () => {
    await systemctl('start', UNIT);
    const sock = await connect(socketPath);
    return socketLink(sock, () => void systemctl('stop', UNIT).catch(() => {}), async () => {
      const r = await systemctl('show', '-p', 'Result', '--value', UNIT).catch(() => '');
      return /oom-kill/.test(r) ? 'oom' : 'exit';
    });
  };
}

export function childEngine(socketPath: string, entry: string): () => Promise<WorkerLink> {
  return async () => {
    const child = spawn(process.execPath, ['--no-warnings', entry, socketPath], { stdio: ['ignore', 'ignore', 'inherit'] });
    let signal: string | null = null;
    child.on('exit', (_c, s) => { signal = s; });
    const sock = await connect(socketPath);
    return socketLink(sock, () => child.kill('SIGTERM'), async () => (signal === 'SIGKILL' ? 'oom' : 'exit'));
  };
}
