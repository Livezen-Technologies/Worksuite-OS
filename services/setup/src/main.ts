// worksuite-setup: root daemon owning lk.worksuite.Setup1 on the system bus.
//   worksuite-setup [--mode install|firstRun]   (default: install on the live ISO, firstRun otherwise)
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statfsSync } from 'node:fs'
import { arch } from 'node:os'
import path from 'node:path'
import dbus from 'dbus-next'
import { NAME, serve, type Authority } from './dbus.ts'
import { ActionError, SetupService, type ActionHandler } from './service.ts'
import { MirroredFileStore } from './store.ts'
import { btrfsSnapshot, configBackup, packageTransaction, type Runner } from './rollback.ts'
import { hostRoot } from './hostroot.ts'
import type { SetupMode } from './machine/core/states.ts'
import { CATALOG } from './apps/catalog.ts'
import { plan, type AppPolicy } from './apps/plan.ts'
import { AppEngine, readStatus } from './apps/engine.ts'
import { buildReport, defaultsToApply, writeReport } from './apps/report.ts'

const { Message, Variant } = dbus
const STATE_DIR = '/var/lib/worksuite/setup'
const ESP_DIR = '/boot/efi/worksuite-setup'
const LOG_DIR = '/var/log/worksuite/setup'
const XML = '/usr/share/dbus-1/interfaces/lk.worksuite.Setup1.xml'
const BUNDLED = '/usr/share/worksuite/bundled'
const POLICY = '/run/worksuite-device-agent/policy.json'
const APPS_STATUS = path.join(STATE_DIR, 'apps.json')
const APP_QUEUE = path.join(STATE_DIR, 'app-queue.json')
const REPORT = '/run/worksuite-setup/report.json'
const RUN_ENV = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C.UTF-8', DEBIAN_FRONTEND: 'noninteractive' }

/** Fixed executables, argument vectors, no shell. Package-changing commands run in their own transient unit
 *  (hostRoot): this service keeps ProtectSystem=full, which makes /usr and /etc read-only here and which systemd 257
 *  does not let ReadWritePaths= reopen. Without this, dpkg failed to unpack every app in a VM ("Read-only file
 *  system" under /usr/share/icons). The same split as the package service: the service confined, apt/dpkg not. */
const viaHost = (cmd: string, args: string[]): [string, string[]] => hostRoot(cmd, args)
  ? ['systemd-run', ['--quiet', '--wait', '--pipe', '--collect', '--service-type=exec', '-p', 'KillMode=mixed',
      ...Object.entries(RUN_ENV).map(([k, v]) => `--setenv=${k}=${v}`), '--', cmd, ...args]]
  : [cmd, args]
const runner: Runner & { stream: NonNullable<import('./apps/engine.ts').StreamRunner['stream']> } = {
  // Same fixed argv and environment as run(), with stdout handed over line by line (apt's Status-Fd progress).
  stream: (cmd, args, onLine) => new Promise((resolve) => {
    const [c0, a0] = viaHost(cmd, args)
    const c = spawn(c0, a0, { env: RUN_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = '', buf = ''
    const timer = setTimeout(() => c.kill('SIGKILL'), 3_600_000)
    c.stdout.setEncoding('utf8').on('data', (d: string) => {
      out += d; buf += d
      let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { onLine(line) } catch { /* progress only */ } }
      if (out.length > 32 << 20) out = out.slice(-(16 << 20))
    })
    c.stderr.setEncoding('utf8').on('data', (d: string) => { err = (err + d).slice(-(1 << 20)) })
    c.on('error', (e) => { clearTimeout(timer); resolve({ code: 1, stdout: out, stderr: String(e) }) })
    c.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout: out, stderr: err }) })
  }),
  run: (cmd, args) => new Promise((resolve) => execFile(...viaHost(cmd, args), { env: RUN_ENV, timeout: 3_600_000, maxBuffer: 32 << 20 },
    (err, stdout, stderr) => resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout, stderr }))),
}

const live = existsSync('/run/live/medium')
const modeArg = process.argv.indexOf('--mode')
const mode: SetupMode = modeArg > 0 ? (process.argv[modeArg + 1] === 'install' ? 'install' : 'firstRun') : live ? 'install' : 'firstRun'

const freeGiB = (p: string) => { const s = statfsSync(p); return (s.bavail * s.bsize) / 2 ** 30 }
const bundledVerified = () => {
  // Bundled packages for offline installs: every file must match the signed image's SHA256SUMS.
  if (!existsSync(path.join(BUNDLED, 'SHA256SUMS'))) return 0
  let n = 0
  for (const line of readFileSync(path.join(BUNDLED, 'SHA256SUMS'), 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim()); if (!m) continue
    const f = path.join(BUNDLED, path.basename(m[2]))
    if (!existsSync(f) || createHash('sha256').update(readFileSync(f)).digest('hex') !== m[1]) throw new ActionError(`bundled package ${m[2]} is missing or damaged`, false)
    n++
  }
  return n
}

function policy(): AppPolicy | null { try { return JSON.parse(readFileSync(POLICY, 'utf8')) as AppPolicy } catch { return null } }
const selection = (a: Readonly<Record<string, unknown>>) => [
  ...(Array.isArray(a.worksuiteApps) ? a.worksuiteApps : []), ...(Array.isArray(a.thirdPartyApps) ? a.thirdPartyApps : []),
].filter((x): x is string => typeof x === 'string')
const appPlan = (a: Readonly<Record<string, unknown>>) => plan(selection(a), policy())
/** Set once the service runs: refreshes the setup report after each app step. */
let onAppProgress = () => {}
const engine = (log: (l: string) => void) => new AppEngine({
  runner, bundledDir: BUNDLED, online, statusFile: APPS_STATUS, queueFile: APP_QUEUE, log: (l) => { log(l); onAppProgress() },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
})

// `--drain-queue` (worksuite-setup-queue.timer): install the apps queued while offline, then exit.
if (process.argv.includes('--drain-queue')) {
  if (!online()) { console.log('offline; the queue stays'); process.exit(0) }
  const r = await engine((l) => console.log(l)).drain(new Map(CATALOG.map((a) => [a.id, a])))
  console.log(`installed ${r.installed.length}, still queued ${r.left.length}`)
  if (!r.left.length) { try { (await import('node:fs')).rmSync(APP_QUEUE) } catch { /* already gone */ } }
  process.exit(0)
}

const handlers: Record<string, ActionHandler> = {
  async loadPersistedState() {},
  async probeHardware({ log }) { log(`arch ${arch()}, memory ${Math.round(Number(/MemTotal:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0) / 1024)} MiB`) },
  async validateCompatibility({ log }) {
    if (!['x64', 'arm64'].includes(arch())) throw new ActionError(`this computer's architecture (${arch()}) is not supported`, false)
    log('architecture supported')
  },
  async checkDiskSpace({ log }) {
    const need = mode === 'install' ? 0 : 2   // the installer checks the target disk itself (Calamares partition module)
    const free = freeGiB('/')
    log(`free ${free.toFixed(1)} GiB, need ${need} GiB`)
    if (free < need) throw new ActionError(`not enough free space: ${free.toFixed(1)} GiB free, ${need} GiB needed`, false)
  },
  async resolveDependencies({ answers, log }) {
    // App-level: the plan (policy, catalog dependencies, order). Package-level: apt simulates each install in the engine.
    const p = appPlan(answers)
    log(`apps to install: ${p.install.map((x) => `${x.app.id}${x.required ? ' (required)' : ''}`).join(', ') || 'none'}`)
    for (const s of p.skipped) log(`not installed: ${s.id} (${s.why})`)
  },
  async verifyBundledPackages({ log }) { log(`${bundledVerified()} bundled package(s) verified`) },
  async enrollDevice({ answers, log }) {
    // Enrollment itself happens in the UI through lk.worksuite.DeviceAgent1.Enroll (polkit; the token never enters
    // the setup state). Here: an enterprise setup does not continue until the device really is enrolled.
    if (answers.accountType !== 'enterprise') { log('personal setup: not enrolled'); return }
    const r = await bus.call(new Message({ destination: 'lk.worksuite.DeviceAgent1', path: '/lk/worksuite/DeviceAgent1', interface: 'lk.worksuite.DeviceAgent1', member: 'GetManagementInfo' }))
    const info = (r?.body[0] ?? {}) as Record<string, { value: unknown }>
    if (info.managed?.value !== true) throw new ActionError('this device is not enrolled yet; enter the enrollment code and try again', true)
    log(`enrolled with ${String(info.org_name?.value ?? 'the organization')}`)
  },
  async queueInstalls({ answers, log, stopped }) {
    try { await engine(log).run(appPlan(answers), stopped) } catch (e) { throw new ActionError((e as Error).message, (e as { retryable?: boolean }).retryable !== false) }
  },
  async verifyPackages({ log }) {
    const r = await runner.run('dpkg', ['--audit'])
    if (r.code !== 0 || r.stdout.trim()) throw new ActionError(`packages are not fully configured: ${r.stdout.trim().split('\n')[0] ?? r.stderr}`, true)
    log('dpkg --audit clean')
  },
  async verifyServices({ log }) {
    const units = ['greetd.service', 'worksuite-device-agent.service', 'dbus.service']
    const r = await runner.run('systemctl', ['is-failed', ...units])
    // is-failed exits 0 when at least one unit has failed.
    if (r.code === 0 && /^failed$/m.test(r.stdout)) throw new ActionError(`a system service failed: ${r.stdout.trim().replace(/\n/g, ', ')}`, true)
    log('core services healthy')
  },
  async applyServiceConfig({ log }) { log('service configuration applied by the packages; nothing to change') },
  async createLaunchers({ log }) { const r = await runner.run('update-desktop-database', ['/usr/share/applications']); log(`launchers refreshed (${r.code})`) },
  async clearRecoveryData({ log }) { log('setup complete; recovery data kept for the log until the next setup') },
  async collectLogs({ log }) { const r = await runner.run('journalctl', ['-b', '-n', '200', '--no-pager', '-u', 'worksuite-setup']); log(`journal: ${r.stdout.split('\n').length} lines`) },
}

function online(): boolean {
  try { return readdirSync('/sys/class/net').some((i) => i !== 'lo' && readFileSync(`/sys/class/net/${i}/operstate`, 'utf8').trim() === 'up') } catch { return false }
}

const bus = dbus.systemBus()
const store = new MirroredFileStore(mode === 'install' && existsSync('/boot/efi') ? [ESP_DIR, STATE_DIR] : [STATE_DIR])
const svc = new SetupService({
  mode, store, logDir: LOG_DIR, handlers, online,
  providers: {
    'package-transaction': packageTransaction(path.join(STATE_DIR, 'rollback'), runner),
    'config-backup': configBackup(path.join(STATE_DIR, 'rollback'), () => ['/etc/greetd/config.toml', '/etc/worksuite/device.json']),
    snapshot: btrfsSnapshot(() => (existsSync('/target') ? '/target' : null), runner),
    // No enrollment provider: the device agent cannot unenroll itself, so enrollment is not rolled back here (an
    // administrator revokes the device in the console). The machine therefore never offers that rollback.
  },
})

const auth: Authority = {
  async uid(sender) {
    const r = await bus.call(new Message({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'GetConnectionUnixUser', signature: 's', body: [sender] }))
    return Number(r?.body[0])
  },
  async check(sender, action) {
    const r = await bus.call(new Message({ destination: 'org.freedesktop.PolicyKit1', path: '/org/freedesktop/PolicyKit1/Authority', interface: 'org.freedesktop.PolicyKit1.Authority',
      member: 'CheckAuthorization', signature: '(sa{sv})sa{ss}us', body: [['system-bus-name', { name: new Variant('s', sender) }], action, {}, 1, ''] }))
    return r?.body[0]?.[0] === true
  },
}
await svc.start()

// Enterprise deployment sync (src/apps/report.ts): the organization's defaults, and the report the device agent sends.
for (const [k, v] of defaultsToApply((policy() as { setup_defaults?: unknown } | null)?.setup_defaults, svc.getState().answers)) {
  try { await svc.setAnswer(k, v); svc.log(`organization default ${k} = ${v}`) } catch (e) { svc.log(`organization default ${k} refused: ${(e as Error).message}`) }
}
let completedAt: number | null = null
let lastState = ''
const report = () => {
  const st = svc.getState()
  if (st.state === 'SETUP_COMPLETED' && completedAt === null) completedAt = Date.now()
  try { writeReport(REPORT, buildReport(st, readStatus(APPS_STATUS), Date.now(), completedAt)) } catch (e) { svc.log(`setup report not written: ${(e as Error).message}`) }
  // Milestones go to the organization at once rather than with the next daily inventory.
  if (st.state !== lastState && ['INSTALLING_APPLICATIONS', 'VERIFYING_INSTALLATION', 'SETUP_COMPLETED', 'FAILED', 'RECOVERY_MODE', 'ROLLED_BACK', 'CANCELLED'].includes(st.state)) {
    bus.call(new Message({ destination: 'lk.worksuite.DeviceAgent1', path: '/lk/worksuite/DeviceAgent1', interface: 'lk.worksuite.DeviceAgent1', member: 'ReportInventory' }))
      .catch(() => { /* not enrolled or no agent: the report waits for the next inventory */ })
  }
  lastState = st.state
}
svc.on('changed', report)
onAppProgress = report
report()
serve(bus, svc, auth, readFileSync(XML, 'utf8'), () => readStatus(APPS_STATUS))
await bus.requestName(NAME, 0)
svc.log(`worksuite-setup started (${mode}), state ${svc.getState().state}`)
