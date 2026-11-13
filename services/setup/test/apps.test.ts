// Phase 4: the app plan (selection, organization policy, dependencies, order) and the installation engine (verified
// bundled packages, signed APT, per-app retry, unresolvable dependencies, offline queue and its drain), against a
// fake package manager that records every command.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CATALOG, type AppDef } from '../src/apps/catalog.ts'
import { plan } from '../src/apps/plan.ts'
import { AppEngine, readQueue, readStatus } from '../src/apps/engine.ts'

const ids = (p: ReturnType<typeof plan>) => p.install.map((x) => x.app.id)

test('plan: Desktop always, selection kept, policy mandatory and restricted, third-party allowlist', () => {
  assert.deepEqual(ids(plan([], null)), ['worksuite-desktop'])
  const p = plan(['worksuite-office', 'vlc', 'nope'], { setup_mandatory_apps: ['worksuite-pos'], setup_restricted_apps: ['worksuite-office', 'worksuite-desktop'] })
  assert.deepEqual(ids(p), ['worksuite-desktop', 'worksuite-pos', 'vlc'])
  assert.deepEqual(p.install.map((x) => x.required), [true, true, false])
  assert.deepEqual(p.skipped, [{ id: 'nope', why: 'unknown' }, { id: 'worksuite-office', why: 'restricted' }])
  assert.deepEqual(ids(plan(['vlc', 'gimp'], { software_install: 'block' })), ['worksuite-desktop'])
  assert.deepEqual(ids(plan(['vlc', 'gimp', 'thunderbird'], { software_install: 'approved', app_allowlist: ['apt:vlc', 'setup:thunderbird'] })), ['worksuite-desktop', 'vlc', 'thunderbird'])
})

test('plan: dependencies first, a dependency of a required app is required, cycles are refused', () => {
  const cat: AppDef[] = [
    { id: 'core', name: 'Core', group: 'worksuite', sources: [{ type: 'apt', package: 'core' }], core: true, requires: ['lib'] },
    { id: 'lib', name: 'Lib', group: 'worksuite', sources: [{ type: 'apt', package: 'lib' }] },
    { id: 'app', name: 'App', group: 'worksuite', sources: [{ type: 'apt', package: 'app' }], requires: ['lib'] },
  ]
  const p = plan(['app'], null, cat)
  assert.deepEqual(ids(p), ['lib', 'core', 'app'])
  assert.equal(p.install[0].required, true)
  assert.throws(() => plan([], null, [{ ...cat[0], requires: ['x'] }, { id: 'x', name: 'X', group: 'worksuite', sources: [], requires: ['core'] }]), /cycle/)
})

type Cmd = string[]
function harness(o: { online?: boolean; installed?: string[]; fail?: (c: Cmd) => { code: number; stdout?: string; stderr?: string } | null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-apps-'))
  const bundled = path.join(dir, 'bundled')
  const cmds: Cmd[] = []
  const installed = new Set(o.installed ?? [])
  const state = { online: o.online ?? true }
  const env = {
    runner: {
      async run(cmd: string, args: string[]) {
        const c = [cmd, ...args]; cmds.push(c)
        const f = o.fail?.(c); if (f) return { stdout: '', stderr: '', ...f }
        if (cmd === 'dpkg-query') return installed.has(args.at(-1)!) ? { code: 0, stdout: 'install ok installed', stderr: '' } : { code: 1, stdout: '', stderr: 'not installed' }
        if (cmd === 'apt-get' && args.includes('install') && !args.includes('-s')) installed.add(path.basename(args.at(-1)!).split('_')[0])
        if (cmd === 'flatpak' && args[0] === 'remotes') return { code: 0, stdout: 'flathub\n', stderr: '' }
        if (cmd === 'flatpak' && args[0] === 'info') return { code: 1, stdout: '', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    },
    bundledDir: bundled, online: () => state.online,
    statusFile: path.join(dir, 'apps.json'), queueFile: path.join(dir, 'app-queue.json'),
    log: () => {}, sleep: async () => {}, retry: { max: 3, backoffMs: 1 },
  }
  const bundle = (files: Record<string, string>, corrupt?: string) => {
    mkdirSync(bundled, { recursive: true })
    const lines: string[] = []
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(path.join(bundled, name), body)
      lines.push(`${createHash('sha256').update(name === corrupt ? 'tampered' : body).digest('hex')}  ${name}`)
    }
    writeFileSync(path.join(bundled, 'SHA256SUMS'), lines.join('\n') + '\n')
  }
  return { env, cmds, bundle, state, installed, engine: new AppEngine(env) }
}

test('engine: bundled packages install offline by absolute path after their checksum; apt stays signed', async () => {
  const h = harness({ online: false })
  h.bundle({ 'worksuite_0.2.300_amd64.deb': 'desk', 'worksuite-pos_1.0.8_amd64.deb': 'pos' })
  const st = await h.engine.run(plan(['worksuite-pos'], null))
  assert.deepEqual(st.map((s) => [s.id, s.state, s.source]), [['worksuite-desktop', 'installed', 'bundled'], ['worksuite-pos', 'installed', 'bundled']])
  const installs = h.cmds.filter((c) => c[0] === 'apt-get' && c.includes('install') && !c.includes('-s'))
  assert.ok(installs.every((c) => path.isAbsolute(c.at(-1)!) && c.includes('APT::Get::AllowUnauthenticated=false')))
  assert.ok(!h.cmds.some((c) => c.join(' ').includes('update')), 'offline bundled installs need no package lists')
  assert.deepEqual(readStatus(h.env.statusFile).map((s) => s.state), ['installed', 'installed'])
})

test('engine: a damaged bundled package is never installed; a required one fails the step after the others ran', async () => {
  const h = harness({ online: false })
  h.bundle({ 'worksuite_0.2.300_amd64.deb': 'desk', 'worksuite-office_10.1.20_amd64.deb': 'office' }, 'worksuite_0.2.300_amd64.deb')
  await assert.rejects(h.engine.run(plan(['worksuite-office'], null)), /WorkSuite Desktop: the bundled worksuite_0\.2\.300_amd64\.deb is missing or damaged/)
  assert.ok(!h.cmds.some((c) => c.join(' ').includes('worksuite_0.2.300')), 'the damaged file never reached apt')
  assert.equal(readStatus(h.env.statusFile).find((s) => s.id === 'worksuite-office')?.state, 'installed')
})

test('engine: offline apps without a bundled package are queued, then installed by the drain once online', async () => {
  const h = harness({ online: false })
  h.bundle({ 'worksuite_0.2.300_amd64.deb': 'desk' })
  const st = await h.engine.run(plan(['vlc', 'worksuite-frameflow'], null))
  assert.deepEqual(st.map((s) => [s.id, s.state]), [['worksuite-desktop', 'installed'], ['vlc', 'queued'], ['worksuite-frameflow', 'queued']])
  assert.deepEqual(readQueue(h.env.queueFile), ['vlc', 'worksuite-frameflow'])
  h.state.online = true
  const r = await new AppEngine(h.env).drain(new Map(CATALOG.map((a) => [a.id, a])))
  assert.deepEqual(r, { installed: ['vlc', 'worksuite-frameflow'], left: [] })
  assert.deepEqual(readQueue(h.env.queueFile), [])
  assert.ok(h.cmds.some((c) => c.join(' ') === 'apt-get -q update'))
})

test('engine: per-app retry with backoff; unresolvable dependencies are not retried; optional failures do not fail setup', async () => {
  let n = 0
  const h = harness({
    installed: ['worksuite'],
    fail: (c) => {
      if (c[0] === 'apt-get' && c.includes('install') && !c.includes('-s') && !c.includes('--print-uris') && c.at(-1) === 'worksuite-office' && ++n < 3) return { code: 100, stderr: 'E: Connection reset' }
      if (c[0] === 'apt-get' && c.includes('-s') && c.at(-1) === 'gimp') return { code: 100, stdout: 'gimp : Depends: libgimp3 but it is not installable' }
      return null
    },
  })
  const st = await h.engine.run(plan(['worksuite-office', 'gimp'], null))
  const by = Object.fromEntries(st.map((s) => [s.id, s]))
  assert.equal(by['worksuite-desktop'].state, 'already')
  assert.equal(by['worksuite-office'].state, 'installed'); assert.equal(by['worksuite-office'].attempts, 3)
  assert.equal(by.gimp.state, 'failed'); assert.equal(by.gimp.attempts, 1)
  assert.match(by.gimp.error!, /dependencies cannot be resolved: gimp : Depends: libgimp3/)
  // Once at the start, and again before each retry that follows a failed download (stale lists are a common cause).
  assert.equal(h.cmds.filter((c) => c.join(' ') === 'apt-get -q update').length, 3, 'lists refreshed first and after each network failure')
})

test('engine: downloads that keep failing while "online" queue an optional app for later, never a non-network error', async () => {
  const h = harness({
    installed: ['worksuite'],
    fail: (c) => {
      if (c[0] !== 'apt-get' || !c.includes('install') || c.includes('-s')) return null
      if (c.at(-1) === 'vlc') return { code: 100, stderr: 'E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?' }
      if (c.at(-1) === 'gimp') return { code: 100, stderr: 'E: Sub-process /usr/bin/dpkg returned an error code (1)' }
      return null
    },
  })
  const st = await h.engine.run(plan(['vlc', 'gimp'], null))
  const by = Object.fromEntries(st.map((s) => [s.id, s]))
  assert.equal(by.vlc.state, 'queued'); assert.equal(by.vlc.attempts, 3)
  assert.match(by.vlc.error!, /Unable to fetch/)
  assert.equal(by.gimp.state, 'failed')
  assert.deepEqual(readQueue(h.env.queueFile), ['vlc'])
})

test('engine: restricted and not-allowed apps are reported as skipped, never installed', async () => {
  const h = harness({ installed: ['worksuite'] })
  const st = await h.engine.run(plan(['worksuite-pos', 'vlc'], { setup_restricted_apps: ['worksuite-pos'], software_install: 'block' }))
  assert.deepEqual(st.map((s) => [s.id, s.state, s.why ?? null]), [['worksuite-desktop', 'already', null], ['worksuite-pos', 'skipped', 'restricted'], ['vlc', 'skipped', 'not_allowed']])
  assert.ok(!h.cmds.some((c) => c.includes('worksuite-pos') || c.includes('vlc')))
  assert.ok(JSON.parse(readFileSync(h.env.statusFile, 'utf8')).length === 3)
})

test('deployment sync: the report carries states, never answers; defaults apply only where unanswered and well-formed', async () => {
  const { buildReport, defaultsToApply } = await import('../src/apps/report.ts')
  const r = buildReport({ state: 'INSTALLING_APPLICATIONS', mode: 'install', lastError: 'e'.repeat(500) },
    [{ id: 'worksuite-pos', name: 'WorkSuite POS', required: false, state: 'failed', source: 'apt', attempts: 3, error: 'E: reset' }], 10, null)
  assert.deepEqual(r, { state: 'INSTALLING_APPLICATIONS', mode: 'install', updated_at: 10, completed_at: null, last_error: 'e'.repeat(300),
    apps: [{ id: 'worksuite-pos', state: 'failed', required: false, attempts: 3, error: 'E: reset' }] })
  assert.ok(!JSON.stringify(r).includes('WorkSuite POS'), 'no display names or answers, ids only')
  assert.deepEqual(defaultsToApply({ locale: 'si_LK', timezone: 'Asia/Colombo', keyboard: 'us; reboot' }, { timezone: 'UTC' }), [['locale', 'si_LK']])
  assert.deepEqual(defaultsToApply(null, {}), [])
  assert.deepEqual(defaultsToApply(['si_LK'], {}), [])
})

test('engine: apt Status-Fd progress becomes each app\'s 0–100 figure, download then install', async () => {
  const { aptProgress } = await import('../src/apps/engine.ts')
  assert.equal(aptProgress('dlstatus:1:40.0000:Retrieving file 2 of 5'), 20)
  assert.equal(aptProgress('pmstatus:worksuite-pos:60:Unpacking worksuite-pos'), 80)
  assert.equal(aptProgress('Reading package lists...'), null)
  const h = harness({ installed: ['worksuite'] })
  const seen: number[] = []
  ;(h.env.runner as { stream?: unknown }).stream = async (cmd: string, args: string[], onLine: (l: string) => void) => {
    assert.ok(args.includes('APT::Status-Fd=1'))
    for (const l of ['dlstatus:1:0:start', 'dlstatus:1:100:done', 'pmstatus:p:10:Preparing', 'pmstatus:p:10:again', 'pmstatus:p:100:Installed']) {
      onLine(l)
      seen.push(readStatus(h.env.statusFile).find((s) => s.id === 'worksuite-pos')!.progress!)
    }
    return h.env.runner.run(cmd, args)
  }
  const st = await h.engine.run(plan(['worksuite-pos'], null))
  assert.deepEqual(seen, [0, 50, 55, 55, 100])
  assert.deepEqual(st.map((s) => [s.id, s.state, s.progress]), [['worksuite-desktop', 'already', 100], ['worksuite-pos', 'installed', 100]])
})

test('apt phases, download size and actionable reasons come from apt\'s own output', async () => {
  const { aptPhase, downloadBytes, aptReason } = await import('../src/apps/engine.ts')
  assert.equal(aptPhase('dlstatus:1:12.5:Retrieving file 1 of 3'), 'downloading')
  assert.equal(aptPhase('pmstatus:vlc:40:Unpacking vlc (amd64)'), 'installing')
  assert.equal(aptPhase('pmstatus:vlc:80:Configuring vlc (amd64)'), 'configuring')
  assert.equal(aptPhase('pmstatus:dpkg-exec:95:Running dpkg'), 'configuring')
  assert.equal(aptPhase('Reading package lists...'), null)
  assert.equal(downloadBytes("'http://deb.debian.org/debian/pool/main/v/vlc/vlc_3.0.21_amd64.deb' vlc_3.0.21_amd64.deb 1048576 SHA256:ab\n'http://x/y.deb' y.deb 2048 SHA256:cd\n"), 1050624)
  assert.equal(downloadBytes(''), 0)
  assert.match(aptReason("E: You don't have enough free space in /var/cache/apt/archives/.") ?? '', /free disk space/)
  assert.match(aptReason('E: Unmet dependencies. Try apt --fix-broken') ?? '', /conflict/)
  assert.equal(aptReason('E: Failed to fetch http://x'), null)
})

test('engine: a stop request takes effect between apps; the rest stay pending for the next run', async () => {
  const h = harness({ installed: ['worksuite'] })
  let installs = 0
  const orig = h.env.runner.run
  h.env.runner.run = async (cmd, args) => { if (cmd === 'apt-get' && args.includes('install') && !args.includes('-s') && !args.includes('--print-uris')) installs++; return orig(cmd, args) }
  const st = await h.engine.run(plan(['worksuite-office', 'worksuite-pos'], null), () => installs >= 1)
  const by = Object.fromEntries(st.map((s) => [s.id, s.state]))
  assert.equal(by['worksuite-office'], 'installed')
  assert.equal(by['worksuite-pos'], 'pending', 'not started after the stop')
  assert.equal(installs, 1)
})
