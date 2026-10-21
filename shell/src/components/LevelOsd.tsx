// Fn-key level indicator (#62) in the shell's own window, for when worksuite-toasts (the layer-shell helper that draws
// it over the apps) is not available. worksuite-hotkey changes the level and tells the shell (Shell1.Osd).
import { useEffect, useState } from 'react'
import { captureApi, type OsdLevel } from '../lib/captureApi'
import { formatNumber, useT } from '../i18n'

export const OSD_MS = 1500

export function LevelOsd({ api = captureApi }: { api?: { onOsd?(cb: (o: OsdLevel) => void): () => void } | null }) {
  const t = useT()
  const [o, setO] = useState<OsdLevel | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = api?.onOsd?.((x) => { setO(x); clearTimeout(timer); timer = setTimeout(() => setO(null), OSD_MS) })
    return () => { clearTimeout(timer); off?.() }
  }, [api])
  if (!o) return null
  const name = t(o.kind === 'volume' ? 'osd.volume' : o.kind === 'mic' ? 'osd.mic' : 'osd.brightness')
  const text = o.muted ? t('osd.muted') : `${formatNumber(o.value)}%`
  return (
    <div role="status" aria-live="polite" data-testid="level-osd" className="pointer-events-none fixed bottom-24 left-1/2 z-[60] flex w-[260px] -translate-x-1/2 items-center gap-3 rounded-2xl border border-[rgba(127,178,255,0.2)] bg-[rgba(10,24,56,0.96)] px-4 py-3 text-[#E8EEFA] shadow-[0_24px_60px_rgba(0,0,0,0.5)]">
      <span className="w-24 shrink-0 text-xs">{name}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/15">
        <span className="block h-full rounded-full bg-[#1F6BFF]" style={{ width: `${o.muted ? 0 : o.value}%` }} />
      </span>
      <span className="w-14 shrink-0 text-end text-xs tabular-nums">{text}</span>
    </div>
  )
}
