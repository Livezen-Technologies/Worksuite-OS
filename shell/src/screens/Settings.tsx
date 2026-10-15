import { useEffect, useState } from 'react'
import { cloudErrorText, os, type CloudAccount } from '../lib/os'
import type { WindowProps } from './types'
import CIcon from '../components/CIcon'

const SECTIONS = ['Network', 'Bluetooth', 'Displays', 'Sound', 'Power', 'Printers', 'Apps', 'Accounts', 'Privacy', 'Updates', 'About this device'] as const
type Section = (typeof SECTIONS)[number]

type UpdateState = 'idle' | 'checking' | 'downloading' | 'ready' | 'scheduled' | 'restarting'

const card = 'rounded-[14px] border border-ws-line bg-ws-surface'

function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-ws-accent' : 'bg-slate-300'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  )
}

function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-b border-ws-line/60 px-5 py-3.5 last:border-b-0">
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <span className="text-sm font-semibold">{label}</span>
        {help && <span className="text-[12.5px] text-ws-muted">{help}</span>}
      </div>
      {children}
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 grow flex-col gap-4">
      <h1 className="m-0 text-2xl font-[650]">{title}</h1>
      {children}
    </section>
  )
}

function SimplePanel({ section }: { section: Section }) {
  const [t, setT] = useState<Record<string, boolean>>({ wifi: true, bt: false, night: false, mute: false, saver: false, loc: false, diag: true })
  const set = (k: string) => (v: boolean) => setT((s) => ({ ...s, [k]: v }))
  const [vol, setVol] = useState(60)
  const [bright, setBright] = useState(80)
  switch (section) {
    case 'Network':
      return <Panel title="Network"><div className={card}>
        <Row label="Wi-Fi" help="Connected to LIVEZEN-CORP · WPA2-Enterprise"><Toggle label="Wi-Fi" checked={t.wifi} onChange={set('wifi')} /></Row>
        <Row label="Ethernet" help="Cable unplugged"><span className="text-[13.5px] text-ws-muted">Disconnected</span></Row>
        <Row label="VPN" help="Managed by your organization"><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">Set by policy</span></Row>
      </div></Panel>
    case 'Bluetooth':
      return <Panel title="Bluetooth"><div className={card}>
        <Row label="Bluetooth" help={t.bt ? 'Discoverable as LZT-LAP-0142' : 'Off'}><Toggle label="Bluetooth" checked={t.bt} onChange={set('bt')} /></Row>
        <Row label="Paired devices" help="Logitech MX Keys"><span className="text-[13.5px] text-ws-muted">{t.bt ? 'Connected' : 'Not connected'}</span></Row>
      </div></Panel>
    case 'Displays':
      return <Panel title="Displays"><div className={card}>
        <Row label="Built-in display" help="1920 × 1200 · 100%"><span className="text-[13.5px]">Primary</span></Row>
        <Row label="Brightness"><input aria-label="Brightness" type="range" min={0} max={100} value={bright} onChange={(e) => setBright(+e.target.value)} className="w-48 accent-ws-accent" /></Row>
        <Row label="Night light" help="Warmer colors after sunset"><Toggle label="Night light" checked={t.night} onChange={set('night')} /></Row>
      </div></Panel>
    case 'Sound':
      return <Panel title="Sound"><div className={card}>
        <Row label="Output" help="Built-in speakers"><input aria-label="Volume" type="range" min={0} max={100} value={vol} onChange={(e) => setVol(+e.target.value)} className="w-48 accent-ws-accent" /></Row>
        <Row label="Mute"><Toggle label="Mute" checked={t.mute} onChange={set('mute')} /></Row>
        <Row label="Input" help="Built-in microphone"><span className="text-[13.5px] text-ws-muted">Default</span></Row>
      </div></Panel>
    case 'Power':
      return <Panel title="Power"><div className={card}>
        <Row label="Battery" help="Charging · about 1 h 20 min to full"><span className="text-[13.5px]">74%</span></Row>
        <Row label="Power saver" help="Reduce background activity"><Toggle label="Power saver" checked={t.saver} onChange={set('saver')} /></Row>
        <Row label="Screen lock" help="Locks after 5 min idle"><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">Set by policy</span></Row>
      </div></Panel>
    case 'Printers':
      return <Panel title="Printers"><div className={card}>
        <Row label="HP LaserJet M507 — Floor 3" help="Network printer · shared by IT"><span className="text-[13.5px]">Default</span></Row>
        <Row label="Add a printer" help="Only printers approved by your organization can be added"><button type="button" className="h-9 rounded-lg border border-slate-300 bg-ws-surface px-3 text-sm">Add…</button></Row>
      </div></Panel>
    case 'Apps':
      return <Panel title="Apps"><div className={card}>
        {['Firefox ESR', 'WorkSuite Office', 'Files', 'Terminal'].map((a) => <Row key={a} label={a} help="Approved by your organization"><span className="text-[13.5px] text-ws-muted">Installed</span></Row>)}
      </div></Panel>
    case 'Accounts':
      return <Panel title="Accounts"><div className={card}>
        <CloudAccounts />
        <Row label="Offline sign-in" help="Allowed for 7 days without network"><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">Set by policy</span></Row>
      </div></Panel>
    case 'Privacy':
      return <Panel title="Privacy"><div className={card}>
        <Row label="Location services"><Toggle label="Location services" checked={t.loc} onChange={set('loc')} /></Row>
        <Row label="Send diagnostics" help="Crash reports go to your IT team"><Toggle label="Send diagnostics" checked={t.diag} onChange={set('diag')} /></Row>
        <Row label="Monitoring" help="No keylogging, camera access or remote shell by your organization"><span className="text-[13.5px] text-ws-muted">None</span></Row>
      </div></Panel>
    default:
      return null
  }
}

const POLICY_ROWS = [
  { label: 'Update source', help: 'Signed APT repository and release manifest', value: 'download.worksuitecloud.com' },
  { label: 'Update mode', help: 'Download in background, install when idle or in the window', value: 'Automatic' },
  { label: 'Ring', help: 'Pilot devices get releases before Stable', value: 'Pilot' },
  { label: 'Maintenance window', help: 'Restarts happen only in this window unless critical', value: 'Daily 22:00–02:00' },
]
const HISTORY = [
  { date: '15 Oct 09:31', name: 'WorkSuite OS 1.0.3 (security)', src: 'download.worksuitecloud.com', ok: false },
  { date: '08 Oct 22:14', name: 'WorkSuite Desktop shell 1.0.2', src: 'download.worksuitecloud.com', ok: true },
  { date: '01 Oct 22:05', name: 'Debian kernel 6.12.48', src: 'Debian trixie (pinned)', ok: true },
]

function Updates() {
  const [state, setState] = useState<UpdateState>('ready')
  const [deferrals, setDeferrals] = useState(2)
  const [metered, setMetered] = useState(true)
  const [pct, setPct] = useState(0)

  const check = () => {
    setState('checking')
    setTimeout(() => setState('ready'), 1200)
  }
  const download = () => {
    setState('downloading'); setPct(0)
    let p = 0
    const id = setInterval(() => { p += 20; setPct(p); if (p >= 100) { clearInterval(id); setState('ready') } }, 300)
  }
  const schedule = () => { setState('scheduled'); setDeferrals((d) => Math.max(0, d - 1)) }

  const status = {
    idle: { title: 'WorkSuite OS is up to date', sub: 'Last checked today at 09:31 · Pilot ring' },
    checking: { title: 'Checking for updates…', sub: 'Contacting download.worksuitecloud.com' },
    downloading: { title: `Downloading WorkSuite OS 1.0.3 — ${pct}%`, sub: 'Verifying signature after download' },
    ready: { title: 'WorkSuite OS 1.0.3 is ready — restart to finish', sub: `Downloaded from download.worksuitecloud.com · signature verified · security update · restart required by Fri 17 Oct, 18:00 (${deferrals} deferral${deferrals === 1 ? '' : 's'} left)` },
    scheduled: { title: 'Restart scheduled tonight at 22:00', sub: `WorkSuite OS 1.0.3 installs in the maintenance window · ${deferrals} deferral${deferrals === 1 ? '' : 's'} left` },
    restarting: { title: 'Restarting to install WorkSuite OS 1.0.3…', sub: 'Save your work — apps will close' },
  }[state]

  const btn = 'h-[42px] rounded-[10px] px-4 text-sm'
  return (
    <Panel title="Updates">
      <div className={`${card} flex items-center gap-4 p-5`} aria-live="polite">
        <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700 ${state === 'checking' ? 'animate-spin' : ''}`}><CIcon name="refresh" size={24} /></span>
        <div className="flex min-w-0 grow flex-col gap-1">
          <div className="text-base font-semibold">{status.title}</div>
          <div className="text-[13px] text-ws-muted">{status.sub}</div>
          {state === 'downloading' && <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Download progress"><div className="h-full bg-ws-accent transition-all" style={{ width: `${pct}%` }} /></div>}
        </div>
        {state === 'idle' && <button type="button" onClick={check} className={`${btn} border border-slate-300 bg-ws-surface text-slate-700`}>Check for updates</button>}
        {state === 'ready' && <>
          <button type="button" onClick={schedule} disabled={deferrals === 0} className={`${btn} border border-slate-300 bg-ws-surface text-slate-700 disabled:opacity-50`}>Tonight at 22:00</button>
          <button type="button" onClick={() => setState('restarting')} className={`${btn} bg-ws-accent px-[18px] font-semibold text-white hover:bg-ws-accent-strong`}>Restart now</button>
        </>}
        {state === 'scheduled' && <>
          <button type="button" onClick={() => setState('ready')} className={`${btn} border border-slate-300 bg-ws-surface text-slate-700`}>Change</button>
          <button type="button" onClick={() => setState('restarting')} className={`${btn} bg-ws-accent px-[18px] font-semibold text-white`}>Restart now</button>
        </>}
      </div>

      <div className={`${card} flex flex-col`}>
        {POLICY_ROWS.map((r) => (
          <Row key={r.label} label={r.label} help={r.help}>
            <span className="text-[13.5px]">{r.value}</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">Set by policy</span>
          </Row>
        ))}
        <Row label="Metered connections" help="Pause non-critical downloads on mobile data">
          <span className="text-[13.5px]">{metered ? 'Paused' : 'Allowed'}</span>
          <Toggle label="Pause downloads on metered connections" checked={metered} onChange={setMetered} />
        </Row>
      </div>

      <div className={`${card} flex flex-col gap-2.5 px-5 py-4`}>
        <div className="flex items-center"><span className="text-sm font-semibold">Update history</span>
          <button type="button" onClick={download} className="ml-auto text-[13px] text-ws-accent hover:text-ws-accent-strong">Install from USB bundle…</button></div>
        <table className="w-full border-collapse text-[13px]">
          <thead><tr className="text-left text-xs text-ws-muted"><th className="py-1.5 font-semibold">Date</th><th className="py-1.5 font-semibold">Update</th><th className="py-1.5 font-semibold">Source</th><th className="py-1.5 font-semibold">Result</th></tr></thead>
          <tbody>
            {HISTORY.map((h) => (
              <tr key={h.date}>
                <td className="border-t border-ws-line/60 py-2 text-ws-muted">{h.date}</td>
                <td className="border-t border-ws-line/60 py-2">{h.name}</td>
                <td className="border-t border-ws-line/60 py-2 text-ws-muted">{h.src}</td>
                <td className="border-t border-ws-line/60 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${h.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>{h.ok ? 'Installed' : state === 'scheduled' ? 'Scheduled 22:00' : 'Ready to restart'}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function AboutDevice({ compact }: { compact?: boolean }) {
  const [showWipe, setShowWipe] = useState(false)
  return (
    <div className="flex flex-col gap-4">
      <div className={`${card} flex flex-col gap-2.5 px-5 py-[18px]`}>
        {compact && <div className="text-sm font-semibold">About this device</div>}
        <dl className="m-0 grid grid-cols-[120px_1fr] gap-y-2 text-[13px]">
          {[['Name', 'LZT-LAP-0142'], ['OS', 'WorkSuite OS 1.0.2 (trixie)'], ['Architecture', 'x86-64 (amd64)'], ['Encryption', 'LUKS2 · TPM-bound'], ['Directory', 'Joined to LIVEZEN.LOCAL (Active Directory)'], ['WorkSuite', 'work.livezentech.com · Enterprise']].map(([k, v]) => (
            <div key={k} className="contents"><dt className="text-ws-muted">{k}</dt><dd className="m-0">{v}</dd></div>
          ))}
        </dl>
      </div>
      {/* WSOS-MDM-007: management disclosure */}
      <div className="flex flex-col gap-2.5 rounded-[14px] border border-blue-200 bg-blue-50 px-5 py-[18px]">
        <div className="flex items-center gap-2 text-sm font-semibold text-blue-900"><CIcon name="shield" />Managed by Livezen Technologies</div>
        <ul className="m-0 pl-[18px] text-[13px] leading-relaxed text-slate-800 list-disc">
          <li>Approved apps and repositories only</li>
          <li>Pilot update ring, Automatic mode</li>
          <li>Screen locks after 5 min idle</li>
          <li>Offline sign-in allowed for 7 days</li>
          <li>Your organization can remotely lock this device and wipe WorkSuite data or the whole device</li>
        </ul>
        <div className="text-xs text-blue-900">Last policy check 09:58 · no keylogging, camera or remote shell</div>
        {/* WSOS-WIPE-007: explain wipe scope */}
        <button type="button" aria-expanded={showWipe} onClick={() => setShowWipe((s) => !s)} className="self-start text-[13px] text-ws-accent hover:text-ws-accent-strong">
          {showWipe ? 'Hide' : 'What a remote wipe does'}
        </button>
        {showWipe && (
          <div className="rounded-lg border border-blue-200 bg-white p-3 text-[12.5px] leading-relaxed text-slate-700">
            <p className="m-0"><strong>WorkSuite data wipe</strong> removes your work account, synced WorkSuite files and cached credentials. Personal files in your home folder stay.</p>
            <p className="mb-0 mt-2"><strong>Full device wipe</strong> destroys the LUKS2 encryption keys, making all data unrecoverable, then returns the device to the installer.</p>
            <p className="mb-0 mt-2">You are notified on screen before any wipe runs, and each request is logged.</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default function Settings({ onClose }: WindowProps) {
  const [section, setSection] = useState<Section>('Updates')
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 bottom-[56px] p-[20px_24px]">
      <div role="dialog" aria-label="Settings" className="pointer-events-auto flex h-full w-full flex-col overflow-hidden rounded-xl bg-slate-100 text-ws-ink shadow-[0_16px_48px_rgba(2,6,23,0.45)] dark:bg-ws-subtle">
        <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-ws-line bg-ws-surface pl-4 pr-2">
          <span className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-slate-700 text-[11px] font-bold text-white">S</span>
          <span className="text-[13px] font-semibold">Settings</span>
          <div className="ml-auto flex gap-0.5">
            <button type="button" aria-label="Minimize" className="flex h-8 w-9 items-center justify-center rounded-md text-ws-muted hover:bg-slate-100"><CIcon name="min" size={14} /></button>
            <button type="button" aria-label="Maximize" className="flex h-8 w-9 items-center justify-center rounded-md text-ws-muted hover:bg-slate-100"><CIcon name="max" size={14} /></button>
            <button type="button" aria-label="Close" onClick={onClose} className="flex h-8 w-9 items-center justify-center rounded-md text-ws-muted hover:bg-red-600 hover:text-white"><CIcon name="close" size={14} /></button>
          </div>
        </div>
        <div className="flex min-h-0 grow">
          <nav aria-label="Settings sections" className="flex w-60 shrink-0 flex-col gap-0.5 overflow-auto border-r border-ws-line bg-ws-surface p-3">
            {SECTIONS.map((s) => {
              const cur = s === section
              return (
                <button key={s} type="button" aria-current={cur ? 'page' : undefined} onClick={() => setSection(s)}
                  className={`flex h-9 shrink-0 items-center justify-between rounded-lg px-3 text-left text-sm ${cur ? 'bg-blue-100 font-semibold text-blue-900' : 'text-slate-700 hover:bg-slate-100 dark:text-ws-ink dark:hover:bg-slate-700'}`}>
                  {s}{s === 'Updates' && <span className="text-[11px] text-blue-700" aria-label="1 update">1</span>}
                </button>
              )
            })}
          </nav>
          <main className="flex min-w-0 grow gap-5 overflow-auto px-7 py-6">
            {section === 'Updates' ? <>
              <Updates />
              <aside aria-label="About this device" className="w-[360px] shrink-0"><AboutDevice compact /></aside>
            </> : section === 'About this device' ? (
              <Panel title="About this device"><div className="max-w-[640px]"><AboutDevice /></div></Panel>
            ) : <SimplePanel key={section} section={section} />}
          </main>
        </div>
      </div>
    </div>
  )
}

/** WorkSuite cloud sign-ins held by the credentials broker. Sign-out drops the keyring entry and revokes it. */
function CloudAccounts() {
  const [accounts, setAccounts] = useState<CloudAccount[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => os.cloudAccounts().then((r) => (r.ok ? setAccounts(r.value) : setError(cloudErrorText(r.error))))
  useEffect(() => { void load() }, [])
  const signOut = async (id: string) => {
    const r = await os.cloudSignOut(id)
    if (!r.ok) setError(cloudErrorText(r.error))
    void load()
  }
  if (error) return <Row label="WorkSuite account" help={error}><span className="text-[13.5px] text-ws-muted">Unavailable</span></Row>
  if (!accounts) return <Row label="WorkSuite account"><span className="text-[13.5px] text-ws-muted">Loading…</span></Row>
  if (!accounts.length) return <Row label="WorkSuite account" help="Not signed in. Sign in from first-run setup or here to sync."><span className="text-[13.5px] text-ws-muted">Signed out</span></Row>
  return <>{accounts.map((a) => (
    <Row key={a.id} label={a.name ?? 'WorkSuite account'} help={`${a.server_url}${a.state === 'refresh_failed' ? ' · sign in again to resume sync' : ''}`}>
      <button type="button" onClick={() => void signOut(a.id)} className="h-9 rounded-lg border border-slate-300 bg-ws-surface px-3 text-sm">Sign out</button>
    </Row>
  ))}</>
}
