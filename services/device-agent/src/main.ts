// worksuite-device-agent: root daemon, plus a small CLI that talks to it over a root-only socket.
//   worksuite-device-agent                      run the daemon (systemd)
//   worksuite-device-agent enroll --server URL  enrollment token on stdin (never on the command line); polkit via pkexec
//   worksuite-device-agent status | refresh
import { publicPolicy } from './kiosk.ts';
import { createPublicKey, type KeyObject } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { Agent } from './agent.ts';
import { httpApi } from './api.ts';
import { DEFAULT_PATHS, linuxHost, remoteSupportHost } from './host.ts';
import { consentDispatch, RemoteSupport } from './remoteSupport.ts';
import { unattendedRemoteSupport } from './agent.ts';
import { StateFile } from './state.ts';
import { serveBus } from './dbus.ts';
import { forwardPackageAudit } from './auditForward.ts';
import { serveControl, serveSocket } from './control.ts';
import { applyPendingEnrollment } from './pendingEnroll.ts';
import { SecurityCenter } from './securityCenter.ts';
import { linuxSecurityHost } from './securityHost.ts';
import { recordPowerEvent } from './power.ts';

const KEY_DIR = '/usr/share/worksuite/keys/device-commands';   // from worksuite-archive-keyring
const SOCKET = join(DEFAULT_PATHS.runtimeDir, 'control.sock');
const CONSENT_SOCKET = join(DEFAULT_PATHS.runtimeDir, 'remote-support.sock');
const REMOTE_SUPPORT_POLL_MS = 10_000;
const CHECK_IN_MS = 15 * 60_000;
const POLICY_MS = 60 * 60_000;
const INVENTORY_MS = 24 * 60 * 60_000;
const POWER_EVENTS = join(DEFAULT_PATHS.stateDir, 'power-events.json');   // src/power.ts
const PACKAGE_AUDIT_LOG = '/var/log/worksuite/package-service-audit.log';   // written by worksuite-package-service

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
  const api = httpApi(() => state.state);
  const remoteSupport = new RemoteSupport({
    now: Date.now,
    ...remoteSupportHost(),
    unattendedPolicy: () => state.state.enrolled && unattendedRemoteSupport(state.state.policy),
    report: (id, r) => api.remoteSupportState(id, r),
    audit: (e, f) => host.audit(e, f),
  });

  const security = new SecurityCenter({
    state, host: linuxSecurityHost({ stateDir: DEFAULT_PATHS.stateDir, runtimeDir: DEFAULT_PATHS.runtimeDir, audit: (e, f) => host.audit(e, f) }),
    managed: () => ({ enrolled: state.state.enrolled, policy: state.state.policy ?? null, server: state.state.server_url ?? null }),
  });
  // A scan unit left running by a previous agent process would never be recorded: stop it (#64).
  void security.stopStaleScan();
  const agent = new Agent({ state, host, api, keys: loadKeys(KEY_DIR), security, remoteSupport, powerEventsFile: POWER_EVENTS });

  // /run is empty after boot: republish what user services and Settings read.
  host.publishCredential(state.state.enrolled ? state.state.credential ?? null : null);
  host.publishPolicy(state.state.enrolled && state.state.policy ? publicPolicy(state.state.policy) : null);
  agent.publishStatus();
  // Policy settings are re-applied at every start, so a local edit or a missed change does not persist.
  void agent.enforce();
  void agent.refreshFacts().catch(() => {});

  let busy: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => { const p = busy.then(fn, fn); busy = p.catch(() => {}); return p; };
  const safe = (what: string, fn: () => Promise<unknown>) => serial(fn).catch((e) => host.audit(`${what}_failed`, { error: String(e?.message ?? e) }));

  // Root only (0600); pkexec runs the CLI as root.
  const server = serveControl(SOCKET, {
    enroll: (url, token) => serial(() => agent.enroll(url, token)),
    refresh: async () => { await safe('refresh', async () => { await agent.refreshPolicy(); await agent.checkIn(); }); return agent.status(); },
    status: () => agent.status(),
  });

  // Remote support consent (issue #19): any local user may end a session or drop control; only the seat user, with
  // the nonce in consent/<uid>, may grant. 0666 so the shell (running as that user) can connect.
  const consent = serveSocket(CONSENT_SOCKET, (line) => consentDispatch(remoteSupport, line).finally(() => agent.publishStatus()), 0o666);

  // lk.worksuite.DeviceAgent1 (WSOS-ARC-002): what Settings and first-run call, each privileged method behind polkit.
  // The root-only socket stays for the admin CLI. No bus (rescue shell) just means no D-Bus API.
  await serveBus({
    status: () => agent.status(),
    effectivePolicy: () => (state.state.enrolled && state.state.policy ? publicPolicy(state.state.policy) : null),
    enroll: (url, token) => serial(() => agent.enroll(url, token)),
    refresh: async () => { await safe('refresh', async () => { await agent.refreshPolicy(); await agent.checkIn(); }); },
    scan: (kind) => security.startScan(kind, 'user'),
    cancelScan: () => security.cancelScan(),
    updateDefinitions: () => security.updateDefinitions(),
    restore: (id) => security.restore(id, false, 'user'),
    deleteQuarantined: (id) => security.deleteQuarantined(id, 'user'),
    resolveSuspended: (id, action) => security.resolveSuspended(id, action, 'user'),
  }).catch((e) => host.audit('dbus_unavailable', { error: String(e?.message ?? e) }));

  const jitter = (ms: number) => ms + Math.floor(Math.random() * ms * 0.2);
  const every = (ms: number, what: string, fn: () => Promise<unknown>) => {
    const tick = () => { void safe(what, fn).finally(() => setTimeout(tick, jitter(ms))); };
    setTimeout(tick, jitter(10_000));
  };
  // Enrollment chosen in the installer (WSOS-INS-006): tried at start and every 5 minutes until it is done or dropped.
  let pending = true;
  every(5 * 60_000, 'installer_enrollment', async () => {
    if (!pending) return;
    const r = await applyPendingEnrollment({ enrolled: () => state.state.enrolled, enroll: (u, t) => agent.enroll(u, t), audit: (e, d) => host.audit(e, d) });
    if (r !== 'retry') pending = false;
  });
  every(CHECK_IN_MS, 'check_in', () => agent.checkIn());
  // Not serialised behind check-ins: a support request should reach the user within seconds. Network errors are quiet.
  const rsTick = () => { void agent.pollRemoteSupport().catch(() => {}).finally(() => setTimeout(rsTick, REMOTE_SUPPORT_POLL_MS)); };
  setTimeout(rsTick, REMOTE_SUPPORT_POLL_MS);
  every(POLICY_MS, 'policy', () => agent.refreshPolicy());
  every(5 * 60_000, 'package_audit', async () => {
    if (!state.state.enrolled) return;
    const api = httpApi(() => state.state);
    await forwardPackageAudit({ path: PACKAGE_AUDIT_LOG, cursor: state.state.package_audit ?? { offset: 0 }, send: (ev) => api.audit(ev), save: (c) => state.update((s) => { s.package_audit = c; }) });
  });
  // WorkSuite Security: retention, firewall alerts, engine health, scheduled scans when idle (#20 §11, §13).
  every(30 * 60_000, 'security', () => security.tick());
  every(INVENTORY_MS, 'inventory', async () => { if (state.state.enrolled) await httpApi(() => state.state).inventory(await host.inventory()); });

  process.on('SIGTERM', () => { security.close(); server.close(); consent.close(); void remoteSupport.end('user_ended').finally(() => process.exit(0)); });
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
  // worksuite-power-events.service (#39): no daemon or network needed, so it works at boot and during shutdown.
  if (cmd === 'power-event') {
    const type = rest[0];
    if (type !== 'startup' && type !== 'shutdown') { process.stderr.write('usage: worksuite-device-agent power-event startup|shutdown\n'); process.exitCode = 2; return; }
    recordPowerEvent(POWER_EVENTS, type, new StateFile(join(DEFAULT_PATHS.stateDir, 'state.json')).state);
    return;
  }
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
