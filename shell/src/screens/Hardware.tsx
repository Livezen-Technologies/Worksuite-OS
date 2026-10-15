// Devices and drivers (boards H1–H6, HwSettings). Devices are read from sysfs by the bridge; there is no driver
// catalog or driver installer service yet, so driver choices and driver updates show an honest empty state.
import { useEffect, useRef, useState } from 'react'
import { formatBytes, os, type Avail, type DriverOffer, type HwDevice, type Printer } from '../lib/os'
import { KIND_ICON, deviceStatus, deviceSub, driversInUse, groupDevices, newDevices, offerLocked, offerTag, offerVersion } from '../lib/hardware'
import { C, Dialog, OptionCard, Progress, Spinner, Svg, Tag, btnGhost, btnPrimary, card, dialogFooter, linkBtn, rowLine, sectionLabel } from '../components/Dk'
import { ICON } from './Updates'

type Res<T> = { state: 'loading' } | { state: 'ok'; value: T } | { state: 'unavailable' }

function useResource<T>(load: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>) {
  const [r, setR] = useState<Res<T>>({ state: 'loading' })
  const reload = () => load().then((x) => setR(x.ok ? { state: 'ok', value: x.value } : { state: 'unavailable' })).catch(() => setR({ state: 'unavailable' }))
  useEffect(() => { void reload() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return [r, reload] as const
}

function DeviceIcon({ d, size = 34 }: { d: HwDevice; size?: number }) {
  return <span className="flex shrink-0 items-center justify-center rounded-[9px] bg-[rgba(31,107,255,0.16)]" style={{ width: size, height: size }}><Svg d={KIND_ICON[d.kind]} size={18} stroke="#7FB2FF" /></span>
}

function Header({ title, action, onAction, busy }: { title: string; action: string; onAction: () => void; busy?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <h1 className="m-0 text-[28px] font-bold">{title}</h1>
      <button type="button" disabled={busy} onClick={onAction} className={`${btnGhost} px-4 py-[9px] text-[13px]`}>{action}</button>
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className={`${card} flex flex-col gap-1.5 px-5 py-[18px]`} role="status">
      <span className="text-sm font-semibold">{title}</span>
      {children && <span className="text-[13px] leading-[1.45] text-[#8FA3C8]">{children}</span>}
    </div>
  )
}

/** Settings › Devices (HwSettings page=devices). */
export function DevicesPanel({ onProblem }: { onProblem?: (d: HwDevice) => void }) {
  const [devs, reload] = useResource(os.hwDevices)
  const [printers, setPrinters] = useState<Avail<Printer[]> | null>(null)
  const loadPrinters = () => os.sysPrinters().then(setPrinters, () => setPrinters({ available: false, reason: 'service_unavailable' }))
  useEffect(() => { void loadPrinters() }, [])
  return (
    <div className="flex flex-col gap-4">
      <Header title="Devices" action="Refresh" onAction={() => { void reload(); void loadPrinters() }} />
      {printers?.available && printers.value.length > 0 && (
        <section aria-label="Printers" className="flex flex-col gap-1.5">
          <h2 className={`m-0 font-normal ${sectionLabel}`}>Printers</h2>
          <ul className={`${card} m-0 list-none overflow-hidden p-0`}>
            {printers.value.map((p) => {
              const color = p.state === 'disabled' ? C.amber : p.state === 'unknown' ? C.muted : C.green
              return (
                <li key={p.name} className={`flex items-center gap-3.5 px-4 py-3 ${rowLine}`}>
                  <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-[rgba(31,107,255,0.16)]"><Svg d={KIND_ICON.printer} size={18} stroke="#7FB2FF" /></span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="truncate text-sm font-medium">{p.name.replace(/_/g, ' ')}</span><span className="text-xs text-[#8FA3C8]">Printer{p.is_default ? ' · default' : ''}</span></span>
                  <span className="flex items-center gap-1.5 text-xs" style={{ color }}><span className="h-2 w-2 rounded-full" style={{ background: color }} />{p.state === 'printing' ? 'Printing' : p.state === 'disabled' ? 'Paused' : p.state === 'unknown' ? 'Unknown' : 'Ready'}</span>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {devs.state === 'loading' && <Empty title="Looking for devices…" />}
      {devs.state === 'unavailable' && <Empty title="Device information isn't available yet">This computer didn't report its hardware to the shell.</Empty>}
      {devs.state === 'ok' && devs.value.length === 0 && <Empty title="No devices found">Plugged-in and built-in devices appear here.</Empty>}
      {devs.state === 'ok' && groupDevices(devs.value).map((g) => (
        <section key={g.name} aria-label={g.name} className="flex flex-col gap-1.5">
          <h2 className={`m-0 font-normal ${sectionLabel}`}>{g.name}</h2>
          <ul className={`${card} m-0 list-none overflow-hidden p-0`}>
            {g.items.map((d) => {
              const s = deviceStatus(d)
              return (
                <li key={d.id} className={`flex items-center gap-3.5 px-4 py-3 ${rowLine}`}>
                  <DeviceIcon d={d} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="truncate text-sm font-medium">{d.name}</span><span className="truncate text-xs text-[#8FA3C8]">{deviceSub(d)}</span></span>
                  {!d.driver && onProblem
                    ? <button type="button" onClick={() => onProblem(d)} className="flex cursor-pointer items-center gap-1.5 rounded text-xs hover:underline" style={{ color: s.color }}><span className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.label}</button>
                    : <span className="flex items-center gap-1.5 text-xs" style={{ color: s.color }}><span className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.label}</span>}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** Settings › Drivers (HwSettings page=drivers). */
export function DriversPanel({ onOpenUpdates }: { onOpenUpdates: () => void }) {
  const [devs] = useResource(os.hwDevices)
  const [offers, reload] = useResource(os.hwDriverUpdates)
  const [sel, setSel] = useState<Set<string> | null>(null)
  const [installing, setInstalling] = useState<DriverOffer[] | null>(null)
  const list = offers.state === 'ok' ? offers.value : []
  const chosen = sel ?? new Set(list.map((o) => o.id))
  const picked = list.filter((o) => chosen.has(o.id) || offerLocked(o))
  const bytes = picked.reduce((n, o) => n + (o.size_bytes ?? 0), 0)
  const restarts = picked.filter((o) => o.restart).length
  return (
    <div className="flex flex-col gap-3.5">
      <Header title="Drivers" action="Check for updates" onAction={() => void reload()} busy={offers.state === 'loading'} />
      {offers.state === 'unavailable' && (
        <div className="flex items-center gap-3.5 rounded-xl border border-[rgba(31,107,255,0.35)] bg-[rgba(31,107,255,0.1)] px-[18px] py-4">
          <Svg d={ICON.download} size={22} stroke="#7FB2FF" />
          <span className="flex-1 text-sm"><strong>Driver updates come with WorkSuite OS updates.</strong> <span className="text-[#C9D6EE]">There's no separate driver catalog on this computer yet.</span></span>
          <button type="button" onClick={onOpenUpdates} className={btnPrimary}>Open Updates</button>
        </div>
      )}
      {offers.state === 'ok' && list.length > 0 && <>
        <div className="flex items-center gap-3.5 rounded-xl border border-[rgba(31,107,255,0.35)] bg-[rgba(31,107,255,0.1)] px-[18px] py-4">
          <Svg d={ICON.download} size={22} stroke="#7FB2FF" />
          <span className="flex-1 text-sm"><strong>{list.length} driver update{list.length === 1 ? '' : 's'}</strong> available{bytes ? ` · ${formatBytes(bytes)}` : ''}{restarts ? ` · ${restarts} need${restarts === 1 ? 's' : ''} a restart` : ''}</span>
          <button type="button" disabled={!picked.length} onClick={() => setInstalling(picked)} className={btnPrimary}>Install selected</button>
        </div>
        <ul className={`${card} m-0 list-none overflow-hidden p-0`}>
          {list.map((o) => {
            const t = offerTag(o)
            const on = chosen.has(o.id) || offerLocked(o)
            return (
              <li key={o.id} className={rowLine}>
                <label className="flex cursor-pointer items-center gap-3.5 px-4 py-[13px]">
                  <input type="checkbox" checked={on} disabled={offerLocked(o)} aria-label={o.name}
                    onChange={() => { const n = new Set(chosen); if (n.has(o.id)) n.delete(o.id); else n.add(o.id); setSel(n) }} className="h-[18px] w-[18px] accent-[#1F6BFF]" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2 text-sm font-medium">{o.name}<Tag text={t.tag} bg={t.bg} color={t.color} /></span>
                    <span className="text-xs text-[#8FA3C8]">{o.summary}{o.restart ? ' · restart required' : ''}</span>
                  </span>
                  <span className="font-mono text-xs text-[#C9D6EE]">{offerVersion(o)}</span>
                </label>
              </li>
            )
          })}
        </ul>
      </>}
      {offers.state === 'ok' && list.length === 0 && <Empty title="Drivers are up to date" />}
      <section aria-label="Drivers in use" className="flex flex-col gap-1.5">
        <h2 className={`m-0 font-normal ${sectionLabel}`}>In use</h2>
        {devs.state === 'unavailable' && <Empty title="Driver information isn't available yet" />}
        {devs.state === 'ok' && (
          <ul className={`${card} m-0 list-none overflow-hidden p-0`}>
            {driversInUse(devs.value).map((d) => {
              const t = d.proprietary ? { tag: 'PROPRIETARY', bg: 'rgba(255,159,90,0.16)', color: C.amber } : d.proprietary === false ? { tag: 'OPEN SOURCE', bg: 'rgba(127,178,255,0.12)', color: C.soft } : null
              return (
                <li key={d.driver} className={`flex items-center gap-3.5 px-4 py-[13px] ${rowLine}`}>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2 font-mono text-sm font-medium">{d.driver}{t && <Tag text={t.tag} bg={t.bg} color={t.color} />}</span>
                    <span className="truncate text-xs text-[#8FA3C8]">{d.devices.join(', ')}</span>
                  </span>
                  <span className="font-mono text-xs text-[#C9D6EE]">{d.version ?? 'kernel'}</span>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      {installing && <DriverInstallDialog offers={installing} onClose={() => { setInstalling(null); void reload() }} />}
    </div>
  )
}

/** H5: driver install progress from the package service job events (phase = offer id). */
export function DriverInstallDialog({ offers, onClose }: { offers: DriverOffer[]; onClose: () => void }) {
  const [pct, setPct] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | null>(null)
  const job = useRef<string | null>(null)
  useEffect(() => {
    const off = os.onPkgJob((e) => {
      if (e.job !== job.current) return
      if (e.kind === 'progress' && e.phase) setPct((p) => ({ ...p, [e.phase!]: e.percent ?? 0 }))
      if (e.kind === 'finished' && e.result !== 'success') setError(e.error ?? 'The driver install didn’t finish.')
    })
    void os.hwInstallDrivers(offers.map((o) => o.id)).then((r) => { if (r.ok) job.current = r.value; else setError('Drivers can’t be installed here yet.') })
    return off
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const done = offers.every((o) => (pct[o.id] ?? 0) >= 100)
  const restart = offers.filter((o) => o.restart)
  const active = offers.find((o) => (pct[o.id] ?? 0) < 100 && pct[o.id] != null)
  return (
    <Dialog width={500} onClose={onClose}>
      {(tid) => <>
        <div className="flex flex-col gap-1.5 px-6 pt-6 pb-3">
          <h2 id={tid} className="m-0 text-[19px] font-bold">Installing driver updates</h2>
          <p className="m-0 text-sm text-[#8FA3C8]">Drivers install through the package service. You can keep working.</p>
        </div>
        <ul className="m-0 flex list-none flex-col gap-1.5 px-4 pt-2 pb-4" aria-live="polite">
          {offers.map((o) => {
            const p = pct[o.id]
            const st = p == null ? 'wait' : p >= 100 ? 'done' : 'active'
            return (
              <li key={o.id} className="flex flex-col gap-2 rounded-xl px-3.5 py-3" style={{ background: st === 'active' ? 'rgba(24,212,240,0.08)' : 'transparent' }}>
                <div className="flex items-center gap-3">
                  {st === 'done' && <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#5FD39A" /><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#0F2350" strokeWidth="2.4" strokeLinecap="round" /></svg>}
                  {st === 'active' && <Spinner size={20} />}
                  {st === 'wait' && <span className="h-5 w-5 rounded-full border-2 border-[rgba(127,178,255,0.3)]" />}
                  <span className="flex-1 text-sm font-medium">{o.name} {o.to_version}</span>
                  <span className="text-xs text-[#8FA3C8]">{st === 'done' ? 'Installed' : st === 'active' ? `Installing… ${p}%` : `Waiting${o.size_bytes ? ` · ${formatBytes(o.size_bytes)}` : ''}`}</span>
                </div>
                {st === 'active' && <div className="ml-8"><Progress value={p} label={`${o.name} progress`} height={4} /></div>}
              </li>
            )
          })}
        </ul>
        {error && <p role="alert" className="mx-4 mb-4 rounded-xl border border-[rgba(255,138,122,0.3)] bg-[rgba(255,138,122,0.08)] px-3.5 py-3 text-[13px] text-[#FFB0A6]">{error}</p>}
        {restart.length > 0 && (
          <div className="mx-4 mb-4 flex gap-2.5 rounded-xl border border-[rgba(255,159,90,0.3)] bg-[rgba(255,159,90,0.08)] px-3.5 py-3 text-[13px] text-[#C9D6EE]">
            <Svg d={ICON.restart} size={18} stroke={C.amber} /><span>{restart.map((o) => o.name).join(', ')} need{restart.length === 1 ? 's' : ''} a restart to finish.</span>
          </div>
        )}
        <div className={dialogFooter}>
          <button type="button" onClick={onClose} className={btnGhost}>{done || error ? 'Close' : 'Run in background'}</button>
          {restart.length > 0 && <button type="button" disabled={!done || !!active} onClick={() => void os.power('restart')} className={btnPrimary}>Restart now</button>}
        </div>
      </>}
    </Dialog>
  )
}

/** H2: set up a newly connected device. Only the driver the kernel bound is a real choice today. */
export function DeviceSetupDialog({ device, onClose }: { device: HwDevice; onClose: () => void }) {
  const [offers] = useResource(os.hwDriverUpdates)
  const mine = offers.state === 'ok' ? offers.value.filter((o) => o.device_id === device.id) : []
  const [pick, setPick] = useState<string>('basic')
  const [installing, setInstalling] = useState<DriverOffer[] | null>(null)
  if (installing) return <DriverInstallDialog offers={installing} onClose={onClose} />
  const chosen = mine.find((o) => o.id === pick)
  return (
    <Dialog width={640} onClose={onClose} className="rounded-[20px]">
      {(tid) => <>
        <div className="flex items-center gap-[18px] border-b border-[rgba(127,178,255,0.12)] px-7 py-6">
          <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-[rgba(31,107,255,0.18)]"><Svg d={KIND_ICON[device.kind]} size={32} stroke="#7FB2FF" width={1.8} /></span>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[11px] tracking-[0.08em] text-[#18D4F0]">NEW DEVICE · {device.bus.toUpperCase()}</span>
            <h2 id={tid} className="m-0 text-[21px] font-bold">Set up {device.name}</h2>
            <span className="text-[13px] text-[#8FA3C8]">{device.driver ? `It works now with the built-in ${device.driver} driver.` : 'No driver is in use for it yet.'}</span>
          </div>
        </div>
        <div role="radiogroup" aria-labelledby={tid} className="flex flex-col gap-2 px-6 py-5">
          {mine.map((o) => {
            const t = offerTag(o)
            return <OptionCard key={o.id} name="drv" checked={pick === o.id} onPick={() => setPick(o.id)} title={o.name} tag={<Tag text={t.tag} bg={t.bg} color={t.color} />} desc={o.summary}
              right={<span className="font-mono text-xs text-[#8FA3C8]">{formatBytes(o.size_bytes)}</span>} />
          })}
          <OptionCard name="drv" checked={pick === 'basic'} onPick={() => setPick('basic')} title={device.driver ? `Keep the built-in driver (${device.driver})` : 'Leave it for now'}
            desc={device.driver ? 'Already working · nothing to download' : 'You can come back to it in Settings › Devices'} right={<span className="font-mono text-xs text-[#8FA3C8]">—</span>} />
          {offers.state === 'unavailable' && <p className="m-0 mt-1.5 text-[13px] text-[#8FA3C8]">Other drivers can't be looked up yet: there's no driver catalog on this computer. Driver updates arrive with WorkSuite OS updates.</p>}
        </div>
        <div className={dialogFooter}>
          <button type="button" onClick={onClose} className={btnGhost}>Not now</button>
          <button type="button" data-autofocus onClick={() => (chosen ? setInstalling([chosen]) : onClose())} className={btnPrimary}>{chosen ? 'Install driver' : device.driver ? 'Keep basic' : 'Done'}</button>
        </div>
      </>}
    </Dialog>
  )
}

/** H6: a device without a working driver. Fixes are the real actions available, most useful first. */
export function DeviceProblemDialog({ device, onClose, onOpenUpdates, onOpenDrivers }: { device: HwDevice; onClose: () => void; onOpenUpdates: () => void; onOpenDrivers: () => void }) {
  const [details, setDetails] = useState(false)
  const fixes: { title: string; desc: string; run?: () => void }[] = [
    { title: 'Check for WorkSuite OS updates', desc: 'Drivers ship with OS updates.', run: () => { onClose(); onOpenUpdates() } },
    { title: 'Look for a driver', desc: 'See the drivers this computer uses and any driver updates.', run: () => { onClose(); onOpenDrivers() } },
    { title: 'Unplug it and plug it back in', desc: 'Some devices only start after reconnecting.' },
  ]
  return (
    <Dialog width={640} onClose={onClose} className="rounded-[20px]">
      {(tid) => <>
        <div className="flex items-center gap-[18px] border-b border-[rgba(127,178,255,0.12)] px-7 py-6">
          <span className="relative flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-[rgba(255,159,90,0.14)]">
            <Svg d={KIND_ICON[device.kind]} size={30} stroke={C.amber} width={1.8} />
            <span className="absolute -right-1 -bottom-1 flex h-[22px] w-[22px] items-center justify-center rounded-full border-[3px] border-[#0F2350] bg-[#FF8A7A] text-xs font-bold text-[#0F2350]">!</span>
          </span>
          <div className="flex flex-col gap-1">
            <h2 id={tid} className="m-0 text-[21px] font-bold">{device.name} isn't working yet</h2>
            <span className="text-[13px] text-[#8FA3C8]">{deviceSub(device)} · no driver is in use for it.</span>
          </div>
        </div>
        <div className="flex flex-col gap-2 px-6 py-5">
          <span className="mb-1 text-[13px] text-[#C9D6EE]">Try these, most likely fix first:</span>
          {fixes.map((f, i) => {
            const inner = <>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold" style={{ background: i === 0 ? C.blue : 'rgba(127,178,255,0.15)' }}>{i + 1}</span>
              <span className="flex flex-1 flex-col gap-0.5 text-left"><span className="text-sm font-semibold">{f.title}</span><span className="text-xs text-[#8FA3C8]">{f.desc}</span></span>
              {f.run && <Svg d="M9 6l6 6-6 6" size={16} stroke={C.muted} />}
            </>
            const cls = 'flex items-center gap-3.5 rounded-xl border px-4 py-3.5'
            const style = { borderColor: i === 0 ? C.blue : 'rgba(127,178,255,0.14)', background: i === 0 ? 'rgba(31,107,255,0.12)' : 'transparent' }
            return f.run
              ? <button key={f.title} type="button" data-autofocus={i === 0 || undefined} onClick={f.run} className={`${cls} cursor-pointer hover:bg-white/[0.04]`} style={style}>{inner}</button>
              : <div key={f.title} className={cls} style={style}>{inner}</div>
          })}
          {details && <dl className="m-0 mt-1 grid grid-cols-[120px_1fr] gap-y-1 font-mono text-xs text-[#C9D6EE]"><dt className="text-[#8FA3C8]">Bus</dt><dd className="m-0">{device.bus.toUpperCase()} {device.id.replace(/^\w+:/, '')}</dd><dt className="text-[#8FA3C8]">Vendor:product</dt><dd className="m-0">{device.ids}</dd><dt className="text-[#8FA3C8]">Driver</dt><dd className="m-0">none bound</dd></dl>}
        </div>
        <div className={`${dialogFooter} justify-between`}>
          <button type="button" aria-expanded={details} onClick={() => setDetails((v) => !v)} className={linkBtn}>{details ? 'Hide technical details' : 'Show technical details'}</button>
          <button type="button" onClick={onClose} className={btnGhost}>Close</button>
        </div>
      </>}
    </Dialog>
  )
}

/** H1: watch for newly connected devices (poll the bridge) and toast them. */
export function DeviceWatcher({ onOpenUpdates, onOpenDrivers }: { onOpenUpdates: () => void; onOpenDrivers: () => void }) {
  const [toasts, setToasts] = useState<HwDevice[]>([])
  const [setup, setSetup] = useState<HwDevice | null>(null)
  const [problem, setProblem] = useState<HwDevice | null>(null)
  useEffect(() => {
    let prev: HwDevice[] | null = null
    let stop = false
    const poll = () => void os.hwDevices().then((r) => {
      if (stop || !r.ok) return
      const fresh = newDevices(prev, r.value)
      prev = r.value
      if (fresh.length) setToasts((t) => [...t, ...fresh].slice(-3))
    }).catch(() => {})
    poll()
    const t = setInterval(poll, 4000)
    return () => { stop = true; clearInterval(t) }
  }, [])
  useEffect(() => { if (!toasts.length) return; const t = setTimeout(() => setToasts((x) => x.slice(1)), 12_000); return () => clearTimeout(t) }, [toasts])
  const drop = (d: HwDevice) => setToasts((t) => t.filter((x) => x.id !== d.id))
  return <>
    {toasts.length > 0 && (
      <div className="pointer-events-auto flex w-full flex-col gap-2.5">
        {toasts.map((d) => {
          const ok = !!d.driver
          return (
            <div key={d.id} role="status" className="flex gap-3.5 rounded-2xl border border-[rgba(127,178,255,0.22)] bg-[rgba(10,24,56,0.96)] p-4 text-[#E8EEFA] shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
              <span className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[11px]" style={{ background: ok ? 'rgba(95,211,154,0.16)' : 'rgba(255,159,90,0.14)' }}><Svg d={KIND_ICON[d.kind]} size={22} stroke={ok ? C.green : C.amber} /></span>
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="truncate text-sm font-semibold">{ok ? `${d.name} is ready` : `${d.name} needs a driver`}</span>
                <span className="text-[13px] text-[#8FA3C8]">{ok ? `Set up automatically · ${d.bus.toUpperCase()} · ${d.driver}` : `Connected · ${d.bus.toUpperCase()} · no driver in use`}</span>
              </div>
              <button type="button" onClick={() => { drop(d); if (ok) setSetup(d); else setProblem(d) }} className={`${linkBtn} self-center whitespace-nowrap`}>{ok ? 'Set up…' : 'Fix…'}</button>
              <button type="button" aria-label="Dismiss" onClick={() => drop(d)} className="flex h-6 w-6 cursor-pointer items-center justify-center self-start rounded-md text-base leading-none text-[#8FA3C8] hover:bg-white/10 hover:text-white">×</button>
            </div>
          )
        })}
      </div>
    )}
    {setup && <DeviceSetupDialog device={setup} onClose={() => setSetup(null)} />}
    {problem && <DeviceProblemDialog device={problem} onClose={() => setProblem(null)} onOpenUpdates={onOpenUpdates} onOpenDrivers={onOpenDrivers} />}
  </>
}
