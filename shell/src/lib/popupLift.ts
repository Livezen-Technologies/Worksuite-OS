// Small popups of the taskbar's own controls (the language switcher, a window's "move to desktop" menu, the VPN
// flyout…) are drawn in the shell's window, which is below the apps (Labwc always-on-bottom, rc.xml). Desktop.tsx lifts
// the shell over the apps while something of its own is open (shellOnTop); these popups live in their components, so
// they register here while open and Desktop.tsx counts them in. When an app takes the focus (the shell goes back
// below the apps) Desktop.tsx closes them all, like its own menus (#62: the language menu showed behind foot).
import { useEffect, useRef, useSyncExternalStore } from 'react'

const open = new Map<symbol, () => void>()
const subs = new Set<() => void>()
const changed = () => { for (const s of subs) s() }

export function popupsOpen(): number { return open.size }

/** Register a popup while `on`; `close` is called when the shell goes back below the apps. */
export function usePopupLift(on: boolean, close: () => void) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!on) return
    const id = Symbol('popup')
    open.set(id, () => closeRef.current())
    changed()
    return () => { open.delete(id); changed() }
  }, [on])
}

/** True while any registered popup is open (Desktop.tsx: part of shellOnTop). */
export function useAnyPopupOpen(): boolean {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb) } }, () => open.size > 0, () => false)
}

/** The shell went back below the apps: close every registered popup. */
export function closePopups() {
  for (const close of [...open.values()]) close()
}
