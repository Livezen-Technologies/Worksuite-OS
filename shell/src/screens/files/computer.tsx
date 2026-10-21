// Files › This Computer (#63): disks, partitions and drives with their space, and mount / unmount / eject.
// Data and actions come from electron/volumes.ts (udisks2); the list refreshes when udisks reports a change.
import { useCallback, useEffect, useState } from 'react'
import { AnimatedProgress } from '../../components/AnimatedProgress'
import { formatBytes, os, type DiskVolume } from '../../lib/os'
import { peripheralsApi } from '../../lib/peripheralsApi'
import { t, type MessageKey } from '../../i18n'
import { C, Modal, P, Svg } from './parts'

const ERRORS = ['auth_cancelled', 'not_authorized', 'busy', 'not_mounted', 'already_mounted', 'gone', 'unreadable', 'locked', 'system', 'not_removable', 'unavailable', 'bad_passphrase'] as const
/** A volume error code → the sentence shown for it. */
export const volError = (code: string) => t(((ERRORS as readonly string[]).includes(code) ? `files.vol.err.${code}` : 'files.vol.err.failed') as MessageKey)

/** The name a volume is listed under: the system disk, its label, else its size and drive model. */
export function volName(v: Pick<DiskVolume, 'kind' | 'label' | 'size' | 'model' | 'mountpoint'>) {
  if (v.kind === 'system' && v.mountpoint === '/') return v.label || t('files.vol.system')
  return v.label || t('files.vol.unnamed', { size: formatBytes(v.size) })
}

const DISK = 'M3 6h18v12H3zM7 14h.01M11 14h6'
const DISC = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4'
const LOCK = 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3'

export function ComputerView({ onOpen, onChanged }: { onOpen: (root: string) => void; onChanged: () => void }) {
  const [vols, setVols] = useState<DiskVolume[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const [unlock, setUnlock] = useState<DiskVolume | null>(null)
  const load = useCallback(() => void os.filesVolumes().then((r) => { if (r.ok) { setVols(r.value); setFailed(null) } else setFailed(r.error) }), [])
  useEffect(() => { load(); return os.onFilesVolumes(() => { load(); onChanged() }) }, [load]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (v: DiskVolume, what: 'mount' | 'unmount' | 'eject') => {
    setBusy(v.device); setMsg(null)
    const r = what === 'mount' ? await os.filesVolMount(v.device) : what === 'unmount' ? await os.filesVolUnmount(v.device) : await os.filesVolEject(v.device)
    setBusy(null); load(); onChanged()
    if (!r.ok) { setMsg({ text: volError(r.error), error: true }); return }
    if (what === 'mount' && typeof r.value === 'string' && r.value) onOpen(r.value)
    if (what === 'eject') setMsg({ text: t('files.vol.ejected', { name: volName(v) }), error: false })
  }
  const open = (v: DiskVolume) => { if (v.root) onOpen(v.root); else if (v.mountpoint) setMsg({ text: t('files.vol.err.not_browsable'), error: true }); else void act(v, 'mount') }

  if (failed) return <p role="alert" className="p-6 text-sm" style={{ color: '#FF8A7A' }}>{failed === 'unavailable' ? t('files.vol.unavailable') : volError(failed)}</p>
  if (!vols) return <p className="p-6 text-sm" style={{ color: C.muted }}>{t('common.loading')}</p>
  const groups: [string, DiskVolume[]][] = [
    [t('files.vol.sectionDisks'), vols.filter((v) => v.kind === 'system' || v.kind === 'internal')],
    [t('files.vol.sectionRemovable'), vols.filter((v) => v.kind === 'removable' || v.kind === 'optical')],
  ]
  const btnCls = 'flex h-[30px] cursor-pointer items-center rounded-lg px-3 text-[12px] disabled:cursor-default disabled:opacity-40'
  return (
    <div className="flex flex-1 flex-col gap-4 overflow-auto px-6 py-[22px]">
      {msg && <p role={msg.error ? 'alert' : 'status'} className="m-0 rounded-xl px-4 py-3 text-[13px]" style={{ background: msg.error ? 'rgba(255,138,122,0.1)' : 'rgba(31,107,255,0.08)', color: msg.error ? '#FFB4A8' : C.soft }}>{msg.text}</p>}
      {vols.length === 0 && <p className="text-sm" style={{ color: C.muted }}>{t('files.vol.none')}</p>}
      {groups.filter(([, l]) => l.length).map(([name, list]) => (
        <section key={name} aria-label={name} className="flex flex-col gap-2.5">
          <span className="text-xs" style={{ color: C.muted }}>{name}</span>
          <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0">
            {list.map((v) => {
              const used = v.total != null && v.free != null ? v.total - v.free : null
              const label = volName(v)
              return (
                <li key={`${v.device}:${v.mountpoint ?? ""}`} className="flex flex-col gap-2 rounded-xl px-4 py-3" style={{ background: C.card, border: `1px solid ${C.line}` }}>
                  <button type="button" onClick={() => open(v)} disabled={busy === v.device || v.locked} title={[v.model, v.device, v.fstype].filter(Boolean).join(' · ')}
                    className="flex cursor-pointer items-center gap-3 border-0 bg-transparent p-0 text-left disabled:cursor-default" style={{ color: C.text }}>
                    <Svg d={v.kind === 'optical' ? DISC : v.kind === 'removable' ? P.usb : v.kind === 'system' ? P.home : DISK} size={26} stroke={C.cyan} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-[14px] font-semibold">{label}</span>
                      <span className="truncate text-xs" style={{ color: C.muted }}>
                        {v.locked ? t('files.vol.locked', { size: formatBytes(v.size) })
                          : v.total != null && v.free != null ? t('files.vol.free', { free: formatBytes(v.free), total: formatBytes(v.total) })
                          : v.mountpoint ? formatBytes(v.size) : t('files.vol.notMounted', { size: formatBytes(v.size) })}
                        {v.readOnly ? ` · ${t('files.vol.readOnly')}` : ''}
                      </span>
                    </span>
                    {v.encrypted && <span className="ml-auto" title={t('files.diskEncrypted')}><Svg d={LOCK} size={14} stroke={C.muted} /></span>}
                  </button>
                  {used != null && <AnimatedProgress value={Math.round((used / Math.max(1, v.total!)) * 100)} label={t('files.vol.usage', { name: label })} height={5} shimmer={false} />}
                  <div className="flex flex-wrap gap-2">
                    {v.locked ? <button type="button" className={btnCls} style={{ border: '1px solid rgba(127,178,255,0.25)', color: C.text }} disabled={!peripheralsApi() || busy === v.device} onClick={() => setUnlock(v)}>{t('files.vol.unlock')}</button>
                      : v.mountpoint ? <button type="button" className={btnCls} style={{ background: C.blue, color: '#FFFFFF' }} disabled={!v.root} onClick={() => open(v)}>{t('files.vol.open')}</button>
                      : <button type="button" className={btnCls} style={{ background: C.blue, color: '#FFFFFF' }} disabled={busy === v.device} onClick={() => void act(v, 'mount')}>{busy === v.device ? t('files.vol.working') : t('files.vol.mount')}</button>}
                    {v.mountpoint && v.kind !== 'system' && <button type="button" className={btnCls} style={{ border: '1px solid rgba(127,178,255,0.25)', color: C.text }} disabled={busy === v.device} onClick={() => void act(v, 'unmount')}>{busy === v.device ? t('files.vol.working') : t('files.vol.unmount')}</button>}
                    {(v.kind === 'removable' || v.kind === 'optical') && <button type="button" aria-label={t('files.eject', { name: label })} className={btnCls} style={{ border: '1px solid rgba(127,178,255,0.25)', color: C.text }} disabled={busy === v.device} onClick={() => void act(v, 'eject')}>{`⏏ ${t('files.vol.eject')}`}</button>}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      {unlock && <UnlockDialog vol={unlock} onDone={(err) => { setUnlock(null); load(); onChanged(); if (err) setMsg({ text: volError(err), error: true }) }} />}
    </div>
  )
}

function UnlockDialog({ vol, onDone }: { vol: DiskVolume; onDone: (error: string | null) => void }) {
  const [pw, setPw] = useState('')
  const [working, setWorking] = useState(false)
  const submit = async () => {
    const api = peripheralsApi()
    if (!api || !pw) return
    setWorking(true)
    const r = await api.volUnlock(vol.device, pw)
    setPw('')
    onDone(r.available ? null : r.reason === 'bad_passphrase' ? 'bad_passphrase' : r.reason === 'storage_busy' ? 'busy' : r.reason === 'not_authorized' ? 'not_authorized' : 'failed')
  }
  return (
    <Modal label={t('files.vol.unlockTitle', { name: volName(vol) })}>
      <span className="text-[15px] font-semibold">{t('files.vol.unlockTitle', { name: volName(vol) })}</span>
      <input type="password" autoFocus aria-label={t('files.vol.passphrase')} placeholder={t('files.vol.passphrase')} value={pw} onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') onDone(null) }}
        className="box-border h-9 rounded-lg px-3 text-sm outline-none" style={{ background: 'var(--ws-g-field)', border: '1px solid rgba(127,178,255,0.25)', color: C.text }} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => onDone(null)} className="h-8 cursor-pointer rounded-lg px-3 text-[13px]" style={{ color: C.link }}>{t('common.cancel')}</button>
        <button type="button" disabled={!pw || working} onClick={() => void submit()} className="h-8 cursor-pointer rounded-lg px-3 text-[13px] font-semibold disabled:opacity-40" style={{ background: C.blue, color: '#FFFFFF' }}>{t('files.vol.unlock')}</button>
      </div>
    </Modal>
  )
}
