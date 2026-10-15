import { useEffect, useState } from 'react'
import { cloudErrorText, lockChoiceLabel, os, packageErrorText, policyLines, serverUrlFor, type OsUpdateStatus, type CloudAccount, type DeviceInfo, type LockSettings, type SignOutChoice } from '../lib/os'
import type { WindowProps } from './types'
import CIcon from '../components/CIcon'
import { AppIcon } from '../components/Logo'

const SECTIONS = ['Network', 'Bluetooth', 'Displays', 'Sound', 'Power', 'Printers', 'Apps', 'Accounts', 'Privacy', 'Updates', 'About this device'] as const
type Section = (typeof SECTIONS)[number]


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

/** WSOS-LOCK-003: idle lock timeout, chosen by the user within the organization's maximum. */
function ScreenLockRow() {
  const [s, setS] = useState<LockSettings | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { void os.lockSettings().then(setS).catch(() => setErr('Screen lock settings are unavailable.')) }, [])
  const change = async (v: number) => {
    const r = await os.setLockTimeout(v)
    if (r.ok) { setS(r.value); setErr(null) } else setErr(r.error === 'above_policy_maximum' ? 'Your organization does not allow a longer time.' : 'Could not save this setting.')
  }
  const help = err ?? (!s ? 'Loading…' : s.max_s !== null ? `Your organization allows up to ${lockChoiceLabel(s.max_s)}` : 'Locks the screen after this much idle time and before sleep')
  return (
    <Row label="Lock screen after" help={help}>
      {s && <select aria-label="Lock screen after" value={s.timeout_s} onChange={(e) => void change(Number(e.target.value))}
        className="h-9 rounded-lg border border-slate-300 bg-ws-surface px-2 text-sm">
        {s.choices.map((c) => <option key={c} value={c}>{lockChoiceLabel(c)}</option>)}
      </select>}
    </Row>
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
        <ScreenLockRow />
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

const WAIT_REASON: Record<string, string> = {
  waiting_for_user: 'Ready to install when you are.',
  outside_window: 'Installs in the maintenance window.',
  not_idle: 'Installs next time the computer is idle.',
  metered: 'Waiting for a non-metered connection.',
  deferred: 'You postponed this update.',
  paused: 'Your organization paused this release.',
  pulled: 'This release was withdrawn.',
  not_in_rollout: 'Rolling out gradually; this computer isn’t included yet.',
  manual_mode: 'Updates are set to manual.',
}
const RING: Record<string, string> = { development: 'Development', pilot: 'Pilot', stable: 'Stable' }
const MODE: Record<string, string> = { automatic: 'Automatic', notify: 'Notify', manual: 'Manual' }
const fmt = (ms: number | null | string) => (ms == null ? '—' : new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))

/** Settings › Updates on the package service's update coordinator (WSOS-AUP-011). */
function Updates() {
  const [st, setSt] = useState<OsUpdateStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [policy, setPolicy] = useState<DeviceInfo['policies']>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    void os.updateStatus(false).then((r) => (r.ok ? setSt(r.value) : setError(packageErrorText(r.error))))
    void os.deviceInfo().then((d) => setPolicy(d.policies))
    const off = os.onUpdateStatus(setSt)
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => { off(); clearInterval(t) }
  }, [])

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true); setError(null)
    const r = await fn()
    setBusy(false)
    if (!r.ok) setError(packageErrorText(r.error ?? 'failed'))
  }
  const check = () => act(async () => { const r = await os.updateStatus(true); if (r.ok) setSt(r.value); return r })
  const later = () => act(async () => { const r = await os.updateDefer(); if (r.ok && !r.value) setError('This update can’t be postponed any more.'); return r })

  const v = st?.version ?? ''
  const due = st?.deadline ? ` · required by ${fmt(st.deadline)}` : ''
  const left = st?.deferrals_left != null ? ` · ${st.deferrals_left} postponement${st.deferrals_left === 1 ? '' : 's'} left` : ''
  const mins = st?.restart_at ? Math.max(0, Math.ceil((st.restart_at - now) / 60_000)) : 0
  const view = !st ? { title: error ? 'Update status unavailable' : 'Loading…', sub: error ?? '' } : {
    up_to_date: { title: 'WorkSuite OS is up to date', sub: `Version ${st.installed} · last checked ${fmt(st.last_check)}` },
    checking: { title: 'Checking for updates…', sub: 'Contacting the update server' },
    available: { title: `WorkSuite OS ${v} is available`, sub: WAIT_REASON[st.reason ?? ''] ?? '' },
    waiting: { title: `WorkSuite OS ${v} is ready to install`, sub: `${WAIT_REASON[st.reason ?? ''] ?? ''}${due}${left}` },
    installing: { title: `Installing WorkSuite OS ${v}…`, sub: 'You can keep working. Signature verified.' },
    ready_to_restart: { title: 'Restart to finish updating', sub: `WorkSuite OS ${st.installed} is installed` },
    restart_pending: { title: `Restarting in ${mins} min to install WorkSuite OS ${v}`, sub: 'This update is required by your organization. Save your work.' },
    failed: { title: 'The last update check or install didn’t work', sub: st.reason ? st.reason.charAt(0).toUpperCase() + st.reason.slice(1) + '.' : '' },
  }[st.state]

  const btn = 'h-[42px] shrink-0 whitespace-nowrap rounded-[10px] px-4 text-sm disabled:opacity-50'
  const canInstall = st && (st.state === 'waiting' || st.state === 'available') && st.reason !== 'paused' && st.reason !== 'pulled'
  const policyRows = [
    { label: 'Update source', help: 'Signed release manifest and APT repository', value: 'download.worksuitecloud.com' },
    { label: 'Ring', help: 'Pilot devices get releases before Stable', value: RING[policy?.update_ring ?? 'stable'] },
    { label: 'Update mode', help: 'Automatic installs when idle or in the window; Notify waits for you', value: MODE[policy?.update_mode ?? 'automatic'] },
    { label: 'Maintenance window', help: 'Automatic installs happen in this window', value: policy?.maintenance_window ?? 'Any time the computer is idle' },
  ]
  return (
    <Panel title="Updates">
      <div className={`${card} flex items-center gap-4 p-5`} aria-live="polite">
        <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700 ${st?.state === 'checking' || st?.state === 'installing' ? 'animate-spin' : ''}`}><CIcon name="refresh" size={24} /></span>
        <div className="flex min-w-0 grow flex-col gap-1">
          <div className="text-base font-semibold">{view.title}</div>
          <div className="text-[13px] text-ws-muted">{view.sub}</div>
          {error && st && <div role="alert" className="text-[13px] text-red-700">{error}</div>}
        </div>
        {st && (st.state === 'up_to_date' || st.state === 'failed') && <button type="button" disabled={busy} onClick={() => void check()} className={`${btn} border border-slate-300 bg-ws-surface text-slate-700`}>Check for updates</button>}
        {canInstall && <>
          <button type="button" disabled={busy || st!.deferrals_left === 0} onClick={() => void later()} className={`${btn} border border-slate-300 bg-ws-surface text-slate-700`}>Later</button>
          <button type="button" disabled={busy} onClick={() => void act(os.updateInstallNow)} className={`${btn} bg-ws-accent px-[18px] font-semibold text-white hover:bg-ws-accent-strong`}>Install now</button>
        </>}
        {st?.state === 'ready_to_restart' && <button type="button" onClick={() => void os.power('restart')} className={`${btn} bg-ws-accent px-[18px] font-semibold text-white hover:bg-ws-accent-strong`}>Restart now</button>}
      </div>

      <div className={`${card} flex flex-col`}>
        {policyRows.map((r) => (
          <Row key={r.label} label={r.label} help={r.help}>
            <span className="text-[13.5px]">{r.value}</span>
            {policy && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">Set by policy</span>}
          </Row>
        ))}
        <Row label="Metered connections" help="Non-critical downloads wait for Wi-Fi or Ethernet">
          <span className="text-[13.5px] text-ws-muted">Automatic</span>
        </Row>
      </div>
    </Panel>
  )
}

function AboutDevice({ compact }: { compact?: boolean }) {
  const [showWipe, setShowWipe] = useState(false)
  const [info, setInfo] = useState<DeviceInfo | null>(null)
  useEffect(() => { void os.deviceInfo().then(setInfo) }, [])
  if (!info) return <div className={`${card} px-5 py-[18px] text-[13px] text-ws-muted`}>Loading device information…</div>

  const d = info.device
  const enc = d?.encrypted == null ? 'Unknown' : d.encrypted ? 'Encrypted (LUKS2)' : 'Not encrypted'
  const rows: [string, string][] = [
    ['Name', d?.hostname ?? 'Unknown'],
    ['OS', d?.os_version ?? 'Unknown'],
    ['Architecture', d?.arch === 'arm64' ? 'ARM64 (arm64)' : 'x86-64 (amd64)'],
    ['Kernel', d?.kernel_version ?? 'Unknown'],
    ['Encryption', enc],
  ]
  const lines = policyLines(info.policies)
  const checked = info.last_check_in ? new Date(info.last_check_in).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'not yet'

  return (
    <div className="flex flex-col gap-4">
      <div className={`${card} flex flex-col gap-2.5 px-5 py-[18px]`}>
        {compact && <div className="text-sm font-semibold">About this device</div>}
        {!compact && (
          <div className="flex items-center gap-4 pb-1">
            <AppIcon size={56} />
            <div className="flex flex-col gap-0.5">
              <span className="text-[17px] font-semibold">WorkSuite OS</span>
              <span className="text-[13px] text-ws-muted">{d?.os_version ?? 'Debian 13'}</span>
            </div>
          </div>
        )}
        <dl className="m-0 grid grid-cols-[120px_1fr] gap-y-2 text-[13px]">
          {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-ws-muted">{k}</dt><dd className="m-0">{v}</dd></div>)}
        </dl>
      </div>
      {/* WSOS-MDM-007: management disclosure, from the device agent */}
      {info.managed ? (
        <div className="flex flex-col gap-2.5 rounded-[14px] border border-blue-200 bg-blue-50 px-5 py-[18px]">
          <div className="flex items-center gap-2 text-sm font-semibold text-blue-900"><CIcon name="shield" />Managed by {info.org_name ?? info.server ?? 'your organization'}</div>
          <ul className="m-0 pl-[18px] text-[13px] leading-relaxed text-slate-800 list-disc">
            {lines.map((l) => <li key={l}>{l}</li>)}
            <li>Your organization can remotely lock this device and wipe WorkSuite data{d?.encrypted ? ' or the whole device' : ''}</li>
          </ul>
          <div className="text-xs text-blue-900">{info.server ? `${info.server} · ` : ''}Last policy check {checked} · no keylogging, camera access or remote shell</div>
          {/* WSOS-WIPE-007: explain wipe scope */}
          <button type="button" aria-expanded={showWipe} onClick={() => setShowWipe((v) => !v)} className="self-start text-[13px] text-ws-accent hover:text-ws-accent-strong">
            {showWipe ? 'Hide' : 'What a remote wipe does'}
          </button>
          {showWipe && (
            <div className="rounded-lg border border-blue-200 bg-white p-3 text-[12.5px] leading-relaxed text-slate-700">
              <p className="m-0"><strong>WorkSuite data wipe</strong> signs everyone out and removes WorkSuite accounts, synced WorkSuite files and the WorkSuite Drive folder for every user. Other files in home folders stay.</p>
              <p className="mb-0 mt-2"><strong>Full device wipe</strong>{d?.encrypted ? ' destroys the disk encryption keys, making all data unrecoverable, then restarts the computer.' : ' is only possible on encrypted devices; this one is not encrypted.'}</p>
              <p className="mb-0 mt-2">Every wipe needs an administrator plus a second approver and is recorded by your organization.</p>
            </div>
          )}
        </div>
      ) : info.agent ? (
        <EnrollCard compact={compact} onEnrolled={() => void os.deviceInfo().then(setInfo)} />
      ) : (
        <div className={`${card} px-5 py-[18px] text-[13px] text-ws-muted`}>Management status is unavailable: the WorkSuite device agent isn’t running.</div>
      )}
    </div>
  )
}

/** Enroll an unmanaged device with an organization (§9.3); same path as first-run: device agent via pkexec. */
function EnrollCard({ compact, onEnrolled }: { compact?: boolean; onEnrolled: () => void }) {
  const [open, setOpen] = useState(false)
  const [server, setServer] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = 'h-10 rounded-lg border border-slate-300 bg-ws-surface px-3 text-sm font-normal text-ws-ink outline-none focus:border-ws-accent'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!server.trim() || !code.trim()) return setError('Enter the server address and the enrollment code from your IT admin.')
    setBusy(true); setError(null)
    const r = await os.enrollDevice(serverUrlFor('enterprise', server), code)
    setBusy(false)
    if (!r.ok) return setError(cloudErrorText(r.error))
    onEnrolled()
  }

  return (
    <div className={`${card} flex flex-col gap-3 px-5 py-[18px] text-[13px]`}>
      <span className="text-ws-muted">This device isn’t managed by an organization.</span>
      {!open ? (
        !compact && <button type="button" onClick={() => setOpen(true)} className="self-start h-9 rounded-lg border border-slate-300 bg-ws-surface px-3 text-sm">Enroll with an organization…</button>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Enroll this device">
          <p className="m-0 text-ws-muted">Your organization will be able to apply its policies and updates, and lock or wipe this device remotely. An administrator password is needed.</p>
          <label className="flex flex-col gap-1 font-semibold">Server address
            <input value={server} onChange={(e) => { setServer(e.target.value); setError(null) }} placeholder="work.example.com" spellCheck={false} className={field} />
          </label>
          <label className="flex flex-col gap-1 font-semibold">Enrollment code
            <input value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(null) }} autoComplete="off" spellCheck={false} className={`${field} w-[260px] max-w-full font-mono tracking-[1px]`} />
          </label>
          {error && <p role="alert" className="m-0 text-red-700">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="h-9 rounded-lg bg-ws-accent px-4 text-sm font-semibold text-white disabled:opacity-60">{busy ? 'Enrolling…' : 'Enroll this device'}</button>
            <button type="button" disabled={busy} onClick={() => { setOpen(false); setError(null) }} className="h-9 rounded-lg border border-slate-300 bg-ws-surface px-3 text-sm">Cancel</button>
          </div>
        </form>
      )}
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
                  {s}
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
  const [notice, setNotice] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<{ account: CloudAccount; unsent: number } | null>(null)
  const load = () => os.cloudAccounts().then((r) => (r.ok ? setAccounts(r.value) : setError(cloudErrorText(r.error))))
  useEffect(() => { void load() }, [])

  const finish = async (a: CloudAccount, choice: SignOutChoice) => {
    const r = await os.cloudSignOut(a.id, choice)
    setPrompt(null)
    if (!r.ok) { setError(cloudErrorText(r.error)); return }
    setNotice(r.value.exported ? `Signed out. Unsent changes were saved to ${r.value.exported}` : 'Signed out.')
    void load()
  }
  // WSOS-SYN-008: never sign out silently over unsent changes.
  const signOut = async (a: CloudAccount) => {
    setError(null); setNotice(null)
    const r = await os.syncUnsent(a.id)
    if (!r.ok) { setError(cloudErrorText(r.error)); return }
    if (r.value === 0) return finish(a, 'none')
    setPrompt({ account: a, unsent: r.value })
  }

  if (error && !accounts) return <Row label="WorkSuite account" help={error}><span className="text-[13.5px] text-ws-muted">Unavailable</span></Row>
  if (!accounts) return <Row label="WorkSuite account"><span className="text-[13.5px] text-ws-muted">Loading…</span></Row>
  return <>
    {(error || notice) && <p role="status" className={`m-0 border-b border-ws-line/60 px-5 py-3 text-[13px] ${error ? 'text-red-700' : 'text-emerald-700'}`}>{error ?? notice}</p>}
    {accounts.length === 0
      ? <Row label="WorkSuite account" help="Not signed in. Sign in from first-run setup or here to sync."><span className="text-[13.5px] text-ws-muted">Signed out</span></Row>
      : accounts.map((a) => (
        <Row key={a.id} label={a.name ?? 'WorkSuite account'} help={`${a.server_url}${a.state === 'refresh_failed' ? ' · sign in again to resume sync' : ''}`}>
          <button type="button" onClick={() => void signOut(a)} className="h-9 rounded-lg border border-slate-300 bg-ws-surface px-3 text-sm">Sign out</button>
        </Row>
      ))}
    {prompt && <UnsentDialog {...prompt} onCancel={() => setPrompt(null)} onChoose={(c) => finish(prompt.account, c)} />}
  </>
}

/** Wait to sync, export, or discard (confirmed) — the three choices SRS WSOS-SYN-008 requires. */
function UnsentDialog({ account, unsent, onCancel, onChoose }: { account: CloudAccount; unsent: number; onCancel: () => void; onChoose: (c: SignOutChoice) => Promise<void> }) {
  const [left, setLeft] = useState(unsent)
  const [waiting, setWaiting] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [busy, setBusy] = useState(false)
  const n = (k: number) => `${k} unsent change${k === 1 ? '' : 's'}`

  // "Wait to sync": ask for a sync and check every 2 s; sign out once nothing is left.
  useEffect(() => {
    if (!waiting) return
    let stop = false
    const tick = async () => {
      if (stop) return
      await os.syncNow()
      const r = await os.syncUnsent(account.id)
      if (stop) return
      if (r.ok && r.value === 0) { stop = true; await onChoose('none'); return }
      if (r.ok) setLeft(r.value)
      timer = setTimeout(tick, 2000)
    }
    let timer = setTimeout(tick, 0)
    return () => { stop = true; clearTimeout(timer) }
  }, [waiting, account.id, onChoose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const run = async (c: SignOutChoice) => { setBusy(true); await onChoose(c); setBusy(false) }
  const btn = 'h-10 rounded-lg px-4 text-sm font-semibold disabled:opacity-50'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div role="alertdialog" aria-modal="true" aria-labelledby="unsent-title" aria-describedby="unsent-desc"
        className="flex w-[460px] max-w-full flex-col gap-4 rounded-2xl bg-ws-surface p-6 text-ws-ink shadow-[0_24px_64px_rgba(2,6,23,0.35)]">
        <h3 id="unsent-title" className="m-0 text-lg font-semibold">{n(left)}</h3>
        <p id="unsent-desc" className="m-0 text-sm text-ws-muted">
          Changes you made offline haven’t reached {account.server_url} yet. Signing out removes WorkSuite data from this computer, so choose what happens to them.
        </p>
        {waiting ? (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-800" aria-live="polite">
            <span>Syncing… you’ll be signed out when everything has reached the server.</span>
            <button type="button" onClick={() => setWaiting(false)} className="shrink-0 underline">Stop waiting</button>
          </div>
        ) : confirmDiscard ? (
          <div className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            <span>Discard {n(left)}? They can’t be recovered.</span>
            <div className="flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => setConfirmDiscard(false)} className={`${btn} border border-slate-300 bg-white text-slate-700`}>Keep them</button>
              <button type="button" disabled={busy} onClick={() => void run('discard')} className={`${btn} bg-red-700 text-white`}>Discard and sign out</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <button type="button" disabled={busy} onClick={() => setWaiting(true)} className={`${btn} bg-ws-accent text-white`}>Wait to sync, then sign out</button>
            <button type="button" disabled={busy} onClick={() => void run('export')} className={`${btn} border border-slate-300 bg-ws-surface`}>Save changes to a file and sign out</button>
            <button type="button" disabled={busy} onClick={() => setConfirmDiscard(true)} className={`${btn} border border-red-200 bg-ws-surface text-red-700`}>Discard changes…</button>
          </div>
        )}
        <button type="button" disabled={busy} onClick={onCancel} className="self-end text-sm text-ws-muted underline">Cancel — stay signed in</button>
      </div>
    </div>
  )
}
