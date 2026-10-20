// Linux effects for WorkSuite Security (src/securityCenter.ts): nft, ClamAV (clamscan, freshclam), systemd, the
// kernel log. Fixed argument arrays only. Scans run as a transient unit at idle CPU/IO priority under the policy's
// CPU quota (systemd-run), outside the agent's sandbox so they can read every file they are given.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, lstatSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { cpus, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import type { SecurityHost } from './securityCenter.ts';
import { exclusionArgs, FIREWALL_RULES, FRESHCLAM_ENV, LOG_PREFIX, parseClamscan, parseClamVersion, parseFirewallLog, POLICY_TABLE, walkFiles } from './security.ts';

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      if (err && code === -1) reject(new Error(`${cmd}: ${err.message.split('\n')[0]}`)); else resolve({ code, out: stdout });
    });
  });
}

function writePublic(path: string, data: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path + '.tmp', data, { mode: 0o644 });
  chmodSync(path + '.tmp', 0o644);
  renameSync(path + '.tmp', path);
}

export function linuxSecurityHost(o: { stateDir: string; runtimeDir: string; audit: (e: string, f?: Record<string, unknown>) => void }): SecurityHost {
  const qdir = join(o.stateDir, 'quarantine');
  return {
    async applyFirewall(rules) {
      if (rules === null) {
        rmSync(FIREWALL_RULES, { force: true });
        await run('nft', ['delete', 'table', 'inet', POLICY_TABLE]).catch(() => {});
        return;
      }
      let cur: string | null = null;
      try { cur = readFileSync(FIREWALL_RULES, 'utf8'); } catch { /* absent */ }
      if (cur !== rules) writePublic(FIREWALL_RULES, rules);
      const r = await run('nft', ['-f', FIREWALL_RULES]);
      if (r.code !== 0) throw new Error('NFT_REJECTED');
    },
    writeFreshclamEnv(content) {
      let cur: string | null = null;
      try { cur = readFileSync(FRESHCLAM_ENV, 'utf8'); } catch { /* absent */ }
      if (cur === content) return false;
      if (content === null) rmSync(FRESHCLAM_ENV, { force: true }); else writePublic(FRESHCLAM_ENV, content);
      return true;
    },
    async facts() {
      const base = await run('nft', ['list', 'table', 'inet', 'worksuite_filter']).catch(() => ({ code: 1, out: '' }));
      const pol = await run('nft', ['list', 'table', 'inet', POLICY_TABLE]).catch(() => ({ code: 1, out: '' }));
      const ver = await run('clamscan', ['--version'], 20_000).catch(() => ({ code: 1, out: '' }));
      const fc = await run('systemctl', ['is-active', 'clamav-freshclam.service']).catch(() => ({ code: 1, out: '' }));
      const state = fc.out.trim();
      return {
        firewall_active: base.code === 0 && /policy drop/.test(base.out),
        policy_table_active: pol.code === 0,
        clamav: ver.code === 0 ? parseClamVersion(ver.out) : null,
        freshclam: state === 'active' || state === 'activating' ? 'active' : state === 'failed' ? 'failed' : existsSync('/usr/bin/freshclam') ? 'inactive' : 'missing',
      };
    },
    async restartUnit(unit) { await run('systemctl', ['restart', unit]); },
    async resolve(host) { return (await lookup(host, { all: true })).map((a) => a.address); },
    async scan(kind, s, since) {
      const list = join(o.runtimeDir, `scan-${randomUUID()}.list`);
      let files = 0;
      try {
        const paths: string[] = [];
        for (const f of walkFiles(s.av_scan_paths, s.av_exclusions, kind === 'quick' ? since : null, {
          readdir: (p) => readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile(), link: e.isSymbolicLink() })),
          mtimeMs: (p) => lstatSync(p).mtimeMs,
        })) paths.push(f);
        files = paths.length;
        if (!files) return { files: 0, detections: [] };
        writeFileSync(list, paths.join('\n') + '\n', { mode: 0o600 });
        // Exit 0 = clean, 1 = detections, 2 = errors (unreadable files are not a failed scan when others were scanned).
        const r = await run('systemd-run', [
          '--quiet', '--wait', '--pipe', '--collect', '--unit=worksuite-av-scan-' + process.pid + '-' + Date.now(),
          '-p', `CPUQuota=${s.av_cpu_quota_percent}%`, '-p', 'Nice=19', '-p', 'IOSchedulingClass=idle', '-p', 'MemoryHigh=768M',
          '--', 'clamscan', '--infected', '--no-summary', '--stdout', '--max-filesize=200M', '--max-scansize=400M',
          ...exclusionArgs(s.av_exclusions), `--file-list=${list}`,
        ], 6 * 3_600_000);
        if (r.code !== 0 && r.code !== 1 && r.code !== 2) throw new Error(`CLAMSCAN_${r.code}`);
        return { files, detections: parseClamscan(r.out) };
      } finally { rmSync(list, { force: true }); }
    },
    async quarantine(path, signature) {
      mkdirSync(qdir, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const st = statSync(path);
      const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
      // Moved, not copied, so the original cannot run; rename fails across file systems → copy then remove.
      const dest = join(qdir, `${id}.bin`);
      try { renameSync(path, dest); } catch { copyFileSync(path, dest); rmSync(path); }
      chmodSync(dest, 0o000);
      writeFileSync(join(qdir, `${id}.json`), JSON.stringify({ id, path, signature, sha256: sha, size: st.size, uid: st.uid, mode: st.mode & 0o7777, at: Date.now() }), { mode: 0o600 });
      return id;
    },
    async load() {
      // loginctl IdleHint: every graphical session idle (or none) → idle.
      const out = await run('loginctl', ['list-sessions', '--no-legend']).catch(() => ({ code: 1, out: '' }));
      let idle = true;
      for (const line of out.out.split('\n').filter(Boolean)) {
        const id = line.trim().split(/\s+/)[0];
        const r = await run('loginctl', ['show-session', id, '-p', 'IdleHint', '-p', 'Type', '--value']).catch(() => ({ code: 1, out: '' }));
        const [hint, type] = r.out.split('\n');
        if ((type === 'wayland' || type === 'x11') && hint !== 'yes') idle = false;
      }
      let onBattery = false;
      try {
        for (const d of readdirSync('/sys/class/power_supply')) {
          const t = readFileSync(`/sys/class/power_supply/${d}/type`, 'utf8').trim();
          if (t === 'Mains' && readFileSync(`/sys/class/power_supply/${d}/online`, 'utf8').trim() === '0') onBattery = true;
        }
      } catch { /* desktop */ }
      return { idle, loadPerCore: loadavg()[0] / Math.max(1, cpus().length), onBattery, hour: new Date().getHours() };
    },
    async firewallAlerts(cursor) {
      const args = ['-k', '-o', 'short-iso', '--show-cursor', '--no-pager', `--grep=${LOG_PREFIX.trim()}`, ...(cursor ? [`--after-cursor=${cursor}`] : ['--since=-1h'])];
      const r = await run('journalctl', args, 30_000);
      const lines = r.out.split('\n');
      const c = /^-- cursor: (\S+)/m.exec(r.out)?.[1];
      return { alerts: parseFirewallLog(lines).map(({ uid: _u, ...a }) => ({ ...a, at: a.at ?? Date.now() })), cursor: c ?? cursor };
    },
    publish(status) { writePublic(join(o.runtimeDir, 'security.json'), JSON.stringify(status, null, 2)); },
    audit: o.audit,
  };
}
