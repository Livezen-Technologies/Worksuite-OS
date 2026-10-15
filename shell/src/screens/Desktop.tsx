import { Children, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopProps } from './types'
import { managedLabel, os, type DeviceInfo } from '../lib/os'
import BIcon from '../components/BIcon'
import type { Notice } from '../lib/syncNotices'
import { ageLabel } from '../lib/power'
import { BG, Icon, Mark, P } from '../components/Ws'
import { PowerMenu, ShutdownConfirm } from '../components/Power'
import { RunningApps, TrayItems, UpdateBadge, VpnBadge, useLauncherKey } from '../components/PanelItems'
import { useDisplayState, wallpaperFor, windowsOnOutput } from '../lib/displays'
import type { PanelWindow } from '../lib/panel'
import A11yPanel from '../components/A11yPanel'
import { localeTag, useT } from '../i18n'
import { UpdateOverlays } from './Updates'
import { DeviceWatcher } from './Hardware'
import { requestSettingsSection } from '../lib/settingsNav'
import { buildLauncherApps, filterApps, taskbarApps, type LauncherApp } from '../lib/launcher'

const TONE_BG: Record<Notice['tone'], string> = { ok: '#2E9E6A', warn: '#B7791F', error: '#D9452B' }

const SETTINGS_PAGES = ['Wi-Fi and network', 'Bluetooth', 'Displays', 'Sound', 'Power and battery', 'Appearance', 'Accounts', 'Privacy and security', 'Updates', 'Keyboard shortcuts']

const RECENT = [
  { ext: 'XLS', name: 'Q4 budget — Livezen.xlsx', where: 'WorkSuite Cloud › Finance', state: 'Synced', cls: 'bg-[#ecfdf5] text-[#047857]' },
  { ext: 'DOC', name: 'SFCL proposal v3.docx', where: 'WorkSuite Cloud › Tenders', state: 'Uploading', cls: 'bg-[#eff6ff] text-[#1d4ed8]' },
  { ext: 'PDF', name: 'Invoice INV-2026-0418.pdf', where: 'This Computer › Downloads', state: 'Local', cls: 'bg-[#f1f5f9] text-[#334155]' },
]

// Taskbar pins (running windows from the Wayland bridge join them, components/PanelItems.tsx); entries the org hasn't enabled or that aren't installed drop out.
const TASKBAR = ['worksuite-mail', 'worksuite-chat', 'worksuite-drive', 'office', 'firefox-esr']

const TABS = [['all', 'All apps'], ['ws', 'WorkSuite'], ['linux', 'Linux apps'], ['fav', 'Favorites']] as const
type Tab = (typeof TABS)[number][0]

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(t) }, [])
  return now
}

export default function Desktop({ user, onLock, onLogout, onOpen, notes, children }: DesktopProps) {
  const t = useT()
  const now = useClock()
  const [launcher, setLauncher] = useState(false)
  const [a11yOpen, setA11yOpen] = useState(false)
  // Super key from Labwc arrives over lk.worksuite.Shell1 (WSOS-DSK-011).
  useLauncherKey(useCallback((a: 'toggle' | 'show') => setLauncher((v) => (a === 'show' ? true : !v)), []))
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [powerOpen, setPowerOpen] = useState(false)
  const [confirmShutdown, setConfirmShutdown] = useState(false)
  const [workspace, setWorkspace] = useState(1)
  const { notices, setNotices, toast, setToast, unread, setUnread } = notes
  const [trayOpen, setTrayOpen] = useState(false)
  // Do not disturb holds toasts back; notices still collect in the notification center.
  const [dnd, setDnd] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const name = displayName(user) || 'Hasarinda'

  const time = now.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit', hour12: false })
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
      if (e.key === 'Escape') { setPowerOpen(false); setLauncher(false); setTrayOpen(false) }
      else if ((e.key === 'Meta' || e.key === 'OS' || e.key === 'Super') && !e.repeat) setLauncher((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => { if (launcher) searchRef.current?.focus(); else setQuery('') }, [launcher])

  // Start menu list: the org's WorkSuite apps (fallback list when not signed in/offline) and installed XDG apps.
  const [allApps, setAllApps] = useState<LauncherApp[]>(() => buildLauncherApps(null, null, null))
  const appsLoaded = useRef(false)
  useEffect(() => {
    // On start, then again each time the launcher opens (sign-in, installs and org changes show up).
    if (!launcher && appsLoaded.current) return
    appsLoaded.current = true
    let live = true
    void Promise.all([os.webApps().catch(() => null), os.installedApps().catch(() => null)]).then(([w, i]) => {
      if (live) setAllApps(buildLauncherApps(w?.ok ? w.value : null, i?.apps ?? null, i?.office ?? null))
    })
    return () => { live = false }
  }, [launcher])
  const q = query.trim().toLowerCase()
  const apps = useMemo(() => filterApps(allApps, tab, q), [allApps, tab, q])
  const settingsHits = q ? SETTINGS_PAGES.filter((s) => s.toLowerCase().includes(q)) : []
  const recent = q ? RECENT.filter((r) => r.name.toLowerCase().includes(q)) : RECENT

  const launch = (id: string) => {
    setLauncher(false)
    const a = allApps.find((x) => x.id === id)
    if (!a) return
    if ('screen' in a.launch) onOpen(a.launch.screen)
    else if ('office' in a.launch) void os.launchOffice(a.launch.office)
    else void os.launchApp(a.launch.desktop)
  }
  const taskbar = taskbarApps(allApps, TASKBAR)
  // This window is the primary monitor's desktop; other monitors have their own (OutputDesktop, WSOS-DSK-005).
  const display = useDisplayState()
  const primaryOut = display?.layout.primary ?? null
  const onPrimary = useMemo(() => (primaryOut && display ? (ws: PanelWindow[]) => windowsOnOutput(ws, primaryOut, true, display.layout.outputs.filter((o) => o.enabled).map((o) => o.name)) : undefined), [primaryOut, display])

  const openSettingsAt = (section: string) => { requestSettingsSection(section); onOpen('settings') }

  const quick = [
    { label: t('quick.dnd'), d: P.sleep, on: dnd, run: () => { setDnd((v) => !v); if (!dnd) setToast(null) } },
    { label: t('quick.settings'), d: P.settings, on: false, run: () => { setTrayOpen(false); onOpen('settings') } },
    { label: t('quick.lock'), d: P.lock, on: false, run: () => { setTrayOpen(false); onLock() } },
  ]

  return (
    <div className="relative h-full w-full overflow-hidden font-sans text-[#0f172a]" style={{ background: wallpaperFor(display, primaryOut, BG.desktop) }}>
      <div className="absolute top-7 left-8 flex flex-col gap-1.5 text-[#E8EEFA]">
        <div className="text-sm text-[#8FA3C8]">{longDate}</div>
        <div className="text-[44px] font-light tracking-[-1px]">{time}</div>
      </div>

      {/* Work area for open windows, above the taskbar */}
      {children && <div className="absolute inset-x-0 top-0 bottom-14 z-10 px-6 pt-5 pb-5">{children}</div>}

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

      {/* OS updates (U1, U4–U7) and new devices (H1, H2, H6) */}
      <div className="pointer-events-none absolute right-5 bottom-[76px] z-30 flex w-[400px] max-w-[calc(100%-40px)] flex-col gap-2.5">
        <DeviceWatcher onOpenUpdates={() => openSettingsAt('Updates')} onOpenDrivers={() => openSettingsAt('Drivers')} />
        <UpdateOverlays quiet={trayOpen || Children.toArray(children).length > 0} onOpenUpdates={() => openSettingsAt('Updates')} />
      </div>

      {trayOpen && (
        <aside id="ws-notifications" aria-label={t('notes.title')} className="absolute top-3 right-3 bottom-[68px] z-40 flex w-[400px] max-w-[calc(100%-24px)] flex-col gap-3.5 rounded-[20px] border border-[rgba(127,178,255,0.18)] bg-[rgba(10,24,56,0.94)] p-[18px] text-[#E8EEFA] shadow-[0_24px_60px_rgba(0,0,0,0.5)] backdrop-blur-[24px]">
          <div className="grid grid-cols-3 gap-2">
            {quick.map((q) => (
              <button key={q.label} type="button" aria-pressed={q.d === P.sleep ? q.on : undefined} onClick={q.run}
                className={`flex cursor-pointer flex-col gap-2 rounded-xl p-3 text-left ${q.on ? 'bg-[#1F6BFF] text-white' : 'bg-white/[0.06] text-[#E8EEFA] hover:bg-white/10'}`}>
                <Icon d={q.d} size={18} stroke={q.on ? '#FFFFFF' : '#C9D6EE'} />
                <span className="text-xs font-medium">{q.label}</span>
              </button>
            ))}
          </div>
          <div className="mt-1 flex items-center justify-between">
            <h2 className="m-0 text-base font-semibold">{t('notes.title')}</h2>
            {notices.length > 0 && <button type="button" onClick={() => setNotices([])} className="cursor-pointer rounded text-[13px] text-[#7FB2FF] hover:text-[#B8D4FF]">{t('notes.clearAll')}</button>}
          </div>
          <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-2 overflow-auto p-0">
            {notices.length === 0 && (
              <li className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[rgba(31,107,255,0.15)]"><Icon d={P.bell} size={22} stroke="#7FB2FF" /></span>
                <span className="text-sm font-semibold">{t('notes.empty')}</span>
                <span className="max-w-[260px] text-[13px] text-[#8FA3C8]">{t('notes.emptyHint')}</span>
              </li>
            )}
            {notices.map((x) => (
              <li key={x.id} className="flex gap-3 rounded-xl border border-[rgba(127,178,255,0.1)] bg-white/[0.04] p-3">
                <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] text-white" style={{ background: TONE_BG[x.tone] }}><BIcon name={x.tone === 'ok' ? 'check' : 'alert'} size={16} /></span>
                <div className="flex flex-1 flex-col gap-[3px]">
                  <div className="flex justify-between gap-2"><span className="text-[13px] font-semibold">{x.title}</span><span className="text-[11px] text-[#8FA3C8]">{ageLabel(x.at, now.getTime())}</span></div>
                  <span className="text-[13px] leading-[1.4] text-[#C9D6EE]">{x.body}</span>
                </div>
              </li>
            ))}
          </ul>
        </aside>
      )}

      {launcher && (
        <div className="absolute inset-x-0 top-0 bottom-14 z-30 flex items-center justify-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setLauncher(false) }}>
          <div id="ws-launcher" role="dialog" aria-label={t('launcher.title')} className="flex h-[650px] max-h-full w-[720px] max-w-full flex-col overflow-hidden rounded-2xl bg-white shadow-[0_24px_64px_rgba(2,6,23,0.5)]">
            <div className="flex flex-col gap-3.5 px-5 pt-5 pb-3">
              <label className="flex h-11 items-center gap-2.5 rounded-[10px] border border-[#e2e8f0] bg-[#f1f5f9] px-3.5 text-[#475569]">
                <BIcon name="search" />
                <span className="sr-only">{t('launcher.search')}</span>
                <input ref={searchRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('launcher.searchPlaceholder')} className="grow border-0 bg-transparent text-[15px] text-[#0f172a] outline-none" />
                <span aria-hidden="true" className="rounded border border-[#cbd5e1] px-1.5 py-0.5 text-[11px] text-[#475569]">Super</span>
              </label>
              <div role="tablist" aria-label={t('launcher.title')} className="flex gap-1.5">
                {TABS.map(([id]) => (
                  <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                    className={`h-8 rounded-full px-3.5 text-[13px] ${tab === id ? 'bg-[#2563eb] font-semibold text-white' : 'border border-[#e2e8f0] bg-white text-[#334155] hover:bg-[#f8fafc]'}`}>{t(`launcher.tab.${id}`)}</button>
                ))}
              </div>
            </div>

            <div className="min-h-0 grow overflow-auto">
              <div className="px-5 py-1 text-xs font-semibold tracking-[0.06em] text-[#475569] uppercase">{q ? t('launcher.apps') : tab === 'all' ? t('launcher.pinned') : t(`launcher.tab.${tab}`)}</div>
              {apps.length ? (
                <div className="grid grid-cols-6 gap-2 px-5 pt-2 pb-1">
                  {apps.map((a) => (
                    <button key={a.id} type="button" onClick={() => launch(a.id)} className="flex flex-col items-center gap-2 rounded-xl px-1 py-3 hover:bg-[#f1f5f9]">
                      <span className="flex size-12 items-center justify-center rounded-xl text-[17px] font-bold" style={{ background: a.bg, color: a.fg }}>{a.mark}</span>
                      <span className="text-xs text-[#0f172a]">{a.name}</span>
                      <span className="text-[10.5px] text-[#475569]">{a.kind}</span>
                    </button>
                  ))}
                </div>
              ) : <p className="px-5 py-3 text-[13px] text-[#475569]">{t('launcher.noApps')}</p>}

              {settingsHits.length > 0 && (
                <>
                  <div className="px-5 pt-3 pb-1 text-xs font-semibold tracking-[0.06em] text-[#475569] uppercase">{t('launcher.settings')}</div>
                  <div className="flex flex-col px-3 py-1">
                    {settingsHits.map((s) => (
                      <button key={s} type="button" onClick={() => { setLauncher(false); onOpen('settings') }} className="flex h-11 items-center gap-3 rounded-lg px-2 text-left hover:bg-[#f1f5f9]">
                        <span className="flex size-7 items-center justify-center rounded-md bg-[#f1f5f9] text-[#334155]"><BIcon name="settings" size={16} /></span>
                        <span className="grow text-[13px]">{s}</span>
                        <span className="text-xs text-[#475569]">{t('launcher.settings')}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {recent.length > 0 && (
                <>
                  <div className="px-5 pt-3 pb-1 text-xs font-semibold tracking-[0.06em] text-[#475569] uppercase">{t('launcher.recent')}</div>
                  <div className="flex flex-col px-3 py-1">
                    {recent.map((r) => (
                      <button key={r.name} type="button" onClick={() => { setLauncher(false); onOpen('files') }} className="flex h-11 items-center gap-3 rounded-lg px-2 text-left hover:bg-[#f1f5f9]">
                        <span className="flex size-7 items-center justify-center rounded-md bg-[#eff6ff] text-[11px] font-bold text-[#1d4ed8]">{r.ext}</span>
                        <span className="grow text-[13px] text-[#0f172a]">{r.name}</span>
                        <span className="text-xs text-[#475569]">{r.where}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] ${r.cls}`}>{r.state}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="relative flex items-center gap-3 border-t border-[#e2e8f0] bg-[#f8fafc] px-5 py-3">
              <span className="flex size-9 items-center justify-center rounded-full bg-[#1e3a8a] text-sm font-semibold text-white">{name[0]?.toUpperCase()}</span>
              <div className="flex grow flex-col gap-px">
                <span className="text-[13px] font-semibold">{name}</span>
                <span className="text-xs text-[#475569]">Livezen Technologies · Enterprise · Synced 1 min ago</span>
              </div>
              <button type="button" aria-label={t('launcher.appCenter')} onClick={() => launch('appcenter')} className="flex size-10 items-center justify-center rounded-[10px] border border-[#e2e8f0] bg-white text-[#334155] hover:bg-[#f1f5f9]"><BIcon name="grid" /></button>
              <button type="button" aria-label={t('launcher.settings')} onClick={() => { setLauncher(false); onOpen('settings') }} className="flex size-10 items-center justify-center rounded-[10px] border border-[#e2e8f0] bg-white text-[#334155] hover:bg-[#f1f5f9]"><BIcon name="settings" /></button>
              <button type="button" aria-label={t('quick.lock')} onClick={() => { setLauncher(false); onLock() }} className="flex size-10 items-center justify-center rounded-[10px] border border-[#e2e8f0] bg-white text-[#334155] hover:bg-[#f1f5f9]"><BIcon name="lock" /></button>
              <button type="button" aria-label={t('launcher.powerMenu')} aria-haspopup="menu" onClick={() => { setLauncher(false); setPowerOpen(true) }} className="flex size-10 items-center justify-center rounded-[10px] border border-[#e2e8f0] bg-white text-[#b91c1c] hover:bg-[#fef2f2]"><BIcon name="power" /></button>
            </div>
          </div>
        </div>
      )}

      <nav aria-label={t('panel.taskbar')} className="absolute inset-x-0 bottom-0 z-40 flex h-14 items-center gap-2 border-t border-[rgba(127,178,255,0.12)] bg-[rgba(6,14,34,0.82)] px-4 text-[#E8EEFA] backdrop-blur-[20px]">
        <button type="button" aria-label={t('panel.openLauncher')} aria-expanded={launcher} aria-controls="ws-launcher" onClick={() => setLauncher((v) => !v)}
          className={`flex size-10 cursor-pointer items-center justify-center rounded-[10px] ${launcher ? 'bg-[rgba(31,107,255,0.45)] ring-2 ring-[#1F6BFF]' : 'bg-[rgba(31,107,255,0.25)] hover:bg-[rgba(31,107,255,0.4)]'}`}><Mark size={22} hole="#0A1A3D" /></button>
        <RunningApps pinned={taskbar.map((a) => a.id)} info={(id) => allApps.find((a) => a.id === id)} onLaunch={launch} only={onPrimary} />
        <div role="group" aria-label={t('panel.workspaces')} className="ml-4 hidden gap-1 sm:flex">
          {[1, 2, 3].map((n) => (
            <button key={n} type="button" aria-label={t('panel.workspace', { n })} aria-pressed={workspace === n} onClick={() => setWorkspace(n)}
              className={`h-7 min-w-7 cursor-pointer rounded-md text-xs ${workspace === n ? 'bg-white/[0.14] text-white' : 'text-[#8FA3C8] hover:bg-white/10'}`}>{n}</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {managed && (
            <button type="button" onClick={() => onOpen('settings')} title={device?.org_name ? t('panel.managedBy', { org: device.org_name }) : undefined}
              className="hidden cursor-pointer rounded-full bg-[rgba(31,107,255,0.25)] px-2.5 py-1 text-xs text-[#C9D6EE] hover:bg-[rgba(31,107,255,0.4)] lg:inline">{managed}</button>
          )}
          <TrayItems />
          <VpnBadge onOpen={() => openSettingsAt('Network')} />
          <UpdateBadge onOpen={() => openSettingsAt('Updates')} />
          <button type="button" aria-label={t('a11y.button')} aria-haspopup="dialog" aria-expanded={a11yOpen} onClick={() => { setA11yOpen((v) => !v); setTrayOpen(false); setPowerOpen(false) }}
            className="flex size-10 cursor-pointer items-center justify-center rounded-[10px] bg-white/[0.12] hover:bg-white/20"><Icon d={P.a11y} size={18}><circle cx="12" cy="4.5" r="1.5" /></Icon></button>
          <button type="button" aria-label={t('panel.notifications')} aria-expanded={trayOpen} aria-controls="ws-notifications"
            onClick={() => { setTrayOpen((v) => !v); setUnread(0); setPowerOpen(false) }}
            className={`flex h-10 cursor-pointer items-center gap-2.5 rounded-[10px] px-3 text-[13px] ${trayOpen ? 'bg-white/20' : 'bg-white/[0.12] hover:bg-white/20'}`}>
            <time dateTime={now.toISOString()} title={shortDate}>{time}</time>
            {unread > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-[10px] bg-[#1F6BFF] px-1.5 text-[11px] font-bold" aria-label={t('panel.newCount', { count: unread })}>{unread}</span>}
          </button>
          <button type="button" aria-label={t('panel.power')} aria-haspopup="menu" aria-expanded={powerOpen} data-power-toggle onClick={() => { setPowerOpen((v) => !v); setTrayOpen(false) }}
            className="flex size-10 cursor-pointer items-center justify-center rounded-[10px] bg-white/[0.12] shadow-[inset_0_0_0_1px_rgba(127,178,255,0.4)] hover:bg-white/20"><Icon d={P.power} size={18} /></button>
        </div>
      </nav>
      {powerOpen && (
        <PowerMenu user={name} className="right-4 bottom-[68px]" onClose={() => setPowerOpen(false)}
          onLock={onLock} onSignOut={onLogout} onShutdown={() => setConfirmShutdown(true)} />
      )}
      {confirmShutdown && <ShutdownConfirm onCancel={() => setConfirmShutdown(false)} />}
      {a11yOpen && <A11yPanel className="right-4 bottom-[68px]" onClose={() => setA11yOpen(false)} />}
    </div>
  )
}

// Login names arrive as user, user@domain or DOMAIN\user; show the bare name capitalised.
function displayName(login: string) {
  const bare = login.split('\\').pop()!.split('@')[0]
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}
