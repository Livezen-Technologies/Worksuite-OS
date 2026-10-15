// worksuite-device-agent: root daemon, plus a small CLI that talks to it over a root-only socket.
//   worksuite-device-agent                      run the daemon (systemd)
//   worksuite-device-agent enroll --server URL  enrollment token on stdin (never on the command line); polkit via pkexec
//   worksuite-device-agent status | refresh
import { createPublicKey, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { Agent } from './agent.ts';
import { httpApi } from './api.ts';
import { DEFAULT_PATHS, linuxHost } from './host.ts';
import { StateFile } from './state.ts';

const KEY_DIR = '/usr/share/worksuite/keys/device-commands';   // from worksuite-archive-keyring
const SOCKET = join(DEFAULT_PATHS.runtimeDir, 'control.sock');
const CHECK_IN_MS = 15 * 60_000;
const POLICY_MS = 60 * 60_000;
const INVENTORY_MS = 24 * 60 * 60_000;

/** Server signing keys by id: <KEY_DIR>/<key_id>.pem. */
export function loadKeys(dir: string): (id: string) => KeyObject | undefined {
  const keys = new Map<string, KeyObject>();
  if (existsSync(dir)) for (const f of readdirSync(dir)) {
    if (f.endsWith('.pem')) keys.set(f.slice(0, -4), createPublicKey(readFileSync(join(dir, f))));
  }
  return (id) => keys.get(id);
}

async function daemon() {
  const state = new StateFile(join(DEFAULT_PATHS.stateDir, 'state.json'));
  const host = linuxHost();
  const agent = new Agent({ state, host, api: httpApi(() => state.state), keys: loadKeys(KEY_DIR) });

  // /run is empty after boot: republish what user services and Settings read.
  host.publishCredential(state.state.enrolled ? state.state.credential ?? null : null);
  host.publishPolicy(state.state.enrolled ? state.state.policy ?? null : null);
  agent.publishStatus();
  void agent.refreshFacts().catch(() => {});

  let busy: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => { const p = busy.then(fn, fn); busy = p.catch(() => {}); return p; };
  const safe = (what: string, fn: () => Promise<unknown>) => serial(fn).catch((e) => host.audit(`${what}_failed`, { error: String(e?.message ?? e) }));

  const server = createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', async (c) => {
      buf += c;
      if (buf.length > 16 * 1024) return sock.destroy();
      const nl = buf.indexOf('\n'); if (nl < 0) return;
      let req: { method?: string; params?: Record<string, unknown> };
      try { req = JSON.parse(buf.slice(0, nl)); } catch { return sock.end('{"error":"bad_request"}\n'); }
      const p = req.params ?? {};
      try {
        if (req.method === 'Enroll' && typeof p.server_url === 'string' && typeof p.enrollment_token === 'string') {
          const id = await serial(() => agent.enroll(p.server_url as string, p.enrollment_token as string));
          return sock.end(JSON.stringify({ result: id }) + '\n');
        }
        if (req.method === 'Refresh') { await safe('refresh', async () => { await agent.refreshPolicy(); await agent.checkIn(); }); return sock.end(JSON.stringify({ result: agent.status() }) + '\n'); }
        if (req.method === 'Status') return sock.end(JSON.stringify({ result: agent.status() }) + '\n');
        sock.end('{"error":"unknown_method"}\n');
      } catch (e) { sock.end(JSON.stringify({ error: String((e as Error).message) }) + '\n'); }
    });
    sock.on('error', () => {});
  });
  rmSync(SOCKET, { force: true });
  server.listen(SOCKET, () => chmodSync(SOCKET, 0o600));   // root only; pkexec runs the CLI as root

  const jitter = (ms: number) => ms + Math.floor(Math.random() * ms * 0.2);
  const every = (ms: number, what: string, fn: () => Promise<unknown>) => {
    const tick = () => { void safe(what, fn).finally(() => setTimeout(tick, jitter(ms))); };
    setTimeout(tick, jitter(10_000));
  };
  every(CHECK_IN_MS, 'check_in', () => agent.checkIn());
  every(POLICY_MS, 'policy', () => agent.refreshPolicy());
  every(INVENTORY_MS, 'inventory', async () => { if (state.state.enrolled) await httpApi(() => state.state).inventory(await host.inventory()); });

  process.on('SIGTERM', () => { server.close(); process.exit(0); });
  host.audit('started', { enrolled: state.state.enrolled });
}

function cli(method: string, params: Record<string, unknown> = {}) {
  return new Promise<void>((resolve) => {
    const s = createConnection(SOCKET);
    let buf = '';
    s.setEncoding('utf8');
    s.on('connect', () => s.write(JSON.stringify({ method, params }) + '\n'));
    s.on('data', (c) => { buf += c; });
    s.on('end', () => {
      const r = JSON.parse(buf || '{"error":"no_reply"}');
      if (r.error) { process.stderr.write(`error: ${r.error}\n`); process.exitCode = 1; } else process.stdout.write(JSON.stringify(r.result, null, 2) + '\n');
      resolve();
    });
    s.on('error', () => { process.stderr.write('error: device agent is not running\n'); process.exitCode = 1; resolve(); });
  });
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd) return daemon();
  if (cmd === 'status') return cli('Status');
  if (cmd === 'refresh') return cli('Refresh');
  if (cmd === 'enroll') {
    const i = rest.indexOf('--server');
    const server = i >= 0 ? rest[i + 1] : undefined;
    if (!server) { process.stderr.write('usage: worksuite-device-agent enroll --server https://… < token\n'); process.exitCode = 2; return; }
    const token = readFileSync(0, 'utf8').trim();
    if (!token) { process.stderr.write('error: enrollment token expected on stdin\n'); process.exitCode = 2; return; }
    return cli('Enroll', { server_url: server, enrollment_token: token });
  }
  process.stderr.write(`unknown command: ${cmd}\n`); process.exitCode = 2;
}

if (import.meta.main) main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
