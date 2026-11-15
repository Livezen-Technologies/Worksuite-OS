// The setup service end to end with fake actions and instant timers: work runs and reports itself, failures retry
// then open recovery, a restart mid-install opens recovery, rollback really restores files, the installer reports
// the disk step, and the first rollback handle of a step is kept across retries.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ActionError, SetupService, type ActionHandler } from '../src/service.ts'
import { MirroredFileStore } from '../src/store.ts'
import { configBackup, type Handle, type Provider } from '../src/rollback.ts'
import type { SetupMode } from '../src/machine/core/states.ts'

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
const ANSWERS: Record<string, unknown> = { locale: 'en_US', timezone: 'Asia/Colombo', keyboard: 'us', accountType: 'personal', account: { user: 'ana' }, disk: 'vda', diskConfirmed: 'vda', encryption: { enabled: true }, worksuiteApps: ['worksuite-desktop'], reviewAccepted: true }

function make(o: { mode?: SetupMode; dir?: string; handlers?: Record<string, ActionHandler>; providers?: Record<string, Provider>; online?: { v: boolean } } = {}) {
  const dir = o.dir ?? mkdtempSync(path.join(tmpdir(), 'ws-setup-svc-'))
  const timers: { fn: () => void; ms: number; live: boolean }[] = []
  const ran: string[] = []
  const handlers: Record<string, ActionHandler> = new Proxy(o.handlers ?? {}, {
    get: (t, k: string) => t[k] ?? (async () => { ran.push(k) }),
    has: () => true,
  })
  const svc = new SetupService({
    mode: o.mode ?? 'firstRun', store: new MirroredFileStore([path.join(dir, 'state')]), logDir: path.join(dir, 'log'),
    handlers, providers: o.providers ?? {}, online: () => o.online?.v ?? true,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return { cancel: () => { t.live = false } } },
  })
  const fire = async () => { const t = timers.filter((x) => x.live).at(-1); assert.ok(t, 'a timer is pending'); t.live = false; t.fn(); await settle() }
  return { svc, dir, timers, fire, ran }
}
async function answerAll(svc: SetupService) { for (const [k, v] of Object.entries(ANSWERS)) { if (!svc.machine.state.startsWith('INSTALLING')) await svc.setAnswer(k, v).catch(() => {}) } }
async function nextUntil(svc: SetupService, target: string) {
  for (let i = 0; i < 40 && svc.machine.state !== target; i++) {
    await answerAll(svc)
    const s = svc.machine.state
    if (!['INITIALIZING', 'PRE_INSTALL_VALIDATION', 'INSTALLING_OS', 'INSTALLING_APPLICATIONS', 'VERIFYING_INSTALLATION', 'FINAL_CONFIGURATION'].includes(s)) await svc.send({ type: 'NEXT' })
    await settle()
  }
  assert.equal(svc.machine.state, target)
}

test('first run: unattended steps run their actions and finish by themselves, to completion', async () => {
  const { svc, ran } = make()
  await svc.start(); await settle()
  assert.equal(svc.machine.state, 'WELCOME')   // INITIALIZING ran loadPersistedState/probeHardware and finished
  await nextUntil(svc, 'SETUP_COMPLETED')
  for (const a of ['validateCompatibility', 'checkDiskSpace', 'queueInstalls', 'verifyPackages', 'verifyServices', 'applyServiceConfig', 'createLaunchers', 'clearRecoveryData']) assert.ok(ran.includes(a), a)
  assert.ok(!ran.includes('partitionAndCopy'))
  assert.match(svc.readLog(), /FINAL_CONFIGURATION --WORK_DONE--> SETUP_COMPLETED/)
})

test('a failing step retries on the backoff timer, then opens recovery with the error', async () => {
  let n = 0
  const { svc, timers, fire } = make({ handlers: { queueInstalls: async () => { n++; throw new ActionError('mirror unreachable') } } })
  await svc.start(); await settle()
  await nextUntil(svc, 'RETRYING')
  for (let i = 0; i < 3; i++) { if (svc.machine.state === 'RETRYING') await fire() }
  assert.equal(svc.machine.state, 'RECOVERY_MODE')
  assert.equal(n, 4)
  assert.equal(svc.getState().lastError, 'mirror unreachable')
  assert.deepEqual(timers.map((t) => t.ms).filter((ms) => ms < 60_000), [5000, 10000, 20000])   // the rest are step timeouts
})

test('answers cannot change while the system is being changed', async () => {
  const { svc } = make({ handlers: { queueInstalls: () => new Promise(() => {}) } })   // never finishes
  await svc.start(); await settle()
  await nextUntil(svc, 'INSTALLING_APPLICATIONS')
  await assert.rejects(svc.setAnswer('locale', 'si_LK'), /asking questions/)
})

test('a restart in the middle of installing opens recovery; retry runs the step again', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-setup-svc-'))
  const first = make({ dir, handlers: { queueInstalls: () => new Promise(() => {}) } })
  await first.svc.start(); await settle()
  await nextUntil(first.svc, 'INSTALLING_APPLICATIONS')
  // power cut: a new service process on the same durable state
  const second = make({ dir })
  await second.svc.start(); await settle()
  assert.equal(second.svc.machine.state, 'RECOVERY_MODE')
  assert.equal(second.svc.getState().startReason, 'interrupted')
  assert.ok(second.svc.recovery().actions.find((a) => a.id === 'retry')!.available)
  await second.svc.send({ type: 'RETRY_NOW' }); await settle()
  assert.ok(['VERIFYING_INSTALLATION', 'FINAL_CONFIGURATION', 'SETUP_COMPLETED'].includes(second.svc.machine.state))
})

test('rollback restores the configuration files the final step changed, then setup can resume', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-setup-svc-'))
  const conf = path.join(dir, 'greetd.toml'), fresh = path.join(dir, 'new.json')
  writeFileSync(conf, 'original\n')
  const { svc } = make({
    dir,
    providers: { 'config-backup': configBackup(path.join(dir, 'rb'), () => [conf, fresh]) },
    handlers: {
      applyServiceConfig: async () => { writeFileSync(conf, 'changed\n'); writeFileSync(fresh, '{}') },
      createLaunchers: async () => { throw new ActionError('desktop database broken', false) },
    },
  })
  await svc.start(); await settle()
  await nextUntil(svc, 'RECOVERY_MODE')
  assert.equal(readFileSync(conf, 'utf8'), 'changed\n')
  const opts = svc.recovery()
  assert.ok(opts.rollback.possible, opts.rollback.reason)
  await svc.send({ type: 'ROLLBACK' }); await settle()
  assert.equal(svc.machine.state, 'ROLLED_BACK')
  assert.equal(readFileSync(conf, 'utf8'), 'original\n')
  assert.ok(!existsSync(fresh), 'a file that did not exist before is removed again')
  assert.match(svc.readLog(), /rollback FINAL_CONFIGURATION: restored 2 configuration file/)
})

test('rollback is refused when no provider could give a verified rollback point', async () => {
  const { svc } = make({ handlers: { createLaunchers: async () => { throw new ActionError('x', false) } } })
  await svc.start(); await settle()
  await nextUntil(svc, 'RECOVERY_MODE')
  assert.equal(svc.recovery().rollback.possible, false)
  await assert.rejects(svc.send({ type: 'ROLLBACK' }), /no verified rollback point/)
  assert.match(svc.readLog(), /no rollback point for FINAL_CONFIGURATION/)
})

test('the first rollback handle of a step is kept when the step is retried', async () => {
  let takes = 0
  const provider: Provider = { kind: 'package-transaction', async take() { takes++; return { kind: 'package-transaction', ref: `tx${takes}`, verified: true } as Handle }, async verify() { return true }, async undo() { return 'ok' } }
  let fail = true
  const { svc, fire } = make({ providers: { 'package-transaction': provider }, handlers: { queueInstalls: async () => { if (fail) { fail = false; throw new ActionError('flaky mirror') } } } })
  await svc.start(); await settle()
  await nextUntil(svc, 'RETRYING')
  await fire()
  assert.equal(takes, 1)
  assert.equal(svc.machine.checkpoints.find((c) => c.rollback)?.rollback?.ref, 'tx1')
})

test('install mode: the disk step waits for the installer to report it; the report must name the current step', async () => {
  const { svc, ran } = make({ mode: 'install' })
  await svc.start(); await settle()
  await nextUntil(svc, 'INSTALLING_OS')
  await settle()
  assert.equal(svc.machine.state, 'INSTALLING_OS')
  assert.ok(!ran.includes('partitionAndCopy'))
  assert.match(svc.readLog(), /waiting for partitionAndCopy/)
  await assert.rejects(svc.workResult('FINAL_CONFIGURATION', true, ''), /not FINAL_CONFIGURATION/)
  await svc.workResult('INSTALLING_OS', true, ''); await settle()
  assert.notEqual(svc.machine.state, 'INSTALLING_OS')
})

test('install mode: a failed disk step is not retried silently; it goes to recovery', async () => {
  const { svc } = make({ mode: 'install' })
  await svc.start(); await settle()
  await nextUntil(svc, 'INSTALLING_OS')
  await svc.workResult('INSTALLING_OS', false, 'partition table could not be written'); await settle()
  assert.equal(svc.machine.state, 'RECOVERY_MODE')
  assert.equal(svc.getState().lastError, 'partition table could not be written')
})

test('UI actions are handed back; privileged ones never are', async () => {
  const { svc } = make()
  await svc.start(); await settle()
  await svc.send({ type: 'NEXT' })   // → LANGUAGE_REGION
  await answerAll(svc)
  await svc.send({ type: 'NEXT' })   // → NETWORK_SETUP
  assert.deepEqual(svc.getState().uiActions, ['applyLocalePreview', 'scanNetworks'])
})
