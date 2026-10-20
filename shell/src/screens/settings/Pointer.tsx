// Settings › Mouse & touchpad (#35). State comes from electron/pointer.ts: only the controls the connected hardware
// supports are shown; changes are applied live through Labwc and kept per user. Sliders send their value once the
// person stops moving them, so Labwc is not reloaded on every step.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Switch, card, rowLine, sectionLabel } from '../../components/Dk'
import { Empty } from '../Hardware'
import { SCROLL_STEPS, speedToStep, stepToSpeed, usePointer, type Avail, type PointerApi, type PointerCaps, type PointerPatch, type PointerState, type MouseSettings } from '../../lib/pointer'
import { formatNumber, t } from '../../i18n'
import { H1, Note, Unavail } from './ui'

function Row({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className={`flex min-h-[56px] flex-wrap items-center gap-4 px-5 py-3 ${rowLine}`}>
      <span className="flex min-w-[180px] flex-1 flex-col gap-0.5"><span className="text-sm font-semibold">{title}</span>{sub && <span className="text-xs text-[#8FA3C8]">{sub}</span>}</span>
      {children}
    </div>
  )
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex shrink-0 gap-1 rounded-[10px] bg-[rgba(4,10,26,0.5)] p-1">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={o.id === value} onClick={() => onChange(o.id)}
          className={`min-h-9 cursor-pointer rounded-lg px-3 text-[13px] ${o.id === value ? 'bg-[#1F6BFF] font-semibold text-white' : 'text-[#C9D6EE] hover:bg-white/[0.06]'}`}>{o.label}</button>
      ))}
    </div>
  )
}

/** Range slider that commits after the value settles (250 ms) or on release. */
function Slider({ label, value, min, max, valueText, low, high, onCommit }: { label: string; value: number; min: number; max: number; valueText: (v: number) => string; low: string; high: string; onCommit: (v: number) => void }) {
  const [v, setV] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => setV(value), [value])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const commit = (x: number) => { if (timer.current) clearTimeout(timer.current); timer.current = null; if (x !== value) onCommit(x) }
  return (
    <span className="flex w-[260px] max-w-full shrink-0 flex-col gap-1">
      <input type="range" aria-label={label} aria-valuetext={valueText(v)} min={min} max={max} step={1} value={v} className="w-full accent-[#1F6BFF]"
        onChange={(e) => { const x = Number(e.target.value); setV(x); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => commit(x), 250) }}
        onPointerUp={() => commit(v)} onKeyUp={() => commit(v)} />
      <span className="flex justify-between text-[11px] text-[#8FA3C8]"><span>{low}</span><span className="text-[#C9D6EE]">{valueText(v)}</span><span>{high}</span></span>
    </span>
  )
}

const ERR: Record<string, () => string> = {
  labwc_reload: () => t('ptr.err.reload'),
  labwc_missing: () => t('ptr.err.reload'),
  labwc_config: () => t('ptr.err.config'),
  save_failed: () => t('ptr.err.save'),
}

/** The settings both kinds share: speed, acceleration, scroll speed and direction, primary button. */
function Common({ kind, s, caps, scrollFactor, put }: { kind: 'mouse' | 'touchpad'; s: MouseSettings; caps: PointerCaps; scrollFactor: boolean; put: (p: Partial<MouseSettings>) => Promise<Avail<PointerState>> }) {
  const scrollIdx = Math.max(0, SCROLL_STEPS.findIndex((x) => x >= s.scrollFactor - 1e-6))
  return <>
    {caps.accel && (
      <Row title={t(`ptr.${kind}.speed`)} sub={t('ptr.speedSub')}>
        <Slider label={t(`ptr.${kind}.speed`)} value={speedToStep(s.speed)} min={1} max={11} low={t('ptr.slow')} high={t('ptr.fast')} valueText={(x) => formatNumber(x)} onCommit={(x) => void put({ speed: stepToSpeed(x) })} />
      </Row>
    )}
    {caps.accel && caps.flat && (
      <Row title={t('ptr.accel')} sub={t('ptr.accelSub')}>
        <Switch label={t(`ptr.${kind}.accel`)} checked={s.accel === 'adaptive'} onChange={(v) => put({ accel: v ? 'adaptive' : 'flat' })} />
      </Row>
    )}
    {scrollFactor && (
      <Row title={t('ptr.scrollSpeed')} sub={t('ptr.scrollSpeedSub')}>
        <Slider label={t(`ptr.${kind}.scrollSpeed`)} value={scrollIdx} min={0} max={SCROLL_STEPS.length - 1} low={t('ptr.slow')} high={t('ptr.fast')}
          valueText={(i) => `${formatNumber(SCROLL_STEPS[i] ?? 1)}×`} onCommit={(i) => void put({ scrollFactor: SCROLL_STEPS[i] })} />
      </Row>
    )}
    {caps.naturalScroll && (
      <Row title={t('ptr.natural')} sub={t(kind === 'touchpad' ? 'ptr.naturalSubTouchpad' : 'ptr.naturalSubMouse')}>
        <Switch label={t(`ptr.${kind}.natural`)} checked={s.naturalScroll} onChange={(v) => put({ naturalScroll: v })} />
      </Row>
    )}
    {kind === 'mouse' && caps.leftHanded && (
      <Row title={t('ptr.primary')} sub={t('ptr.primarySub')}>
        <Segmented label={t('ptr.primary')} value={s.leftHanded ? 'right' : 'left'} options={[{ id: 'left', label: t('ptr.primary.left') }, { id: 'right', label: t('ptr.primary.right') }]}
          onChange={(v) => void put({ leftHanded: v === 'right' })} />
      </Row>
    )}
  </>
}

export function PointerPanel({ api }: { api?: PointerApi | null }) {
  const { state, reason, set } = usePointer(api === undefined ? undefined : api)
  const [error, setError] = useState<string | null>(null)
  const apply = async (p: PointerPatch) => {
    setError(null)
    const r = await set(p)
    if (!r.available) setError((ERR[r.reason] ?? (() => t('ptr.err.other')))())
    return r
  }
  if (reason && !state) return <><H1>{t('settings.nav.Mouse & touchpad')}</H1><Unavail what={t('settings.nav.Mouse & touchpad')} reason={reason} /></>
  if (!state) return <><H1>{t('settings.nav.Mouse & touchpad')}</H1><Note>{t('ptr.reading')}</Note></>
  const { support: sup, settings: s } = state
  const tp = sup.touchpad, tps = s.touchpad
  return <>
    <H1>{t('settings.nav.Mouse & touchpad')}</H1>
    {!sup.mouse && !sup.touchpad && <Empty title={t('ptr.none')}>{t('ptr.noneSub')}</Empty>}
    {error && <p role="alert" className="m-0 rounded-xl border border-[rgba(217,69,43,0.35)] bg-[rgba(217,69,43,0.12)] px-4 py-3 text-[13px] text-[#FFB4A6]">{error}</p>}

    {sup.mouse && (
      <section aria-labelledby="ptr-mouse" className="flex flex-col gap-2">
        <h2 id="ptr-mouse" className={`m-0 font-normal ${sectionLabel}`}>{t('ptr.mouse')}</h2>
        <div className={card}>
          <Common kind="mouse" s={s.mouse} caps={sup.mouse} scrollFactor={sup.scrollFactor} put={(p) => apply({ mouse: p })} />
        </div>
      </section>
    )}

    {tp && (
      <section aria-labelledby="ptr-touchpad" className="flex flex-col gap-2">
        <h2 id="ptr-touchpad" className={`m-0 font-normal ${sectionLabel}`}>{t('ptr.touchpad')}</h2>
        <div className={card}>
          <Row title={t('ptr.tp.use')} sub={t('ptr.tp.useSub')}>
            <Segmented label={t('ptr.tp.use')} value={tps.enabled} onChange={(v) => void apply({ touchpad: { enabled: v } })}
              options={[{ id: 'yes', label: t('switch.on') }, { id: 'disabledOnExternalMouse', label: t('ptr.tp.offWithMouse') }, { id: 'no', label: t('switch.off') }]} />
          </Row>
          {tps.enabled !== 'no' && <>
            <Common kind="touchpad" s={tps} caps={tp} scrollFactor={sup.scrollFactor} put={(p) => apply({ touchpad: p })} />
            {tp.twoFingerScroll && tp.edgeScroll && (
              <Row title={t('ptr.tp.scrollMethod')} sub={t('ptr.tp.scrollMethodSub')}>
                <Segmented label={t('ptr.tp.scrollMethod')} value={tps.scrollMethod} onChange={(v) => void apply({ touchpad: { scrollMethod: v } })}
                  options={[{ id: 'twoFinger', label: t('ptr.tp.twoFinger') }, { id: 'edge', label: t('ptr.tp.edge') }]} />
              </Row>
            )}
            {tp.disableWhileTyping && (
              <Row title={t('ptr.tp.dwt')} sub={t('ptr.tp.dwtSub')}>
                <Switch label={t('ptr.tp.dwt')} checked={tps.disableWhileTyping} onChange={(v) => apply({ touchpad: { disableWhileTyping: v } })} />
              </Row>
            )}
          </>}
        </div>
      </section>
    )}

    {tp && tps.enabled !== 'no' && (
      <section aria-labelledby="ptr-gestures" className="flex flex-col gap-2">
        <h2 id="ptr-gestures" className={`m-0 font-normal ${sectionLabel}`}>{t('ptr.gestures')}</h2>
        <div className={card}>
          <Row title={t('ptr.tp.tap')} sub={t('ptr.tp.tapSub')}>
            <Switch label={t('ptr.tp.tap')} checked={tp.tap && tps.tap} unavailable={tp.tap ? undefined : t('ptr.notSupported')} onChange={(v) => apply({ touchpad: { tap: v } })} />
          </Row>
          {tp.tap && tps.tap && (
            <Row title={t('ptr.tp.tapDrag')} sub={t('ptr.tp.tapDragSub')}>
              <Switch label={t('ptr.tp.tapDrag')} checked={tps.tapAndDrag} onChange={(v) => apply({ touchpad: { tapAndDrag: v } })} />
            </Row>
          )}
          {tp.tap && tps.tap && tps.tapAndDrag && tp.dragLock && (
            <Row title={t('ptr.tp.dragLock')} sub={t('ptr.tp.dragLockSub')}>
              <Switch label={t('ptr.tp.dragLock')} checked={tps.dragLock} onChange={(v) => apply({ touchpad: { dragLock: v } })} />
            </Row>
          )}
          {tp.clickfinger && tp.buttonAreas && (
            <Row title={t('ptr.tp.rightClick')} sub={t('ptr.tp.rightClickSub')}>
              <Segmented label={t('ptr.tp.rightClick')} value={tps.clickMethod} onChange={(v) => void apply({ touchpad: { clickMethod: v } })}
                options={[{ id: 'clickfinger', label: t('ptr.tp.twoFingerClick') }, { id: 'buttonAreas', label: t('ptr.tp.cornerClick') }]} />
            </Row>
          )}
          <Row title={t('ptr.tp.swipes')} sub={t('ptr.tp.swipesSub')}>
            <Switch label={t('ptr.tp.swipes')} checked={false} unavailable={sup.swipeGestures ? undefined : t('ptr.tp.swipesUnavailable')} />
          </Row>
        </div>
      </section>
    )}
    <Note>{t('ptr.note')}</Note>
  </>
}
