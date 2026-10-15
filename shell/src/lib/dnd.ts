// Do not disturb, shared by the notification dock and Settings › Notifications. Kept for this session in the
// shell (it holds back toasts; notices still collect in the dock).
import { useEffect, useState } from 'react'

const EVENT = 'ws:dnd'
let on = false

export function setDnd(v: boolean) {
  on = v
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
