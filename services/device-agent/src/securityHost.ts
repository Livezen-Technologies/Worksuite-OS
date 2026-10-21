// Linux effects for WorkSuite Security (src/securityCenter.ts): nft, ClamAV (clamscan, freshclam), systemd, the
// kernel log. Fixed argument arrays only. Scans run as a transient unit at idle CPU/IO priority under the policy's
// CPU quota (systemd-run), outside the agent's sandbox so they can read every file they are given.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, lstatSync, watch, type FSWatcher } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { cpus, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import type { SecurityHost } from './securityCenter.ts';
import { CLAMD_SOCKET } from './protection.ts';
import { exclusionArgs, FIREWALL_RULES, FRESHCLAM_ENV, LOG_PREFIX, parseClamscan, parseClamVersion, parseFirewallLog, POLICY_TABLE } from './security.ts';

/** One scan at a time, under a fixed name: cancel and a restarted agent can always find (and stop) it. */
export const SCAN_UNIT = 'worksuite-av-scan.service';

/** The transient unit's command line (#64): recursive, every file's result on stdout (progress), no summary. */
export function scanCommand(plan: { roots: string[]; exclusions: string[] }, cpuQuota: number): string[] {
  return [
    '--quiet', '--wait', '--pipe', '--collect', `--unit=${SCAN_UNIT}`, '--description=WorkSuite Security malware scan',
    '-p', `CPUQuota=${cpuQuota}%`, '-p', 'Nice=19', '-p', 'IOSchedulingClass=idle', '-p', 'MemoryHigh=1G',
    '--', 'clamscan', '--stdout', '--no-summary', '--recursive', '--max-filesize=200M', '--max-scansize=400M',
    ...exclusionArgs(plan.exclusions), ...plan.roots,
  ];
}

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
      const unitState = async (u: string, bin: string) => {
        const r = await run('systemctl', ['is-active', u]).catch(() => ({ code: 1, out: '' }));
        const v = r.out.trim();
        return v === 'active' || v === 'activating' ? 'active' as const : v === 'failed' ? 'failed' as const : existsSync(bin) ? 'inactive' as const : 'missing' as const;
      };
      return {
        onaccess: await unitState('worksuite-onaccess.service', '/usr/sbin/clamonacc'),
        guard: await unitState('worksuite-guard.service', '/usr/lib/worksuite/worksuite-guard'),
        // NetworkManager starts its dnsmasq with this pid file once dns=dnsmasq is in effect.
        dns_filter: existsSync('/etc/NetworkManager/conf.d/50-worksuite-dns.conf') && existsSync('/run/NetworkManager/dnsmasq.pid'),
        firewall_active: base.code === 0 && /policy drop/.test(base.out),
        policy_table_active: pol.code === 0,
        clamav: ver.code === 0 ? parseClamVersion(ver.out) : null,
        freshclam: state === 'active' || state === 'activating' ? 'active' : state === 'failed' ? 'failed' : existsSync('/usr/bin/freshclam') ? 'inactive' : 'missing',
      };
    },
    async restartUnit(unit) { await run('systemctl', ['restart', unit]); },
    async resolve(host) { return (await lookup(host, { all: true })).map((a) => a.address); },
    async scan(plan, s, onLine) {
      const roots = plan.roots.filter((r) => existsSync(r));
      if (!roots.length) return { code: 0 };
      // A unit left from an agent that stopped mid-scan would make systemd-run refuse the name.
      await run('systemctl', ['stop', SCAN_UNIT]).catch(() => {});
      await run('systemctl', ['reset-failed', SCAN_UNIT]).catch(() => {});
      return new Promise((resolve, reject) => {
        // Outside the agent's sandbox (PrivateTmp, AppArmor): it sees the real /tmp and can read every local file.
        const child = spawn('systemd-run', scanCommand({ roots, exclusions: plan.exclusions }, s.av_cpu_quota_percent), { stdio: ['ignore', 'pipe', 'pipe'] });
        const lines = (stream: NodeJS.ReadableStream) => {
          let buf = '';
          stream.setEncoding('utf8');
          stream.on('data', (c: string) => {
            buf += c;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { onLine(l); } catch { /* one bad line */ } }
            if (buf.length > 1 << 20) buf = '';
          });
          stream.on('end', () => { if (buf) try { onLine(buf); } catch { /* ignore */ } });
        };
        lines(child.stdout!); lines(child.stderr!);
        child.on('error', (e) => reject(new Error(`SYSTEMD_RUN: ${e.message}`)));
        child.on('close', (code) => resolve({ code: code ?? -1 }));
      });
    },
    async cancelScan() { await run('systemctl', ['stop', SCAN_UNIT]).catch(() => {}); },
    // Our own mount table: /proc/1 needs CAP_SYS_PTRACE, and host mounts propagate into the agent's namespace.
    async mounts() { return readFileSync('/proc/self/mounts', 'utf8'); },
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

    // ---- #38 protection layers ----
    async homes() {
      const r = await run('getent', ['passwd']).catch(() => ({ code: 1, out: '' }));
      return r.out.split('\n').map((l) => l.split(':')).filter((f) => f.length >= 7 && Number(f[2]) >= 1000 && Number(f[2]) < 60000 && f[5].startsWith('/home/') && existsSync(f[5])).map((f) => f[5]);
    },
    writeConfig(path, content) {
      let cur: string | null = null;
      try { cur = readFileSync(path, 'utf8'); } catch { /* absent */ }
      if (cur === content) return false;
      if (content === null) rmSync(path, { force: true }); else writePublic(path, content);
      return true;
    },
    async unit(name, action) {
      const r = await run('systemctl', [action, name]);
      if (r.code !== 0) throw new Error(`UNIT_${action.toUpperCase()}_FAILED`);
    },
    follow(unit, onLine) {
      // From now on (-n 0); a journalctl that ends (journald restarted) is started again after a pause.
      let stopped = false, child: ReturnType<typeof spawn> | null = null;
      const start = () => {
        if (stopped) return;
        child = spawn('journalctl', ['-f', '-n', '0', '-o', 'cat', '-u', unit], { stdio: ['ignore', 'pipe', 'ignore'] });
        let buf = '';
        child.stdout!.setEncoding('utf8');
        child.stdout!.on('data', (c: string) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { onLine(l); } catch { /* one bad line */ } }
          if (buf.length > 1 << 20) buf = '';
        });
        child.on('exit', () => { child = null; if (!stopped) setTimeout(start, 10_000).unref(); });
      };
      start();
      return () => { stopped = true; child?.kill(); };
    },
    async fetchFeed(url, maxBytes, sig) {
      const get = async (u: string, optional: boolean): Promise<Buffer | null> => {
        if (new URL(u).protocol !== 'https:') throw new Error('NOT_HTTPS');
        const r = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
        if (optional && r.status === 404) return null;
        if (!r.ok || !r.body) throw new Error(`HTTP_${r.status}`);
        const parts: Buffer[] = [];
        let n = 0;
        for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
          n += c.byteLength;
          if (n > maxBytes) throw new Error('FEED_TOO_LARGE');
          parts.push(Buffer.from(c));
        }
        return Buffer.concat(parts);
      };
      const body = (await get(url, false))!;
      return { body, signature: sig ? await get(url + '.sig', true) : null };
    },
    feedCache(name, data) {
      const p = join(o.stateDir, 'feeds', `${name}.json`);
      if (data === undefined) { try { return readFileSync(p, 'utf8'); } catch { return null; } }
      if (data === null) { rmSync(p, { force: true }); return null; }
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      writeFileSync(p + '.tmp', data, { mode: 0o600 }); renameSync(p + '.tmp', p);
      return data;
    },
    async reloadDns() {
      // "conf" re-reads conf.d (dns=dnsmasq on or off); "dns-full" restarts the dnsmasq instance with the new list.
      const r = await run('nmcli', ['general', 'reload', 'conf', 'dns-full']);
      if (r.code !== 0) throw new Error('NM_RELOAD_FAILED');
    },
    watchFiles(dirs, onFile) {
      // inotify per folder (new names: a browser's final rename, a copy). A file is handed over once its size has
      // stayed the same for two seconds; partial downloads (.part, .crdownload) are skipped until renamed.
      const ws: FSWatcher[] = [], pending = new Map<string, NodeJS.Timeout>();
      const settle = (p: string, last = -1) => {
        clearTimeout(pending.get(p));
        pending.set(p, setTimeout(() => {
          let st; try { st = lstatSync(p); } catch { pending.delete(p); return; }
          if (!st.isFile()) { pending.delete(p); return; }
          if (st.size !== last) return settle(p, st.size);
          pending.delete(p); onFile(p);
        }, 2000));
      };
      const add = (d: string) => {
        try {
          ws.push(watch(d, (_ev, name) => {
            if (!name || /\.(part|crdownload|download|tmp)$/i.test(String(name)) || String(name).startsWith('.')) return;
            settle(join(d, String(name)));
          }));
        } catch { /* folder missing: created later, picked up at the next policy application */ }
      };
      dirs.forEach(add);
      return () => { ws.forEach((w) => w.close()); for (const t of pending.values()) clearTimeout(t); pending.clear(); };
    },
    async scanFiles(paths, s) {
      const files = paths.filter((p) => { try { return lstatSync(p).isFile(); } catch { return false; } });
      if (!files.length) return [];
      // clamd (when real-time protection runs it) answers at once; otherwise clamscan loads the signatures itself.
      const useClamd = existsSync(CLAMD_SOCKET);
      const r = useClamd
        ? await run('clamdscan', ['--fdpass', '--infected', '--no-summary', '--stdout', ...files], 10 * 60_000)
        : await run('systemd-run', ['--quiet', '--wait', '--pipe', '--collect', '-p', `CPUQuota=${s.av_cpu_quota_percent}%`, '-p', 'Nice=10', '-p', 'MemoryHigh=768M',
          '--', 'clamscan', '--infected', '--no-summary', '--stdout', '--max-filesize=200M', '--max-scansize=400M', ...files], 10 * 60_000);
      if (r.code !== 0 && r.code !== 1 && r.code !== 2) throw new Error(`CLAMSCAN_${r.code}`);
      return parseClamscan(r.out);
    },
    async restoreQuarantined(id, force) {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('BAD_ID');
      const meta = JSON.parse(readFileSync(join(qdir, `${id}.json`), 'utf8')) as { path: string; uid: number; mode: number; sha256: string };
      const bin = join(qdir, `${id}.bin`);
      if (existsSync(meta.path)) throw new Error('PATH_EXISTS');
      // Re-scan a copy in the quarantine (root-only) before anything leaves it.
      const tmp = join(qdir, `${id}.rescan`);
      chmodSync(bin, 0o400); copyFileSync(bin, tmp); chmodSync(bin, 0o000);
      try {
        if (createHash('sha256').update(readFileSync(tmp)).digest('hex') !== meta.sha256) throw new Error('QUARANTINE_CORRUPT');
        const r = await run('clamscan', ['--infected', '--no-summary', '--stdout', tmp], 10 * 60_000);
        if (r.code === 1 && !force) throw new Error('STILL_DETECTED');
        if (r.code !== 0 && r.code !== 1) throw new Error('RESCAN_FAILED');
        mkdirSync(dirname(meta.path), { recursive: true });
        // Written as its owner's file again; the copy is renamed into place so a half-written file never appears.
        const dest = meta.path + `.ws-restore-${id.slice(0, 8)}`;
        copyFileSync(tmp, dest);
        chownSync(dest, meta.uid, meta.uid === 0 ? 0 : statSync(dirname(meta.path)).gid);
        chmodSync(dest, meta.mode & 0o777);
        renameSync(dest, meta.path);
      } finally { rmSync(tmp, { force: true }); }
      rmSync(bin, { force: true }); rmSync(join(qdir, `${id}.json`), { force: true });
      return { path: meta.path };
    },
    async deleteQuarantined(id) {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('BAD_ID');
      if (!existsSync(join(qdir, `${id}.json`))) throw new Error('NOT_IN_QUARANTINE');
      rmSync(join(qdir, `${id}.bin`), { force: true }); rmSync(join(qdir, `${id}.json`), { force: true });
    },
    async signal(pid, start, sig) {
      let stat: string;
      try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return 'gone'; }
      if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] !== start) return 'gone';
      process.kill(pid, sig);
      return 'ok';
    },
  };
}
