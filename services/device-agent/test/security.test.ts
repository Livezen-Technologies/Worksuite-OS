import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exclusionArgs, isolationPlan, parseClamscan, parseClamVersion, parseFirewallLog, pruneSecurity, renderPolicyFirewall, scanDue,
  securitySettings, securityStatus, walkFiles, emptySecurity, type EngineFacts,
} from '../src/security.ts';
import { SecurityCenter, type SecurityHost } from '../src/securityCenter.ts';
import { StateFile, type Policy } from '../src/state.ts';

const NOW = Date.parse('2026-10-20T13:00:00Z');
const HOUR = 3_600_000, DAY = 24 * HOUR;
const pol = (x: Record<string, unknown>) => ({ version: 'p', signature: 's', ...x }) as Policy;

test('settings: defaults, and malformed values fall back instead of failing', () => {
  const d = securitySettings(null);
  assert.equal(d.antivirus, true);
  assert.equal(d.av_scan_schedule, 'weekly');
  assert.deepEqual(d.av_scan_paths, ['/home']);
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

test('walk: exclusions, symlinks skipped, quick scan only changed files', () => {
  const d = mkdtempSync(join(tmpdir(), 'ws-sec-'));
  try {
    mkdirSync(join(d, 'a/skip'), { recursive: true });
    writeFileSync(join(d, 'a/new'), 'x'); writeFileSync(join(d, 'a/old'), 'x'); writeFileSync(join(d, 'a/skip/f'), 'x');
    utimesSync(join(d, 'a/old'), new Date(NOW - 10 * DAY), new Date(NOW - 10 * DAY));
    const fs = {
      readdir: (p: string) => readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile(), link: e.isSymbolicLink() })),
      mtimeMs: (p: string) => lstatSync(p).mtimeMs,
    };
    assert.deepEqual([...walkFiles([d], [join(d, 'a/skip')], null, fs)].sort(), [join(d, 'a/new'), join(d, 'a/old')]);
    assert.deepEqual([...walkFiles([d], [], NOW - DAY, fs)].sort(), [join(d, 'a/new'), join(d, 'a/skip/f')]);
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
  const h = { firewall: [] as (string | null)[], env: [] as (string | null)[], restarts: [] as string[], detections: [{ path: '/home/a/eicar', signature: 'Eicar' }, { path: '/home/a/ro', signature: 'Eicar' }], published: null as unknown, facts: facts(), scans: 0 };
  const host: SecurityHost = {
    async applyFirewall(r) { h.firewall.push(r); },
    writeFreshclamEnv(c) { const changed = h.env.at(-1) !== c; h.env.push(c); return changed; },
    async facts() { return h.facts; },
    async restartUnit(u) { h.restarts.push(u); },
    async resolve() { return ['192.0.2.10']; },
    async scan() { h.scans++; await new Promise((r) => setTimeout(r, 5)); return { files: 3, detections: h.detections }; },
    async quarantine(p) { if (p.endsWith('/ro')) throw new Error('EROFS'); return 'q1'; },
    async load() { return { idle: true, loadPerCore: 0, onBattery: false, hour: 14 }; },
    async firewallAlerts() { return { alerts: [] }; },
    publish(s) { h.published = s; },
    audit(e) { log.push(e); },
  };
  let now = NOW;
  const c = new SecurityCenter({ state, host, now: () => now, managed: () => ({ enrolled: policy !== null, policy, server: 'https://work.example.com' }) });
  return { c, h, log, state, setNow: (n: number) => { now = n; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('center: scan quarantines what it can, records the rest as needing action, no duplicate scans', async () => {
  const w = center(pol({}));
  try {
    await Promise.all([w.c.scan('quick', 'user'), w.c.scan('quick', 'remote')]);
    assert.equal(w.h.scans, 1);
    const st = await w.c.status();
    assert.equal(st.threats.quarantined, 1); assert.equal(st.threats.active, 1);
    assert.equal(st.overall, 'at_risk');
    assert.equal(st.antivirus.last_scan?.kind, 'full');   // first scan is always full
    assert.ok(w.log.includes('threat_quarantined') && w.log.includes('threat_detected'));
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
