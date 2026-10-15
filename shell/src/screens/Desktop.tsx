import { useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopProps } from './types'
import { managedLabel, os, type DeviceInfo } from '../lib/os'
import BIcon from '../components/BIcon'
import { LogoMark } from '../components/Logo'

type Kind = 'WorkSuite' | 'Linux app' | 'System'
interface App { id: string; name: string; mark: string; bg: string; fg: string; kind: Kind; fav?: boolean }

const ws = (id: string, name: string, mark: string, bg: string, fg: string, fav = false): App => ({ id, name, mark, bg, fg, kind: 'WorkSuite', fav })
const lx = (id: string, name: string, mark: string, bg: string, fg: string, fav = false): App => ({ id, name, mark, bg, fg, kind: 'Linux app', fav })

const APPS: App[] = [
  ws('mail', 'Mail', 'M', '#dbeafe', '#1d4ed8', true),
  ws('calendar', 'Calendar', 'C', '#e0e7ff', '#4338ca', true),
  ws('chat', 'Chat', 'Ch', '#dcfce7', '#15803d', true),
  ws('drive', 'Drive', 'D', '#e0f2fe', '#0369a1', true),
  ws('tasks', 'Tasks', 'T', '#fef3c7', '#b45309'),
  ws('projects', 'Projects', 'P', '#fae8ff', '#a21caf'),
  ws('crm', 'CRM', 'CR', '#ffe4e6', '#be123c'),
  ws('meet', 'Meet', 'Me', '#ccfbf1', '#0f766e'),
  ws('office', 'Office', 'O', '#ffedd5', '#c2410c', true),
  ws('pdf-studio', 'PDF Studio', 'PDF', '#fee2e2', '#b91c1c'),
  lx('firefox', 'Firefox', 'Fx', '#f1f5f9', '#334155', true),
  lx('terminal', 'Terminal', '>_', '#0f172a', '#e2e8f0'),
  { id: 'appcenter', name: 'App Center', mark: 'A', bg: '#2563eb', fg: '#ffffff', kind: 'System' },
]

const SETTINGS_PAGES = ['Wi-Fi and network', 'Bluetooth', 'Displays', 'Sound', 'Power and battery', 'Appearance', 'Accounts', 'Privacy and security', 'Updates', 'Keyboard shortcuts']

const RECENT = [
  { ext: 'XLS', name: 'Q4 budget — Livezen.xlsx', where: 'WorkSuite Cloud › Finance', state: 'Synced', cls: 'bg-[#ecfdf5] text-[#047857]' },
  { ext: 'DOC', name: 'SFCL proposal v3.docx', where: 'WorkSuite Cloud › Tenders', state: 'Uploading', cls: 'bg-[#eff6ff] text-[#1d4ed8]' },
  { ext: 'PDF', name: 'Invoice INV-2026-0418.pdf', where: 'This Computer › Downloads', state: 'Local', cls: 'bg-[#f1f5f9] text-[#334155]' },
]

const TASKBAR = [
  { id: 'mail', running: true, active: true },
  { id: 'chat', running: true },
  { id: 'drive' },
  { id: 'office', running: true },
  { id: 'firefox' },
  { id: 'terminal' },
] as { id: string; running?: boolean; active?: boolean }[]

const TABS = [['all', 'All apps'], ['ws', 'WorkSuite'], ['linux', 'Linux apps'], ['fav', 'Favorites']] as const
type Tab = (typeof TABS)[number][0]

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(t) }, [])
  return now
}

export default function Desktop({ user, onLock, onLogout, onOpen, children }: DesktopProps) {
  const now = useClock()
  const [launcher, setLauncher] = useState(false)
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [powerOpen, setPowerOpen] = useState(false)
  const [workspace, setWorkspace] = useState(1)
  const [toast, setToast] = useState(true)
  const searchRef = useRef<HTMLInputElement>(null)
  const name = displayName(user) || 'Hasarinda'

  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const longDate = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
  const shortDate = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')

  useEffect(() => { const t = setTimeout(() => setToast(false), 8000); return () => clearTimeout(t) }, [])

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
      if (e.key === 'Escape') { setPowerOpen(false); setLauncher(false) }
      else if ((e.key === 'Meta' || e.key === 'OS' || e.key === 'Super') && !e.repeat) setLauncher((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => { if (launcher) searchRef.current?.focus(); else { setQuery(''); setPowerOpen(false) } }, [launcher])

  const q = query.trim().toLowerCase()
  const apps = useMemo(() => APPS.filter((a) => {
    if (tab === 'ws' && a.kind !== 'WorkSuite') return false
    if (tab === 'linux' && a.kind !== 'Linux app') return false
    if (tab === 'fav' && !a.fav) return false
    // App Center lives in the footer; it joins the grid only as a search hit so Recent stays visible.
    if (!q) return a.id !== 'appcenter'
    return a.name.toLowerCase().includes(q)
  }), [tab, q])
  const settingsHits = q ? SETTINGS_PAGES.filter((s) => s.toLowerCase().includes(q)) : []
  const recent = q ? RECENT.filter((r) => r.name.toLowerCase().includes(q)) : RECENT

  const launch = (id: string) => {
    setLauncher(false)
    if (id === 'drive') onOpen('files')
    else if (id === 'appcenter') onOpen('appcenter')
    else void os.launchApp(id)
  }
  const byId = (id: string) => APPS.find((a) => a.id === id)!

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#172033] font-sans text-[#0f172a]">
      <svg aria-hidden="true" className="absolute inset-0 h-full w-full" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
        <circle cx="1180" cy="180" r="420" fill="none" stroke="#24314a" />
        <circle cx="1180" cy="180" r="300" fill="none" stroke="#24314a" />
        <circle cx="1180" cy="180" r="180" fill="none" stroke="#2b3a56" />
        <circle cx="220" cy="820" r="360" fill="none" stroke="#1e2a40" />
      </svg>

      <div className="absolute top-7 left-8 flex flex-col gap-1.5 text-[#e2e8f0]">
        <div className="text-sm text-[#94a3b8]">{longDate}</div>
        <div className="text-[44px] font-light tracking-[-1px]">{time}</div>
      </div>

      {/* Work area for open windows, above the taskbar */}
      {children && <div className="absolute inset-x-0 top-0 bottom-14 z-10 px-6 pt-5 pb-5">{children}</div>}

      {toast && (
        <div role="status" className="absolute top-6 right-6 z-20 flex w-[340px] items-start gap-3 rounded-xl bg-white px-4 py-3.5 shadow-[0_12px_32px_rgba(2,6,23,0.35)]">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#ecfdf5] text-[#047857]"><BIcon name="check" /></div>
          <div className="flex grow flex-col gap-0.5">
            <div className="text-[13px] font-semibold">Back online — 14 changes synced</div>
            <div className="text-xs text-[#475569]">Offline edits in Tasks and CRM reached the server. No conflicts.</div>
          </div>
          <button type="button" aria-label="Dismiss notification" onClick={() => setToast(false)} className="text-[#475569] hover:text-[#0f172a]"><BIcon name="close" size={14} /></button>
        </div>
      )}

      {launcher && (
        <div className="absolute inset-x-0 top-0 bottom-14 z-30 flex items-center justify-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setLauncher(false) }}>
          <div id="ws-launcher" role="dialog" aria-label="Launcher" className="flex h-[650px] max-h-full w-[720px] max-w-full flex-col overflow-hidden rounded-2xl bg-white shadow-[0_24px_64px_rgba(2,6,23,0.5)]">
            <div className="flex flex-col gap-3.5 px-5 pt-5 pb-3">
              <label className="flex h-11 items-center gap-2.5 rounded-[10px] border border-[#e2e8f0] bg-[#f1f5f9] px-3.5 text-[#475569]">
                <BIcon name="search" />
                <span className="sr-only">Search</span>
                <input ref={searchRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search apps, files, records and settings" className="grow border-0 bg-transparent text-[15px] text-[#0f172a] outline-none" />
                <span className="rounded border border-[#cbd5e1] px-1.5 py-0.5 text-[11px] text-[#475569]">Super</span>
              </label>
              <div role="tablist" className="flex gap-1.5">
                {TABS.map(([id, label]) => (
                  <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                    className={`h-8 rounded-full px-3.5 text-[13px] ${tab === id ? 'bg-[#2563eb] font-semibold text-white' : 'border border-[#e2e8f0] bg-white text-[#334155] hover:bg-[#f8fafc]'}`}>{label}</button>
                ))}
              </div>
            </div>

            <div className="min-h-0 grow overflow-auto">
              <div className="px-5 py-1 text-xs font-semibold tracking-[0.06em] text-[#475569] uppercase">{q ? 'Apps' : tab === 'all' ? 'Pinned' : TABS.find((t) => t[0] === tab)![1]}</div>
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
              ) : <p className="px-5 py-3 text-[13px] text-[#475569]">No apps match.</p>}

              {settingsHits.length > 0 && (
                <>
                  <div className="px-5 pt-3 pb-1 text-xs font-semibold tracking-[0.06em] text-[#475569] uppercase">Settings</div>
                  <div className="flex flex-col px-3 py-1">
                    {settingsHits.map((s) => (
                      <button key={s} type="button" onClick={() => { setLauncher(false); onOpen('settings') }} className="flex h-11 items-center gap-3 rounded-lg px-2 text-left hover:bg-[#f1f5f9]">
                        <span className="flex size-7 items-center justify-center rounded-md bg-[#f1f5f9] text-[#334155]"><BIcon name="settings" size={16} /></span>
                        <span className="grow text-[13px]">{s}</span>
                        <span className="text-xs text-[#475569]">Settings</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {recent.length > 0 && (
                <>
                  <div className="px-5 pt-3 pb-1 text-xs font-semibold tracking-[0.06em] text-[#475569] uppercase">Recent</div>
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
              <button type="button" aria-label="App Center" onClick={() => launch('appcenter')} className="flex size-10 items-center justify-center rounded-[10px] border border-[#e2e8f0] bg-white text-[#334155] hover:bg-[#f1f5f9]"><BIcon name="grid" /></button>
              <button type="button" aria-label="Settings" onClick={() => { setLauncher(false); onOpen('settings') }} className="flex size-10 items-center justify-center rounded-[10px] border border-[#e2e8f0] bg-white text-[#334155] hover:bg-[#f1f5f9]"><BIcon name="settings" /></button>
              <button type="button" aria-label="Lock" onClick={() => { setLauncher(false); onLock() }} className="flex size-10 items-center justify-center rounded-[10px] border border-[#e2e8f0] bg-white text-[#334155] hover:bg-[#f1f5f9]"><BIcon name="lock" /></button>
              <button type="button" aria-label="Power menu" aria-haspopup="menu" aria-expanded={powerOpen} onClick={() => setPowerOpen((v) => !v)} className="flex size-10 items-center justify-center rounded-[10px] border border-[#e2e8f0] bg-white text-[#b91c1c] hover:bg-[#fef2f2]"><BIcon name="power" /></button>
              {powerOpen && (
                <div role="menu" aria-label="Power" className="absolute right-5 bottom-[60px] flex w-48 flex-col rounded-xl border border-[#e2e8f0] bg-white p-1.5 shadow-[0_12px_32px_rgba(2,6,23,0.25)]">
                  <button type="button" role="menuitem" onClick={onLogout} className="h-9 rounded-lg px-3 text-left text-[13px] hover:bg-[#f1f5f9]">Log out</button>
                  <button type="button" role="menuitem" onClick={() => { setPowerOpen(false); void os.power('suspend') }} className="h-9 rounded-lg px-3 text-left text-[13px] hover:bg-[#f1f5f9]">Suspend</button>
                  <button type="button" role="menuitem" onClick={() => { setPowerOpen(false); void os.power('restart') }} className="h-9 rounded-lg px-3 text-left text-[13px] hover:bg-[#f1f5f9]">Restart</button>
                  <button type="button" role="menuitem" onClick={() => { setPowerOpen(false); void os.power('shutdown') }} className="h-9 rounded-lg px-3 text-left text-[13px] text-[#b91c1c] hover:bg-[#fef2f2]">Shut down</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <nav aria-label="Taskbar" className="absolute inset-x-0 bottom-0 z-40 flex h-14 items-center gap-1.5 border-t border-[#24314a] bg-[rgba(15,23,42,0.94)] px-3 text-[#e2e8f0]">
        <button type="button" aria-label="Open launcher" aria-expanded={launcher} aria-controls="ws-launcher" onClick={() => setLauncher((v) => !v)}
          className={`flex size-11 items-center justify-center rounded-[10px] ${launcher ? 'bg-[#334155] ring-2 ring-[#0A6CFF]' : 'bg-[#1e293b] hover:bg-[#334155]'}`}><LogoMark onDark height={30} /></button>
        <div className="mx-1.5 h-7 w-px bg-[#334155]" />
        {TASKBAR.map((t) => {
          const a = byId(t.id)
          return (
            <button key={t.id} type="button" aria-label={`${a.name}${t.running ? ', running' : ''}`} onClick={() => launch(t.id)}
              className={`relative flex size-11 items-center justify-center rounded-[10px] ${t.active ? 'bg-[#1e293b]' : 'hover:bg-[#1e293b]'}`}>
              <span className="flex size-[30px] items-center justify-center rounded-lg text-xs font-bold" style={{ background: a.bg, color: a.fg }}>{a.mark}</span>
              {t.running && <span className={`absolute bottom-[3px] h-[3px] rounded-sm bg-[#60a5fa] ${t.active ? 'w-3.5' : 'w-1.5'}`} />}
            </button>
          )
        })}
        <div role="group" aria-label="Workspaces" className="ml-4 hidden gap-1 sm:flex">
          {[1, 2, 3].map((n) => (
            <button key={n} type="button" aria-label={`Workspace ${n}`} aria-pressed={workspace === n} onClick={() => setWorkspace(n)}
              className={`h-7 min-w-7 rounded-md text-xs ${workspace === n ? 'bg-[#334155] text-[#f8fafc]' : 'text-[#94a3b8] hover:bg-[#1e293b]'}`}>{n}</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {managed && (
            <button type="button" onClick={() => onOpen('settings')} title={device?.org_name ? `Managed by ${device.org_name}` : undefined}
              className="hidden rounded-full bg-[#1e3a8a] px-2.5 py-1 text-xs text-[#dbeafe] hover:bg-[#1e40af] lg:inline">{managed}</button>
          )}
          <button type="button" aria-label="Network: Livezen-Office, connected" className="flex size-10 items-center justify-center rounded-lg hover:bg-[#1e293b]"><BIcon name="wifi" /></button>
          <button type="button" aria-label="Volume 60 percent" className="flex size-10 items-center justify-center rounded-lg hover:bg-[#1e293b]"><BIcon name="volume" /></button>
          <button type="button" aria-label="Battery 82 percent" className="flex h-10 items-center gap-1.5 rounded-lg px-2 text-xs hover:bg-[#1e293b]"><BIcon name="battery" />82%</button>
          <button type="button" aria-label="Notifications, 3 new" className="relative flex size-10 items-center justify-center rounded-lg hover:bg-[#1e293b]">
            <BIcon name="bell" />
            <span className="absolute top-1.5 right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#dc2626] text-[10px] text-white">3</span>
          </button>
          <div className="flex flex-col items-end pr-2 pl-2.5 text-xs leading-[1.3]">
            <span className="text-[#f8fafc]">{time}</span>
            <span className="text-[#94a3b8]">{shortDate}</span>
          </div>
        </div>
      </nav>
    </div>
  )
}

// Login names arrive as user, user@domain or DOMAIN\user; show the bare name capitalised.
function displayName(login: string) {
  const bare = login.split('\\').pop()!.split('@')[0]
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}
