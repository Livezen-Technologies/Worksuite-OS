// Persistent taskbar indicator while the screen is being captured through the portal (WSOS-INT-013, SRS §7.1). Shown
// for as long as PipeWire has a running xdg-desktop-portal-wlr stream; nothing is shown when that cannot be read.
// "Stop sharing" is the one-click emergency stop: it ends every ScreenCast session (worksuite-screencast-stop, also on
// Super+Shift+Esc, which works on the lock screen too).
import { useCallback, useEffect, useState } from 'react'
import { peripheralsApi } from '../lib/peripheralsApi'
import { t } from '../i18n'

export function CaptureBadge({ pollMs = 3000 }: { pollMs?: number }) {
  const [count, setCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const poll = useCallback(async () => {
    const api = peripheralsApi()
    if (!api) return
    try { const r = await api.screenCapture(); setCount(r.available ? r.value : 0) } catch { /* keep the last state */ }
  }, [])
  useEffect(() => {
    if (!peripheralsApi()) return
    let live = true
    const tick = () => { if (live) void poll() }
    tick()
    const id = setInterval(tick, pollMs)
    return () => { live = false; clearInterval(id) }
  }, [pollMs, poll])

  const stop = async () => {
    const api = peripheralsApi()
    if (!api) return
    setBusy(true); setFailed(false)
    try {
      const r = await api.stopScreenCapture()
      setFailed(!r.available)
      if (r.available) setCount(0)
    } catch { setFailed(true) }
    setBusy(false)
    void poll()
  }

  if (count === 0) return null
  return (
    <span role="status" title={t('capture.hint')} className="flex items-center gap-1.5 rounded-full bg-[#D9452B] py-1 pl-2.5 pr-1 text-xs font-semibold text-white">
      <span aria-hidden="true" className="size-2 rounded-full bg-white" />{t('capture.active')}
      <button type="button" onClick={() => void stop()} disabled={busy}
        className="ml-1 rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-[#B3321B] hover:bg-[#FFE3DD] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-60">
        {t('capture.stop')}
      </button>
      {failed && <span role="alert" className="sr-only">{t('capture.stopFailed')}</span>}
    </span>
  )
}
