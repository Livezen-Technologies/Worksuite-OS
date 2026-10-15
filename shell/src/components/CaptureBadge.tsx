// Persistent taskbar indicator while the screen is being captured through the portal (WSOS-INT-013). Shown for as
// long as PipeWire has a running xdg-desktop-portal-wlr stream; nothing is shown when that cannot be read.
import { useEffect, useState } from 'react'
import { peripheralsApi } from '../lib/peripheralsApi'
import { t } from '../i18n'

export function CaptureBadge({ pollMs = 3000 }: { pollMs?: number }) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    const api = peripheralsApi()
    if (!api) return
    let live = true
    const poll = () => void api.screenCapture().then((r) => { if (live) setCount(r.available ? r.value : 0) }).catch(() => {})
    poll()
    const id = setInterval(poll, pollMs)
    return () => { live = false; clearInterval(id) }
  }, [pollMs])
  if (count === 0) return null
  return (
    <span role="status" title={t('capture.hint')} className="flex items-center gap-1.5 rounded-full bg-[#D9452B] px-2.5 py-1 text-xs font-semibold text-white">
      <span aria-hidden="true" className="size-2 rounded-full bg-white" />{t('capture.active')}
    </span>
  )
}
