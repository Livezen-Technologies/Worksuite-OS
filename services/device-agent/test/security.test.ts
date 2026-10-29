import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exclusionArgs, isolationPlan, parseClamscan, parseClamVersion, parseFirewallLog, parseScanLine, pruneSecurity, renderPolicyFirewall, scanDue,
  scanOutcome, scanPlan, securitySettings, securityStatus, skippedMounts, emptySecurity, type EngineFacts,
} from '../src/security.ts';
import { SecurityCenter, type SecurityHost } from '../src/securityCenter.ts';
import { SCAN_MEMORY_HIGH, scanCommand } from '../src/securityHost.ts';
import { StateFile, type Policy } from '../src/state.ts';

const NOW = Date.parse('2026-10-20T13:00:00Z');
const HOUR = 3_600_000, DAY = 24 * HOUR;
const pol = (x: Record<string, unknown>) => ({ version: 'p', signature: 's', ...x }) as Policy;

test('settings: defaults, and malformed values fall back instead of failing', () => {
  const d = securitySettings(null);
  assert.equal(d.antivirus, true);
  assert.equal(d.av_scan_schedule, 'weekly');
  assert.deepEqual(d.av_scan_paths, ['/']);   // #64: a full scan covers the local file systems
  assert.deepEqual(d.firewall_outbound_block, []);
  const s = securitySettings(pol({ firewall_outbound_block: ['203.0.113.0/24', 'nonsense', '2001:db8::/32', '203.0.113.0/24'], av_scan_schedule: 'hourly', av_cpu_quota_percent: 5, av_exclusions: ['/home/a/vm', 'relative', '/x/../etc'] }));
  assert.deepEqual(s.firewall_outbound_block, ['203.0.113.0/24', '2001:db8::/32']);
  assert.equal(s.av_scan_schedule, 'weekly');
  assert.equal(s.av_cpu_quota_percent, 50);
  assert.deepEqual(s.av_exclusions, ['/home/a/vm']);
});

test('firewall: nothing to add → no table; blocks are drops in a separate table; never flushes the ruleset', () => {
  assert.equal(renderPolicyFirewall(securitySettings(null), null), null);
  const r = renderPolicyFirewall(securitySettings(pol({ firewall_outbound_block: ['198.51.100.7', '2001:db8::/32'], firewall_log_blocked: true })), null)!;
  assert.match(r, /delete table inet worksuite_policy/);
  assert.match(r, /ip daddr \{ 198\.51\.100\.7 \} limit rate .* log prefix "worksuite-fw-drop: " flags skuid\n/);
  assert.match(r, /\n    ip daddr \{ 198\.51\.100\.7 \} drop\n/);   // the drop itself is not rate-limited
  assert.match(r, /ip6 daddr \{ 2001:db8::\/32 \} .*drop/);
  assert.match(r, /hook output priority filter \+ 10; policy accept;/);
  assert.doesNotMatch(r, /flush ruleset|worksuite_filter|chain input/);
});

test('isolation: keeps DHCP, DNS and HTTPS to the management server; refuses without a management address; capped', () => {
  assert.throws(() => isolationPlan(NOW, 4, []), /NO_MANAGEMENT_PATH/);
  const iso = isolationPlan(NOW, 4, ['192.0.2.10', '2001:db8::10']);
  assert.equal(iso.until, NOW + 4 * HOUR);
  assert.equal(isolationPlan(NOW, 1000, ['192.0.2.10']).until, NOW + 24 * HOUR);
  const r = renderPolicyFirewall(securitySettings(null), iso)!;
  assert.match(r, /ip daddr \{ 192\.0\.2\.10 \} tcp dport 443 accept/);
  assert.match(r, /ip6 daddr \{ 2001:db8::10 \} tcp dport 443 accept/);
  assert.match(r, /th dport 53 accept/);
  assert.match(r, /udp dport \{ 67, 547 \} accept/);
  assert.match(r, /hook input priority filter \+ 10; policy drop;/);
  assert.match(r, /\n    drop\n  \}/);
});

test('ClamAV output parsing', () => {
  const v = parseClamVersion('ClamAV 1.0.7/27431/Mon Oct 19 08:24:01 2026\n')!;
  assert.equal(v.engine, '1.0.7'); assert.equal(v.signatures, 27431); assert.ok(v.signatures_at);
  assert.equal(parseClamVersion('ClamAV 1.0.7')!.signatures, null);
  assert.equal(parseClamVersion('bash: clamscan: not found'), null);
  assert.deepEqual(parseClamscan('/home/a/eicar.com: Win.Test.EICAR_HDB-1 FOUND\n/home/a/x: y: Eicar-Sig FOUND\nLibClamAV Warning: x\n'), [
    { path: '/home/a/eicar.com', signature: 'Win.Test.EICAR_HDB-1' }, { path: '/home/a/x: y', signature: 'Eicar-Sig' },
  ]);
  const fw = parseFirewallLog(['2026-10-20T12:00:00+0000 host kernel: worksuite-fw-drop: IN= OUT=wlan0 SRC=10.0.0.2 DST=198.51.100.7 LEN=60 PROTO=TCP SPT=5000 DPT=443 UID=1000', 'unrelated']);
  assert.deepEqual(fw, [{ at: Date.parse('2026-10-20T12:00:00+0000'), dst: '198.51.100.7', dport: 443, proto: 'TCP', uid: 1000 }]);
});

test('exclusions become anchored, escaped clamscan regexes', () => {
  assert.deepEqual(exclusionArgs(['/home/a/my.vm/']), ['--exclude-dir=^/home/a/my\\.vm(/|$)', '--exclude=^/home/a/my\\.vm/$']);
});

// Lines exactly as clamscan 1.4.3 (Debian trixie) prints them with --stdout --no-summary, stderr merged.
const NO_DB = 'LibClamAV Error: cli_loaddbdir: No supported database files found in /var/lib/clamav\nERROR: Can\'t open file or directory\n';

test('#64 scan lines: results, unreadable files, and an empty signature database is fatal', () => {
  assert.deepEqual(parseScanLine('/root/t/eicar.com: Test.EICAR-HDB.UNOFFICIAL FOUND'), { kind: 'found', path: '/root/t/eicar.com', signature: 'Test.EICAR-HDB.UNOFFICIAL' });
  assert.deepEqual(parseScanLine('/root/t/sp ace/b: c.txt: OK'), { kind: 'ok', path: '/root/t/sp ace/b: c.txt' });
  assert.deepEqual(parseScanLine('/root/t/empty: Empty file'), { kind: 'ok', path: '/root/t/empty' });
  assert.deepEqual(parseScanLine('/home/a/locked: Access denied. ERROR'), { kind: 'error', path: '/home/a/locked' });
  assert.equal(parseScanLine('/root/t/ex: Excluded'), null);
  assert.equal(parseScanLine('WARNING: /root/nonexist: Can\'t access file'), null);
  assert.deepEqual(NO_DB.split('\n').map(parseScanLine).filter(Boolean), [{ kind: 'fatal', error: 'NO_SIGNATURES' }, { kind: 'fatal', error: 'NO_SIGNATURES' }]);
});

test('#64 scan outcome: exit 2 with nothing scanned (no signatures) is a failure, not a finished scan', () => {
  assert.equal(scanOutcome(0, { files: 10 }, null, false), null);
  assert.equal(scanOutcome(1, { files: 10 }, null, false), null);
  assert.equal(scanOutcome(2, { files: 10 }, null, false), null);   // some files unreadable
  assert.equal(scanOutcome(2, { files: 0 }, 'NO_SIGNATURES', false), 'NO_SIGNATURES');
  assert.equal(scanOutcome(2, { files: 0 }, null, false), 'SCAN_ERROR');
  assert.equal(scanOutcome(143, { files: 3 }, null, true), 'CANCELLED');
  assert.equal(scanOutcome(-1, { files: 0 }, null, false), 'CLAMSCAN_-1');
});

test('#64 scan plan: quick covers high-risk folders; full covers / without kernel, runtime and network file systems', () => {
  const s = securitySettings(null);
  const q = scanPlan('quick', s, ['/home/a'], '');
  for (const r of ['/home/a/Downloads', '/home/a/Desktop', '/home/a/Documents', '/home/a/.config/autostart', '/tmp', '/var/tmp', '/dev/shm', '/etc/xdg/autostart']) assert.ok(q.roots.includes(r), r);
  assert.ok(!q.roots.includes('/'));
  const mounts = 'proc /proc proc rw 0 0\nserver:/x /mnt/nfs nfs4 rw 0 0\n//nas/s /media/my\\040share cifs rw 0 0\n/dev/sda2 /data ext4 rw 0 0\nsshfs#h: /home/a/remote fuse.sshfs rw 0 0\ntmpfs /tmp tmpfs rw 0 0\n';
  assert.deepEqual(skippedMounts(mounts), ['/proc', '/mnt/nfs', '/media/my share', '/home/a/remote']);
  const f = scanPlan('full', securitySettings(pol({ av_exclusions: ['/home/a/vm'] })), ['/home/a'], mounts);
  assert.deepEqual(f.roots, ['/']);
  for (const e of ['/proc', '/sys', '/dev', '/run', '/var/lib/worksuite-device-agent/quarantine', '/mnt/nfs', '/media/my share', '/home/a/remote', '/home/a/vm']) assert.ok(f.exclusions.includes(e), e);
  assert.ok(!f.exclusions.includes('/tmp') && !f.exclusions.includes('/data'));
  // The command: recursive with per-file results (progress), under a fixed unit name so cancel can stop it.
  const cmd = scanCommand(f, 50);
  assert.ok(cmd.includes('--unit=worksuite-av-scan.service') && cmd.includes('--recursive') && cmd.includes('--stdout') && !cmd.includes('--infected'));
  assert.equal(cmd.at(-1), '/');
  // #68: room for the signature database, so a scan isn't throttled before it reads a file.
  assert.ok(cmd.includes(`MemoryHigh=${SCAN_MEMORY_HIGH}`) && SCAN_MEMORY_HIGH === '2G');
});

const CLAMSCAN = spawnSync('clamscan', ['--version']).status === 0;
test('#64 real clamscan: detection, results per file and the empty-database failure (needs clamscan)', { skip: !CLAMSCAN }, () => {
  const d = mkdtempSync(join(tmpdir(), 'ws-clam-'));
  try {
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    mkdirSync(join(d, 'files/sp ace'), { recursive: true }); mkdirSync(join(d, 'db')); mkdirSync(join(d, 'empty'));
    writeFileSync(join(d, 'files/eicar.com'), eicar); writeFileSync(join(d, 'files/sp ace/b: c.txt'), 'clean');
    const md5 = execFileSync('md5sum', [join(d, 'files/eicar.com')], { encoding: 'utf8' }).split(' ')[0];
    writeFileSync(join(d, 'db/t.hdb'), `${md5}:${eicar.length}:Test.EICAR\n`);
    const run = (db: string) => spawnSync('clamscan', ['-d', db, '--stdout', '--no-summary', '--recursive', join(d, 'files')], { encoding: 'utf8' });
    const ok = run(join(d, 'db/t.hdb'));
    assert.equal(ok.status, 1);
    const lines = (ok.stdout + ok.stderr).split('\n').map(parseScanLine).filter(Boolean);
    assert.deepEqual(lines.filter((l) => l!.kind === 'found').map((l) => (l as { path: string }).path), [join(d, 'files/eicar.com')]);
    assert.ok(lines.some((l) => l!.kind === 'ok' && (l as { path: string }).path === join(d, 'files/sp ace/b: c.txt')));
    const none = run(join(d, 'empty'));
    assert.equal(none.status, 2);
    const fatal = (none.stdout + none.stderr).split('\n').map(parseScanLine).find((l) => l?.kind === 'fatal');
    assert.equal(scanOutcome(none.status!, { files: 0 }, fatal && 'error' in fatal ? fatal.error : null, false), 'NO_SIGNATURES');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('scheduling: waits for idle, unloaded, mains power and the scan hour; first scan is full', () => {
  const s = securitySettings(null), st = emptySecurity();
  const ok = { idle: true, loadPerCore: 0.1, onBattery: false, hour: 14 };
  assert.equal(scanDue(s, st, NOW, ok), 'full');
  assert.equal(scanDue(s, st, NOW, { ...ok, idle: false }), null);
  assert.equal(scanDue(s, st, NOW, { ...ok, loadPerCore: 2 }), null);
  assert.equal(scanDue(s, st, NOW, { ...ok, onBattery: true }), null);
  assert.equal(scanDue(s, st, NOW, { ...ok, hour: 3 }), null);
  assert.equal(scanDue(s, { ...st, last_full_scan: NOW - DAY, last_scan: NOW - DAY }, NOW, ok), null);
  assert.equal(scanDue(s, { ...st, last_full_scan: NOW - 8 * DAY, last_scan: NOW - 8 * DAY }, NOW, ok), 'quick');
  assert.equal(scanDue(securitySettings(pol({ av_scan_schedule: 'off' })), st, NOW, ok), null);
});

test('retention drops old history but keeps what is still in quarantine', () => {
  const st = { ...emptySecurity(), threats: [
    { id: '1', at: NOW - 100 * DAY, path: '/a', signature: 's', action: 'quarantined' as const },
    { id: '2', at: NOW - 100 * DAY, path: '/b', signature: 's', action: 'deleted' as const },
  ], firewall_alerts: [{ at: NOW - 100 * DAY, dst: 'x', dport: 1, proto: 'TCP' }, { at: NOW, dst: 'y', dport: 1, proto: 'TCP' }] };
  const p = pruneSecurity(st, 90, NOW);
  assert.deepEqual(p.threats.map((t) => t.id), ['1']);
  assert.deepEqual(p.firewall_alerts.map((a) => a.dst), ['y']);
});

test('#64 status: installed without signatures needs attention and is not ready to scan', () => {
  const st = securityStatus(securitySettings(null), emptySecurity(), facts({ clamav: { engine: '1.4.3', signatures: null, signatures_at: null } }), NOW, false);
  assert.ok(st.issues.includes('no_signatures'));
  assert.equal(st.overall, 'attention');
  assert.equal(st.antivirus.ready, false);
  assert.equal(securityStatus(securitySettings(null), emptySecurity(), facts(), NOW, false).antivirus.ready, true);
});

const facts = (over: Partial<EngineFacts> = {}): EngineFacts => ({ firewall_active: true, policy_table_active: false, clamav: { engine: '1.0.7', signatures: 1, signatures_at: NOW - DAY }, freshclam: 'active', ...over });

test('status: protected, attention and at-risk', () => {
  const s = securitySettings(null);
  assert.equal(securityStatus(s, emptySecurity(), facts(), NOW, false).overall, 'protected');
  const old = securityStatus(s, emptySecurity(), facts({ clamav: { engine: '1', signatures: 1, signatures_at: NOW - 9 * DAY } }), NOW, false);
  assert.equal(old.overall, 'attention'); assert.deepEqual(old.issues, ['signatures_outdated']);
  assert.equal(securityStatus(s, emptySecurity(), facts({ firewall_active: false }), NOW, false).overall, 'at_risk');
  assert.equal(securityStatus(s, emptySecurity(), facts({ firewall_active: false, clamav: null }), NOW, false).overall, 'unavailable');
});

function center(policy: Policy | null = null) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-secc-'));
  const state = new StateFile(join(dir, 'state.json'));
  const log: string[] = [];
  const h = { firewall: [] as (string | null)[], env: [] as (string | null)[], restarts: [] as string[], published: null as unknown, facts: facts(), scans: 0,
    // What the fake clamscan prints, its exit code, and whether it waits for cancel.
    lines: ['/home/a/Downloads/eicar: Eicar FOUND', '/home/a/Downloads/ok.pdf: OK', '/home/a/Downloads/ro: Eicar FOUND'], code: 1, hang: false, plans: [] as { roots: string[]; exclusions: string[] }[], cancels: 0,
    release: null as (() => void) | null };
  const host: SecurityHost = {
    async applyFirewall(r) { h.firewall.push(r); },
    writeFreshclamEnv(c) { const changed = h.env.at(-1) !== c; h.env.push(c); return changed; },
    async facts() { return h.facts; },
    async restartUnit(u) { h.restarts.push(u); },
    async resolve() { return ['192.0.2.10']; },
    async scan(plan, _s, onLine) {
      h.scans++; h.plans.push(plan);
      await new Promise((r) => setTimeout(r, 5));
      for (const l of h.lines) onLine(l);
      if (h.hang) { await new Promise<void>((r) => { h.release = r; }); return { code: 143 }; }
      return { code: h.code };
    },
    async cancelScan() { h.cancels++; h.release?.(); },
    async mounts() { return 'server:/x /mnt/nfs nfs4 rw 0 0\n'; },
    async quarantine(p) { if (p.endsWith('/ro')) throw new Error('EROFS'); return 'q1'; },
    async load() { return { idle: true, loadPerCore: 0, onBattery: false, hour: 14 }; },
    async firewallAlerts() { return { alerts: [] }; },
    publish(s) { h.published = s; },
    audit(e) { log.push(e); },
    // #38 layers: inert here (test/protection.test.ts covers them).
    async homes() { return ['/home/a']; }, writeConfig() { return false; }, async unit() {}, follow() { return () => {}; },
    async fetchFeed() { throw new Error('offline'); }, feedCache() { return null; }, async reloadDns() {}, watchFiles() { return () => {}; },
    async scanFiles() { return []; }, async restoreQuarantined() { return { path: '' }; }, async deleteQuarantined() {}, async signal() { return 'gone' as const; },
  };
  let now = NOW;
  const c = new SecurityCenter({ state, host, now: () => now, managed: () => ({ enrolled: policy !== null, policy, server: 'https://work.example.com' }) });
  return { c, h, log, state, dir, host, setNow: (n: number) => { now = n; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('center: scan quarantines what it can, records the rest as needing action, no duplicate scans', async () => {
  const w = center(pol({}));
  try {
    await Promise.all([w.c.scan('quick', 'user'), w.c.scan('quick', 'remote')]);
    assert.equal(w.h.scans, 1);
    const st = await w.c.status();
    assert.equal(st.threats.quarantined, 1); assert.equal(st.threats.active, 1);
    assert.equal(st.overall, 'at_risk');
    assert.equal(st.antivirus.last_scan?.kind, 'quick');
    assert.equal(st.antivirus.last_scan?.files, 3);
    assert.ok(w.h.plans[0].roots.includes('/home/a/Downloads'));
    assert.ok(w.log.includes('threat_quarantined') && w.log.includes('threat_detected'));
  } finally { w.cleanup(); }
});

test('#64 center: no signatures → the scan does not start and says why; a scheduled one is recorded as failed', async () => {
  const w = center(null);
  try {
    w.h.facts = facts({ clamav: { engine: '1.4.3', signatures: null, signatures_at: null } });
    // freshclam is running: the definitions are on their way (#68).
    await assert.rejects(w.c.startScan('quick', 'user'), /SIGNATURES_DOWNLOADING/);
    assert.equal(w.h.scans, 0);
    await assert.rejects(w.c.scan('full', 'schedule'), /NO_SIGNATURES/);
    const st = await w.c.status();
    assert.equal(st.antivirus.last_scan?.error, 'NO_SIGNATURES');
    assert.ok(st.issues.includes('no_signatures'));
    // Signatures gone between the check and clamscan (or damaged): exit 2 and the loader's error, never "0 files, clean".
    w.h.facts = facts(); w.h.lines = NO_DB.split('\n'); w.h.code = 2;
    await assert.rejects(w.c.scan('quick', 'user'), /NO_SIGNATURES/);
    assert.equal((await w.c.status()).antivirus.last_scan?.error, 'NO_SIGNATURES');
    assert.equal(w.c.st.last_scan, undefined);
    w.h.facts = facts({ clamav: null });
    await assert.rejects(w.c.startScan('quick', 'user'), /ANTIVIRUS_MISSING/);
    await w.c.updateDefinitions().then(() => assert.fail('no engine'), (e) => assert.match(e.message, /ANTIVIRUS_MISSING/));
    w.h.facts = facts({ clamav: { engine: '1.4.3', signatures: null, signatures_at: null } });
    await w.c.updateDefinitions();
    assert.deepEqual(w.h.restarts, ['clamav-freshclam.service']);
  } finally { w.cleanup(); }
});

test('#68 center: a scan that cannot start says the engine\'s real state, and a stopped updater is started', async () => {
  const w = center(null);
  try {
    const none = { engine: '1.4.3', signatures: null, signatures_at: null };
    // Updater stopped (never enabled, or it gave up): started now, and the person is told definitions are coming.
    w.h.facts = facts({ clamav: none, freshclam: 'inactive' });
    await assert.rejects(w.c.startScan('quick', 'user'), /SIGNATURES_DOWNLOADING/);
    assert.deepEqual(w.h.restarts, ['clamav-freshclam.service']);
    assert.ok(w.log.includes('security_service_restarted'));
    // Asked again at once: not restarted again; a failed updater is named as failed.
    w.h.facts = facts({ clamav: none, freshclam: 'failed' });
    await assert.rejects(w.c.startScan('full', 'user'), /UPDATER_FAILED/);
    assert.equal(w.h.restarts.length, 1);
    // The restart itself fails.
    w.setNow(NOW + 10 * 60_000);
    w.h.restarts = [];
    const restart = w.host.restartUnit;
    w.host.restartUnit = async () => { throw new Error('UNIT_RESTART_FAILED'); };
    await assert.rejects(w.c.startScan('full', 'user'), /UPDATER_FAILED/);
    w.host.restartUnit = restart;
    // No updater at all.
    w.h.facts = facts({ clamav: none, freshclam: 'missing' });
    await assert.rejects(w.c.startScan('quick', 'user'), /UPDATER_MISSING/);
    await assert.rejects(w.c.updateDefinitions(), /UPDATER_MISSING/);
    // The engine probe itself fails (systemctl or clamscan could not run): said so, not "FAILED".
    const probe = w.host.facts;
    w.host.facts = async () => { throw new Error('spawn systemctl EACCES'); };
    await assert.rejects(w.c.startScan('quick', 'user'), /^Error: ENGINE_CHECK_FAILED$/);
    w.host.facts = probe;
    // Definitions present, updater stopped: the scan still starts (updates are a separate warning).
    w.h.facts = facts({ freshclam: 'inactive' });
    await w.c.startScan('quick', 'user');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(w.h.scans, 1);
    assert.ok((await w.c.status()).issues.includes('updates_not_running'));
  } finally { w.cleanup(); }
});

test('#64 center: progress while scanning, cancel keeps what was found, full scan skips network mounts', async () => {
  const w = center(null);
  try {
    w.h.hang = true;
    await w.c.startScan('full', 'user');
    await new Promise((r) => setTimeout(r, 20));
    const run = await w.c.status();
    assert.equal(run.scanning, true);
    assert.equal(run.antivirus.progress?.files, 3);
    assert.equal(run.antivirus.progress?.detections, 2);
    assert.equal(run.antivirus.progress?.current, '/home/a/Downloads/ro');
    assert.ok(w.h.plans[0].exclusions.includes('/mnt/nfs') && w.h.plans[0].roots.includes('/'));
    await w.c.startScan('quick', 'user');   // joins, no second scan
    assert.equal(w.h.scans, 1);
    await w.c.cancelScan();
    const st = await w.c.status();
    assert.equal(st.scanning, false); assert.equal(st.antivirus.progress, null);
    assert.equal(st.antivirus.last_scan?.error, 'CANCELLED');
    assert.equal(st.antivirus.scans.length, 1);
    assert.equal(st.threats.quarantined, 1);
    assert.ok(w.log.includes('scan_cancelled'));
    await assert.rejects(w.c.cancelScan(), /NOT_SCANNING/);
    // History survives a restart (state file), as Settings shows it after a reboot.
    const again = new SecurityCenter({ state: new StateFile(join(w.dir, 'state.json')), host: w.host, now: () => NOW, managed: () => ({ enrolled: false, policy: null, server: null }) });
    assert.equal((await again.status()).antivirus.scans[0].error, 'CANCELLED');
  } finally { w.cleanup(); }
});

test('center: isolation applies, expires on its own (lockout safeguard), release lifts it; freshclam schedule only when managed', async () => {
  const w = center(pol({ av_signature_checks_per_day: 4 }));
  try {
    await w.c.enforce();
    assert.equal(w.h.firewall.at(-1), null);
    assert.match(w.h.env.at(-1)!, /FRESHCLAM_CHECKS=4/);
    assert.deepEqual(w.h.restarts, ['clamav-freshclam.service']);
    await w.c.isolate(2);
    assert.match(w.h.firewall.at(-1)!, /192\.0\.2\.10/);
    assert.ok((await w.c.status()).isolation);
    w.setNow(NOW + 3 * HOUR);
    await w.c.tick();
    assert.equal(w.h.firewall.at(-1), null);
    assert.ok(w.log.includes('isolation_expired'));
    await w.c.isolate(2); await w.c.release();
    assert.equal(w.h.firewall.at(-1), null);
  } finally { w.cleanup(); }
  const u = center(null);
  try { await u.c.enforce(); assert.equal(u.h.env.at(-1), null); await assert.rejects(u.c.isolate(2)); } finally { u.cleanup(); }
});

test('center: a failed signature updater is restarted at most hourly', async () => {
  const w = center(pol({}));
  try {
    w.h.facts = facts({ freshclam: 'failed' });
    await w.c.health(); await w.c.health();
    assert.deepEqual(w.h.restarts, ['clamav-freshclam.service']);
  } finally { w.cleanup(); }
});

test('#64 center: an updater that is not running, or has no signatures yet, is (re)started', async () => {
  const w = center(null);
  try {
    w.h.facts = facts({ freshclam: 'inactive' });
    await w.c.health();
    assert.deepEqual(w.h.restarts, ['clamav-freshclam.service']);
    w.h.facts = facts({ clamav: { engine: '1.4.3', signatures: null, signatures_at: null } });
    await w.c.health();
    assert.equal(w.h.restarts.length, 1);   // not again at once
    w.setNow(NOW + 26 * 60_000);
    await w.c.health();
    assert.equal(w.h.restarts.length, 2);   // offline at boot: retried within the half hour
    w.h.facts = facts({ freshclam: 'missing' }); w.setNow(NOW + 3 * HOUR);
    await w.c.health();
    assert.equal(w.h.restarts.length, 2);
  } finally { w.cleanup(); }
});

test('rendered policy table parses with nft -c (root with nft only)', { skip: !(process.getuid?.() === 0 && ['/usr/sbin/nft', '/sbin/nft'].some((p) => { try { return lstatSync(p).isFile(); } catch { return false; } })) }, async () => {
  const { execFileSync } = await import('node:child_process');
  const d = mkdtempSync(join(tmpdir(), 'ws-nft-'));
  try {
    const s = securitySettings(pol({ firewall_outbound_block: ['198.51.100.7', '2001:db8::/32'], firewall_log_blocked: true }));
    for (const iso of [null, isolationPlan(NOW, 2, ['192.0.2.1', '2001:db8::1'])]) {
      writeFileSync(join(d, 'p.nft'), renderPolicyFirewall(s, iso)!);
      execFileSync('nft', ['-c', '-f', join(d, 'p.nft')]);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});
