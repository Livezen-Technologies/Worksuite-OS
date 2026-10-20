// Renderer side of electron/remoteSupport.ts (issue #19). Outside Electron there is no bridge and nothing is shown.
import { useCallback, useEffect, useState } from 'react'

export type RsMode = 'view' | 'control'
export interface RsSession {
  session_id: string
  state: 'pending' | 'active' | 'ended'
  mode: RsMode
  reason: string
  admin_name: string
  org_name: string
  consent: 'user' | 'unattended_policy' | null
  granted_mode: RsMode | null
  requested_at: number
  started_at: number | null
  expires_at: number
}
type Reply<T> = { ok: true; value: T } | { ok: false; error: string }

export interface RemoteSupportApi {
  state(): Promise<RsSession | null>
  decide(decision: 'deny' | 'view' | 'control'): Promise<Reply<RsSession | null>>
  revokeControl(): Promise<Reply<RsSession | null>>
  end(): Promise<Reply<RsSession | null>>
  /** Chat with the administrator over the session's data channel (older bridges lack it). */
  chat?(): Promise<{ from: 'admin' | 'user'; text: string; at: number }[]>
  sendChat?(text: string): Promise<boolean>
}

declare global {
  interface Window { worksuiteRemoteSupport?: RemoteSupportApi }
}

export const remoteSupportApi = (): RemoteSupportApi | undefined => (typeof window !== 'undefined' ? window.worksuiteRemoteSupport : undefined)

/** The current request/session, polled (the agent writes it within a second of every change). */
export function useRemoteSupport(pollMs = 1500) {
  const api = remoteSupportApi()
  const [s, setS] = useState<RsSession | null>(null)
  const refresh = useCallback(async () => {
    if (!api) return
    try { setS(await api.state()) } catch { /* keep the last state */ }
  }, [api])
  useEffect(() => {
    if (!api) return
    let live = true
    const tick = () => { if (live) void refresh() }
    tick()
    const id = setInterval(tick, pollMs)
    return () => { live = false; clearInterval(id) }
  }, [api, pollMs, refresh])
  return { api, session: s, refresh }
}
