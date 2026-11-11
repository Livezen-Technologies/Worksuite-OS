// The wizard's view of the setup service: the current state, sending events and answers, and polling while setup
// runs on its own (unattended work, retries, waiting for the network or an administrator, rollback). The service is
// the source of truth; the UI never moves the machine itself.
import { useCallback, useEffect, useRef, useState } from 'react'
import { isMain, WORK_STATES, type SetupEvent, type SetupState } from './core/states.ts'
import type { SetupApi, SetupView } from '../../lib/setupApi'

const POLL_STATES: readonly SetupState[] = [...WORK_STATES, 'RETRYING', 'WAITING_FOR_NETWORK', 'WAITING_FOR_ADMIN_APPROVAL', 'ROLLING_BACK']
export const polls = (s: SetupState) => POLL_STATES.includes(s)
/** States a person answers (not unattended work). */
export const asks = (s: SetupState) => isMain(s) && !WORK_STATES.includes(s)

export type SetupError = 'not_authorized' | 'service_unavailable' | string

export function useSetup(api: SetupApi, pollMs = 1000) {
  const [view, setView] = useState<SetupView | null>(null)
  const [loadError, setLoadError] = useState<SetupError | null>(null)
  const [error, setError] = useState<SetupError | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const refresh = useCallback(async () => {
    const r = await api.state()
    if (!alive.current) return
    if (r.ok) { setView(r.value); setLoadError(null) } else setLoadError(r.error)
  }, [api])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!view || !polls(view.state)) return
    const id = setInterval(() => { void refresh() }, pollMs)
    return () => clearInterval(id)
  }, [view, pollMs, refresh])

  const send = useCallback(async (e: SetupEvent): Promise<boolean> => {
    setBusy(true); setError(null)
    try {
      const r = await api.send(e)
      if (!alive.current) return false
      if (!r.ok) { setError(r.error); return false }
      setFieldErrors(r.value.fieldErrors ?? {})
      if (!r.value.ok && !r.value.fieldErrors) setError(r.value.error ?? 'refused')
      await refresh()
      return r.value.ok
    } finally { if (alive.current) setBusy(false) }
  }, [api, refresh])

  const answer = useCallback(async (key: string, value: unknown): Promise<boolean> => {
    const r = await api.answer(key, value)
    if (!alive.current) return false
    if (!r.ok) { setError(r.error); return false }
    setFieldErrors(({ [key]: _gone, ...rest }) => rest)
    setView((v) => (v ? { ...v, answers: { ...v.answers, [key]: value } } : v))
    return true
  }, [api])

  return { view, loadError, error, fieldErrors, busy, refresh, send, answer, clearError: () => setError(null) }
}
