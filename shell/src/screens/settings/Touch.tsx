// Settings › Touchscreen & pen and Settings › Keyboard (on-screen keyboard). State comes from electron/touch.ts;
// with no touchscreen the page says so instead of showing controls that would do nothing.
import { useEffect, useState, type ReactNode } from 'react'
import { Svg, card, chip, field, rowLine, sectionLabel } from '../../components/Dk'
import { Empty } from '../Hardware'
import { DEFAULT_GESTURES, hasTabletSwitch, pens, touchApi, touchScreens, useTouch, type OskMode, type OskSize, type PenEvent, type TabletMode, type TouchSettings, type GestureSettings } from '../../lib/touch'
import { formatNumber, t, type MessageKey } from '../../i18n'
import { BigSwitch, H1, Note, Unavail } from './ui'
import { TouchCalibrate } from './TouchCalibrate'

const HAND = 'M8 13V5a1.5 1.5 0 0 1 3 0v6M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7 6 6 0 0 1-5-3l-2.5-4.5a1.5 1.5 0 0 1 2.6-1.5L8 15'
const PEN = 'M15 4l5 5L9 20H4v-5zM13 6l5 5'
const KBD = 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10'

function Row({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className={`flex min-h-[56px] items-center gap-4 px-5 py-3 ${rowLine}`}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="text-sm font-semibold">{title}</span>{sub && <span className="text-xs text-[#8FA3C8]">{sub}</span>}</span>
      {children}
    </div>
  )
}
/** Segmented choice in the boards' style (chips in a pill). */
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
const Hero = ({ d, title, sub, tint }: { d: string; title: string; sub: string; tint: string }) => (
  <div className={`${card} flex items-center gap-4 px-5 py-[18px]`}>
    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl" style={{ background: tint }}><Svg d={d} size={24} stroke="#FFFFFF" /></span>
    <span className="flex min-w-0 flex-col gap-0.5"><span className="text-base font-semibold">{title}</span><span className="text-[13px] text-[#8FA3C8]">{sub}</span></span>
  </div>
)

function PenTest() {
  const [on, setOn] = useState(false)
  const [p, setP] = useState<{ pressure: number; near: boolean; buttons: string[] }>({ pressure: 0, near: false, buttons: [] })
  useEffect(() => {
    const api = touchApi()
    if (!on || !api) return
    void api.penTest(true)
    const off = api.onPen((raw) => {
      const e = raw as PenEvent
      setP((s) => ({
        pressure: e.pressure ?? s.pressure,
        near: e.proximity ?? s.near,
        buttons: e.button ? (e.pressed ? [...new Set([...s.buttons, e.button])] : s.buttons.filter((b) => b !== e.button)) : s.buttons,
      }))
    })
    return () => { off(); void api.penTest(false) }
  }, [on])
  return (
    <Row title={t('touch.pen.test')} sub={on ? (p.near ? t('touch.pen.near') : t('touch.pen.bring')) : t('touch.pen.testSub')}>
      {on && <span className="flex w-40 flex-col gap-1">
        <span className="h-2 overflow-hidden rounded bg-white/15" role="meter" aria-label={t('touch.pen.pressure')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.pressure * 100)}>
          <span className="block h-full bg-[#18D4F0]" style={{ width: `${p.pressure * 100}%` }} />
        </span>
        <span className="text-[11px] text-[#8FA3C8]">{t('touch.pen.pressureValue', { n: formatNumber(Math.round(p.pressure * 100)) })}{p.buttons.length ? ` · ${p.buttons.join(', ')}` : ''}</span>
      </span>}
      <BigSwitch label={t('touch.pen.test')} checked={on} onChange={setOn} />
    </Row>
  )
}

const ghostBtn = 'min-h-9 cursor-pointer rounded-[9px] border border-[rgba(127,178,255,0.25)] px-4 text-[13px] hover:bg-white/[0.06]'

export function TouchPanel() {
  const { state, reason, set } = useTouch()
  const [calibrating, setCalibrating] = useState<string | null>(null)
  if (reason) return <><H1>{t('settings.nav.Touchscreen & pen')}</H1><Unavail what={t('touch.devices')} reason={reason} /></>
  if (!state) return <><H1>{t('settings.nav.Touchscreen & pen')}</H1><Empty title={t('touch.reading')} /></>
  const screens = touchScreens(state)
  const pen = pens(state)
  const s = state.settings
  const tabletOpts: { id: TabletMode; label: string }[] = [{ id: 'auto', label: t('touch.mode.auto') }, { id: 'on', label: t('common.on') }, { id: 'off', label: t('common.off') }]
  const cal = s.calibration ?? {}
  return <>
    <H1 action={!!screens.length && s.touchEnabled ? <button type="button" onClick={() => setCalibrating(screens[0].name)} className={ghostBtn}>{t('touch.cal.open')}</button> : undefined}>{t('settings.nav.Touchscreen & pen')}</H1>
    {calibrating && <TouchCalibrate device={calibrating} current={cal[calibrating]} onClose={() => setCalibrating(null)}
      onSave={(m) => { void set({ calibration: { ...cal, [calibrating]: m } }); setCalibrating(null) }} />}
    {!screens.length ? <Hero d={HAND} tint="rgba(127,178,255,0.18)" title={t('touch.none')} sub={t('touch.noneSub')} /> : <>
      <div className={`${card} flex items-center gap-4 px-5 py-[18px]`}>
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[rgba(14,143,168,0.25)]"><Svg d={HAND} size={24} stroke="#18D4F0" /></span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2 text-base font-semibold">{screens.map((d) => d.name).join(', ')}
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${s.touchEnabled ? 'bg-[rgba(95,211,154,0.16)] text-[#5FD39A]' : 'bg-white/10 text-[#C9D6EE]'}`}>{s.touchEnabled ? t('touch.working') : t('touch.offBadge')}</span>
            {screens.some((d) => cal[d.name]) && <span className="rounded-full bg-[rgba(31,107,255,0.2)] px-2 py-0.5 text-[11px] font-medium text-[#7FB2FF]">{t('touch.cal.saved')}</span>}
          </span>
          <span className="text-[13px] text-[#8FA3C8]">{s.touchEnabled ? t('touch.on') : t('touch.offSub')}</span>
        </span>
        {screens.some((d) => cal[d.name]) && <button type="button" onClick={() => { const next = { ...cal }; screens.forEach((d) => { delete next[d.name] }); void set({ calibration: next }) }} className={ghostBtn}>{t('touch.cal.reset')}</button>}
      </div>
      <section aria-label={t('touch.screen')} className="flex flex-col gap-2">
        <h2 className={`m-0 font-normal ${sectionLabel}`}>{t('touch.screen')}</h2>
        <div className={card}>
          <Row title={t('touch.enable')} sub={t('touch.enableSub')}><BigSwitch label={t('touch.enable')} checked={s.touchEnabled} onChange={(v) => void set({ touchEnabled: v })} /></Row>
          {state.outputs.length > 1 && screens.map((d) => (
            <Row key={d.node} title={t('touch.mapTo')} sub={d.name}>
              <select aria-label={t('touch.mapToFor', { name: d.name })} value={s.mapToOutput[d.name] ?? ''} className={field}
                onChange={(e) => void set({ mapToOutput: { ...s.mapToOutput, [d.name]: e.target.value } })}>
                <option value="">{t('touch.allDisplays')}</option>
                {state.outputs.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Row>
          ))}
        </div>
      </section>
    </>}
    {!!screens.length && s.touchEnabled && <Gestures s={s} set={set} />}
    <section aria-label={t('touch.tabletMode')} className="flex flex-col gap-2">
      <h2 className={`m-0 font-normal ${sectionLabel}`}>{t('touch.tabletMode')}</h2>
      <div className={card}>
        <Row title={t('touch.tabletMode')} sub={hasTabletSwitch(state) ? (state.tabletSwitch ? t('touch.folded') : t('touch.laptop')) : t('touch.noSwitch')}>
          <Segmented label={t('touch.tabletMode')} value={s.tabletMode} options={tabletOpts} onChange={(v) => void set({ tabletMode: v })} />
        </Row>
        <Row title={t('touch.rotationLock')} sub={state.hasAccelerometer ? t('touch.rotationSub') : t('touch.noSensor')}>
          <BigSwitch label={t('touch.rotationLock')} checked={s.rotationLock} disabled={!state.hasAccelerometer} onChange={(v) => void set({ rotationLock: v })} />
        </Row>
      </div>
      <Note>{t('touch.modeNote')}</Note>
    </section>
    <section aria-label={t('touch.pen')} className="flex flex-col gap-2">
      <h2 className={`m-0 font-normal ${sectionLabel}`}>{t('touch.pen')}</h2>
      {!pen.length ? <Hero d={PEN} tint="rgba(127,178,255,0.18)" title={t('touch.noPen')} sub={t('touch.noPenSub')} /> : (
        <div className={card}>
          {pen.map((d) => <Row key={d.node} title={d.name} sub={t('touch.penFound')}><span className={chip}>{d.node.replace('/dev/input/', '')}</span></Row>)}
          <PenTest />
        </div>
      )}
    </section>
    <Note>{t('touch.calibrationNote')}</Note>
  </>
}

/** Board SetTouch › Gestures: edge swipes, three-finger swipes (worksuite-gestures) and the long-press delay. */
function Gestures({ s, set }: { s: TouchSettings; set: (p: Partial<TouchSettings>) => unknown }) {
  const g: GestureSettings = s.gestures ?? DEFAULT_GESTURES
  const hold = s.longPressMs ?? 600
  const put = (patch: Partial<GestureSettings>) => void set({ gestures: { ...g, ...patch } })
  const rows: { k: keyof GestureSettings; f: string; what: MessageKey; opts: string[]; edge: boolean }[] = [
    { k: 'edgeBottom', f: '1 ↑', what: 'touch.g.edgeBottom', opts: ['launcher', 'off'], edge: true },
    { k: 'edgeRight', f: '1 ←', what: 'touch.g.edgeRight', opts: ['notifications', 'off'], edge: true },
    { k: 'edgeLeft', f: '1 →', what: 'touch.g.edgeLeft', opts: ['switch-apps', 'off'], edge: true },
    { k: 'threeHorizontal', f: '3 ↔', what: 'touch.g.threeHorizontal', opts: ['workspaces', 'switch-apps', 'off'], edge: false },
    { k: 'threeDown', f: '3 ↓', what: 'touch.g.threeDown', opts: ['desktop', 'off'], edge: false },
    { k: 'threeUp', f: '3 ↑', what: 'touch.g.threeUp', opts: ['taskview', 'off'], edge: false },
  ]
  return (
    <section aria-label={t('touch.g.title')} className="flex flex-col gap-2">
      <h2 className={`m-0 font-normal ${sectionLabel}`}>{t('touch.g.title')}</h2>
      <div className={card}>
        <Row title={t('touch.g.enable')} sub={t('touch.g.enableSub')}><BigSwitch label={t('touch.g.enable')} checked={g.enabled} onChange={(v) => put({ enabled: v })} /></Row>
        {g.enabled && <Row title={t('touch.g.edges')} sub={t('touch.g.edgesSub')}><BigSwitch label={t('touch.g.edges')} checked={g.edgeSwipes} onChange={(v) => put({ edgeSwipes: v })} /></Row>}
        {g.enabled && rows.filter((r) => !r.edge || g.edgeSwipes).map((r) => (
          <Row key={r.k} title={<span className="flex items-center gap-2"><span className="w-9 font-mono text-[11px] text-[#18D4F0]" aria-hidden="true">{r.f}</span>{t(r.what)}</span>}>
            <select aria-label={t(r.what)} value={g[r.k] as string} className={field} onChange={(e) => put({ [r.k]: e.target.value } as Partial<GestureSettings>)}>
              {r.opts.map((o) => <option key={o} value={o}>{t(`touch.g.a.${o}` as MessageKey)}</option>)}
            </select>
          </Row>
        ))}
        <Row title={t('touch.g.hold')} sub={t('touch.g.holdSub')}>
          <span className="flex items-center gap-3">
            <input type="range" min={300} max={1200} step={50} value={hold} aria-label={t('touch.g.hold')} aria-valuetext={t('touch.g.ms', { n: formatNumber(hold) })}
              onChange={(e) => void set({ longPressMs: Number(e.target.value) })} className="w-40 accent-[#1F6BFF]" />
            <span className="w-16 font-mono text-xs text-[#C9D6EE]">{t('touch.g.ms', { n: formatNumber(hold) })}</span>
          </span>
        </Row>
      </div>
    </section>
  )
}

export function KeyboardPanel() {
  const { state, reason, set } = useTouch()
  const s: TouchSettings | null = state?.settings ?? null
  const modes: { id: OskMode; label: string }[] = [{ id: 'off', label: t('common.off') }, { id: 'touch', label: t('osk.touchOnly') }, { id: 'always', label: t('osk.always') }]
  const layouts: { id: 'full' | 'split' | 'floating'; label: string }[] = (['full', 'split', 'floating'] as const).map((id) => ({ id, label: t(`osk.layout.${id}` as MessageKey) }))
  const sizes: { id: OskSize; label: string }[] = (['small', 'medium', 'large'] as const).map((id) => ({ id, label: t(`osk.size.${id}` as MessageKey) }))
  return <>
    <H1>{t('settings.nav.Keyboard')}</H1>
    {reason ? <Unavail what={t('osk.title')} reason={reason} /> : !s ? <Empty title={t('touch.reading')} /> : <>
      <Hero d={KBD} tint="#7A4FE0" title={t('osk.title')} sub={state?.osk.available || s.osk === 'off' ? t('osk.sub') : t('osk.missing')} />
      <div className={card}>
        <Row title={t('osk.show')} sub={t('osk.showSub')}><Segmented label={t('osk.show')} value={s.osk} options={modes} onChange={(v) => void set({ osk: v })} /></Row>
        <Row title={t('osk.sizeTitle')}><Segmented label={t('osk.sizeTitle')} value={s.oskSize} options={sizes} onChange={(v) => void set({ oskSize: v })} /></Row>
        <Row title={t('osk.layoutTitle')} sub={t('osk.layoutSub')}><Segmented label={t('osk.layoutTitle')} value={s.oskLayout ?? 'full'} options={layouts} onChange={(v) => void set({ oskLayout: v })} /></Row>
        <Row title={t('osk.suggest')} sub={t('osk.suggestSub')}><BigSwitch label={t('osk.suggest')} checked={s.oskSuggestions !== false} onChange={(v) => void set({ oskSuggestions: v })} /></Row>
      </div>
      <Note>{t('osk.layoutsNote')}</Note>
    </>}
  </>
}
