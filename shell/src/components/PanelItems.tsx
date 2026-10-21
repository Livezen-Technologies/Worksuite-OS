import { AppGlyph } from './AppGlyph'
import { useEffect, useMemo, useState, type KeyboardEvent, type WheelEvent } from 'react'
import { taskbarWindows, isSticky, isStickyApp, desktopName, MAX_DESKTOPS, type Scope } from '../lib/desktops'
import { clickAction, panel, taskbarEntries, taskbarUnread, updateBadge, type PanelWindow, type ShellAction, type TrayItem, type Workspaces } from '../lib/panel'
import { os, type OsUpdateStatus, type VpnState } from '../lib/os'
import { activeVpn, vpnErrorText } from '../lib/vpn'
import { useT } from '../i18n'

// Panel contents fed by the Wayland bridge (SRS §5.1): running windows, tray and update badge.

/** id: launcher id (for its bundled icon); icon: theme icon name / Icon= value. */
export interface AppInfo { id?: string; name: string; mark: string; bg: string; fg: string; icon?: string | null }

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

/** A vertical wheel scrolls the overflowing app list sideways. */
function wheelScroll(e: WheelEvent<HTMLElement>) {
  const el = e.currentTarget
  if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += document.dir === 'rtl' ? -e.deltaY : e.deltaY
}

/** `only` limits the windows to one monitor's (per-monitor taskbars, WSOS-DSK-005). */
/** scope: Settings › Multitasking, "On the taskbar, show windows from" (the current desktop's, by default, or all). */
export function RunningApps({ pinned, info, onLaunch, only, scope = 'current' }: { pinned: string[]; info: (id: string) => AppInfo | undefined; onLaunch: (id: string) => void; only?: (w: PanelWindow[]) => PanelWindow[]; scope?: Scope }) {
  const t = useT()
  const all = usePanelWindows()
  const ws = useWorkspaces()
  const [menu, setMenu] = useState<{ handle: string; x: number } | null>(null)
  const windows = useMemo(() => taskbarWindows(only ? only(all) : all, ws, scope), [only, all, ws, scope])
  const entries = useMemo(() => taskbarEntries(pinned, windows), [pinned, windows])
  const click = (id: string) => {
    const e = entries.find((x) => x.id === id)!
    const a = clickAction(e)
    if (a.kind === 'launch') onLaunch(id)
    else if (a.kind === 'activate') void panel.activate(a.handle)
    else void panel.minimize(a.handle, true)
  }
  return (
    // Many apps on a narrow screen: the list shrinks and scrolls sideways (no scrollbar; focus and the wheel bring items in).
    <div role="toolbar" aria-label={t('panel.taskbar')} onKeyDown={rovingKeys} onWheel={wheelScroll} data-testid="taskbar-apps"
      className="ws-taskbar-apps flex min-w-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden py-1">
      {entries.map((e) => {
        // A window with no launcher entry still tries its app_id as an icon name (most apps name both alike).
        const a = info(e.id) ?? { id: e.id, name: e.title || e.id, mark: (e.title || e.id).slice(0, 2), bg: '#E2E8F0', fg: '#0F172A', icon: SYSTEM_ICONS[e.id.toLowerCase()] ?? (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(e.id) ? e.id : null) }
        const unread = taskbarUnread(e.id, e.windows)
        const base = e.windows.length > 1 ? t('panel.windows', { name: a.name, count: e.windows.length }) : e.active ? t('panel.active', { name: a.name }) : e.running ? t('panel.running', { name: a.name }) : a.name
        const label = unread ? t('panel.unread', { name: base, count: unread }) : base
        return (
          <button key={e.id} type="button" aria-label={label} aria-pressed={e.running ? e.active : undefined} title={e.title || a.name} onClick={() => click(e.id)}
            aria-haspopup={ws.supported && e.running ? 'menu' : undefined}
            onContextMenu={(ev) => { if (!ws.supported || !e.running) return; ev.preventDefault(); const w = e.windows.find((x) => x.flags & 1) ?? e.windows[0]; setMenu({ handle: w.handle, x: ev.currentTarget.getBoundingClientRect().left }) }}
            className={`relative flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-[10px] ${e.active ? 'bg-white/10' : 'hover:bg-white/10'}`}>
            {/* The mark is an icon drawn by CSS (not text), so the button's name is the app's name alone (WCAG 2.5.3). */}
            <AppGlyph app={{ ...a, id: a.id ?? e.id }} size={26} radius={7} font={11} css />
            {unread > 0 && <span aria-hidden="true" data-testid="taskbar-unread" className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#25D366] px-1 text-[10px] font-bold leading-none text-white ring-2 ring-[#06102A]">{unread > 99 ? '99+' : unread}</span>}
            {/* Canvas G01: a 16 px cyan bar under the focused app, a 5 px grey dot under one that runs in the background. */}
            {e.running && <span aria-hidden="true" data-indicator={e.active ? 'active' : 'running'} className={`ws-run-dot absolute bottom-[2px] h-[3px] rounded-sm ${e.active ? 'w-4 bg-[#18D4F0]' : 'w-[5px] bg-[var(--ws-g-muted)]'}`} />}
          </button>
        )
      })}
      {menu && <MoveMenu ws={ws} win={all.find((w) => w.handle === menu.handle)} x={menu.x} onPick={(n) => { void panel.moveToWorkspace?.(menu.handle, n); setMenu(null) }} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** A taskbar window's menu (right-click or long-press): move it to another desktop, or show it (or its app's windows)
 *  on all desktops, like Windows 11. */
function MoveMenu({ ws, win, x, onPick, onClose }: { ws: Workspaces; win?: PanelWindow; x: number; onPick: (n: number) => void; onClose: () => void }) {
  const t = useT()
  useEffect(() => {
    const k = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  const others = Array.from({ length: ws.count }, (_, i) => i + 1).filter((n) => n !== (win ? ws.windows[win.handle] ?? ws.current : ws.current))
  const item = 'cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-white/10 focus-visible:bg-white/10'
  const newDesktop = async () => { if (!win) return; await panel.createWorkspace?.(); void panel.moveToWorkspace?.(win.handle, ws.count + 1); onClose() }
  return (
    <>
      <div className="fixed inset-0 z-40" aria-hidden="true" onClick={onClose} />
      <div role="menu" aria-label={t('desktops.moveTo')} className="fixed bottom-[64px] z-50 flex min-w-[240px] flex-col rounded-xl border border-[rgba(127,178,255,0.2)] bg-[#10244F] p-1 text-[13px] text-[#E8EEFA] shadow-[0_18px_40px_rgba(0,0,0,0.5)]" style={{ left: Math.max(8, x) }}>
        <span className="px-3 py-1.5 text-xs text-[#8FA3C8]">{t('desktops.moveTo')}</span>
        {others.map((n, i) => (
          <button key={n} type="button" role="menuitem" autoFocus={i === 0} onClick={() => onPick(n)} className={item}>{desktopName(ws, n)}</button>
        ))}
        {ws.dynamic && ws.count < MAX_DESKTOPS && <button type="button" role="menuitem" autoFocus={!others.length} onClick={() => void newDesktop()} className={item}>{t('desktops.new')}</button>}
        {ws.dynamic && win && <>
          <span role="separator" className="my-1 h-px bg-[rgba(127,178,255,0.15)]" />
          <button type="button" role="menuitemcheckbox" aria-checked={isSticky(ws, win)} onClick={() => { void panel.setWindowOnAllDesktops?.(win.handle, !isSticky(ws, win)); onClose() }} className={item}>{t('desktops.showWindowAll')}</button>
          <button type="button" role="menuitemcheckbox" aria-checked={isStickyApp(ws, win)} onClick={() => { void panel.setAppOnAllDesktops?.(win.appId, !isStickyApp(ws, win)); onClose() }} className={item}>{t('desktops.showAppAll')}</button>
        </>}
      </div>
    </>
  )
}

/** System prompts whose app_id is no icon name: GNOME Keyring's password prompt ("gcr-prompter", untitled) showed as a
 *  "gc" tile. */
const SYSTEM_ICONS: Record<string, string> = { 'gcr-prompter': 'dialog-password', 'org.gnome.keyring.systemprompter': 'dialog-password' }

/** fcitx5's own tray item (SNI Id "Fcitx"): its click toggled fcitx5 for the text field that had just lost the focus to
 *  the taskbar, so it seemed to do nothing, and its language menu is a D-Bus menu. InputMethodSwitcher replaces it (#58). */
export const HIDDEN_TRAY_IDS = ['Fcitx']

export function TrayItems() {
  const t = useT()
  const [items, setItems] = useState<TrayItem[]>([])
  useEffect(() => {
    let live = true
    void panel.tray().then((x) => { if (live) setItems(x) })
    const off = panel.onTray(setItems)
    return () => { live = false; off() }
  }, [])
  const shown = items.filter((i) => i.status !== 'Passive' && !HIDDEN_TRAY_IDS.includes(i.id))
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
