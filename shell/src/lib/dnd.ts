// Do not disturb, shared by the notification dock and Settings › Notifications. It holds back toasts (notices still
// collect in the dock) and is remembered across shell restarts and sign-ins.
import { useEffect, useState } from 'react'

const EVENT = 'ws:dnd'
const KEY = 'ws.dnd'
let on = (() => { try { return localStorage.getItem(KEY) === '1' } catch { return false } })()

export function setDnd(v: boolean) {
  on = v
  try { localStorage.setItem(KEY, v ? '1' : '0') } catch { /* no storage: this session only */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: v }))
}
export function useDnd(): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(on)
  useEffect(() => {
    const l = (e: Event) => setV(Boolean((e as CustomEvent).detail))
    window.addEventListener(EVENT, l)
    return () => window.removeEventListener(EVENT, l)
  }, [])
  return [v, setDnd]
}
