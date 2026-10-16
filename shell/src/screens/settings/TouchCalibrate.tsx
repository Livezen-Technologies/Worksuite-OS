// Touch calibration (board TouchCalibrate): a full-screen page with four targets lit one after another. Each tap
// (finger or pen) is read where it landed, an affine fit lines the panel up with the screen, and Save stores it as
// the device's libinput calibration matrix (Labwc rc.xml, electron/touch.ts). Esc or Cancel leaves everything as it was.
import { useEffect, useRef, useState } from 'react'
import { TARGETS, compose, fitAffine, meanError, sane, type Matrix, IDENTITY } from '../../lib/calibrate'
import { formatNumber, t } from '../../i18n'

const RIPPLE = '@keyframes ws-cal-ripple{0%{transform:scale(.4);opacity:.9}100%{transform:scale(1.8);opacity:0}}@media (prefers-reduced-motion: reduce){.ws-cal-ring{animation:none!important}}'
/** Taps further than this from where they should be (after the fit) mean a mis-tap: start over. */
const MAX_ERROR_PX = 12

export function TouchCalibrate({ device, current, onSave, onClose }: { device: string; current: number[] | undefined; onSave: (m: Matrix) => void; onClose: () => void }) {
  const [taps, setTaps] = useState<[number, number][]>([])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  const n = taps.length, done = n >= TARGETS.length
  const w = window.innerWidth, h = window.innerHeight
  const fit = done ? fitAffine(taps, TARGETS) : null
  const err = fit ? meanError(fit, taps, TARGETS, w, h) : null
  const base = current && current.length === 6 ? (current as Matrix) : IDENTITY
  const next = fit ? compose(fit, base) : null
  const good = !!next && sane(next) && err != null && err <= MAX_ERROR_PX
  const px = Math.round(w * (window.devicePixelRatio || 1)), py = Math.round(h * (window.devicePixelRatio || 1))

  const onPointer = (e: React.PointerEvent) => {
    if (done || (e.pointerType !== 'touch' && e.pointerType !== 'pen')) return
    e.preventDefault()
    setTaps((l) => [...l, [e.clientX / w, e.clientY / h]])
  }
  const label = done ? (good ? t('touch.cal.doneLabel') : t('touch.cal.badLabel')) : t('touch.cal.step', { n: formatNumber(n + 1), total: formatNumber(TARGETS.length) })
  const title = done ? (good ? t('touch.cal.doneTitle') : t('touch.cal.badTitle')) : t('touch.cal.title')
  const sub = done ? (good ? t('touch.cal.doneSub', { px: formatNumber(Math.round(err! * 10) / 10) }) : t('touch.cal.badSub')) : t('touch.cal.sub')
  return (
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="cal-t" aria-describedby="cal-s" onPointerDown={onPointer}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
      className="fixed inset-0 z-[90] touch-none font-sans text-[#E8EEFA] outline-none select-none" style={{ background: '#050E24' }}>
      <style>{RIPPLE}</style>
      <div className="absolute top-1/2 left-1/2 flex w-[520px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2.5 text-center">
        <span className="font-mono text-xs tracking-[0.08em] uppercase" style={{ color: done && !good ? '#FFB98A' : '#18D4F0' }} aria-live="polite">{label}</span>
        <h1 id="cal-t" className="m-0 text-[26px] font-bold">{title}</h1>
        <p id="cal-s" className="m-0 text-sm leading-normal text-[#8FA3C8]">{sub}</p>
        <div className="mt-2 flex gap-2" aria-hidden="true">
          {TARGETS.map((_, i) => <span key={i} className="h-1 w-[30px] rounded-sm" style={{ background: i < n ? '#5FD39A' : i === n ? '#1F6BFF' : 'rgba(127,178,255,0.2)' }} />)}
        </div>
        <div className="mt-3.5 flex gap-2.5">
          <button type="button" onClick={() => (done ? setTaps([]) : onClose())} className="min-h-11 cursor-pointer rounded-[10px] px-[18px] text-sm" style={{ border: '1px solid rgba(127,178,255,0.25)' }}>{done ? t('touch.cal.again') : t('common.cancel')}</button>
          {done && good && <button type="button" autoFocus onClick={() => onSave(next!)} className="min-h-11 cursor-pointer rounded-[10px] bg-[#1F6BFF] px-[22px] text-sm font-semibold">{t('touch.cal.save')}</button>}
          {done && !good && <button type="button" onClick={onClose} className="min-h-11 cursor-pointer rounded-[10px] px-[18px] text-sm text-[#8FA3C8]">{t('touch.cal.keep')}</button>}
        </div>
      </div>
      {TARGETS.map(([x, y], i) => {
        const hit = i < n || done, on = i === n && !done
        const col = hit ? '#5FD39A' : on ? '#18D4F0' : '#5E739C'
        return (
          <span key={i} aria-hidden="true" className="absolute -mt-8 -ml-8 size-16" style={{ left: `${x * 100}%`, top: `${y * 100}%`, opacity: hit || on ? 1 : 0.25 }}>
            <span className="ws-cal-ring absolute inset-0 rounded-full" style={{ border: `2px solid ${col}`, animation: on ? 'ws-cal-ripple 1.4s ease-out infinite' : 'none' }} />
            <span className="absolute top-2 left-[31px] h-12 w-0.5" style={{ background: col }} />
            <span className="absolute top-[31px] left-2 h-0.5 w-12" style={{ background: col }} />
            <span className="absolute top-[26px] left-[26px] size-3 rounded-full" style={{ background: hit || on ? col : 'transparent' }} />
          </span>
        )
      })}
      <div className="absolute right-0 bottom-5 left-0 text-center text-xs text-[#8FA3C8]">{t('touch.cal.footer', { device, w: String(px), h: String(py) })}</div>
    </div>
  )
}
