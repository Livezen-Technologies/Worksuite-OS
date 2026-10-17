// Renderer side of electron/sessionHost.ts. In a plain browser (design review) a stub answers; URL switches drive it
// into each state: ?admin=1 (administrator), ?inhibit=1 (an app blocks shutdown), ?crash=<name> (an app crashed).
import { useEffect, useState } from 'react'

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }
export type EndAction = 'shutdown' | 'restart' | 'logout'
export interface Inhibitor { what: string; who: string; why: string; mode: string; uid: number; pid: number }
export interface Crash { appId: string | null; name: string; at: number; details: string }
/** What the main window's overlay shows; other displays mirror it (null: none). */
export interface EndState { action: EndAction; phase: 'closing' | 'blocked' | 'ending'; progress: number }

export interface SessionApi {
  inhibitors(action: EndAction): Promise<Result<Inhibitor[]>>
  powerForce(action: 'shutdown' | 'restart'): Promise<Result<true>>
  setEndState(state: EndState | null): Promise<boolean>
  onEndState(cb: (s: EndState | null) => void): () => void
  onCrash(cb: (c: Crash) => void): () => void
  reopen(appId: string): Promise<unknown>
  isAdmin(): Promise<boolean>
  sessionJournal(lines: number): Promise<Result<string>>
  systemJournal(kind: 'boot' | 'previous' | 'greeter', lines: number): Promise<Result<string>>
  bootDetails(op: 'status' | 'on' | 'off'): Promise<Result<boolean>>
}

declare global {
  interface Window { worksuiteSession?: SessionApi }
}

const PV = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams()
let stubDetails = false
const endListeners = new Set<(s: EndState | null) => void>()
const PREVIEW_LOG = ['2026-10-16T09:12:03+0530 worksuite-session[1432]: Starting the WorkSuite session',
  '2026-10-16T09:12:05+0530 worksuite-shell[1490]: ready'].join('\n')

const stub: SessionApi = {
  async inhibitors() {
    return { ok: true, value: PV.get('inhibit') ? [{ what: 'shutdown:sleep', who: 'Docs', why: 'Unsaved changes in “Q4 plan”', mode: 'block', uid: 1000, pid: 4242 }] : [] }
  },
  async powerForce() { return { ok: true, value: true } },
  async setEndState(s) { endListeners.forEach((f) => f(s)); return true },
  onEndState(cb) { endListeners.add(cb); return () => { endListeners.delete(cb) } },
  onCrash(cb) {
    const name = PV.get('crash')
    if (!name) return () => {}
    const id = setTimeout(() => cb({ appId: 'preview-app', name, at: Date.now(), details: `Process: ${name.toLowerCase()} (PID 4242)\nSignal: SIGSEGV` }), 800)
    return () => clearTimeout(id)
  },
  async reopen() {},
  async isAdmin() { return PV.get('admin') === '1' },
  async sessionJournal() { return { ok: true, value: PREVIEW_LOG } },
  async systemJournal() { return PV.get('admin') === '1' ? { ok: true, value: PREVIEW_LOG } : { ok: false, error: 'not_authorized' } },
  async bootDetails(op) { if (op !== 'status') stubDetails = op === 'on'; return { ok: true, value: stubDetails } },
}

const api = (): SessionApi => (typeof window !== 'undefined' && window.worksuiteSession) || stub
/** The bridge when Electron provides it (looked up on each call), else the preview stub. */
export const sessionApi: SessionApi = {
  inhibitors: (a) => api().inhibitors(a),
  powerForce: (a) => api().powerForce(a),
  setEndState: (s) => api().setEndState(s),
  onEndState: (cb) => api().onEndState(cb),
  onCrash: (cb) => api().onCrash(cb),
  reopen: (id) => api().reopen(id),
  isAdmin: () => api().isAdmin(),
  sessionJournal: (n) => api().sessionJournal(n),
  systemJournal: (k, n) => api().systemJournal(k, n),
  bootDetails: (op) => api().bootDetails(op),
}

let admin: Promise<boolean> | null = null
/** Tests: ask again (another user, another bridge). */
export function forgetAdmin(): void { admin = null }
/** Member of sudo/admin/wheel (asked once per shell start). */
export function isAdmin(): Promise<boolean> {
  admin ??= sessionApi.isAdmin().then(Boolean).catch(() => false)
  return admin
}

export function useIsAdmin(): boolean {
  const [a, setA] = useState(false)
  useEffect(() => {
    let live = true
    void isAdmin().then((v) => { if (live) setA(v) })
    return () => { live = false }
  }, [])
  return a
}
