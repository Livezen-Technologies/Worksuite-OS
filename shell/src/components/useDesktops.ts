// The shell's desktops state (WSOS-DSK-003): the bridge's desktops, restored at sign-in from the synced preferences
// (names, order, count, wallpapers, apps on all desktops, Alt+Tab's scope) and saved back whenever they change.
import { useCallback, useEffect, useRef, useState } from 'react'
import { panel, type Workspaces } from '../lib/panel'
import { os } from '../lib/os'
import { shellPrefsFrom } from '../lib/shellPrefs'
import { DEFAULT_DESKTOP_PREFS, sameDesktops, saveDesktopPrefs, savedList, setDesktopPrefs, useDesktopPrefs, wallpapersFor, type DesktopPrefs, type SavedDesktop } from '../lib/desktops'
import { useWorkspaces } from './PanelItems'
import { t } from '../i18n'

type Sync = Parameters<typeof saveDesktopPrefs>[1]

export function useDesktops(enabled: boolean, sync: Sync = os) {
  const ws = useWorkspaces()
  const prefs = useDesktopPrefs()
  const [wallpapers, setWallpapers] = useState<Record<string, string>>({})
  const started = useRef(false)
  const pending = useRef<SavedDesktop[] | null>(null)
  const [settled, setSettled] = useState(false)

  // Sign-in: the synced desktops onto the bridge (once the bridge has answered).
  useEffect(() => {
    if (!enabled || !ws.dynamic || !ws.ids || started.current) return
    started.current = true
    void sync.shellPrefs().catch(() => ({ ok: false, value: null })).then((r) => {
      const saved = r.ok ? shellPrefsFrom(r.value).desktops : undefined
      const p: DesktopPrefs = saved ?? { ...DEFAULT_DESKTOP_PREFS, list: savedList(ws, {}) }
      setDesktopPrefs(p)
      if ((p.altTab === 'all') !== !!ws.switcherAll) void panel.setSwitcherAllDesktops?.(p.altTab === 'all')
      for (const a of p.stickyApps) if (!(ws.stickyApps ?? []).includes(a)) void panel.setAppOnAllDesktops?.(a, true)
      if (saved && !sameDesktops(ws, saved.list)) {
        pending.current = saved.list
        void panel.restoreWorkspaces?.(saved.list.map((d) => d.name), t('desktops.prefix'))
      } else {
        setWallpapers(wallpapersFor(ws, p.list))
        setSettled(true)
      }
    })
  }, [enabled, ws, sync])

  // The restored desktops arrived: their wallpapers, by the bridge's new ids.
  useEffect(() => {
    const list = pending.current
    if (!list || !sameDesktops(ws, list)) return
    pending.current = null
    setWallpapers(wallpapersFor(ws, list))
    setSettled(true)
  }, [ws])

  // Save whenever the desktops change (created, closed, moved, renamed, new wallpaper, apps on all desktops).
  useEffect(() => {
    if (!settled || !ws.dynamic) return
    const list = savedList(ws, wallpapers)
    const stickyApps = [...(ws.stickyApps ?? [])].sort()
    if (JSON.stringify(list) === JSON.stringify(prefs.list) && JSON.stringify(stickyApps) === JSON.stringify([...prefs.stickyApps].sort())) return
    const id = setTimeout(() => void saveDesktopPrefs({ ...prefs, list, stickyApps }, sync), 400)
    return () => clearTimeout(id)
  }, [settled, ws, wallpapers, prefs, sync])

  const setWallpaper = useCallback((n: number, id: string) => {
    const key = ws.ids?.[n - 1]
    if (!key) return
    setWallpapers((w) => { const next = { ...w }; if (id) next[key] = id; else delete next[key]; return next })
  }, [ws])

  return { ws, prefs, wallpapers, setWallpaper }
}

export type DesktopsState = ReturnType<typeof useDesktops>
export type { Workspaces }
