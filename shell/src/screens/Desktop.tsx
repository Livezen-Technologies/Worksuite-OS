import { Children, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopProps } from './types'
import { personName } from '../lib/session'
import { managedLabel, os, type DeviceInfo } from '../lib/os'
import BIcon from '../components/BIcon'
import type { Notice } from '../lib/syncNotices'
import { BG, Icon, Mark, P } from '../components/Ws'
import { PowerMenu, ShutdownConfirm } from '../components/Power'
import { RunningApps, TrayItems, UpdateBadge, VpnBadge, WorkspaceSwitcher, useLauncherKey } from '../components/PanelItems'
import { QuickPanel, QuickTray, useQuickState } from '../components/QuickSettings'
import { OskButton } from '../components/TouchItems'
import { useTouchMode } from '../lib/touch'
import { useDisplayState, wallpaperFor, windowsOnOutput } from '../lib/displays'
import { panel, showDesktopTargets, type PanelWindow, type ShellAction } from '../lib/panel'
import A11yPanel from '../components/A11yPanel'
import NotifDock, { MOON } from '../components/NotifDock'
import { CaptureBadge } from '../components/CaptureBadge'
import { useDnd } from '../lib/dnd'
import { formatTime, localeTag, t as t0, useT } from '../i18n'
import { UpdateOverlays } from './Updates'
import { DeviceWatcher } from './Hardware'
import { requestSettingsSection } from '../lib/settingsNav'
import { markLauncherRequest, reportLauncherFirstFrame } from '../lib/perfProbe'
import { applyShellPrefs, shellPrefsFrom, taskbarPins, toggleFavorite, type ShellPrefs } from '../lib/shellPrefs'
import { alphaGroups, buildLauncherApps, filterApps, startPins, taskbarApps, tileColor, type LauncherApp } from '../lib/launcher'
import type { MessageKey } from '../i18n'
import GlobalSearch from '../components/GlobalSearch'
import Assistant, { AI_ICON } from '../components/Assistant'
import { onAssistantRequest, type AssistantRequest } from '../lib/assistantNav'
import ShellRestartNotice from '../components/ShellRestartNotice'
import AuthPrompt from '../components/AuthPrompt'
import type { SearchHit } from '../../electron/search'

const TONE_BG: Record<Notice['tone'], string> = { ok: '#2E9E6A', warn: '#B7791F', error: '#D9452B' }

// Settings pages the search finds, with the Settings section each opens.
const SETTINGS_PAGES: [MessageKey, string][] = [
  ['launcher.page.network', 'Network'], ['settings.nav.Bluetooth', 'Bluetooth'], ['launcher.page.displays', 'Display'], ['settings.nav.Sound', 'Sound'],
  ['launcher.page.power', 'Power'], ['settings.nav.Appearance', 'Appearance'], ['launcher.page.accounts', 'Users'], ['launcher.page.privacy', 'Privacy'],
  ['settings.nav.Updates', 'Updates'], ['launcher.page.shortcuts', 'Keyboard'],
]

// Recent files: local (XDG recently-used.xbel) then WorkSuite Drive's recent list, through the main-process bridge.
const RECENT_MAX = 6

// Taskbar pins (running windows from the Wayland bridge join them, components/PanelItems.tsx); entries the org hasn't enabled or that aren't installed drop out.
const TASKBAR = ['worksuite-mail', 'worksuite-chat', 'worksuite-drive', 'office', 'firefox-esr']

// Settings as a Start menu tile (G02); it opens the Settings window like the footer button.
const SETTINGS_TILE: LauncherApp = { id: 'settings', get name() { return t0('launcher.settings') }, mark: '⚙', bg: '#5E739C', fg: '#ffffff', kind: 'System', launch: { screen: 'settings' }, keywords: [] }
const EXT_COLOR: Record<string, string> = { xlsx: '#2E9E6A', ods: '#2E9E6A', csv: '#2E9E6A', docx: '#1F6BFF', odt: '#1F6BFF', doc: '#1F6BFF', pptx: '#D9572B', odp: '#D9572B', pdf: '#D9452B', png: '#7A4FE0', jpg: '#7A4FE0', jpeg: '#7A4FE0', svg: '#7A4FE0' }
const FOOT_ICONS = { files: 'M3 6h6l2 2h10v11H3z', settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2', lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z', power: 'M12 3v9M6.3 7.3a8 8 0 1 0 11.4 0' }

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(t) }, [])
  return now
}

export default function Desktop({ user, fullName, onLock, onLogout, onOpen, notes, children }: DesktopProps) {
  const t = useT()
  const now = useClock()
  const [launcher, setLauncher] = useState(false)
  useTouchMode() // :root[data-touch] sizing and the on-screen keyboard on text-field focus
  const [a11yOpen, setA11yOpen] = useState(false)
  // Super key from Labwc arrives over lk.worksuite.Shell1 (WSOS-DSK-011).
  // The on-device AI assistant (services/ai): Super+A (rc.xml → Shell1.ToggleAssistant), the taskbar button, "Ask AI"
  // in search and "Explain with AI" in Files.
  const [assistant, setAssistant] = useState(false)
  const [assistantReq, setAssistantReq] = useState<AssistantRequest | null>(null)
  useEffect(() => onAssistantRequest((r) => { setLauncher(false); setAssistantReq(r); setAssistant(true) }), [])
  useLauncherKey(useCallback((a: ShellAction) => {
    if (a === 'assistant') { setLauncher(false); setAssistant((v) => !v); return }
    if (a === 'notifications') { setTrayOpen((v) => !v); return }
    if (a === 'desktop') { void Promise.all([panel.windows(), panel.workspaces?.() ?? Promise.resolve(undefined)]).then(([w, ws]) => showDesktopTargets(w, ws ?? { supported: false, current: 1, count: 1, windows: {} }).forEach((h) => void panel.minimize(h, true))); return }
    markLauncherRequest(); setLauncher((v) => (a === 'show' ? true : !v))
  }, []))
  // Launcher first frame (WSOS-PRF-005); only forwarded off the console in perf test runs.
  useEffect(() => { if (launcher) void reportLauncherFirstFrame() }, [launcher])
  const [allView, setAllView] = useState(false)
  const [qsOpen, setQsOpen] = useState(false)
  const [quick, refreshQuick] = useQuickState()
  const [query, setQuery] = useState('')
  const [powerOpen, setPowerOpen] = useState(false)
  const [confirmShutdown, setConfirmShutdown] = useState(false)
  const { notices, setNotices, toast, setToast, unread, setUnread } = notes
  const [trayOpen, setTrayOpen] = useState(false)
  // Do not disturb holds toasts back; notices still collect in the notification center.
  const [dnd, setDnd] = useDnd()
  const searchRef = useRef<HTMLInputElement>(null)
  const name = personName(user, fullName) || user

  const time = formatTime(now)
  const longDate = now.toLocaleDateString(localeTag(), { weekday: 'long', day: 'numeric', month: 'long' })
  const shortDate = now.toLocaleDateString(localeTag(), { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 5000); return () => clearTimeout(t) }, [toast, setToast])

  // Management chip from the device agent's status; re-read each minute so enrollment, wipe or revocation show up.
  const [device, setDevice] = useState<DeviceInfo | null>(null)
  useEffect(() => {
    const load = () => void os.deviceInfo().then(setDevice).catch(() => setDevice(null))
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [])
  const managed = managedLabel(device)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setPowerOpen(false); setLauncher(false); setTrayOpen(false); setQsOpen(false) }
      // Super+A inside the shell's own window (the compositor binding covers everywhere else).
      else if (e.metaKey && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); setLauncher(false); setAssistant((v) => !v) }
      else if ((e.key === 'Meta' || e.key === 'OS' || e.key === 'Super') && !e.repeat) { markLauncherRequest(e.timeStamp); setLauncher((v) => !v) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const launcherButton = useRef<HTMLButtonElement>(null)
  const launcherWasOpen = useRef(false)
  useEffect(() => {
    if (launcher) searchRef.current?.focus()
    else {
      setQuery('')
      setAllView(false)
      // Focus goes back to the launcher button on close, so screen-reader and keyboard users are not left on <body>.
      if (launcherWasOpen.current && (!document.activeElement || document.activeElement === document.body)) launcherButton.current?.focus()
    }
    launcherWasOpen.current = launcher
  }, [launcher])

  // Start menu list: the org's WorkSuite apps (fallback list when not signed in/offline) and installed XDG apps.
  const [baseApps, setAllApps] = useState<LauncherApp[]>(() => buildLauncherApps(null, null, null))
  // The user's favourites, taskbar pins and order (Shell ENH-01 preferences, synced; WSOS-DSK-001).
  const [prefs, setPrefs] = useState<ShellPrefs>({})
  const [appsCached, setAppsCached] = useState(false)
  const allApps = useMemo(() => applyShellPrefs(baseApps, prefs), [baseApps, prefs])
  const toggleFav = (id: string) => {
    const next = toggleFavorite(prefs, allApps, id)
    setPrefs(next)
    void os.setShellPrefs(next).catch(() => undefined)
  }
  const appsLoaded = useRef(false)
  useEffect(() => {
    // On start, then again each time the launcher opens (sign-in, installs and org changes show up).
    if (!launcher && appsLoaded.current) return
    appsLoaded.current = true
    let live = true
    void Promise.all([os.webApps().catch(() => null), os.installedApps().catch(() => null), os.shellPrefs().catch(() => null)]).then(([w, i, p]) => {
      if (!live) return
      setAllApps(buildLauncherApps(w?.ok ? w.value : null, i?.apps ?? null, i?.office ?? null, i?.desktop ?? null))
      setAppsCached(!!(w?.ok && w.cached))
      if (p?.ok) setPrefs(shellPrefsFrom(p.value))
    })
    return () => { live = false }
  }, [launcher])
  const [recent, setRecent] = useState<SearchHit[]>([])
  useEffect(() => {
    if (!launcher) return
    let live = true
    void os.recentFiles().then((r) => { if (live) setRecent([...r.local, ...r.cloud.hits].slice(0, RECENT_MAX)) }).catch(() => { if (live) setRecent([]) })
    return () => { live = false }
  }, [launcher])
  const q = query.trim().toLowerCase()
  const apps = useMemo(() => filterApps(allApps, 'all', q), [allApps, q])
  const pins = useMemo(() => startPins(allApps, 12, [SETTINGS_TILE]), [allApps])
  const groups = useMemo(() => alphaGroups(allApps), [allApps])
  const settingsHits = useMemo(() => (q ? SETTINGS_PAGES.map(([k, section]) => ({ label: t(k), section })).filter((s) => s.label.toLowerCase().includes(q)) : []), [q, t])

  const launch = (id: string) => {
    setLauncher(false)
    const a = id === SETTINGS_TILE.id ? SETTINGS_TILE : allApps.find((x) => x.id === id)
    if (!a) return
    if ('screen' in a.launch) onOpen(a.launch.screen)
    else if ('office' in a.launch) void os.launchOffice(a.launch.office)
    else if ('worksuite' in a.launch) void os.launchWorkSuite(a.launch.worksuite)
    else void os.launchApp(a.launch.desktop)
  }
  const taskbar = taskbarApps(allApps, taskbarPins(prefs, TASKBAR))
  // This window is the primary monitor's desktop; other monitors have their own (OutputDesktop, WSOS-DSK-005).
  const display = useDisplayState()
  const primaryOut = display?.layout.primary ?? null
  const onPrimary = useMemo(() => (primaryOut && display ? (ws: PanelWindow[]) => windowsOnOutput(ws, primaryOut, true, display.layout.outputs.filter((o) => o.enabled).map((o) => o.name)) : undefined), [primaryOut, display])

  const openSettingsAt = (section: string) => { requestSettingsSection(section); onOpen('settings') }


  return (
    <div className="relative h-full w-full overflow-hidden font-sans text-[#0f172a]" style={{ background: wallpaperFor(display, primaryOut, BG.desktop) }}>
      {/* On the wallpaper: keeps its light text in the light theme (ws-dark-zone). */}
      <div className="ws-dark-zone absolute top-7 left-8 flex flex-col gap-1.5 text-[#E8EEFA]">
        <div className="text-sm text-[#8FA3C8]">{longDate}</div>
        <div className="text-[44px] font-light tracking-[-1px]">{time}</div>
      </div>

      {/* Work area for open windows, above the taskbar */}
      {children && <div className="absolute inset-x-0 top-0 bottom-[52px] z-10 px-6 pt-5 pb-5">{children}</div>}

      {toast && !dnd && !trayOpen && (
        <div role="status" className="absolute top-6 right-6 z-20 flex w-[380px] gap-3 rounded-2xl border border-[rgba(127,178,255,0.2)] bg-[rgba(10,24,56,0.94)] p-4 text-[#E8EEFA] shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] font-bold text-white" style={{ background: TONE_BG[toast.tone] }}><BIcon name={toast.tone === 'ok' ? 'check' : 'alert'} /></span>
          <div className="flex flex-1 flex-col gap-[3px]">
            <div className="flex justify-between gap-2"><span className="text-sm font-semibold">{toast.title}</span><span className="text-xs text-[#8FA3C8]">{t('notes.now')}</span></div>
            <span className="text-[13px] leading-[1.4] text-[#C9D6EE]">{toast.body}</span>
          </div>
          <button type="button" aria-label={t('notes.dismiss')} onClick={() => setToast(null)} className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[#8FA3C8] hover:bg-white/10 hover:text-white"><Icon d={P.close} size={14} /></button>
        </div>
      )}

      {/* G12: the shell was restarted by systemd; apps in their own scopes kept running */}
      <ShellRestartNotice />
      <AuthPrompt />

      {/* OS updates (U1, U4–U7) and new devices (H1, H2, H6) */}
      <div className="pointer-events-none absolute right-5 bottom-[76px] z-30 flex w-[400px] max-w-[calc(100%-40px)] flex-col gap-2.5">
        <DeviceWatcher onOpenUpdates={() => openSettingsAt('Updates')} onOpenDrivers={() => openSettingsAt('Drivers')} />
        <UpdateOverlays quiet={trayOpen || qsOpen || launcher || Children.toArray(children).length > 0} onOpenUpdates={() => openSettingsAt('Updates')} />
      </div>

      {trayOpen && <NotifDock now={now} time={time} notices={notices} setNotices={setNotices} dnd={dnd} setDnd={(v) => { setDnd(v); if (v) setToast(null) }} />}

      {launcher && q && (
        <div className="absolute inset-x-0 top-0 bottom-[52px] z-30 flex items-start justify-center bg-[rgba(2,6,16,0.45)] px-4 pt-[90px] backdrop-blur-[6px]" onMouseDown={(e) => { if (e.target === e.currentTarget) setLauncher(false) }}>
          <GlobalSearch query={query} onQuery={setQuery} apps={apps} settings={settingsHits} onLaunchApp={launch}
            onOpenSettings={(s) => { setLauncher(false); openSettingsAt(s) }} onClose={() => setLauncher(false)}
            onAskAI={(text) => { setLauncher(false); setAssistantReq({ kind: 'ask', text }); setAssistant(true) }} />
        </div>
      )}
      {launcher && !q && (
        <div className="absolute inset-x-0 top-0 bottom-[52px] z-30 flex items-end justify-center p-3" onMouseDown={(e) => { if (e.target === e.currentTarget) setLauncher(false) }}>
          <div id="ws-launcher" role="dialog" aria-modal="true" aria-label={t('launcher.title')} className="ws-rise flex h-[660px] max-h-full w-[660px] max-w-full flex-col overflow-hidden rounded-[22px] border border-[rgba(127,178,255,0.2)] bg-[rgba(10,24,56,0.97)] text-[#E8EEFA] shadow-[0_40px_90px_rgba(0,0,0,0.6)] backdrop-blur-[24px]">
            <div className="flex min-h-0 flex-1 flex-col gap-[18px] px-[26px] pt-[22px]">
              <label className="box-border flex h-11 shrink-0 items-center gap-2.5 rounded-[22px] border border-[rgba(127,178,255,0.18)] bg-[rgba(4,10,26,0.6)] px-4 text-[#8FA3C8] focus-within:border-[#1F6BFF]">
                <Icon d={['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4-4']} size={16} width={2.2} />
                <span className="sr-only">{t('launcher.search')}</span>
                <input ref={searchRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('launcher.searchPlaceholder')} className="grow border-0 bg-transparent text-sm focus-visible:shadow-none focus-visible:outline-none text-[#E8EEFA] outline-none placeholder:text-[#8FA3C8]" />
                <span aria-hidden="true" className="rounded border border-[#3D5280] px-1.5 py-0.5 font-mono text-[10px]">Super</span>
              </label>
              <div className="flex items-center justify-between">
                <h2 className="m-0 text-sm font-semibold">{allView ? t('launcher.tab.all') : t('launcher.pinned')}{appsCached && <span className="ml-2 text-xs font-normal text-[#8FA3C8]">{t('launcher.cachedList')}</span>}</h2>
                <button type="button" onClick={() => setAllView((v) => !v)} className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-white/[0.07] px-3 py-[5px] text-xs hover:bg-white/[0.12]">
                  {allView ? t('common.back') : t('launcher.tab.all')}<Icon d={[allView ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6']} size={12} width={2.4} stroke="#C9D6EE" />
                </button>
              </div>
              {!allView ? (
                <>
                  <div className="ws-pins grid grid-cols-6 gap-x-1.5 gap-y-1">
                    {pins.map((a) => (
                      <button key={a.id} type="button" onClick={() => launch(a.id)} onContextMenu={(e) => { if (a.id === SETTINGS_TILE.id) return; e.preventDefault(); toggleFav(a.id) }} aria-description={a.fav ? t('launcher.unpinHint') : t('launcher.pinHint')} className="flex min-w-0 cursor-pointer flex-col items-center gap-[7px] rounded-xl px-1 py-2.5 hover:bg-white/[0.07] focus-visible:bg-white/[0.07]">
                        <span aria-hidden="true" className="ws-mark flex size-11 items-center justify-center whitespace-nowrap rounded-xl leading-none font-bold text-white shadow-[0_6px_14px_rgba(0,0,0,0.25)]" style={{ background: tileColor(a), fontSize: 16 }}>{a.mark}</span>
                        <span className="max-w-full truncate text-xs">{a.name}</span>
                      </button>
                    ))}
                  </div>
                  <div className="h-px shrink-0 bg-[rgba(127,178,255,0.1)]" />
                  <div className="flex items-center justify-between">
                    <h2 className="m-0 text-sm font-semibold">{t('launcher.recommended')}</h2>
                    <button type="button" onClick={() => { setLauncher(false); onOpen('files') }} className="cursor-pointer text-xs text-[#7FB2FF] hover:text-[#B8D4FF]">{t('launcher.more')}</button>
                  </div>
                  {recent.length ? (
                    <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                      {recent.map((r) => {
                        const ext = (r.ext ?? '').toLowerCase()
                        return (
                          <button key={r.id} type="button" onClick={() => { setLauncher(false); void os.openSearchResult(r.link) }} className="flex min-w-0 cursor-pointer items-center gap-3 rounded-[10px] px-2.5 py-2 text-left hover:bg-white/[0.07]">
                            <span aria-hidden="true" className="flex size-[34px] flex-none items-center justify-center rounded-lg font-mono text-[9px] font-bold uppercase" style={{ background: EXT_COLOR[ext] ?? '#3D5280' }}>{ext.slice(0, 4) || '—'}</span>
                            <span className="flex min-w-0 flex-col gap-px"><span className="truncate text-[13px]">{r.title}</span><span className="truncate text-[11px] text-[#8FA3C8]">{r.subtitle || t(r.source === 'local' ? 'launcher.recentLocal' : 'search.source.drive')}</span></span>
                          </button>
                        )
                      })}
                    </div>
                  ) : <p className="m-0 px-2.5 text-[13px] text-[#8FA3C8]">{t('launcher.noRecent')}</p>}
                </>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-px overflow-auto pr-1">
                  {groups.map((g) => (
                    <div key={g.letter} role="group" aria-label={g.letter} className="flex flex-col gap-px">
                      <span aria-hidden="true" className="px-2.5 pt-2 pb-1 text-xs font-bold text-[#18D4F0]">{g.letter}</span>
                      {g.apps.map((a) => (
                        <button key={a.id} type="button" onClick={() => launch(a.id)} className="flex cursor-pointer items-center gap-3 rounded-[9px] px-2.5 py-[7px] text-left hover:bg-white/[0.07]">
                          <span aria-hidden="true" className="ws-mark flex size-[30px] items-center justify-center whitespace-nowrap rounded-lg leading-none font-bold text-white" style={{ fontSize: 12, background: tileColor(a) }}>{a.mark}</span>
                          <span className="text-[13px]">{a.name}</span>
                          <span className="ml-auto text-[11px] text-[#8FA3C8]">{a.kind === 'WorkSuite' ? '' : t(`launcher.kind.${a.kind}` as MessageKey)}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-3.5 flex items-center gap-3 border-t border-[rgba(127,178,255,0.1)] bg-[rgba(4,10,26,0.45)] px-[22px] py-3">
              <button type="button" onClick={() => { setLauncher(false); openSettingsAt('Users') }} className="flex cursor-pointer items-center gap-2.5 rounded-[10px] py-1.5 pr-2.5 pl-1.5 text-left hover:bg-white/[0.06]">
                <span aria-hidden="true" className="flex size-[34px] items-center justify-center rounded-full bg-[linear-gradient(135deg,#1F6BFF,#18D4F0)] text-xs font-semibold">{initials(name)}</span>
                <span className="flex flex-col"><span className="text-[13px] font-semibold">{name}</span><span className="text-[11px] text-[#8FA3C8]">{device?.org_name ?? user}</span></span>
              </button>
              <span className="ml-auto flex gap-1.5">
                {([['files', t('files.title'), () => { setLauncher(false); onOpen('files') }], ['settings', t('launcher.settings'), () => { setLauncher(false); onOpen('settings') }],
                  ['lock', t('quick.lock'), () => { setLauncher(false); onLock() }], ['power', t('launcher.powerMenu'), () => { setLauncher(false); setPowerOpen(true) }]] as const).map(([k, label, run]) => (
                  <button key={k} type="button" aria-label={label} title={label} aria-haspopup={k === 'power' ? 'menu' : undefined} onClick={run}
                    className="flex size-[38px] cursor-pointer items-center justify-center rounded-[10px] bg-white/[0.05] hover:bg-white/[0.12]"><Icon d={[FOOT_ICONS[k]]} size={18} stroke="#C9D6EE" /></button>
                ))}
              </span>
            </div>
          </div>
        </div>
      )}

      {assistant && <Assistant onClose={() => setAssistant(false)} onOpenSettings={() => { setAssistant(false); openSettingsAt('AI') }} request={assistantReq} onRequestHandled={() => setAssistantReq(null)} />}

      {qsOpen && (
        <QuickPanel state={quick} refresh={refreshQuick} dnd={dnd} setDnd={(v) => { setDnd(v); if (v) setToast(null) }} onClose={() => setQsOpen(false)}
          onSettings={() => { setQsOpen(false); onOpen('settings') }} onLock={() => { setQsOpen(false); onLock() }} onPower={() => { setQsOpen(false); setPowerOpen(true) }} />
      )}

      <nav aria-label={t('panel.taskbar')} className="ws-taskbar absolute inset-x-0 bottom-0 z-40 box-border flex h-[52px] items-center gap-1.5 border-t border-[rgba(127,178,255,0.12)] bg-[rgba(6,14,34,0.88)] px-2.5 text-[#E8EEFA] backdrop-blur-[20px]">
        <button ref={launcherButton} type="button" aria-label={t('panel.openLauncher')} aria-expanded={launcher} aria-controls="ws-launcher" onClick={(e) => { markLauncherRequest(e.timeStamp); setLauncher((v) => !v) }}
          className={`flex size-10 cursor-pointer items-center justify-center rounded-[10px] ${launcher ? 'bg-[rgba(31,107,255,0.5)]' : 'bg-[rgba(31,107,255,0.25)] hover:bg-[rgba(31,107,255,0.4)]'}`}><Mark size={22} hole="#0A1A3D" /></button>
        <button type="button" onClick={() => setLauncher(true)} className="box-border hidden h-9 w-[200px] cursor-text items-center gap-2 rounded-[9px] bg-white/[0.06] px-3 text-[13px] text-[#8FA3C8] hover:bg-white/10 md:flex">
          <Icon d={['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4-4']} size={14} width={2.2} />{t('launcher.search')}
        </button>
        <span aria-hidden="true" className="mx-1 h-6 w-px bg-[rgba(127,178,255,0.15)]" />
        <RunningApps pinned={taskbar.map((a) => a.id)} info={(id) => { const a = allApps.find((x) => x.id === id); return a && { ...a, bg: tileColor(a), fg: '#FFFFFF' } }} onLaunch={launch} only={onPrimary} />
        <div className="ml-auto flex items-center gap-1.5">
          <WorkspaceSwitcher />
          {managed && (
            <button type="button" onClick={() => onOpen('settings')} title={device?.org_name ? t('panel.managedBy', { org: device.org_name }) : undefined}
              className="hidden cursor-pointer rounded-full bg-[rgba(31,107,255,0.25)] px-2.5 py-1 text-xs text-[#C9D6EE] hover:bg-[rgba(31,107,255,0.4)] lg:inline">{managed}</button>
          )}
          <TrayItems />
          <CaptureBadge />
          <VpnBadge onOpen={() => openSettingsAt('VPN')} />
          <UpdateBadge onOpen={() => openSettingsAt('Updates')} />
          <OskButton />
          <button type="button" aria-label={t('ai.open')} title={t('ai.openHint')} aria-expanded={assistant} aria-controls="ws-assistant" onClick={() => { setAssistant((v) => !v); setLauncher(false) }}
            className={`flex size-9 cursor-pointer items-center justify-center rounded-[10px] ${assistant ? 'bg-[rgba(31,107,255,0.4)]' : 'hover:bg-white/10'}`}><Icon d={[AI_ICON]} size={18} /></button>
          <button type="button" aria-label={t('a11y.button')} aria-haspopup="dialog" aria-expanded={a11yOpen} onClick={() => { setA11yOpen((v) => !v); setTrayOpen(false); setPowerOpen(false); setQsOpen(false) }}
            className="flex size-9 cursor-pointer items-center justify-center rounded-[10px] hover:bg-white/10"><Icon d={P.a11y} size={18}><circle cx="12" cy="4.5" r="1.5" /></Icon></button>
          <QuickTray state={quick} open={qsOpen} onToggle={() => { setQsOpen((v) => !v); setTrayOpen(false); setPowerOpen(false); setA11yOpen(false) }} />
          <time dateTime={now.toISOString()} className="flex flex-col items-end px-2 text-xs leading-[1.25]"><span>{time}</span><span className="text-[#8FA3C8]">{shortDate}</span></time>
          <button type="button" aria-label={unread > 0 ? `${t('notes.title')}, ${t('panel.newCount', { count: unread })}` : t('notes.title')} aria-expanded={trayOpen} aria-controls="ws-notifications"
            onClick={() => { setTrayOpen((v) => !v); setUnread(0); setPowerOpen(false); setQsOpen(false) }}
            className={`relative flex size-9 cursor-pointer items-center justify-center rounded-[10px] ${trayOpen ? 'bg-white/20' : 'hover:bg-white/10'}`}>
            <Icon d={dnd ? MOON : P.bell} size={18} />
            {unread > 0 && <span aria-hidden="true" className="absolute top-[5px] right-[5px] size-2 rounded-full bg-[#18D4F0]" />}
          </button>
        </div>
      </nav>
      {powerOpen && (
        <PowerMenu user={name} className="right-3 bottom-16" onClose={() => setPowerOpen(false)}
          onLock={onLock} onSignOut={onLogout} onShutdown={() => setConfirmShutdown(true)} />
      )}
      {confirmShutdown && <ShutdownConfirm onCancel={() => setConfirmShutdown(false)} />}
      {a11yOpen && <A11yPanel className="right-4 bottom-[68px]" onClose={() => setA11yOpen(false)} />}
    </div>
  )
}

function initials(name: string) {
  const w = name.split(/[\s._-]+/).filter(Boolean)
  return ((w[0]?.[0] ?? '') + (w[1]?.[0] ?? '')).toUpperCase() || '?'
}

