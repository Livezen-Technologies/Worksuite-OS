import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { clickAction, panel, taskbarEntries, updateBadge, type PanelWindow, type TrayItem } from '../lib/panel'
import { os, type OsUpdateStatus, type VpnState } from '../lib/os'
import { activeVpn } from '../lib/vpn'
import { useT } from '../i18n'

// Panel contents fed by the Wayland bridge (SRS §5.1): running windows, tray and update badge.

export interface AppInfo { name: string; mark: string; bg: string; fg: string }

export function usePanelWindows(): PanelWindow[] {
  const [windows, setWindows] = useState<PanelWindow[]>([])
  useEffect(() => {
    let live = true
    void panel.windows().then((w) => { if (live) setWindows(w) })
    const off = panel.onWindows(setWindows)
    return () => { live = false; off() }
  }, [])
  return windows
}

/** Super key through lk.worksuite.Shell1 (Labwc keybinding). */
export function useLauncherKey(onAction: (a: 'toggle' | 'show') => void): void {
  useEffect(() => panel.onLauncher(onAction), [onAction])
}

/** Arrow keys move between the buttons of a toolbar group (roving focus, WSOS-ACC keyboard operation). */
export function rovingKeys(e: KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])')]
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (i < 0) return
  const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null
  if (next === null) return
  e.preventDefault()
  items[(next + items.length) % items.length]?.focus()
}

export function RunningApps({ pinned, info, onLaunch }: { pinned: string[]; info: (id: string) => AppInfo | undefined; onLaunch: (id: string) => void }) {
  const t = useT()
  const windows = usePanelWindows()
  const entries = useMemo(() => taskbarEntries(pinned, windows), [pinned, windows])
  const click = (id: string) => {
    const e = entries.find((x) => x.id === id)!
    const a = clickAction(e)
    if (a.kind === 'launch') onLaunch(id)
    else if (a.kind === 'activate') void panel.activate(a.handle)
    else void panel.minimize(a.handle, true)
  }
  return (
    <div role="toolbar" aria-label={t('panel.taskbar')} onKeyDown={rovingKeys} className="flex items-center gap-2">
      {entries.map((e) => {
        const a = info(e.id) ?? { name: e.title || e.id, mark: (e.title || e.id).slice(0, 2), bg: '#E2E8F0', fg: '#0F172A' }
        const label = e.windows.length > 1 ? t('panel.windows', { name: a.name, count: e.windows.length }) : e.active ? t('panel.active', { name: a.name }) : e.running ? t('panel.running', { name: a.name }) : a.name
        return (
          <button key={e.id} type="button" aria-label={label} aria-pressed={e.running ? e.active : undefined} title={e.title || a.name} onClick={() => click(e.id)}
            className={`relative flex size-10 cursor-pointer items-center justify-center rounded-[10px] ${e.active ? 'bg-white/10' : 'hover:bg-white/10'}`}>
            <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-[7px] text-[11px] font-bold" style={{ background: a.bg, color: a.fg }}>{a.mark}</span>
            {e.running && <span aria-hidden="true" className={`absolute bottom-[2px] h-[3px] rounded-sm bg-[#18D4F0] ${e.active ? 'w-3.5' : 'w-1.5'}`} />}
          </button>
        )
      })}
    </div>
  )
}

export function TrayItems() {
  const t = useT()
  const [items, setItems] = useState<TrayItem[]>([])
  useEffect(() => {
    let live = true
    void panel.tray().then((x) => { if (live) setItems(x) })
    const off = panel.onTray(setItems)
    return () => { live = false; off() }
  }, [])
  const shown = items.filter((i) => i.status !== 'Passive')
  if (!shown.length) return null
  return (
    <div role="toolbar" aria-label={t('panel.tray')} onKeyDown={rovingKeys} className="flex items-center gap-1">
      {shown.map((i) => (
        <button key={i.key} type="button" aria-label={i.title || i.id} title={i.title || i.id}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); void panel.trayActivate(i.key, r.left + r.width / 2, r.top) }}
          className={`flex size-8 cursor-pointer items-center justify-center rounded-lg text-[11px] font-semibold uppercase hover:bg-white/10 ${i.status === 'NeedsAttention' ? 'text-[#FFD27A]' : 'text-[#C9D6EE]'}`}>
          <span aria-hidden="true">{(i.title || i.id || '?').slice(0, 2)}</span>
        </button>
      ))}
    </div>
  )
}

const BADGE_TONE = { available: '#1F6BFF', downloading: '#18A0B8', restart: '#2E9E6A', failed: '#D9452B' } as const

/** Taskbar VPN indicator (WSOS-INT-001): shown while a VPN is connected; opens Settings › Network. */
export function VpnBadge({ onOpen }: { onOpen: () => void }) {
  const t = useT()
  const [state, setState] = useState<VpnState | null>(null)
  useEffect(() => {
    let live = true
    const load = () => void os.sysVpn().then((r) => { if (live) setState(r.available ? r.value : null) }).catch(() => undefined)
    load()
    const id = setInterval(load, 15_000)
    return () => { live = false; clearInterval(id) }
  }, [])
  const vpn = activeVpn(state)
  if (!vpn) return null
  const label = t('vpn.badge', { name: vpn.name })
  return (
    <button type="button" onClick={onOpen} aria-label={label} title={label}
      className="flex h-10 cursor-pointer items-center gap-1.5 rounded-[10px] bg-white/[0.12] px-2.5 text-xs font-semibold text-[#9BE7B4] hover:bg-white/20">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z" /></svg>
      {t('vpn.title')}
    </button>
  )
}

export function UpdateBadge({ onOpen }: { onOpen: () => void }) {
  const t = useT()
  const [status, setStatus] = useState<OsUpdateStatus | null>(null)
  const [apps, setApps] = useState(0)
  useEffect(() => {
    let live = true
    void os.updateStatus(false).then((r) => { if (live && r.ok) setStatus(r.value) }).catch(() => undefined)
    void os.pkgCheckUpdates().then((r) => { if (live && r.ok) setApps(r.value.packages.length + r.value.flatpaks.length) }).catch(() => undefined)
    const off = os.onUpdateStatus((s) => setStatus(s))
    return () => { live = false; off() }
  }, [])
  const state = updateBadge(status, apps)
  if (!state) return null
  const label = t(`update.${state}`)
  return (
    <button type="button" onClick={onOpen} aria-label={label} title={label}
      className="relative flex size-10 cursor-pointer items-center justify-center rounded-[10px] bg-white/[0.12] hover:bg-white/20">
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#E8EEFA" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>
      <span aria-hidden="true" className="absolute top-1.5 right-1.5 size-2.5 rounded-full ring-2 ring-[#06102A]" style={{ background: BADGE_TONE[state] }} />
    </button>
  )
}
