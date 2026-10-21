// Settings sections backed by electron/peripherals.ts: Bluetooth pairing (WSOS-INT-003), removable storage
// (WSOS-INT-004), power profiles and inhibitors (WSOS-INT-005), printers (WSOS-INT-006), input methods (WSOS-INT-011)
// and changes the server rejected (WSOS-SYN-004). Everything shown comes from the host; without the bridge each
// section says it is unavailable.
import { ErrorDetails } from '../components/ErrorDetails'
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Dialog, Switch, btnGhost, btnPrimary, card, dialogFooter, field, rowLine, sectionLabel } from '../components/Dk'
import { failureKind, knownReason, peripheralsApi, type Avail, type FailedChange, type Inhibitor, type InputState, type PeripheralsApi, type PowerProfiles, type Volume, type BtFound } from '../lib/peripheralsApi'
import { os } from '../lib/os'
import { t, type MessageKey } from '../i18n'

/** Settings › Devices additions: power, removable drives (with the organisation's USB policy), input methods. Printers have their own page (settings/Printers.tsx). */
export function DeviceExtras() {
  const [usb, setUsb] = useState<string | null>(null)
  useEffect(() => { void os.deviceInfo().then((d) => setUsb(d.policies?.usb_storage ?? null)).catch(() => setUsb(null)) }, [])
  return <><PowerSection /><StorageSection usbPolicy={usb} /><InputMethodsSection /></>
}

export function reasonText(reason: string): string {
  const k = knownReason(reason)
  return k ? t(`per.err.${k}` as MessageKey) : t('per.err.generic')
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3"><h2 className={`m-0 font-normal ${sectionLabel}`}>{title}</h2>{action}</div>
      {children}
    </section>
  )
}
const Line = ({ children }: { children: ReactNode }) => <div className={`flex items-center gap-3 px-[18px] py-3 ${rowLine}`}>{children}</div>
const Muted = ({ children }: { children: ReactNode }) => <p className={`${card} m-0 px-[18px] py-3 text-[13px] text-[#8FA3C8]`}>{children}</p>
const Err = ({ text }: { text: string | null }) => (text ? <p role="alert" className="m-0 text-[13px] text-[#FFB98A]">{text}</p> : null)

/** Loads one bridge call; `null` while loading. */
function useLoad<T>(call: ((api: PeripheralsApi) => Promise<Avail<T>>) | null): { r: Avail<T> | null; reload: () => void } {
  const [r, setR] = useState<Avail<T> | null>(null)
  const reload = useCallback(() => {
    const api = peripheralsApi()
    if (!api || !call) { setR({ available: false, reason: 'service_unavailable' }); return }
    void call(api).then(setR).catch(() => setR({ available: false, reason: 'service_unavailable' }))
  }, [call])
  useEffect(reload, [reload])
  return { r, reload }
}

// ---------- Bluetooth: add and remove devices ----------
const scanCall = (a: PeripheralsApi) => a.btScan()
export function BluetoothPairSection({ powered, paired, onChange }: { powered: boolean; paired: { address: string; name: string }[]; onChange: () => void }) {
  const [found, setFound] = useState<BtFound[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const api = peripheralsApi()
  const scan = async () => {
    if (!api) return
    setBusy('scan'); setErr(null)
    const r = await scanCall(api)
    setBusy(null)
    if (r.available) setFound(r.value); else setErr(reasonText(r.reason))
  }
  const pair = async (d: BtFound) => {
    if (!api) return
    setBusy(d.address); setErr(null)
    const r = await api.btPair(d.address)
    setBusy(null)
    if (r.available) { setFound((f) => f?.filter((x) => x.address !== d.address) ?? null); onChange() } else setErr(reasonText(r.reason))
  }
  const remove = async (address: string) => {
    if (!api) return
    const r = await api.btRemove(address)
    if (r.available) onChange(); else setErr(reasonText(r.reason))
  }
  return <>
    <Section title={t('per.bt.add')} action={<button type="button" disabled={!api || !powered || busy !== null} onClick={() => void scan()} className={`${btnGhost} px-3.5 py-2 text-[13px]`}>{busy === 'scan' ? t('per.bt.searching') : t('per.bt.search')}</button>}>
      <Err text={err} />
      {!api ? <Muted>{t('per.unavailable')}</Muted> : !powered ? <Muted>{t('per.bt.turnOn')}</Muted> : found === null ? <Muted>{t('per.bt.hint')}</Muted> : found.length === 0 ? <Muted>{t('per.bt.noneFound')}</Muted> : (
        <div className={card}>
          {found.map((d) => (
            <Line key={d.address}>
              <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm font-medium">{d.name || t('per.bt.unnamed')}</span><span className="text-xs text-[#8FA3C8]">{d.address}</span></span>
              <button type="button" disabled={busy !== null} onClick={() => void pair(d)} className={`${btnPrimary} px-3.5 py-2 text-[13px]`}>{busy === d.address ? t('per.bt.pairing') : t('per.bt.pair')}</button>
            </Line>
          ))}
        </div>
      )}
    </Section>
    {api && paired.length > 0 && (
      <Section title={t('per.bt.forget')}>
        <div className={card}>
          {paired.map((d) => (
            <Line key={d.address}><span className="flex-1 text-sm">{d.name}</span>
              <button type="button" onClick={() => void remove(d.address)} aria-label={t('common.removeName', { name: d.name })} className={`${btnGhost} px-3.5 py-2 text-[13px]`}>{t('common.remove')}</button>
            </Line>
          ))}
        </div>
      </Section>
    )}
  </>
}

// ---------- removable storage ----------
const volCall = (a: PeripheralsApi) => a.volumes()
export function StorageSection({ usbPolicy }: { usbPolicy: string | null }) {
  const { r, reload } = useLoad(volCall)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [unlock, setUnlock] = useState<Volume | null>(null)
  const api = peripheralsApi()
  const act = async (p: Promise<Avail<unknown>>, done: string) => {
    setErr(null); setMsg(null)
    const res = await p
    if (res.available) setMsg(done); else setErr(reasonText(res.reason))
    reload()
  }
  return (
    <Section title={t('per.storage.title')} action={<button type="button" onClick={reload} className={`${btnGhost} px-3.5 py-2 text-[13px]`}>{t('common.refresh')}</button>}>
      {usbPolicy === 'block' && <Muted>{t('per.storage.blocked')}</Muted>}
      {usbPolicy === 'read_only' && <Muted>{t('per.storage.readOnly')}</Muted>}
      <Err text={err} />
      {msg && <p role="status" className="m-0 text-[13px] text-[#7FD8A6]">{msg}</p>}
      {r === null ? <Muted>{t('common.loading')}</Muted> : !r.available ? <Muted>{reasonText(r.reason)}</Muted> : r.value.length === 0 ? <Muted>{t('per.storage.none')}</Muted> : (
        <div className={card}>
          {r.value.map((v) => {
            const name = v.label || v.device
            const locked = v.encrypted && !v.unlocked
            return (
              <Line key={v.device}>
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium">{name}</span>
                  <span className="text-xs text-[#8FA3C8]">{[v.size, v.fstype, locked ? t('per.storage.locked') : v.mountpoint ? t('per.storage.mountedAt', { path: v.mountpoint }) : t('per.storage.notMounted')].filter(Boolean).join(' · ')}</span>
                </span>
                {locked && <button type="button" onClick={() => setUnlock(v)} className={`${btnGhost} px-3.5 py-2 text-[13px]`}>{t('per.storage.unlock')}</button>}
                {!locked && !v.mountpoint && api && <button type="button" onClick={() => void act(api.volMount(v.unlocked ?? v.device), t('per.storage.mounted', { name }))} className={`${btnGhost} px-3.5 py-2 text-[13px]`}>{t('per.storage.mount')}</button>}
                {api && <button type="button" onClick={() => void act(api.volEject(v.device), t('per.storage.ejected', { name }))} className={`${btnPrimary} px-3.5 py-2 text-[13px]`}>{t('per.storage.eject')}</button>}
              </Line>
            )
          })}
        </div>
      )}
      {unlock && api && <UnlockDialog vol={unlock} onCancel={() => setUnlock(null)} onSubmit={async (pass) => {
        const res = await api.volUnlock(unlock.device, pass)
        if (res.available) { setUnlock(null); setMsg(t('per.storage.unlocked', { name: unlock.label || unlock.device })); reload(); return null }
        return reasonText(res.reason)
      }} />}
    </Section>
  )
}

function UnlockDialog({ vol, onCancel, onSubmit }: { vol: Volume; onCancel: () => void; onSubmit: (pass: string) => Promise<string | null> }) {
  const [pass, setPass] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true)
    const r = await onSubmit(pass)
    setBusy(false); setPass('')
    if (r) setErr(r)
  }
  return (
    <Dialog onClose={onCancel}>
      {(tid) => <form onSubmit={(e) => void submit(e)}>
        <div className="flex flex-col gap-3 px-5 py-4">
          <h2 id={tid} className="m-0 text-base font-semibold">{t('per.storage.unlockTitle', { name: vol.label || vol.device })}</h2>
          <label className="flex flex-col gap-1.5 text-[13px]">{t('per.storage.passphrase')}
            <input type="password" autoComplete="off" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} className={field} />
          </label>
          <Err text={err} />
        </div>
        <div className={dialogFooter}>
          <button type="button" onClick={onCancel} className={`${btnGhost} px-4 py-2 text-[13px]`}>{t('common.cancel')}</button>
          <button type="submit" disabled={!pass || busy} className={`${btnPrimary} px-4 py-2 text-[13px]`}>{t('per.storage.unlock')}</button>
        </div>
      </form>}
    </Dialog>
  )
}

// ---------- power ----------
const profCall = (a: PeripheralsApi) => a.powerProfiles()
const inhCall = (a: PeripheralsApi) => a.inhibitors()
const PROFILE_KEYS: Record<string, MessageKey> = { 'power-saver': 'per.power.saver', balanced: 'per.power.balanced', performance: 'per.power.performance' }
export function PowerSection() {
  const prof = useLoad<PowerProfiles>(profCall)
  const inh = useLoad<Inhibitor[]>(inhCall)
  const [err, setErr] = useState<string | null>(null)
  const set = async (name: string) => {
    const r = await peripheralsApi()?.setPowerProfile(name)
    if (r && !r.available) setErr(reasonText(r.reason)); else setErr(null)
    prof.reload()
  }
  const blocks = inh.r?.available ? inh.r.value.filter((i) => i.mode === 'block') : []
  return (
    <Section title={t('per.power.title')}>
      <Err text={err} />
      {prof.r === null ? <Muted>{t('common.loading')}</Muted> : !prof.r.available ? <Muted>{t('per.power.noProfiles')}</Muted> : (
        <div className={`${card} flex flex-col gap-2 px-[18px] py-3`} role="radiogroup" aria-label={t('per.power.mode')}>
          {prof.r.value.profiles.map((p) => (
            <label key={p} className="flex cursor-pointer items-center gap-2.5 text-sm">
              <input type="radio" name="power-profile" checked={prof.r?.available === true && prof.r.value.active === p} onChange={() => void set(p)} />
              {PROFILE_KEYS[p] ? t(PROFILE_KEYS[p]) : p}
            </label>
          ))}
          {prof.r.value.degraded && <span className="text-xs text-[#FFB98A]">{t('per.power.degraded', { reason: prof.r.value.degraded })}</span>}
        </div>
      )}
      {blocks.length > 0 && (
        <div className={card}>
          <Line><span className="text-[13px] font-semibold">{t('per.power.inhibitors')}</span></Line>
          {blocks.map((i, n) => <Line key={n}><span className="flex-1 text-[13px]">{t('per.power.inhibitor', { who: i.who, what: i.what })}{i.why ? ` — ${i.why}` : ''}</span></Line>)}
        </div>
      )}
    </Section>
  )
}

// ---------- input methods ----------
const imCall = (a: PeripheralsApi) => a.inputMethods()
const IM_KEYS: Record<string, MessageKey> = {
  'keyboard-us': 'per.im.us', m17n_si_wijesekera: 'per.im.siWijesekara', m17n_si_singlish: 'per.im.siPhonetic',
  m17n_ta_tamil99: 'per.im.taTamil99', m17n_ta_phonetic: 'per.im.taPhonetic',
}
export function InputMethodsSection() {
  const { r, reload } = useLoad<InputState>(imCall)
  const [err, setErr] = useState<string | null>(null)
  const toggle = async (id: string, on: boolean) => {
    if (!r?.available) return
    const next = on ? [...r.value.enabled, id] : r.value.enabled.filter((x) => x !== id)
    const res = await peripheralsApi()?.setInputMethods(next)
    if (res && !res.available) setErr(reasonText(res.reason)); else setErr(null)
    reload()
  }
  return (
    <Section title={t('per.im.title')}>
      <Err text={err} />
      {r === null ? <Muted>{t('common.loading')}</Muted> : !r.available ? <Muted>{reasonText(r.reason)}</Muted> : <>
        <div className={card}>
          {r.value.available.map((id) => (
            <Line key={id}>
              <span className="flex-1 text-sm">{IM_KEYS[id] ? t(IM_KEYS[id]) : id}</span>
              <Switch label={IM_KEYS[id] ? t(IM_KEYS[id]) : id} checked={r.value.enabled.includes(id)} disabled={id === 'keyboard-us'} onChange={(v) => void toggle(id, v)} />
            </Line>
          ))}
        </div>
        <Muted>{t('per.im.hint')}</Muted>
      </>}
    </Section>
  )
}

// ---------- sync: changes the server rejected ----------
export function SyncProblemsSection() {
  const [rows, setRows] = useState<FailedChange[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(() => {
    const api = peripheralsApi()
    if (!api) { setRows([]); return }
    void api.syncFailed().then((r) => setRows(r.ok ? r.value : [])).catch(() => setRows([]))
  }, [])
  useEffect(load, [load])
  if (!rows || rows.length === 0) return null
  const retry = async (id: string) => {
    const r = await peripheralsApi()?.syncRetry(id)
    if (r && !r.ok) setErr(t('per.err.generic')); else setErr(null)
    load()
  }
  return (
    <Section title={t('per.sync.title')}>
      <p className="m-0 text-[13px] text-[#8FA3C8]">{t('per.sync.hint')}</p>
      <Err text={err} />
      <div className={card}>
        {rows.map((f) => {
          const kind = failureKind(f.last_error)
          return (
            <Line key={f.mutation_id}>
              <span className="flex flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">{t('per.sync.record', { module: f.module, id: f.object_id })}</span>
                <span className="text-xs text-[#FFB98A]">{kind === 'permission' ? t('per.sync.permission') : kind === 'validation' ? t('per.sync.validation') : t('per.sync.other')}</span>
                <ErrorDetails details={f.last_error} />
              </span>
              <button type="button" onClick={() => void retry(f.mutation_id)} className={`${btnGhost} px-3.5 py-2 text-[13px]`}>{t('common.tryAgain')}</button>
            </Line>
          )
        })}
      </div>
    </Section>
  )
}
