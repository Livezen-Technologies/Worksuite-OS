// Settings › Printers (WSOS-INT-006, issue #51): the printers CUPS knows with their state and problems, adding one
// (discovered on the network or USB, or by address) with driver detection, the default printer, preferences, pausing,
// test pages, removing, and the print queue. Everything goes through electron/printers.ts; outside Electron the page
// says printing is unavailable instead of showing sample data.
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { C, Dialog, Svg, btnGhost, btnPrimary, card, chip, dialogFooter, field, rowLine, sectionLabel } from '../../components/Dk'
import { addressUri, peripheralsApi, type AddressKind, type Avail, type FoundPrinter, type PeripheralsApi, type PrintJob, type PrinterDriver, type PrinterInfo, type PrinterPrefs } from '../../lib/peripheralsApi'
import { reasonText } from '../PeripheralSettings'
import { Empty } from '../Hardware'
import { t, type MessageKey } from '../../i18n'
import { H1, Note } from './ui'

const PRINTER = 'M6 9V3h12v6M6 18H4v-7h16v7h-2M8 14h8v7H8z'
const STATE_TONE: Record<PrinterInfo['state'], string> = { idle: C.green, printing: C.cyan, paused: '#FFB98A', unknown: C.muted }
const small = `${btnGhost} px-3 py-1.5 text-[13px]`
const POLL_MS = 10_000

function usePoll<T>(call: (api: PeripheralsApi) => Promise<Avail<T>>): { r: Avail<T> | null; reload: () => void } {
  const [r, setR] = useState<Avail<T> | null>(null)
  const reload = useCallback(() => {
    const api = peripheralsApi()
    if (!api) { setR({ available: false, reason: 'service_unavailable' }); return }
    void call(api).then(setR).catch(() => setR({ available: false, reason: 'service_unavailable' }))
  }, [call])
  useEffect(() => { reload(); const id = setInterval(reload, POLL_MS); return () => clearInterval(id) }, [reload])
  return { r, reload }
}
const printersCall = (a: PeripheralsApi) => a.printers()
const queueCall = (a: PeripheralsApi) => a.printQueue()

export function PrintersPanel() {
  const api = peripheralsApi()
  const list = usePoll<PrinterInfo[]>(printersCall)
  const queue = usePoll<{ jobs: PrintJob[] }>(queueCall)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [prefsFor, setPrefsFor] = useState<PrinterInfo | null>(null)
  const [removing, setRemoving] = useState<PrinterInfo | null>(null)

  /** One action on a printer or job: shows progress on its button, then the outcome. */
  const run = async (key: string, call: () => Promise<Avail<unknown>>, done: string) => {
    setBusy(key); setErr(null); setMsg(null)
    const r = await call().catch(() => ({ available: false as const, reason: 'service_unavailable' }))
    setBusy(null)
    if (r.available) setMsg(done); else setErr(reasonText(r.reason))
    list.reload(); queue.reload()
  }
  const label = (p: PrinterInfo) => p.description || p.name.replace(/_/g, ' ')
  const printers = list.r?.available ? list.r.value : []

  return <>
    <H1 action={api && <button type="button" onClick={() => setAdding(true)} className={`${btnPrimary} px-4 py-2 text-[13px]`}>{t('per.print.add')}</button>}>{t('settings.nav.Printers')}</H1>
    {err && <p role="alert" className="m-0 text-[13px] text-[#FFB98A]">{err}</p>}
    {msg && <p role="status" className="m-0 text-[13px] text-[#7FD8A6]">{msg}</p>}
    {!list.r ? <Empty title={t('settings.printers.reading')} /> : !list.r.available ? <Empty title={t('prn.unavailable')}>{reasonText(list.r.reason)}</Empty> : printers.length === 0 ? (
      <Empty title={t('settings.printers.none')}>{t('prn.noneHint')}</Empty>
    ) : (
      <ul aria-label={t('settings.nav.Printers')} className={`${card} m-0 list-none overflow-hidden p-0`}>
        {printers.map((p) => (
          <li key={p.name} className={`flex flex-wrap items-center gap-3.5 px-[18px] py-[13px] ${rowLine}`}>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[rgba(94,115,156,0.3)]"><Svg d={PRINTER} size={18} stroke="#C9D6EE" /></span>
            <span className="flex min-w-[180px] flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-2 text-sm font-medium">{label(p)}{p.isDefault && <span className={chip}>{t('settings.printers.default')}</span>}</span>
              <span className="text-xs" style={{ color: STATE_TONE[p.state] }}>{t(`prn.state.${p.state}` as MessageKey)}{p.message ? ` · ${p.message}` : ''}</span>
              {p.location && <span className="text-xs text-[#8FA3C8]">{p.location}</span>}
            </span>
            <span className="flex flex-wrap gap-2">
              {!p.isDefault && <button type="button" disabled={!!busy} onClick={() => void run(`def:${p.name}`, () => api!.setDefaultPrinter(p.name), t('prn.defaultSet', { name: label(p) }))} className={small}>{t('prn.makeDefault')}</button>}
              <button type="button" disabled={!!busy} onClick={() => void run(`pause:${p.name}`, () => api!.pausePrinter(p.name, p.state !== 'paused'), t(p.state === 'paused' ? 'prn.resumed' : 'prn.paused', { name: label(p) }))} className={small}>
                {busy === `pause:${p.name}` ? t('prn.working') : t(p.state === 'paused' ? 'prn.resume' : 'prn.pause')}
              </button>
              <button type="button" disabled={!!busy} onClick={() => void run(`test:${p.name}`, () => api!.printTestPage(p.name), t('prn.testSent', { name: label(p) }))} className={small}>
                {busy === `test:${p.name}` ? t('prn.working') : t('prn.testPage')}
              </button>
              <button type="button" disabled={!!busy} onClick={() => setPrefsFor(p)} className={small}>{t('prn.prefs')}</button>
              <button type="button" disabled={!!busy} onClick={() => setRemoving(p)} className={small}>{t('prn.remove')}</button>
            </span>
          </li>
        ))}
      </ul>
    )}

    <section aria-label={t('per.print.title')} className="flex flex-col gap-2">
      <h2 className={`m-0 font-normal ${sectionLabel}`}>{t('per.print.title')}</h2>
      {!queue.r ? null : !queue.r.available ? <p className={`${card} m-0 px-[18px] py-3 text-[13px] text-[#8FA3C8]`}>{reasonText(queue.r.reason)}</p> : queue.r.value.jobs.length === 0 ? (
        <p className={`${card} m-0 px-[18px] py-3 text-[13px] text-[#8FA3C8]`}>{t('per.print.noJobs')}</p>
      ) : (
        <div className={card}>
          {queue.r.value.jobs.map((j) => (
            <div key={j.id} className={`flex flex-wrap items-center gap-3 px-[18px] py-3 ${rowLine}`}>
              <span className="min-w-[180px] flex-1 text-[13px]">{t('per.print.job', { id: j.id, printer: j.printer, user: j.user })}{j.held ? ` · ${t('prn.held')}` : ''}</span>
              <button type="button" disabled={!!busy} onClick={() => void run(`hold:${j.id}`, () => api!.holdJob(j.id, !j.held), t(j.held ? 'prn.jobReleased' : 'prn.jobHeld', { id: j.id }))} className={small}>{t(j.held ? 'prn.release' : 'prn.hold')}</button>
              <button type="button" disabled={!!busy} onClick={() => void run(`cancel:${j.id}`, () => api!.cancelJob(j.id), t('prn.jobCancelled', { id: j.id }))} className={small}>{t('common.cancel')}</button>
            </div>
          ))}
        </div>
      )}
    </section>
    <Note>{t('prn.note')}</Note>

    {adding && api && <AddPrinterDialog api={api} onClose={() => setAdding(false)} onAdded={(n) => { setAdding(false); setErr(null); setMsg(t('per.print.added', { name: n })); list.reload() }} />}
    {prefsFor && api && <PrefsDialog api={api} printer={prefsFor} title={label(prefsFor)} onClose={() => setPrefsFor(null)} onSaved={() => { setPrefsFor(null); setErr(null); setMsg(t('prn.prefsSaved')) }} />}
    {removing && api && (
      <Dialog onClose={() => setRemoving(null)} width={420} alert>
        {(tid) => <>
          <div className="flex flex-col gap-2 px-5 py-4">
            <h2 id={tid} className="m-0 text-base font-semibold">{t('prn.removeTitle', { name: label(removing) })}</h2>
            <p className="m-0 text-[13px] text-[#C9D6EE]">{t('prn.removeBody')}</p>
          </div>
          <div className={dialogFooter}>
            <button type="button" onClick={() => setRemoving(null)} className={`${btnGhost} px-4 py-2 text-[13px]`}>{t('common.cancel')}</button>
            <button type="button" onClick={() => { const p = removing; setRemoving(null); void run(`rm:${p.name}`, () => api.removePrinter(p.name), t('prn.removed', { name: label(p) })) }} className={`${btnPrimary} px-4 py-2 text-[13px]`}>{t('prn.remove')}</button>
          </div>
        </>}
      </Dialog>
    )}
  </>
}

const KINDS: AddressKind[] = ['ipp', 'ipps', 'socket', 'lpd']

function AddPrinterDialog({ api, onClose, onAdded }: { api: PeripheralsApi; onClose: () => void; onAdded: (name: string) => void }) {
  const [found, setFound] = useState<FoundPrinter[] | null>(null)
  const [findErr, setFindErr] = useState<string | null>(null)
  const [mode, setMode] = useState<'found' | 'address'>('found')
  const [picked, setPicked] = useState<FoundPrinter | null>(null)
  const [kind, setKind] = useState<AddressKind>('ipp')
  const [host, setHost] = useState('')
  const [queue, setQueue] = useState('')
  const [model, setModel] = useState('')
  const [name, setName] = useState('')
  const [drivers, setDrivers] = useState<PrinterDriver[] | null>(null)
  const [driver, setDriver] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<'drivers' | 'add' | null>(null)

  const search = useCallback(() => {
    setFound(null); setFindErr(null)
    void api.findPrinters().then((r) => { if (r.available) setFound(r.value); else { setFound([]); setFindErr(reasonText(r.reason)) } })
  }, [api])
  useEffect(search, [search])

  const typed = mode === 'address' && host.trim() ? addressUri(kind, host, queue) : null
  const uri = mode === 'found' ? picked?.uri ?? null : typed
  const findDrivers = useCallback(async (u: string, mm: string, id: string) => {
    setBusy('drivers'); setDrivers(null); setDriver('')
    const r = await api.printerDrivers(u, mm, id)
    setBusy(null)
    if (!r.available) { setErr(reasonText(r.reason)); setDrivers([]); return }
    setDrivers(r.value); setDriver(r.value.find((d) => d.recommended)?.id ?? '')
  }, [api])
  // A picked device: its drivers (IPP Everywhere for driverless printers, PPDs matching its model otherwise).
  useEffect(() => { if (mode === 'found' && picked) void findDrivers(picked.uri, picked.makeModel ?? '', picked.deviceId ?? '') }, [mode, picked, findDrivers])
  // A typed address: IPP answers for itself; JetDirect and LPD need the model to find a driver.
  useEffect(() => {
    if (mode !== 'address') return
    setDrivers(null); setDriver('')
    if (typed && /^ipps?:/.test(typed)) { setDrivers([{ id: 'everywhere', label: 'IPP Everywhere', recommended: true }]); setDriver('everywhere') }
  }, [mode, typed])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!uri) { setErr(t('prn.badAddress')); return }
    if (!driver) { setErr(t('prn.pickDriver')); return }
    setBusy('add'); setErr(null)
    const display = name.trim() || (mode === 'found' ? picked?.name ?? '' : host.trim())
    const r = await api.addPrinter(uri, display, driver)
    setBusy(null)
    // #51: the reason in the person's language, then what CUPS / lpadmin actually said.
    if (r.available) onAdded(display); else setErr(r.detail ? `${reasonText(r.reason)} ${t('prn.cupsSaid', { detail: r.detail })}` : reasonText(r.reason))
  }
  const tab = (m: 'found' | 'address') => `${btnGhost} px-3.5 py-1.5 text-[13px] ${mode === m ? 'bg-white/[0.08]' : ''}`

  return (
    <Dialog onClose={onClose} width={560}>
      {(tid) => <form onSubmit={(e) => void submit(e)} noValidate>
        <div className="flex max-h-[70vh] flex-col gap-3 overflow-auto px-5 py-4">
          <h2 id={tid} className="m-0 text-base font-semibold">{t('per.print.add')}</h2>
          <div role="tablist" aria-label={t('per.print.add')} className="flex gap-2">
            <button type="button" role="tab" aria-selected={mode === 'found'} onClick={() => { setMode('found'); setErr(null) }} className={tab('found')}>{t('prn.tabFound')}</button>
            <button type="button" role="tab" aria-selected={mode === 'address'} onClick={() => { setMode('address'); setErr(null) }} className={tab('address')}>{t('prn.tabAddress')}</button>
          </div>
          {mode === 'found' ? <>
            <div className="flex items-center justify-between gap-3">
              <p className="m-0 text-[13px] text-[#8FA3C8]">{t('prn.foundHint')}</p>
              <button type="button" onClick={search} disabled={found === null} className={small}>{t('prn.searchAgain')}</button>
            </div>
            {found === null ? <span role="status" className="text-[13px]">{t('per.print.searching')}</span> : findErr ? <p role="alert" className="m-0 text-[13px] text-[#FFB98A]">{findErr}</p> : found.length === 0 ? <span className="text-[13px] text-[#8FA3C8]">{t('per.print.noneFound')}</span> : (
              <div className={card}>
                {found.map((p) => (
                  <label key={p.uri} className={`flex cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-sm ${rowLine}`}>
                    <input type="radio" name="found-printer" checked={picked?.uri === p.uri} onChange={() => { setPicked(p); setName(p.name); setErr(null) }} />
                    <span className="flex flex-1 flex-col"><span>{p.name}</span><span className="text-xs text-[#8FA3C8]">{t(p.kind === 'usb' ? 'prn.kindUsb' : 'prn.kindNetwork')}{p.makeModel && p.makeModel !== p.name ? ` · ${p.makeModel}` : ''}</span></span>
                  </label>
                ))}
              </div>
            )}
          </> : <>
            <label className="flex flex-col gap-1.5 text-[13px]">{t('prn.protocol')}
              <select value={kind} onChange={(e) => setKind(e.target.value as AddressKind)} className={field}>
                {KINDS.map((k) => <option key={k} value={k}>{t(`prn.proto.${k}` as MessageKey)}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px]">{t('prn.host')}
              <input value={host} onChange={(e) => { setHost(e.target.value); setErr(null) }} placeholder="192.168.1.20" aria-invalid={!!host.trim() && !typed} className={field} />
            </label>
            {!!host.trim() && !typed && <p role="alert" className="m-0 text-[13px] text-[#FFB98A]">{t('prn.badAddress')}</p>}
            {kind !== 'socket' && <label className="flex flex-col gap-1.5 text-[13px]">{t('prn.queue')}
              <input value={queue} onChange={(e) => setQueue(e.target.value)} placeholder={kind === 'lpd' ? 'queue' : 'ipp/print'} className={field} />
            </label>}
            {typed && !/^ipps?:/.test(typed) && <div className="flex items-end gap-2">
              <label className="flex flex-1 flex-col gap-1.5 text-[13px]">{t('prn.model')}
                <input value={model} onChange={(e) => setModel(e.target.value)} className={field} />
              </label>
              <button type="button" disabled={!model.trim() || busy === 'drivers'} onClick={() => void findDrivers(typed, model.trim(), '')} className={`${btnGhost} px-3.5 py-2 text-[13px]`}>{t('prn.findDrivers')}</button>
            </div>}
          </>}
          {/* #51: the Driver row is always there (disabled until there is something to pick), so the fields below
              do not move while an address is typed. */}
          {drivers && drivers.length === 0 ? <p className="m-0 text-[13px] text-[#FFB98A]">{t('prn.noDrivers')}</p> : (
            <label className="flex flex-col gap-1.5 text-[13px]">{t('prn.driver')}
              <select value={driver} disabled={!drivers?.length} onChange={(e) => setDriver(e.target.value)} className={field} data-testid="printer-driver">
                {drivers?.length ? drivers.map((d) => <option key={d.id} value={d.id}>{d.recommended ? t('prn.recommended', { name: d.label }) : d.label}</option>)
                  : <option value="">{busy === 'drivers' ? t('prn.lookingDrivers') : mode === 'address' ? t('prn.driverPending') : ''}</option>}
              </select>
            </label>
          )}
          {busy === 'drivers' && <span role="status" className="sr-only">{t('prn.lookingDrivers')}</span>}
          <label className="flex flex-col gap-1.5 text-[13px]">{t('per.print.name')}
            <input value={name} maxLength={127} onChange={(e) => setName(e.target.value)} className={field} />
          </label>
          {err && <p role="alert" className="m-0 text-[13px] text-[#FFB98A]">{err}</p>}
        </div>
        <div className={dialogFooter}>
          <button type="button" onClick={onClose} className={`${btnGhost} px-4 py-2 text-[13px]`}>{t('common.cancel')}</button>
          <button type="submit" disabled={!uri || !driver || !!busy} className={`${btnPrimary} px-4 py-2 text-[13px]`}>{busy === 'add' ? t('per.print.adding') : t('per.print.add')}</button>
        </div>
      </form>}
    </Dialog>
  )
}

const PREF_LABELS: Record<string, MessageKey> = {
  PageSize: 'prn.pref.paper', ColorModel: 'prn.pref.color', 'print-color-mode': 'prn.pref.color', Duplex: 'prn.pref.duplex',
  cupsPrintQuality: 'prn.pref.quality', OutputMode: 'prn.pref.quality', InputSlot: 'prn.pref.tray', MediaType: 'prn.pref.mediaType',
}
const ORIENT: [string, MessageKey][] = [['3', 'prn.orient.portrait'], ['4', 'prn.orient.landscape']]

function PrefsDialog({ api, printer, title, onClose, onSaved }: { api: PeripheralsApi; printer: PrinterInfo; title: string; onClose: () => void; onSaved: () => void }) {
  const [p, setP] = useState<PrinterPrefs | null>(null)
  const [vals, setVals] = useState<Record<string, string>>({})
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void api.printerPrefs(printer.name).then((r) => {
      if (!r.available) { setErr(reasonText(r.reason)); return }
      setP(r.value)
      setVals({ ...Object.fromEntries(r.value.options.map((o) => [o.key, o.current])), 'orientation-requested': r.value.orientation, copies: String(r.value.copies) })
    })
  }, [api, printer.name])
  const copies = Number(vals.copies)
  const copiesOk = Number.isInteger(copies) && copies >= 1 && copies <= 99
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!copiesOk) { setErr(t('prn.copiesRange')); return }
    setBusy(true); setErr(null)
    const r = await api.setPrinterPrefs(printer.name, vals)
    setBusy(false)
    if (r.available) onSaved(); else setErr(reasonText(r.reason))
  }
  return (
    <Dialog onClose={onClose} width={480}>
      {(tid) => <form onSubmit={(e) => void submit(e)} noValidate>
        <div className="flex flex-col gap-3 px-5 py-4">
          <h2 id={tid} className="m-0 text-base font-semibold">{t('prn.prefsTitle', { name: title })}</h2>
          {!p && !err && <span role="status" className="text-[13px]">{t('common.loading')}</span>}
          {p && <>
            {p.options.map((o) => (
              <label key={o.key} className="flex flex-col gap-1.5 text-[13px]">{PREF_LABELS[o.key] ? t(PREF_LABELS[o.key]) : o.label}
                <select value={vals[o.key] ?? o.current} onChange={(e) => setVals({ ...vals, [o.key]: e.target.value })} className={field}>
                  {o.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            ))}
            <label className="flex flex-col gap-1.5 text-[13px]">{t('prn.pref.orientation')}
              <select value={vals['orientation-requested']} onChange={(e) => setVals({ ...vals, 'orientation-requested': e.target.value })} className={field}>
                {ORIENT.map(([v, k]) => <option key={v} value={v}>{t(k)}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px]">{t('prn.pref.copies')}
              <input type="number" inputMode="numeric" min={1} max={99} value={vals.copies} aria-invalid={!copiesOk} onChange={(e) => setVals({ ...vals, copies: e.target.value.replace(/\D/g, '').slice(0, 2) })} className={field} />
            </label>
          </>}
          {err && <p role="alert" className="m-0 text-[13px] text-[#FFB98A]">{err}</p>}
        </div>
        <div className={dialogFooter}>
          <button type="button" onClick={onClose} className={`${btnGhost} px-4 py-2 text-[13px]`}>{t('common.cancel')}</button>
          <button type="submit" disabled={!p || busy} className={`${btnPrimary} px-4 py-2 text-[13px]`}>{busy ? t('prn.working') : t('prn.save')}</button>
        </div>
      </form>}
    </Dialog>
  )
}
