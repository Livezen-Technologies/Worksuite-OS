// Renderer side of the setup wizard. In Electron: the ws:setup* bridge to lk.worksuite.Setup1 (services/setup).
// In the browser preview (?setup=1, or ?setup=recovery to open on a failed install): the same state machine in
// memory, with unattended steps finishing on a short timer, so the screens follow the real transition rules.
import { SetupStateMachine } from '../components/setup-wizard/core/SetupStateMachine.ts'
import { MemoryPersistence, type SetupSnapshot } from '../components/setup-wizard/core/SetupPersistence.ts'
import { isMain, WORK_STATES, type MainState, type SetupEvent, type SetupMode, type SetupState } from '../components/setup-wizard/core/states.ts'
import { recoveryOptions } from '../components/setup-wizard/recovery/RecoveryManager.ts'

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string }

export interface SetupView {
  state: SetupState
  mode: SetupMode
  resumeTo: MainState | null
  answers: Record<string, unknown>
  lastError: string | null
  attempts: number
  checkpoints: { id: string; state: MainState; at: number; rollback: boolean }[]
  startReason: string
  uiActions: string[]
}
export interface SendResult { ok: boolean; state: SetupState; fieldErrors?: Record<string, string>; error?: string }
export type RecoveryView = ReturnType<typeof recoveryOptions>
/** Per-app progress of the app installation step (services/setup/src/apps/engine.ts AppStatus). */
export interface AppProgress { id: string; name: string; required: boolean; state: 'pending' | 'installing' | 'installed' | 'already' | 'queued' | 'failed' | 'skipped'; attempts: number; error: string | null }

export interface SetupApi {
  state(): Promise<Reply<SetupView>>
  recovery(): Promise<Reply<RecoveryView>>
  apps(): Promise<Reply<AppProgress[]>>
  log(lines?: number): Promise<Reply<string>>
  send(e: SetupEvent): Promise<Reply<SendResult>>
  answer(key: string, value: unknown): Promise<Reply<true>>
}

interface Bridge {
  setupState(): Promise<Reply<SetupView>>
  setupRecovery(): Promise<Reply<RecoveryView>>
  setupApps?(): Promise<Reply<AppProgress[]>>
  setupLog(lines: number): Promise<Reply<string>>
  setupSend(e: unknown): Promise<Reply<SendResult>>
  setupAnswer(k: string, v: unknown): Promise<Reply<true>>
}

export function bridgeApi(b: Bridge): SetupApi {
  return {
    state: () => b.setupState(), recovery: () => b.setupRecovery(), apps: () => (b.setupApps ? b.setupApps() : Promise.resolve({ ok: true as const, value: [] })), log: (n = 400) => b.setupLog(n),
    send: (e) => b.setupSend(e), answer: (k, v) => b.setupAnswer(k, v),
  }
}

/** In-memory setup for the preview and tests: the real machine; work steps finish after `workMs`. */
export function previewApi(o: { mode?: SetupMode; scenario?: 'fresh' | 'recovery'; workMs?: number } = {}): SetupApi {
  const p = new MemoryPersistence()
  const m = new SetupStateMachine({ mode: o.mode ?? 'firstRun', persistence: p })
  const lines: string[] = []
  const log = (l: string) => lines.push(`${new Date().toISOString()} ${l}`)
  let started: Promise<unknown> | null = null
  const ready = () => (started ??= (async () => {
    await m.start()
    log(`setup started (${o.mode ?? 'firstRun'})`)
    if (o.scenario === 'recovery') {
      // A realistic failure: application installation failed after a package rollback point was taken.
      const a: Record<string, unknown> = { locale: 'en_US', timezone: 'Asia/Colombo', keyboard: 'us', accountType: 'personal', account: { user: 'preview' }, encryption: { enabled: true }, worksuiteApps: ['worksuite-desktop', 'worksuite-office'], reviewAccepted: true }
      for (const [k, v] of Object.entries(a)) m.setAnswer(k, v)
      for (let i = 0; i < 30 && m.state !== 'INSTALLING_APPLICATIONS'; i++) if (!(await m.send({ type: 'NEXT' })).ok) await m.send({ type: 'WORK_DONE' })
      await m.attachRollback({ kind: 'package-transaction', ref: 'preview', verified: true })
      log('run queueInstalls'); log('queueInstalls failed: worksuite-office: download interrupted (connection reset)')
      await m.send({ type: 'WORK_FAILED', error: 'worksuite-office: download interrupted (connection reset)', retryable: false })
    } else autoWork()
  })())
  let timer: ReturnType<typeof setTimeout> | null = null
  const autoWork = () => {
    if (timer) clearTimeout(timer)
    const s = m.state
    if (s === 'ROLLING_BACK') { timer = setTimeout(async () => { log('rollback INSTALLING_APPLICATIONS: removed 3 package(s)'); await m.send({ type: 'ROLLBACK_DONE' }); autoWork() }, o.workMs ?? 1200); return }
    if (!isMain(s) || !WORK_STATES.includes(s)) return
    log(`running ${s}`)
    timer = setTimeout(async () => { if (m.state === s) { await m.send({ type: 'WORK_DONE' }); log(`${s} done`); autoWork() } }, o.workMs ?? 1200)
  }
  const view = (): SetupView => {
    const s = m.snapshot as SetupSnapshot
    return { state: s.state, mode: s.mode, resumeTo: s.resumeTo, answers: s.answers, lastError: s.lastError, attempts: s.attempts,
      checkpoints: s.checkpoints.map((c) => ({ id: c.id, state: c.state, at: c.at, rollback: !!c.rollback?.verified })), startReason: m.startReason, uiActions: [] }
  }
  return {
    async state() { await ready(); return { ok: true, value: view() } },
    async recovery() { await ready(); return { ok: true, value: recoveryOptions(m.snapshot as SetupSnapshot) } },
    async apps() {
      // Preview: the selected apps move through the install step one after another.
      await ready()
      const sel = ['worksuite-desktop', ...((m.snapshot.answers.worksuiteApps as string[] | undefined) ?? []).filter((x) => x !== 'worksuite-desktop'), ...((m.snapshot.answers.thirdPartyApps as string[] | undefined) ?? [])]
      const i = m.state === 'INSTALLING_APPLICATIONS' ? Math.floor((Date.now() / 400) % (sel.length + 1)) : sel.length
      return { ok: true, value: sel.map((id, n) => ({ id, name: id, required: n === 0, state: n < i ? 'installed' : n === i ? 'installing' : 'pending', attempts: n <= i ? 1 : 0, error: null })) as AppProgress[] }
    },
    async log(n = 400) { await ready(); return { ok: true, value: lines.slice(-n).join('\n') } },
    async send(e) {
      await ready()
      const r = await m.send(e)
      if (r.ok) { log(`--${e.type}--> ${r.state}`); autoWork() }
      return { ok: true, value: { ok: r.ok, state: r.state, ...(r.fieldErrors ? { fieldErrors: r.fieldErrors } : {}), ...(r.error ? { error: r.error } : {}) } }
    },
    async answer(k, v) { await ready(); m.setAnswer(k, v); return { ok: true, value: true } },
  }
}

/** The setup API for this shell, or null when there is no setup service (first run then uses its own screens). */
export function setupApi(): SetupApi | null {
  const w = typeof window !== 'undefined' ? (window as unknown as { worksuite?: Partial<Bridge> }) : undefined
  if (w?.worksuite?.setupState) return bridgeApi(w.worksuite as Bridge)
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('setup') : null
  if (q === '1' || q === 'recovery' || q === 'install') return previewApi({ scenario: q === 'recovery' ? 'recovery' : 'fresh', mode: q === 'install' ? 'install' : 'firstRun' })
  return null
}
