import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { clickAction, onWorkspace, panel, taskbarEntries, updateBadge, type PanelWindow, type ShellAction, type TrayItem, type Workspaces } from '../lib/panel'
import { os, type OsUpdateStatus, type VpnState } from '../lib/os'
import { activeVpn, vpnErrorText } from '../lib/vpn'
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

const NO_WS: Workspaces = { supported: false, current: 1, count: 1, windows: {} }
export function useWorkspaces(): Workspaces {
  const [ws, setWs] = useState<Workspaces>(NO_WS)
  useEffect(() => {
    let live = true
    void panel.workspaces?.().then((w) => { if (live) setWs(w) })
    const off = panel.onWorkspaces?.(setWs)
    return () => { live = false; off?.() }
  }, [])
  return ws
}

/** Panel workspace switcher (WSOS-DSK-003): Labwc desktops through the bridge; hidden where there are none. */
export function WorkspaceSwitcher() {
  const t = useT()
  const ws = useWorkspaces()
  if (!ws.supported) return null
  return (
    <div role="toolbar" aria-label={t('panel.workspaces')} onKeyDown={rovingKeys} className="flex items-center gap-1 rounded-[10px] bg-white/[0.06] p-1">
      {Array.from({ length: ws.count }, (_, i) => i + 1).map((n) => {
        const count = Object.values(ws.windows).filter((x) => x === n).length
        return (
          <button key={n} type="button" aria-pressed={n === ws.current} aria-label={count ? t('panel.workspaceWindows', { n: String(n), count }) : t('panel.workspace', { n: String(n) })}
            onClick={() => void panel.activateWorkspace?.(n)}
            className={`relative flex h-8 min-w-8 cursor-pointer items-center justify-center rounded-lg px-2 text-[13px] font-semibold ${n === ws.current ? 'bg-[#1F6BFF] text-white' : 'text-[#C9D6EE] hover:bg-white/10'}`}>
            {n}
            {count > 0 && n !== ws.current && <span aria-hidden="true" className="absolute bottom-[3px] size-1 rounded-full bg-[#18D4F0]" />}
          </button>
        )
      })}
    </div>
  )
}

/** Super key through lk.worksuite.Shell1 (Labwc keybinding). */
export function useLauncherKey(onAction: (a: ShellAction) => void): void {
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

/** `only` limits the windows to one monitor's (per-monitor taskbars, WSOS-DSK-005). */
export function RunningApps({ pinned, info, onLaunch, only }: { pinned: string[]; info: (id: string) => AppInfo | undefined; onLaunch: (id: string) => void; only?: (w: PanelWindow[]) => PanelWindow[] }) {
  const t = useT()
  const all = usePanelWindows()
  const ws = useWorkspaces()
  const [menu, setMenu] = useState<{ handle: string; x: number } | null>(null)
  const windows = useMemo(() => onWorkspace(only ? only(all) : all, ws), [only, all, ws])
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
            aria-haspopup={ws.supported && e.running ? 'menu' : undefined}
            onContextMenu={(ev) => { if (!ws.supported || !e.running) return; ev.preventDefault(); const w = e.windows.find((x) => x.flags & 1) ?? e.windows[0]; setMenu({ handle: w.handle, x: ev.currentTarget.getBoundingClientRect().left }) }}
            className={`relative flex size-10 cursor-pointer items-center justify-center rounded-[10px] ${e.active ? 'bg-white/10' : 'hover:bg-white/10'}`}>
            {/* The mark is an icon drawn by CSS (not text), so the button's name is the app's name alone (WCAG 2.5.3). */}
            <span aria-hidden="true" data-mark={a.mark} className="ws-mark flex size-7 items-center justify-center whitespace-nowrap rounded-[7px] leading-none font-bold before:content-[attr(data-mark)]" style={{ background: a.bg, color: a.fg, fontSize: 11 }} />
            {e.running && <span aria-hidden="true" className={`absolute bottom-[2px] h-[3px] rounded-sm bg-[#18D4F0] ${e.active ? 'w-3.5' : 'w-1.5'}`} />}
          </button>
        )
      })}
      {menu && <MoveMenu ws={ws} x={menu.x} onPick={(n) => { void panel.moveToWorkspace?.(menu.handle, n); setMenu(null) }} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** "Move to workspace" for a taskbar window (right-click or long-press on the button). */
function MoveMenu({ ws, x, onPick, onClose }: { ws: Workspaces; x: number; onPick: (n: number) => void; onClose: () => void }) {
  const t = useT()
  useEffect(() => {
    const k = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <>
      <div className="fixed inset-0 z-40" aria-hidden="true" onClick={onClose} />
      <div role="menu" aria-label={t('panel.moveTo')} className="fixed bottom-[64px] z-50 flex min-w-[200px] flex-col rounded-xl border border-[rgba(127,178,255,0.2)] bg-[#10244F] p-1 text-[13px] text-[#E8EEFA] shadow-[0_18px_40px_rgba(0,0,0,0.5)]" style={{ left: Math.max(8, x) }}>
        <span className="px-3 py-1.5 text-xs text-[#8FA3C8]">{t('panel.moveTo')}</span>
        {Array.from({ length: ws.count }, (_, i) => i + 1).filter((n) => n !== ws.current).map((n, i) => (
          <button key={n} type="button" role="menuitem" autoFocus={i === 0} onClick={() => onPick(n)} className="cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-white/10">{t('panel.workspace', { n: String(n) })}</button>
        ))}
      </div>
    </>
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
          <span aria-hidden="true" data-mark={(i.title || i.id || '?').slice(0, 2)} className="whitespace-nowrap leading-none before:content-[attr(data-mark)]" />
        </button>
      ))}
    </div>
  )
}

const BADGE_TONE = { available: '#1F6BFF', downloading: '#18A0B8', restart: '#2E9E6A', failed: '#D9452B' } as const

/** Taskbar VPN indicator (WSOS-INT-001): shown while a VPN is connected; opens the V3 tunnel panel. */
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
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const vpn = activeVpn(state)
  // Shown while connected, or while the V3 panel is open (so switching the last tunnel off doesn't close it).
  if (!state || (!vpn && !open)) return null
  const label = vpn ? t('vpn.badge', { name: vpn.name }) : t('vpn.title')
  const toggle = async (uuid: string, on: boolean, needsCreds: boolean) => {
    if (on && needsCreds) { setOpen(false); onOpen(); return } // credentials are asked in Settings › VPN
    setBusy(uuid); setError(null)
    const r = await os.sysVpnConnect(uuid, on)
    setBusy(null)
    if (!r.available) setError(vpnErrorText(r.reason) || null)
    const s = await os.sysVpn().catch(() => null)
    if (s?.available) setState(s.value)
  }
  return (
    <span className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label={label} title={label} aria-expanded={open} aria-haspopup="dialog"
        className={`flex size-10 cursor-pointer items-center justify-center rounded-[10px] hover:bg-white/20 ${open ? 'bg-white/20' : 'bg-white/[0.12]'}`}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={vpn ? '#5FD39A' : '#C9D6EE'} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4" /></svg>
      </button>
      {open && (
        <div role="dialog" aria-label={t('vpn.title')} className="absolute right-0 bottom-[52px] flex w-[360px] flex-col gap-3 rounded-2xl border border-[rgba(127,178,255,0.2)] bg-[rgba(10,24,56,0.97)] p-4 text-[#E8EEFA] shadow-[0_24px_60px_rgba(0,0,0,0.5)]">
          <span className="flex items-center gap-2.5 rounded-xl px-3 py-2.5" style={{ background: vpn ? '#2E9E6A' : 'rgba(255,255,255,0.06)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4" /></svg>
            <span className="flex flex-col"><span className="text-[13px] font-semibold">{t('vpn.title')}</span><span className="text-[11px] text-[#DCFCE8]">{vpn ? vpn.name : t('common.notConnected')}</span></span>
          </span>
          <div className="overflow-hidden rounded-xl bg-[rgba(4,10,26,0.5)]">
            <div className="px-3 py-2.5 text-[11px] tracking-[0.06em] text-[#8FA3C8] uppercase">{t('vpn.tunnels')}</div>
            {state.connections.map((c) => {
              const locked = c.managed && c.active && state.vpn_required
              return (
                <div key={c.uuid} className="flex items-center gap-2.5 border-t border-[rgba(127,178,255,0.08)] px-3 py-2.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: c.active ? '#5FD39A' : '#5E739C' }} />
                  <span className="flex flex-1 flex-col"><span className="text-[13px] font-medium">{c.name}</span><span className="font-mono text-[10px] text-[#8FA3C8]">{[c.device, c.active ? t('common.connected') : t('common.off')].filter(Boolean).join(' · ')}</span></span>
                  <button type="button" role="switch" aria-checked={c.active} aria-label={c.name} disabled={busy !== null || locked} onClick={() => void toggle(c.uuid, !c.active, c.needs_credentials)}
                    className="relative h-[22px] w-9 cursor-pointer rounded-[11px] disabled:cursor-default disabled:opacity-60" style={{ background: c.active ? '#2E9E6A' : 'rgba(127,178,255,0.25)' }}>
                    <span className="absolute top-[3px] h-4 w-4 rounded-full bg-white" style={{ left: c.active ? 17 : 3 }} />
                  </button>
                </div>
              )
            })}
          </div>
          {error && <span role="alert" className="text-xs text-[#FF8A7A]">{error}</span>}
          <button type="button" onClick={() => { setOpen(false); onOpen() }} className="cursor-pointer self-start text-xs text-[#7FB2FF] hover:text-[#B8D4FF]">{t('vpn.settingsLink')}</button>
        </div>
      )}
    </span>
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
