// lk.worksuite.Setup1 core: owns the setup state machine, its durable state, the privileged actions and rollback.
// The UI sends validated events; the service runs the work and reports results back to the machine itself.
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { SetupStateMachine, type TransitionResult } from './machine/core/SetupStateMachine.ts'
import type { SetupSnapshot } from './machine/core/SetupPersistence.ts'
import { isMain, SPECS, WORK_STATES, type SetupEvent, type SetupMode } from './machine/core/states.ts'
import { recoveryOptions } from './machine/recovery/RecoveryManager.ts'
import { planRollback, ROLLBACK_METHOD } from './machine/recovery/RollbackManager.ts'
import { SetupError } from './errors.ts'
import type { Handle, Provider } from './rollback.ts'
import type { MirroredFileStore } from './store.ts'

/** Actions another system component performs and reports with WorkResult (root only): the disk is written by the
 *  installer's own jobs (Calamares), so the service waits instead of running anything. */
export const EXTERNAL_ACTIONS = new Set(['partitionAndCopy'])

/** Privileged actions this service runs (the names in states.ts). Anything else in a transition's action list is
 *  the UI's own work (loading a catalog, scanning networks) and is handed back to it in `uiActions`. */
export const SERVICE_ACTIONS = new Set([
  'loadPersistedState', 'probeHardware', 'enrollDevice', 'validateCompatibility', 'resolveDependencies', 'checkDiskSpace',
  'verifyBundledPackages', 'snapshotIfSupported', 'partitionAndCopy', 'queueInstalls', 'verifyPackages', 'verifyServices',
  'applyServiceConfig', 'createLaunchers', 'clearRecoveryData', 'collectLogs', ...EXTERNAL_ACTIONS,
])

export class ActionError extends Error {
  readonly retryable: boolean
  constructor(message: string, retryable = true) { super(message); this.retryable = retryable }
}
/** `stopped()` turns true once this run is superseded (Pause, Cancel, recovery): long actions stop at a safe point. */
export type ActionHandler = (ctx: { answers: Readonly<Record<string, unknown>>; log: (line: string) => void; stopped: () => boolean }) => Promise<void>

export interface SetupServiceOptions {
  mode: SetupMode
  store: MirroredFileStore
  logDir: string
  handlers: Partial<Record<string, ActionHandler>>
  providers: Partial<Record<Handle['kind'], Provider>>
  online: () => boolean
  now?: () => number
  /** Timers are injectable so tests run instantly. */
  setTimer?: (fn: () => void, ms: number) => { cancel(): void }
}

export interface PublicState {
  state: SetupSnapshot['state']
  mode: SetupMode
  resumeTo: SetupSnapshot['resumeTo']
  answers: Record<string, unknown>
  lastError: string | null
  attempts: number
  checkpoints: { id: string; state: string; at: number; rollback: boolean }[]
  startReason: string
  uiActions: string[]
}

export class SetupService extends EventEmitter {
  readonly machine: SetupStateMachine
  private readonly o: SetupServiceOptions
  private queue: Promise<unknown> = Promise.resolve()
  private timer: { cancel(): void } | null = null
  /** Bumped on every transition: a late result from an old run is ignored. */
  private run = 0
  private uiActions: string[] = []

  constructor(o: SetupServiceOptions) {
    super()
    this.o = o
    this.machine = new SetupStateMachine({ mode: o.mode, persistence: o.store, now: o.now, online: o.online })
    mkdirSync(o.logDir, { recursive: true, mode: 0o700 })
  }

  async start() { return this.serial(async () => this.after(await this.machine.start())) }

  // ---- API (called by the D-Bus adapter with validated input) ----
  getState(): PublicState {
    const s = this.machine.snapshot
    return {
      state: s.state, mode: s.mode, resumeTo: s.resumeTo, answers: s.answers, lastError: s.lastError, attempts: s.attempts,
      checkpoints: s.checkpoints.map((c) => ({ id: c.id, state: c.state, at: c.at, rollback: !!c.rollback?.verified })),
      startReason: this.machine.startReason, uiActions: this.uiActions,
    }
  }
  recovery() { return recoveryOptions(this.machine.snapshot as SetupSnapshot) }
  send(e: SetupEvent) { return this.serial(() => this.dispatch(e)) }
  setAnswer(key: string, value: unknown) {
    return this.serial(async () => {
      const s = this.machine.state
      if (!isMain(s) || WORK_STATES.includes(s)) throw new SetupError('Refused', 'answers can only change while setup is asking questions')
      this.machine.setAnswer(key, value)
      this.emit('changed', this.getState())
    })
  }
  /** NetworkManager dispatcher (root). */
  connectivity(online: boolean) { return this.serial(() => this.dispatch({ type: online ? 'NETWORK_RESTORED' : 'NETWORK_LOST' }, true)) }
  /** Calamares mounted the target root (root only): keep a copy of the state there from now on. */
  targetMounted(dir: string) {
    return this.serial(async () => { this.o.store.addMirror(path.join(dir, 'var/lib/worksuite/setup')); this.machine.setAnswer('_targetMounted', true); this.log(`state mirrored to ${dir}`) })
  }
  /** The installer reports the outcome of an external action (root only). Ignored unless setup is in that step. */
  workResult(state: string, ok: boolean, error: string) {
    return this.serial(async () => {
      if (this.machine.state !== state) throw new SetupError('Refused', `setup is in ${this.machine.state}, not ${state}`)
      await this.dispatch(ok ? { type: 'WORK_DONE' } : { type: 'WORK_FAILED', error: error.slice(0, 500) || `${state} failed`, retryable: false }, true)
    })
  }
  readLog(lines = 200): string {
    try { return readFileSync(path.join(this.o.logDir, 'setup.log'), 'utf8').split('\n').slice(-lines - 1).join('\n') } catch { return '' }
  }

  // ---- internals ----
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn)
    this.queue = p.catch(() => {})
    return p
  }

  log(line: string) {
    try { appendFileSync(path.join(this.o.logDir, 'setup.log'), `${new Date(this.o.now?.() ?? Date.now()).toISOString()} ${line}\n`, { mode: 0o600 }) } catch { /* logging never stops setup */ }
  }

  private async dispatch(e: SetupEvent, internal = false): Promise<TransitionResult> {
    const from = this.machine.state
    const r = await this.machine.send(e)
    if (!r.ok) {
      if (!internal) this.log(`refused ${e.type} in ${from}: ${r.error}`)
      if (!internal && !r.fieldErrors) throw new SetupError('Refused', r.error)
      return r
    }
    this.log(`${from} --${e.type}--> ${r.state}${r.error ? ` (${r.error})` : ''}`)
    return this.after(r)
  }

  /** After a transition: rollback handle, the service's actions, retry/timeout timers, and the UI's action list. */
  private async after(r: TransitionResult): Promise<TransitionResult> {
    this.run++
    this.timer?.cancel(); this.timer = null
    const s = this.machine.state
    this.uiActions = r.actions.filter((a) => !SERVICE_ACTIONS.has(a))
    // Before a step that changes the system, attach the rollback handle to the checkpoint just taken.
    if (isMain(s) && SPECS[s].effect !== 'none') await this.takeHandle(s)
    this.emit('changed', this.getState())
    if (s === 'RETRYING' && r.retryInMs !== undefined) this.schedule(r.retryInMs, { type: 'RETRY_NOW' })
    else if (s === 'ROLLING_BACK') void this.serial(() => this.rollback())
    else if (isMain(s) && WORK_STATES.includes(s)) {
      const run = this.run
      if (SPECS[s].timeoutMs) this.schedule(SPECS[s].timeoutMs, { type: 'TIMEOUT' }, run)
      void this.work(r.actions.filter((a) => SERVICE_ACTIONS.has(a)), run)
    } else {
      // Question states: run their privileged actions (e.g. collectLogs) but they do not finish the step.
      for (const a of r.actions.filter((x) => SERVICE_ACTIONS.has(x))) await this.runAction(a).catch((e) => this.log(`${a} failed: ${(e as Error).message}`))
    }
    return r
  }

  private schedule(ms: number, e: SetupEvent, run = this.run) {
    const set = this.o.setTimer ?? ((fn, t) => { const h = setTimeout(fn, t); h.unref?.(); return { cancel: () => clearTimeout(h) } })
    this.timer = set(() => { if (run === this.run) void this.serial(() => this.dispatch(e, true)) }, ms)
  }

  private async runAction(name: string, run?: number) {
    const h = this.o.handlers[name]
    if (!h) throw new ActionError(`${name} is not available on this system`, false)
    this.log(`run ${name}`)
    await h({ answers: this.machine.snapshot.answers, log: (l) => this.log(`  ${name}: ${l}`), stopped: () => run !== undefined && run !== this.run })
  }

  /** Run a work state's actions in order; the outcome goes back into the machine (unless a newer run started). */
  private async work(actions: string[], run: number) {
    let failure: ActionError | null = null
    for (const a of actions) {
      if (EXTERNAL_ACTIONS.has(a)) { this.log(`waiting for ${a} (reported by the installer)`); return }
      try { await this.runAction(a, run) } catch (e) { failure = e instanceof ActionError ? e : new ActionError((e as Error).message); this.log(`${a} failed: ${failure.message}`); break }
      if (run !== this.run) return
    }
    await this.serial(async () => {
      if (run !== this.run) return
      await this.dispatch(failure ? { type: 'WORK_FAILED', error: failure.message, retryable: failure.retryable } : { type: 'WORK_DONE' }, true)
    })
  }

  private async takeHandle(state: keyof typeof ROLLBACK_METHOD) {
    const kind = ROLLBACK_METHOD[state]?.handle
    const p = kind && this.o.providers[kind]
    if (!p) { this.log(`no rollback point for ${state} on this system`); return }
    // Keep the first handle for this step: re-entering it after a retry must not record the half-done state as
    // the "before" (a later rollback would then miss what the first attempt installed).
    if (this.machine.checkpoints.at(-1)?.rollback?.kind === kind) return
    try {
      const h = await p.take()
      if (h) { await this.machine.attachRollback(h); this.log(`rollback point for ${state}: ${h.kind} ${h.verified ? 'verified' : 'NOT verified'}`) }
      else this.log(`no rollback point for ${state}: ${kind} not supported here`)
    } catch (e) { this.log(`rollback point for ${state} failed: ${(e as Error).message}`) }
  }

  private async rollback() {
    const snap = this.machine.snapshot as SetupSnapshot
    const plan = planRollback(snap.mode, snap.resumeTo && isMain(snap.resumeTo) ? snap.resumeTo : null, snap.checkpoints)
    try {
      if (!plan.possible || !plan.checkpoint?.rollback) throw new Error(plan.reason)
      // Undo every step back to the checkpoint, newest first, each with the handle taken right before it.
      for (const step of plan.steps) {
        const cp = snap.checkpoints.find((c) => !!c.rollback && c.rollback.kind === ROLLBACK_METHOD[step.state]?.handle && c.rollback.verified)
        const p = cp?.rollback && this.o.providers[cp.rollback.kind]
        if (!p || !cp?.rollback) throw new Error(`no verified rollback point for ${step.state}`)
        this.log(`rollback ${step.state}: ${await p.undo(cp.rollback)}`)
      }
      for (const n of plan.notUndone) this.log(`not undone: ${n}`)
      await this.dispatch({ type: 'ROLLBACK_DONE' }, true)
    } catch (e) {
      this.log(`rollback failed: ${(e as Error).message}`)
      await this.dispatch({ type: 'ROLLBACK_FAILED', error: (e as Error).message }, true)
    }
  }
}
