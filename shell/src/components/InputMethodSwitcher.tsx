// Taskbar input-method switcher (#58). The only language control on the taskbar was fcitx5's own tray item, whose
// click (StatusNotifierItem.Activate) toggles fcitx5 for the focused text field; the taskbar had just taken the focus,
// so nothing happened, and its menu (Sinhala, Tamil) was a D-Bus menu the taskbar can't show. This button lists the
// enabled methods (Settings › Devices › Keyboard), shows the active one (ENG / සිං / தமி) and switches through
// fcitx5-remote (electron/peripherals.ts), starting fcitx5 when it isn't running. No restart.
import { useCallback, useEffect, useRef, useState } from 'react'
import { knownReason, peripheralsApi, type ImStatus, type PeripheralsApi } from '../lib/peripheralsApi'
import { IM_KEYS, imShortKey } from '../lib/inputMethods'
import { useT, type MessageKey } from '../i18n'
import { usePopupLift } from '../lib/popupLift'

/** Ctrl+Space switches too: the indicator follows by polling (fcitx5-remote -n is cheap). */
export const IM_POLL_MS = 4000

export function InputMethodSwitcher({ onOpenSettings, api: given, pollMs = IM_POLL_MS }: { onOpenSettings?: () => void; api?: PeripheralsApi | null; pollMs?: number }) {
  const t = useT()
  const api = given === undefined ? peripheralsApi() : given
  const [st, setSt] = useState<ImStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef<HTMLSpanElement>(null)

  const load = useCallback(async () => {
    const r = await api?.imStatus().catch(() => null)
    setSt(r?.available ? r.value : null)
  }, [api])
  useEffect(() => {
    if (!api) return
    void load()
    const id = setInterval(() => void load(), pollMs)
    return () => clearInterval(id)
  }, [api, load, pollMs])
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open])
  // Over the apps while open: the menu is drawn in the shell's window, which is below them otherwise (#62).
  usePopupLift(open, () => setOpen(false))

  // Nothing to switch between: only the US keyboard is on (or there is no bridge).
  if (!api || !st || st.enabled.length < 2) return null
  const name = (id: string) => (IM_KEYS[id] ? t(IM_KEYS[id]) : id)
  const current = st.running ? st.current : null
  const label = current ? t('im.switcher', { name: name(current) }) : t('im.notRunning')
  const pick = async (id: string) => {
    setBusy(true); setErr(null)
    const r = await api.setCurrentIm(id).catch(() => ({ available: false as const, reason: 'im_failed' }))
    setBusy(false)
    if (r.available) setOpen(false)
    else { const k = knownReason(r.reason); setErr(t(k ? (`per.err.${k}` as MessageKey) : 'per.err.generic')) }
    await load()
  }
  return (
    <span ref={ref} className="relative">
      <button type="button" data-testid="im-switcher" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen((v) => !v); setErr(null); void load() }}
        className={`flex h-9 min-w-9 cursor-pointer items-center justify-center rounded-[10px] px-1.5 text-xs font-semibold ${open ? 'bg-white/20' : 'hover:bg-white/10'} ${current ? 'text-[#E8EEFA]' : 'text-[#8FA3C8]'}`}>
        {t(imShortKey(current))}
      </button>
      {open && (
        <div role="menu" aria-label={t('im.menu')} className="absolute right-0 bottom-[48px] flex w-[280px] flex-col gap-1 rounded-2xl border border-[rgba(127,178,255,0.2)] bg-[rgba(10,24,56,0.97)] p-2 text-[#E8EEFA] shadow-[0_24px_60px_rgba(0,0,0,0.5)]">
          {!st.running && <span className="px-2.5 py-1.5 text-xs text-[#FFD27A]">{t('im.notRunning')}</span>}
          {st.enabled.map((id) => (
            <button key={id} type="button" role="menuitemradio" aria-checked={id === current} disabled={busy} onClick={() => void pick(id)}
              className={`flex cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-start text-[13px] disabled:cursor-default ${id === current ? 'bg-[rgba(31,107,255,0.3)]' : 'hover:bg-white/10'}`}>
              <span aria-hidden="true" className="w-9 shrink-0 text-xs font-semibold text-[#8FA3C8]">{t(imShortKey(id))}</span>
              <span className="flex-1">{name(id)}</span>
              {id === current && <span aria-hidden="true" className="text-[#5FD39A]">✓</span>}
            </button>
          ))}
          {err && <span role="alert" className="px-2.5 py-1 text-xs text-[#FF8A7A]">{err}</span>}
          {onOpenSettings && <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenSettings() }} className="cursor-pointer self-start px-2.5 py-1.5 text-xs text-[#7FB2FF] hover:text-[#B8D4FF]">{t('im.settings')}</button>}
        </div>
      )}
    </span>
  )
}
