// WorkSuite Security protection layers (issue #38): src/protection.ts and the SecurityCenter parts that run them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cidr4Contains, DNS_BLOCKLIST, DNS_MODE_CONF, expandFolders, GUARD_CONF, GUARD_UNIT, isFeed, ONACCESS_CONF, ONACCESS_UNIT, parseDomainFeed, parseGuardLine,
  parseIpFeed, parseOnAccessLine, protectionSettings, renderDnsBlocklist, renderGuardConf, renderOnAccessConf, verifyFeed,
} from '../src/protection.ts';
import { isolationPlan, renderPolicyFirewall, securitySettings, type EngineFacts } from '../src/security.ts';
import { SecurityCenter, type SecurityHost } from '../src/securityCenter.ts';
import { linuxSecurityHost } from '../src/securityHost.ts';
import { StateFile, type Policy } from '../src/state.ts';

const NOW = Date.parse('2026-10-20T13:00:00Z');
const pol = (x: Record<string, unknown>) => ({ version: 'p', signature: 's', ...x }) as Policy;
const SHA = 'a'.repeat(64);

test('settings: real-time is an organization choice; feeds must be https and pinned or signed; bad values fall back', () => {
  const d = protectionSettings(null);
  assert.equal(d.realtime, false);
  assert.equal(d.download_scan, true);
  assert.equal(d.security_auto_patch, 'window');
  assert.deepEqual(d.ransomware_burst, { count: 200, seconds: 10 });
  assert.equal(protectionSettings(null, false).download_scan, false);
  const s = protectionSettings(pol({
    realtime_protection: true, realtime_prevention: false, protected_folders: ['~/Documents', '/srv/shared', 'relative', '~/../etc'],
    app_denylist: ['/home/a/miner', SHA.toUpperCase(), 'nope'], ransomware_burst: { count: 5, seconds: 10 }, security_auto_patch: 'immediate',
    dns_blocklist: ['Bad.Example', 'not a domain', 'x.example.'], protected_folders_mode: 'audit',
    firewall_threat_feeds: [{ url: 'https://feeds.example/ips.txt', sha256: SHA }, { url: 'https://feeds.example/unpinned.txt' }, { url: 'http://feeds.example/x', sha256: SHA }],
  }));
  assert.equal(s.realtime, true); assert.equal(s.realtime_prevention, false);
  assert.deepEqual(s.protected_folders, ['~/Documents', '/srv/shared']);
  assert.deepEqual(s.app_denylist, { paths: ['/home/a/miner'], sha256: [SHA] });
  assert.deepEqual(s.ransomware_burst, { count: 200, seconds: 10 });   // below 20 → default
  assert.deepEqual(s.dns_blocklist, ['bad.example']);
  assert.equal(s.firewall_threat_feeds.length, 1);
  assert.equal(s.protected_folders_mode, 'audit');
  assert.equal(s.security_auto_patch, 'immediate');
  assert.equal(protectionSettings(pol({ realtime_protection: true }), false).realtime, false);   // antivirus off → no real-time
  assert.equal(isFeed({ url: 'https://x.example/f', key: 'A'.repeat(43) + '=' }), true);
});

test('real-time: clamonacc watches the policy paths and every Downloads folder, prevention from policy', () => {
  assert.equal(renderOnAccessConf(protectionSettings(null), ['/home/a']), null);
  const homes = ['/home/a', '/home/b'];
  const on = renderOnAccessConf(protectionSettings(pol({ realtime_protection: true, av_exclusions: ['/home/a/vm'] })), homes)!;
  assert.match(on, /^OnAccessIncludePath \/home$/m);
  assert.doesNotMatch(on, /Downloads/);   // already below /home
  assert.match(on, /^OnAccessPrevention yes$/m);
  assert.match(on, /^OnAccessExcludePath \/home\/a\/vm$/m);
  assert.match(on, /^OnAccessExcludeUname clamav$/m);
  assert.match(on, /^LocalSocket \/run\/clamav\/clamd.ctl$/m);
  const narrow = renderOnAccessConf(protectionSettings(pol({ realtime_protection: true, realtime_prevention: false, realtime_paths: ['~/Desktop', '/srv'] })), homes)!;
  assert.deepEqual(narrow.match(/^OnAccessIncludePath .*$/gm), [
    'OnAccessIncludePath /home/a/Desktop', 'OnAccessIncludePath /home/a/Downloads', 'OnAccessIncludePath /home/b/Desktop', 'OnAccessIncludePath /home/b/Downloads', 'OnAccessIncludePath /srv',
  ]);
  assert.match(narrow, /^OnAccessPrevention no$/m);
  assert.deepEqual(expandFolders(['~/Documents/', '/srv/'], ['/home/a/']), ['/home/a/Documents', '/srv']);
});

test('guard: protected folders per user, allow list, deny list, burst and audit mode', () => {
  assert.equal(renderGuardConf(protectionSettings(null), ['/home/a']), null);
  const g = renderGuardConf(protectionSettings(pol({ protected_folders: ['~/Documents'], protected_folders_allow: ['/opt/backup/'], app_denylist: [SHA, '/usr/local/bin/x'], ransomware_burst: { count: 50, seconds: 5 } })), ['/home/a', '/home/b'])!;
  assert.deepEqual(g.split('\n').filter((l) => l && !l.startsWith('#')), [
    'mode enforce', 'burst 50 5', 'protect /home/a/Documents', 'protect /home/b/Documents', 'allow /opt/backup/', 'deny-path /usr/local/bin/x', `deny-sha256 ${SHA}`,
  ]);
  assert.match(renderGuardConf(protectionSettings(pol({ protected_folders: ['/srv'], protected_folders_mode: 'audit' })), [])!, /^mode audit$/m);
  // Only an application deny list: the guard still runs.
  assert.ok(renderGuardConf(protectionSettings(pol({ app_denylist: [SHA] })), []));
});

test('guard and clamonacc output parsing', () => {
  assert.deepEqual(parseGuardLine('{"event":"write_blocked","pid":12,"enforced":true,"exe":"/home/a/x","path":"/home/a/Documents/f.odt"}'),
    { kind: 'write_blocked', path: '/home/a/Documents/f.odt', exe: '/home/a/x', pid: 12, enforced: true });
  assert.deepEqual(parseGuardLine('{"event":"exec_blocked","pid":3,"enforced":true,"exe":"/usr/bin/dash","path":"/tmp/m","sha256":"ab"}')?.signature, 'sha256:ab');
  assert.equal(parseGuardLine('{"event":"burst_suspended","pid":9,"enforced":true,"exe":"/usr/bin/python3","path":"/p/f","start":"1234","count":201}')?.start, '1234');
  assert.equal(parseGuardLine('{"event":"burst_suspended","pid":9,"path":"/p","start":"x"}'), null);
  assert.equal(parseGuardLine('{"event":"started","pid":1}'), null);
  assert.equal(parseGuardLine('worksuite-guard: cannot watch /x'), null);
  assert.deepEqual(parseOnAccessLine('ClamInotif: /home/a/Downloads/eicar.com: Win.Test.EICAR_HDB-1 FOUND'), { path: '/home/a/Downloads/eicar.com', signature: 'Win.Test.EICAR_HDB-1' });
  assert.equal(parseOnAccessLine('ClamInotif: watching /home'), null);
});

test('DNS: dnsmasq blocklist and domain feeds (hosts format, comments, invalid names)', () => {
  assert.equal(renderDnsBlocklist([]), null);
  assert.match(renderDnsBlocklist(['bad.example', 'evil.test'])!, /^address=\/bad\.example\/\naddress=\/evil\.test\/\n$/m);
  assert.deepEqual(parseDomainFeed('# list\n0.0.0.0 ads.example\n127.0.0.1 localhost\nphish.example.\nbad_name!\n::1 track.example # c\n', 10), ['ads.example', 'phish.example', 'track.example']);
  assert.deepEqual(parseDomainFeed('a.example\nb.example\nc.example\n', 2), ['a.example', 'b.example']);
});

test('threat-intel IP feeds: validated, capped, never private space, too-wide nets or the management server', () => {
  const r = parseIpFeed('; spamhaus style\n198.51.100.0/24 ; SBL1\n203.0.113.5\n10.1.2.3\n192.168.0.0/16\n0.0.0.0/0\n1.0.0.0/4\n192.0.2.0/24\n2001:db8:1::/48\nfe80::/64\n::/0\nnonsense\n', 100, ['192.0.2.10']);
  assert.deepEqual(r.v4, ['198.51.100.0/24', '203.0.113.5']);
  assert.deepEqual(r.v6, ['2001:db8:1::/48']);
  assert.equal(r.dropped, 8);
  assert.equal(parseIpFeed('198.51.100.1\n198.51.100.2\n198.51.100.3\n', 2).v4.length, 2);
  assert.ok(cidr4Contains('192.0.2.0/24', '192.0.2.10') && !cidr4Contains('192.0.3.0/24', '192.0.2.10'));
});

test('feeds: a body is used only if it matches its pinned hash or Ed25519 signature', () => {
  const body = Buffer.from('198.51.100.7\n');
  const sha = createHash('sha256').update(body).digest('hex');
  assert.equal(verifyFeed({ url: 'https://x', sha256: sha }, body, null), true);
  assert.equal(verifyFeed({ url: 'https://x', sha256: sha }, Buffer.from('0.0.0.0/1\n'), null), false);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  const sig = sign(null, body, privateKey);
  assert.equal(verifyFeed({ url: 'https://x', key }, body, sig), true);
  assert.equal(verifyFeed({ url: 'https://x', key }, body, Buffer.from(sig.toString('base64'))), true);   // base64 .sig files
  assert.equal(verifyFeed({ url: 'https://x', key }, Buffer.from('other'), sig), false);
  assert.equal(verifyFeed({ url: 'https://x', key }, body, null), false);
});

test('firewall: threat-intel sets drop both ways, also during isolation', () => {
  const s = securitySettings(null);
  const r = renderPolicyFirewall(s, null, { v4: ['198.51.100.0/24'], v6: ['2001:db8:1::/48'] })!;
  assert.match(r, /set threat_v4 \{\n    type ipv4_addr; flags interval; auto-merge;\n    elements = \{ 198\.51\.100\.0\/24 \}\n  \}/);
  assert.match(r, /\n    ip daddr @threat_v4 drop\n/);
  assert.match(r, /\n    ip6 daddr @threat_v6 drop\n/);
  assert.match(r, /hook input priority filter \+ 10; policy accept;\n    ip saddr @threat_v4 drop\n    ip6 saddr @threat_v6 drop/);
  const iso = renderPolicyFirewall(s, isolationPlan(NOW, 2, ['192.0.2.10']), { v4: ['198.51.100.0/24'], v6: [] })!;
  assert.match(iso, /policy drop;\n    ip saddr @threat_v4 drop\n    iifname "lo" accept/);
  assert.doesNotMatch(iso, /threat_v6 drop/);
  assert.equal(renderPolicyFirewall(s, null, { v4: [], v6: [] }), null);
});

const hasNft = process.getuid?.() === 0 && ['/usr/sbin/nft', '/sbin/nft'].some((p) => { try { return lstatSync(p).isFile(); } catch { return false; } });
test('threat-intel table parses with nft -c, including a large feed (root with nft only)', { skip: !hasNft }, async () => {
  const { execFileSync } = await import('node:child_process');
  const d = mkdtempSync(join(tmpdir(), 'ws-nft-'));
  try {
    const big = Array.from({ length: 20_000 }, (_, i) => `198.${18 + (i >> 16) % 2}.${(i >> 8) & 255}.${i & 255}`).join('\n');
    const feed = parseIpFeed(big + '\n203.0.113.0/24\n2001:db8:1::/48\n', 50_000);
    assert.equal(feed.v4.length, 20_001);
    const s = securitySettings(pol({ firewall_outbound_block: ['198.51.100.7'], firewall_log_blocked: true }));
    for (const iso of [null, isolationPlan(NOW, 2, ['192.0.2.1'])]) {
      writeFileSync(join(d, 'p.nft'), renderPolicyFirewall(s, iso, feed)!);
      execFileSync('nft', ['-c', '-f', join(d, 'p.nft')]);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- SecurityCenter with a fake host ----

const facts = (over: Partial<EngineFacts> = {}): EngineFacts => ({ firewall_active: true, policy_table_active: false, clamav: { engine: '1.0.7', signatures: 1, signatures_at: NOW - 3_600_000 }, freshclam: 'active', onaccess: 'active', guard: 'active', ...over });

function center(policy: Policy | null) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-prot-'));
  const state = new StateFile(join(dir, 'state.json'));
  const log: { e: string; f?: Record<string, unknown> }[] = [];
  const h = {
    configs: new Map<string, string>(), units: [] as string[], followers: new Map<string, (l: string) => void>(), watched: [] as string[], onFile: null as ((p: string) => void) | null,
    cache: new Map<string, string>(), feeds: new Map<string, { body: Buffer; signature: Buffer | null } | Error>(), dnsReloads: 0, firewall: [] as (string | null)[],
    quarantined: [] as string[], detect: new Set<string>(), restored: [] as [string, boolean][], deleted: [] as string[], signals: [] as [number, string, string][], facts: facts(),
  };
  const host: SecurityHost = {
    async applyFirewall(r) { h.firewall.push(r); }, writeFreshclamEnv() { return false; }, async facts() { return h.facts; }, async restartUnit() {},
    async resolve() { return ['192.0.2.10']; }, async scan() { return { code: 0 }; }, async cancelScan() {}, async mounts() { return ''; },
    async quarantine(p) { h.quarantined.push(p); return `0000000${h.quarantined.length}-0000-4000-8000-000000000000`; },
    async load() { return { idle: false, loadPerCore: 0, onBattery: false, hour: 1 }; }, async firewallAlerts() { return { alerts: [] }; },
    publish() {}, audit(e, f) { log.push({ e, f }); },
    async homes() { return ['/home/a']; },
    writeConfig(p, c) { const cur = h.configs.get(p) ?? null; if (cur === c) return false; if (c === null) h.configs.delete(p); else h.configs.set(p, c); return true; },
    async unit(n, a) { h.units.push(`${a} ${n}`); },
    follow(u, fn) { h.followers.set(u, fn); return () => { h.followers.delete(u); }; },
    async fetchFeed(url) { const r = h.feeds.get(url); if (!r) throw new Error('HTTP_404'); if (r instanceof Error) throw r; return r; },
    feedCache(n, d) { if (d === undefined) return h.cache.get(n) ?? null; if (d === null) { h.cache.delete(n); return null; } h.cache.set(n, d); return d; },
    async reloadDns() { h.dnsReloads++; },
    watchFiles(dirs, fn) { h.watched = dirs; h.onFile = fn; return () => { h.watched = []; h.onFile = null; }; },
    async scanFiles(paths) { return paths.filter((p) => h.detect.has(p)).map((path) => ({ path, signature: 'Eicar' })); },
    async restoreQuarantined(id, force) { h.restored.push([id, force]); return { path: '/home/a/Downloads/x' }; },
    async deleteQuarantined(id) { h.deleted.push(id); },
    async signal(pid, start, sig) { h.signals.push([pid, start, sig]); return pid === 999 ? 'gone' : 'ok'; },
  };
  let p = policy;
  const c = new SecurityCenter({ state, host, now: () => NOW, managed: () => ({ enrolled: p !== null, policy: p, server: 'https://work.example.com' }) });
  return { c, h, log, setPolicy: (x: Policy | null) => { p = x; }, cleanup: () => { c.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('center: policy → clamonacc, guard, DNS and Downloads; turned off again → removed and stopped', async () => {
  const w = center(pol({ realtime_protection: true, protected_folders: ['~/Documents'], dns_blocklist: ['bad.example'] }));
  try {
    await w.c.enforce();
    assert.match(w.h.configs.get(ONACCESS_CONF)!, /OnAccessIncludePath \/home/);
    assert.match(w.h.configs.get(GUARD_CONF)!, /protect \/home\/a\/Documents/);
    assert.match(w.h.configs.get(DNS_BLOCKLIST)!, /address=\/bad\.example\//);
    assert.match(w.h.configs.get(DNS_MODE_CONF)!, /dns=dnsmasq/);
    assert.deepEqual(w.h.units, [`restart ${ONACCESS_UNIT}`, `restart ${GUARD_UNIT}`]);
    assert.equal(w.h.dnsReloads, 1);
    assert.deepEqual([...w.h.followers.keys()].sort(), [GUARD_UNIT, ONACCESS_UNIT]);
    assert.deepEqual(w.h.watched, ['/home/a/Downloads']);
    // Applying the same policy again changes nothing.
    await w.c.enforce();
    assert.equal(w.h.units.length, 2); assert.equal(w.h.dnsReloads, 1);
    const st = await w.c.status();
    assert.equal(st.realtime.state, 'active'); assert.equal(st.protected_folders.state, 'active'); assert.equal(st.web.dns_blocked, 1);
    w.setPolicy(pol({ download_scan: false }));
    await w.c.enforce();
    assert.equal(w.h.configs.size, 0);
    assert.deepEqual(w.h.units.slice(2), [`stop ${ONACCESS_UNIT}`, `stop ${GUARD_UNIT}`]);
    assert.equal(w.h.followers.size, 0); assert.deepEqual(w.h.watched, []);
    assert.equal(w.h.dnsReloads, 2);
  } finally { w.cleanup(); }
});

test('center: real-time block → event, quarantine, at-risk only while unresolved; helper down → attention', async () => {
  const w = center(pol({ realtime_protection: true }));
  try {
    await w.c.enforce();
    await w.c.onAccessLine('ClamInotif: /home/a/Downloads/eicar.com: Win.Test.EICAR_HDB-1 FOUND');
    let st = await w.c.status();
    assert.equal(st.events[0].kind, 'onaccess_blocked');
    assert.deepEqual(w.h.quarantined, ['/home/a/Downloads/eicar.com']);
    assert.equal(st.quarantine.length, 1); assert.equal(st.quarantine[0].signature, 'Win.Test.EICAR_HDB-1');
    assert.equal(st.overall, 'protected');
    w.h.facts = facts({ onaccess: 'failed' });
    st = await w.c.status();
    assert.ok(st.issues.includes('realtime_off')); assert.equal(st.overall, 'attention');
  } finally { w.cleanup(); }
});

test('center: ransomware suspension is at-risk until resumed or ended (pid reuse → gone)', async () => {
  const w = center(pol({ protected_folders: ['~/Documents'] }));
  try {
    await w.c.enforce();
    w.h.followers.get(GUARD_UNIT)!('{"event":"burst_suspended","pid":4242,"enforced":true,"exe":"/usr/bin/python3","path":"/home/a/Documents/f.locked","start":"777","count":200}');
    w.h.followers.get(GUARD_UNIT)!('{"event":"write_blocked","pid":5,"enforced":true,"exe":"/home/a/x","path":"/home/a/Documents/g"}');
    let st = await w.c.status();
    assert.equal(st.overall, 'at_risk'); assert.ok(st.issues.includes('process_suspended'));
    assert.equal(st.suspended.length, 1);
    await w.c.resolveSuspended(st.suspended[0].id, 'terminate', 'user');
    assert.deepEqual(w.h.signals, [[4242, '777', 'SIGKILL']]);
    st = await w.c.status();
    assert.equal(st.overall, 'protected'); assert.equal(st.events.find((e) => e.kind === 'ransomware_suspended')?.resolved, 'terminated');
    await assert.rejects(w.c.resolveSuspended(st.events[1].id, 'resume', 'user'), /NOT_SUSPENDED/);
    assert.ok(w.log.some((l) => l.e === 'protection_ransomware_suspended'));
  } finally { w.cleanup(); }
});

test('center: a new download is scanned and quarantined when infected', async () => {
  const w = center(pol({}));
  try {
    await w.c.enforce();
    w.h.detect.add('/home/a/Downloads/bad.exe');
    await w.c.onDownload('/home/a/Downloads/fine.pdf');
    await w.c.onDownload('/home/a/Downloads/bad.exe');
    assert.deepEqual(w.h.quarantined, ['/home/a/Downloads/bad.exe']);
    assert.equal((await w.c.status()).events[0].kind, 'download_threat');
  } finally { w.cleanup(); }
});

test('center: quarantine restore and delete, only for what is in quarantine', async () => {
  const w = center(pol({}));
  try {
    w.h.detect.add('/home/a/Downloads/a'); w.h.detect.add('/home/a/Downloads/b');
    await w.c.onDownload('/home/a/Downloads/a'); await w.c.onDownload('/home/a/Downloads/b');
    const [b, a] = (await w.c.status()).quarantine;
    await w.c.restore(a.id, false, 'user');
    await w.c.deleteQuarantined(b.id, 'remote');
    assert.deepEqual(w.h.restored, [[a.id, false]]); assert.deepEqual(w.h.deleted, [b.id]);
    const st = await w.c.status();
    assert.equal(st.quarantine.length, 0);
    assert.deepEqual(st.history.map((x) => x.action).sort(), ['deleted', 'restored']);
    await assert.rejects(w.c.restore(a.id, false, 'user'), /NOT_IN_QUARANTINE/);
    assert.equal((await w.c.summary()).quarantine.length, 0);
  } finally { w.cleanup(); }
});

test('center: threat feeds — verified ones merge into the firewall and DNS, a failing one keeps the last good list', async () => {
  const ips = Buffer.from('198.51.100.0/24\n192.0.2.10\n'), doms = Buffer.from('0.0.0.0 phish.example\n');
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const policy = pol({ firewall_threat_feeds: [{ url: 'https://f.example/ips', sha256: sha(ips) }, { url: 'https://f.example/bad', sha256: SHA }], dns_threat_feeds: [{ url: 'https://f.example/dns', sha256: sha(doms) }], dns_blocklist: ['bad.example'] });
  const w = center(policy);
  try {
    w.h.feeds.set('https://f.example/ips', { body: ips, signature: null });
    w.h.feeds.set('https://f.example/bad', { body: Buffer.from('1.2.3.4\n'), signature: null });
    w.h.feeds.set('https://f.example/dns', { body: doms, signature: null });
    await w.c.refreshFeeds(true);
    const fw = w.h.firewall.at(-1)!;
    assert.match(fw, /elements = \{ 198\.51\.100\.0\/24 \}/);   // the management server (192.0.2.10) is never blocked
    assert.doesNotMatch(fw, /1\.2\.3\.4/);                    // hash mismatch → ignored
    assert.match(w.h.configs.get(DNS_BLOCKLIST)!, /address=\/bad\.example\/\naddress=\/phish\.example\//);
    let st = await w.c.status();
    assert.equal(st.threat_intel.entries, 1); assert.equal(st.threat_intel.errors.length, 1); assert.equal(st.web.dns_feed_entries, 1);
    // Feeds down: the last good list stays in force.
    w.h.feeds.set('https://f.example/ips', new Error('HTTP_503')); w.h.feeds.set('https://f.example/dns', new Error('HTTP_503'));
    await w.c.refreshFeeds(true);
    assert.match(w.h.firewall.at(-1)!, /198\.51\.100\.0\/24/);
    st = await w.c.status();
    assert.equal(st.threat_intel.errors.length, 3);
    // Feeds removed from the policy → lists dropped.
    w.setPolicy(pol({}));
    await w.c.refreshFeeds(true);
    assert.equal(w.h.firewall.at(-1), null);
    assert.equal(w.h.configs.get(DNS_BLOCKLIST), undefined);
  } finally { w.cleanup(); }
});

test('host: config files, feed cache and the Downloads watcher on a real file system', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ws-ph-'));
  try {
    const host = linuxSecurityHost({ stateDir: join(d, 'state'), runtimeDir: d, audit: () => {} });
    const conf = join(d, 'etc', 'x.conf');
    assert.equal(host.writeConfig(conf, 'a\n'), true); assert.equal(host.writeConfig(conf, 'a\n'), false);
    assert.equal(readFileSync(conf, 'utf8'), 'a\n');
    assert.equal(host.writeConfig(conf, null), true); assert.equal(host.writeConfig(conf, null), false);
    assert.equal(host.feedCache('dns'), null); host.feedCache('dns', '["a.example"]'); assert.equal(host.feedCache('dns'), '["a.example"]');
    assert.equal((lstatSync(join(d, 'state', 'feeds', 'dns.json')).mode & 0o777), 0o600);
    const dl = join(d, 'Downloads'); mkdirSync(dl);
    const seen: string[] = [];
    const stop = host.watchFiles([dl, join(d, 'missing')], (p) => seen.push(p));
    writeFileSync(join(dl, 'file.zip.part'), 'partial');
    writeFileSync(join(dl, 'report.pdf'), 'done');
    await new Promise((r) => setTimeout(r, 4600));
    stop();
    assert.deepEqual(seen, [join(dl, 'report.pdf')]);
    await assert.rejects(host.fetchFeed('http://feeds.example/x', 10, false), /NOT_HTTPS/);
    assert.equal(await host.signal(2 ** 22 + 1, '1', 'SIGCONT'), 'gone');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
