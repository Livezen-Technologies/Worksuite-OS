// pam_exec entry point:  worksuite-pam-directory auth|session|rotate
//   auth:    `pam_exec.so quiet expose_authtok` — password on stdin (NUL-terminated), PAM_USER in the environment.
//   session: `pam_exec.so quiet type=open_session`.
//   rotate:  worksuite-breakglass-rotate.service.
// Exit 0 = PAM_SUCCESS; anything else fails (the PAM stack treats it as "ignore" for non-directory names).
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { authenticate, rotate, ServerError, session, type Accounts, type Deps, type Server, type Store } from './directory.ts';

const STATE_DIR = process.env.WORKSUITE_DIRECTORY_STATE ?? '/var/lib/worksuite-directory';
const AGENT_STATE = process.env.WORKSUITE_AGENT_STATE ?? '/var/lib/worksuite-device-agent/state.json';

const readJson = <T>(p: string, dflt: T): T => { try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return dflt; } };
function writeJson(p: string, v: unknown) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(p + '.tmp', JSON.stringify(v), { mode: 0o600 });
  renameSync(p + '.tmp', p);
}

export function httpServer(fetchImpl: typeof fetch = fetch): Server {
  const call = async (method: string, path: string, body?: unknown, idem = false) => {
    const s = readJson<{ server_url?: string; credential?: string }>(AGENT_STATE, {});
    if (!s.server_url || !s.credential) throw new ServerError(0, 'NOT_ENROLLED');
    const url = new URL(path, s.server_url);
    if (url.protocol !== 'https:') throw new ServerError(0, 'INSECURE_URL');
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'x-ws-device': s.credential, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': randomUUID() } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new ServerError(0, 'NETWORK'); }
    const text = await res.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { throw new ServerError(0, 'BAD_RESPONSE'); }
    // 5xx means the directory cannot decide right now: treat like offline.
    if (res.status >= 500) throw new ServerError(0, `HTTP_${res.status}`);
    if (res.status >= 400) throw new ServerError(res.status, json?.error?.code ?? `HTTP_${res.status}`);
    return json;
  };
  return {
    authenticate: (username, password) => call('POST', 'desktop/v1/os/directory/authenticate', { username, password }),
    directory: () => call('GET', 'desktop/v1/os/directory'),
    escrow: async (b) => { await call('POST', 'desktop/v1/os/break-glass', b, true); },
    event: async (e) => { await call('POST', 'desktop/v1/os/break-glass/events', e, true); },
  };
}

export const fileStore = (): Store => ({
  cache: () => readJson(join(STATE_DIR, 'cache.json'), {}),
  saveCache: (c) => writeJson(join(STATE_DIR, 'cache.json'), c),
  pending: () => readJson(join(STATE_DIR, 'pending-events.json'), []),
  savePending: (p) => writeJson(join(STATE_DIR, 'pending-events.json'), p),
});

const run = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) =>
  execFile(cmd, args, { timeout: 30_000 }, (err) => (err ? reject(new Error(`${cmd} failed`)) : resolve())));

export const systemAccounts = (): Accounts => ({
  uid(name) {
    for (const line of (readFileSync('/etc/passwd', 'utf8')).split('\n')) {
      const f = line.split(':');
      if (f[0] === name) return Number(f[2]);
    }
    return null;
  },
  // Locked local password ('!'): only this helper authenticates directory users. pam_mkhomedir creates the home.
  create: (name, uid, comment) => run('useradd', ['--uid', String(uid), '--user-group', '--no-create-home', '--home-dir', `/home/${name}`,
    '--shell', '/bin/bash', '--comment', comment, '--', name]),
  setGroups: async (name, groups) => {
    for (const g of ['sudo']) await run('gpasswd', [groups.includes(g) ? '--add' : '--delete', name, g]).catch(() => {});
  },
  lock: (name) => run('usermod', ['--lock', '--', name]),
  unlock: (name) => run('usermod', ['--unlock', '--', name]).catch(() => {}),
  setPassword: (name, password) => new Promise((resolve, reject) => {
    const c = spawn('chpasswd', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('error', () => reject(new Error('chpasswd failed')));
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error('chpasswd failed'))));
    c.stdin.end(`${name}:${password}\n`);
  }),
  startRotation: () => run('systemctl', ['start', '--no-block', 'worksuite-breakglass-rotate.service']).catch(() => {}),
});

/** Journal (authpriv) via logger; messages carry user names and outcomes only. */
const journal = (msg: string) => { execFile('logger', ['-p', 'authpriv.notice', '-t', 'worksuite-directory', '--', msg], () => {}); };

async function readSecret(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf8');
  const nul = s.indexOf('\0');
  return nul >= 0 ? s.slice(0, nul) : s.replace(/\n$/, '');
}

export async function main(argv: string[], deps: Deps = { server: httpServer(), store: fileStore(), accounts: systemAccounts(), log: journal }): Promise<number> {
  const user = process.env.PAM_USER ?? '';
  switch (argv[0]) {
    case 'auth': {
      const r = await authenticate(deps, user, await readSecret());
      return r === 'ok' || r === 'ok_offline' ? 0 : 1;
    }
    case 'session':
      if (process.env.PAM_TYPE && process.env.PAM_TYPE !== 'open_session') return 0;
      await session(deps, user);
      return 0;
    case 'rotate':
      return (await rotate(deps)) === 'rotated' ? 0 : 3;
    default:
      process.stderr.write('usage: worksuite-pam-directory auth|session|rotate\n');
      return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, () => { process.exitCode = 1; });
}
