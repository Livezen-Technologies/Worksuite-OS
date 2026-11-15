// The setup state machine: explicit transition rules, checkpoints, persistence across restarts, recovery and
// rollback boundaries.
import { describe, expect, it } from 'vitest'
import { SetupStateMachine } from './SetupStateMachine.ts'
import { MemoryPersistence, serialize } from './SetupPersistence.ts'
import { flowFor, MAIN_FLOW, SIDE_RULES, SIDE_STATES, SPECS, type SetupMode } from './states.ts'
import { recoveryOptions } from '../recovery/RecoveryManager.ts'
import { planRollback } from '../recovery/RollbackManager.ts'

let clock = 1_000
const answers = { locale: 'en_US', timezone: 'Asia/Colombo', keyboard: 'us', accountType: 'personal', account: { user: 'ana' }, disk: 'vda', diskConfirmed: 'vda', encryption: { enabled: true }, worksuiteApps: ['worksuite-desktop', 'worksuite-office'], reviewAccepted: true }

async function machine(mode: SetupMode = 'install', p = new MemoryPersistence(), online = { v: true }) {
  const m = new SetupStateMachine({ mode, persistence: p, now: () => ++clock, online: () => online.v })
  await m.start()
  return { m, p, online }
}
async function fill(m: SetupStateMachine) { for (const [k, v] of Object.entries(answers)) m.setAnswer(k, v) }
/** Drive to `target`, answering questions and completing unattended work. */
async function driveTo(m: SetupStateMachine, target: string) {
  await fill(m)
  for (let i = 0; i < 40 && m.state !== target; i++) {
    const r = await m.send({ type: 'NEXT' })
    if (!r.ok) { const w = await m.send({ type: 'WORK_DONE' }); if (!w.ok) throw new Error(`stuck in ${m.state}: ${r.error} / ${w.error}`) }
  }
  expect(m.state).toBe(target)
}

describe('rules table', () => {
  it('every state has a spec and every side state a rule set; side rules only target known states', () => {
    for (const s of MAIN_FLOW) expect(SPECS[s]).toBeDefined()
    for (const s of SIDE_STATES) for (const to of Object.values(SIDE_RULES[s])) expect([...MAIN_FLOW, ...SIDE_STATES, '@resume']).toContain(to)
  })
  it('first run skips disk partitioning and OS installation', () => {
    expect(flowFor('firstRun')).not.toContain('STORAGE_CONFIGURATION')
    expect(flowFor('firstRun')).not.toContain('INSTALLING_OS')
    expect(flowFor('install')).toContain('INSTALLING_OS')
  })
  it('INSTALLING_OS is the only destructive state', () => {
    expect(MAIN_FLOW.filter((s) => SPECS[s].effect === 'destructive')).toEqual(['INSTALLING_OS'])
  })
})

describe('main flow', () => {
  it('walks every install state in order to completion, with checkpoints', async () => {
    const { m } = await machine()
    const seen: string[] = [m.state]
    await fill(m)
    while (m.state !== 'SETUP_COMPLETED') { const r = (await m.send({ type: 'NEXT' })).ok || (await m.send({ type: 'WORK_DONE' })).ok; expect(r).toBe(true); seen.push(m.state) }
    expect(seen).toEqual(flowFor('install'))
    expect(m.checkpoints.length).toBeGreaterThan(8)
  })
  it('refuses NEXT with missing answers and reports the fields', async () => {
    const { m } = await machine()
    await m.send({ type: 'WORK_DONE' }); await m.send({ type: 'NEXT' })   // → LANGUAGE_REGION
    const r = await m.send({ type: 'NEXT' })
    expect(r.ok).toBe(false)
    expect(Object.keys(r.fieldErrors!)).toEqual(['locale', 'timezone', 'keyboard'])
  })
  it('the disk is erased only after the exact disk name is confirmed', async () => {
    const { m } = await machine()
    await driveTo(m, 'STORAGE_CONFIGURATION')
    m.setAnswer('diskConfirmed', 'sda')
    expect((await m.send({ type: 'NEXT' })).fieldErrors).toHaveProperty('diskConfirmed')
  })
  it('reports entry and exit actions for the host to run', async () => {
    const { m } = await machine()
    await driveTo(m, 'LANGUAGE_REGION')
    const r = await m.send({ type: 'NEXT' })
    expect(r.actions).toEqual(['applyLocalePreview', 'scanNetworks'])
  })
  it('BACK and GOTO work before the point of no return, never after', async () => {
    const { m } = await machine()
    await driveTo(m, 'REVIEW_CONFIGURATION')
    expect((await m.send({ type: 'GOTO', to: 'WORKSUITE_APP_SELECTION' })).state).toBe('WORKSUITE_APP_SELECTION')
    await driveTo(m, 'INSTALLING_OS')
    expect((await m.send({ type: 'BACK' })).ok).toBe(false)
    expect((await m.send({ type: 'GOTO', to: 'WELCOME' })).ok).toBe(false)
    expect((await m.send({ type: 'CANCEL' })).ok).toBe(false)
    expect((await m.send({ type: 'PAUSE' })).ok).toBe(false)
  })
})

describe('network', () => {
  it('waits for the network before a step that needs it, and resumes when it is back', async () => {
    const online = { v: true }
    const { m } = await machine('install', new MemoryPersistence(), online)
    await driveTo(m, 'ACCOUNT_AUTHENTICATION')
    online.v = false
    expect((await m.send({ type: 'NEXT' })).state).toBe('WAITING_FOR_NETWORK')
    expect((await m.send({ type: 'RESUME' })).ok).toBe(false)
    online.v = true
    expect((await m.send({ type: 'NETWORK_RESTORED' })).state).toBe('DEVICE_ENROLLMENT')
  })
  it('optional-network steps keep going offline', async () => {
    const { m } = await machine()
    await driveTo(m, 'THIRD_PARTY_APP_SELECTION')
    expect((await m.send({ type: 'NETWORK_LOST' })).state).toBe('THIRD_PARTY_APP_SELECTION')
  })
})

describe('retries', () => {
  it('backs off exponentially, then goes to recovery when retries run out', async () => {
    const { m } = await machine()
    await driveTo(m, 'INSTALLING_APPLICATIONS')
    const delays: number[] = []
    for (let i = 0; i < SPECS.INSTALLING_APPLICATIONS.retry.max; i++) {
      const r = await m.send({ type: 'WORK_FAILED', error: 'mirror unreachable' })
      expect(r.state).toBe('RETRYING'); delays.push(r.retryInMs!)
      expect((await m.send({ type: 'RETRY_NOW' })).state).toBe('INSTALLING_APPLICATIONS')
    }
    expect(delays).toEqual([5000, 10000, 20000])
    const last = await m.send({ type: 'WORK_FAILED', error: 'mirror unreachable' })
    expect(last.state).toBe('RECOVERY_MODE')
    expect(m.snapshot.lastError).toBe('mirror unreachable')
  })
  it('a non-retryable failure skips straight to the exhausted state', async () => {
    const { m } = await machine()
    await driveTo(m, 'PRE_INSTALL_VALIDATION')
    expect((await m.send({ type: 'WORK_FAILED', error: 'not enough disk space', retryable: false })).state).toBe('FAILED')
  })
})

describe('persistence and restarts', () => {
  it('resumes a question step exactly where it was after a restart', async () => {
    const p = new MemoryPersistence()
    const { m } = await machine('install', p)
    await driveTo(m, 'SECURITY_CONFIGURATION')
    const again = new SetupStateMachine({ mode: 'install', persistence: p, now: () => ++clock })
    await again.start()
    expect(again.state).toBe('SECURITY_CONFIGURATION')
    expect(again.startReason).toBe('resumed')
    expect(again.snapshot.answers.locale).toBe('en_US')
  })
  it('power loss during installation opens recovery; it never silently re-runs the step', async () => {
    const p = new MemoryPersistence()
    const { m } = await machine('install', p)
    await driveTo(m, 'INSTALLING_OS')
    const again = new SetupStateMachine({ mode: 'install', persistence: p, now: () => ++clock })
    const r = await again.start()
    expect(r.state).toBe('RECOVERY_MODE')
    expect(again.startReason).toBe('interrupted')
    expect((await again.send({ type: 'RETRY_NOW' })).state).toBe('INSTALLING_OS')
  })
  it('a damaged state file goes to recovery instead of being trusted', async () => {
    const p = new MemoryPersistence()
    const { m } = await machine('install', p)
    await driveTo(m, 'REVIEW_CONFIGURATION')
    p.data = p.data!.replace('REVIEW_CONFIGURATION', 'SETUP_COMPLETED')   // checksum no longer matches
    const again = new SetupStateMachine({ mode: 'install', persistence: p, now: () => ++clock })
    expect((await again.start()).state).toBe('RECOVERY_MODE')
    expect(again.startReason).toBe('corrupt')
  })
  it('writes through on every transition', async () => {
    const { m, p } = await machine()
    const before = p.writes
    await m.send({ type: 'WORK_DONE' })
    expect(p.writes).toBe(before + 1)
  })
})

describe('checkpoints and rollback boundaries', () => {
  it('restoring a checkpoint brings its answers back and asks to confirm the disk again', async () => {
    const { m } = await machine()
    await driveTo(m, 'INSTALLING_OS')
    await m.send({ type: 'ENTER_RECOVERY', reason: 'test' })
    const cp = m.checkpoints.find((c) => c.state === 'SECURITY_CONFIGURATION')!
    m.setAnswer('locale', 'si_LK')
    const r = await m.send({ type: 'RESTORE_CHECKPOINT', checkpointId: cp.id })
    expect(r.state).toBe('WORKSUITE_APP_SELECTION')
    expect(m.snapshot.answers.locale).toBe('en_US')
    expect(m.snapshot.answers.diskConfirmed).toBeUndefined()
    expect(m.checkpoints.at(-1)!.id).toBe(cp.id)
  })
  it('rollback is refused without a verified rollback point', async () => {
    const { m } = await machine()
    await driveTo(m, 'INSTALLING_APPLICATIONS')
    await m.send({ type: 'WORK_FAILED', error: 'x', retryable: false })
    await m.send({ type: 'ENTER_RECOVERY', reason: 'x' })
    expect((await m.send({ type: 'ROLLBACK' })).ok).toBe(false)
    expect(recoveryOptions(m.snapshot).actions.find((a) => a.id === 'rollback')!.available).toBe(false)
  })
  it('rolls back application installs to the verified package transaction, keeping earlier answers', async () => {
    const { m } = await machine()
    await driveTo(m, 'INSTALLING_APPLICATIONS')
    await m.attachRollback({ kind: 'package-transaction', ref: 'tx-42', verified: true })
    await m.send({ type: 'WORK_FAILED', error: 'dpkg error', retryable: false })
    await m.send({ type: 'ENTER_RECOVERY', reason: 'dpkg error' })
    const plan = recoveryOptions(m.snapshot)
    expect(plan.rollback.possible).toBe(true)
    expect(plan.rollback.steps.map((s) => s.state)).toEqual(['INSTALLING_APPLICATIONS'])
    expect((await m.send({ type: 'ROLLBACK' })).state).toBe('ROLLING_BACK')
    expect((await m.send({ type: 'ROLLBACK_DONE' })).state).toBe('ROLLED_BACK')
    expect((await m.send({ type: 'RESUME' })).state).toBe('INSTALLING_APPLICATIONS')
    expect(m.snapshot.answers.worksuiteApps).toEqual(answers.worksuiteApps)
  })
  it('never promises to restore an erased disk without a pre-install snapshot', () => {
    const cps = [{ id: 'a', state: 'REVIEW_CONFIGURATION' as const, at: 1, answers: {}, rollback: { kind: 'config-backup' as const, ref: 'b', verified: true } }]
    const plan = planRollback('install', 'INSTALLING_APPLICATIONS', cps)
    expect(plan.notUndone.join(' ')).toMatch(/not restored/)
    expect(plan.steps.map((s) => s.state)).not.toContain('INSTALLING_OS')
  })
  it('restart setup forgets answers and checkpoints but says the disk is not restored', async () => {
    const { m } = await machine()
    await driveTo(m, 'INSTALLING_OS')
    await m.send({ type: 'ENTER_RECOVERY', reason: 'x' })
    expect(recoveryOptions(m.snapshot).actions.find((a) => a.id === 'restart')!.changes).toMatch(/Nothing on the disk is restored/)
    expect((await m.send({ type: 'RESTART_SETUP' })).state).toBe('INITIALIZING')
    expect(m.checkpoints).toHaveLength(0)
    expect(m.snapshot.answers).toEqual({})
  })
})

describe('first run on an installed system', () => {
  it('skips the account, disk and encryption steps and never installs an OS', async () => {
    const { m } = await machine('firstRun')
    await driveTo(m, 'ACCOUNT_TYPE')
    await m.setAnswer('accountType', 'personal')
    expect((await m.send({ type: 'NEXT' })).state).toBe('DEVICE_ENROLLMENT')
    expect((await m.send({ type: 'NEXT' })).state).toBe('WORKSUITE_APP_SELECTION')
    await driveTo(m, 'PRE_INSTALL_VALIDATION')
    expect((await m.send({ type: 'WORK_DONE' })).state).toBe('INSTALLING_APPLICATIONS')
  })
  it('a persisted snapshot from another version is not trusted', async () => {
    const p = new MemoryPersistence()
    p.data = serialize({ version: 99, mode: 'firstRun', state: 'WELCOME', resumeTo: null, answers: {}, attempts: 0, lastError: null, checkpoints: [], updatedAt: 0 })
    const m = new SetupStateMachine({ mode: 'firstRun', persistence: p })
    expect((await m.start()).state).toBe('RECOVERY_MODE')
  })
})
