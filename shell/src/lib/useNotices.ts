import { useEffect, useState } from 'react'
import { os } from './os'
import { diffStatus, type Notice, type SyncStatus } from './syncNotices'
import { mergeApp, notificationsApi } from './appNotifications'

export type TimedNotice = Notice & { at: number }

/**
 * Notices from the sync service (and later other system sources), newest first. Lives above the desktop
 * so the lock screen can preview the same list (titles only).
 */
export function useNotices(enabled: boolean) {
  const [notices, setNotices] = useState<TimedNotice[]>([])
  const [toast, setToast] = useState<Notice | null>(null)
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let prev: SyncStatus | null = null
    const poll = () => void os.syncStatus().then((r) => {
      if (!r.ok) return
      const fresh = diffStatus(prev, r.value)
      prev = r.value
      if (!fresh.length) return
      setNotices((all) => [...fresh.map((f) => ({ ...f, at: Date.now() })), ...all].slice(0, 50))
      setUnread((u) => u + fresh.length)
      setToast(fresh[0])
    }).catch(() => {})
    poll()
    const t = setInterval(poll, 15_000)
    return () => clearInterval(t)
  }, [enabled])

  // App notifications from the shell's org.freedesktop.Notifications server (WSOS-INT-007).
  useEffect(() => {
    const api = notificationsApi()
    if (!enabled || !api) return
    const apply = (list: Parameters<typeof mergeApp>[1]) => setNotices((all) => {
      const { next, fresh } = mergeApp(all, list)
      if (fresh.length) { setUnread((u) => u + fresh.length); setToast(fresh[0]) }
      return next
    })
    void api.list().then(apply).catch(() => {})
    return api.onChange(apply)
  }, [enabled])

  return { notices, setNotices, toast, setToast, unread, setUnread }
}
