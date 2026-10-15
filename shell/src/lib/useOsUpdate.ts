// One subscription to the update coordinator for the whole shell (desktop toasts, taskbar, Settings).
import { useSyncExternalStore } from 'react'
import { os, packageErrorText, type OsUpdateStatus } from './os'
import { START, track, updateJobProgress, type JobProgress, type Tracking } from './updates'

export interface UpdateState { status: OsUpdateStatus | null; job: JobProgress | null; tracking: Tracking; error: string | null }

let state: UpdateState = { status: null, job: null, tracking: START, error: null }
const listeners = new Set<() => void>()
let started = false

function set(p: Partial<UpdateState>) { state = { ...state, ...p }; listeners.forEach((l) => l()) }
function apply(s: OsUpdateStatus) {
  set({ status: s, tracking: track(state.tracking, s, state.job), job: s.state === 'installing' ? state.job : null, error: null })
}

function start() {
  if (started) return
  started = true
  void os.updateStatus(false).then((r) => (r.ok ? apply(r.value) : set({ error: packageErrorText(r.error) }))).catch(() => {})
  os.onUpdateStatus(apply)
  os.onPkgJob((e) => { const p = updateJobProgress(e); if (p) set({ job: p }) })
}

export const updates = {
  apply,
  async check() { const r = await os.updateStatus(true); if (r.ok) apply(r.value); else set({ error: packageErrorText(r.error) }); return r },
  async defer() {
    const r = await os.updateDefer()
    if (!r.ok) set({ error: packageErrorText(r.error) })
    else if (!r.value) set({ error: 'This update can’t be postponed any more.' })
    return r
  },
  async installNow() { const r = await os.updateInstallNow(); if (!r.ok) set({ error: packageErrorText(r.error) }); return r },
  clearFailure() { set({ tracking: { ...state.tracking, failure: null } }) },
}

export function useOsUpdate(): UpdateState {
  start()
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => state)
}
