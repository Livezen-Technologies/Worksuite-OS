// Settings › Graphics (#16): the graphics hardware and its driver, the graphics APIs it offers (OpenGL, Vulkan,
// VA-API video), whether the desktop and the apps are GPU-accelerated, and the fallback to software rendering.
// Facts come from electron/graphics.ts (sysfs, Chromium's GPU info, vainfo, vulkaninfo).
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { os } from '../../lib/os'
import { Empty } from '../Hardware'
import { C, OptionCard, btnGhost, card, chip, heroCard, linkBtn, rowLine, sectionLabel } from '../../components/Dk'
import { H1, Note } from './ui'
import { t, type MessageKey } from '../../i18n'
import type { GraphicsState, RendererChoice } from '../../../electron/graphics'

type Open = (s: 'Drivers' | 'Power' | 'Display') => void
const CHOICES: RendererChoice[] = ['auto', 'gpu', 'software']
/** Chromium feature names worth showing, in order. */
const FEATURES: [string, MessageKey][] = [['gpu_compositing', 'gfx.f.compositing'], ['rasterization', 'gfx.f.raster'], ['video_decode', 'gfx.f.video'], ['webgl', 'gfx.f.webgl'], ['webgpu', 'gfx.f.webgpu']]

function Row({ k, v }: { k: ReactNode; v: ReactNode }) {
  return <div className={`flex items-center gap-4 px-[18px] py-3 ${rowLine}`}><span className="flex-1 text-sm">{k}</span><span className="text-right text-[13px] text-[#C9D6EE]">{v}</span></div>
}
const featureOn = (v: string | undefined) => !!v && v.startsWith('enabled')

/** One line summing up acceleration: the headline of the panel. */
export function accelSummary(g: GraphicsState): { on: boolean; text: string } {
  if (g.apps.disabled_reason === 'gpu_crashed') return { on: false, text: t('gfx.sum.crashed') }
  if (g.compositor.fell_back) return { on: false, text: t('gfx.sum.fellBack') }
  if (g.compositor.renderer === 'software' || g.apps.disabled_reason) {
    return { on: false, text: g.compositor.choice === 'software' ? t('gfx.sum.chosen') : g.gpus.some((x) => x.virtual) ? t('gfx.sum.virtual') : t('gfx.sum.software') }
  }
  return { on: g.apps.accelerated, text: g.apps.accelerated ? t('gfx.sum.on') : t('gfx.sum.appsOff') }
}

export function GraphicsPanel({ onOpen }: { onOpen: Open }) {
  const [g, setG] = useState<GraphicsState | null | 'error'>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const load = useCallback(async () => { const r = await os.graphics().catch(() => null); setG(r?.ok ? r.value : 'error') }, [])
  useEffect(() => { void load() }, [load])
  if (g === null) return <><H1>{t('settings.nav.Graphics')}</H1><Empty title={t('gfx.reading')} /></>
  if (g === 'error') return <><H1>{t('settings.nav.Graphics')}</H1><Empty title={t('gfx.unavailable')} /></>
  const sum = accelSummary(g)
  const choose = async (c: RendererChoice) => {
    const r = await os.graphicsSetRenderer(c)
    setMsg(r.ok ? t('gfx.nextSignIn') : t('gfx.saveFailed'))
    void load()
  }
  const retry = async () => { const r = await os.graphicsReset(); setMsg(r.ok ? t('gfx.nextSignIn') : t('gfx.saveFailed')); void load() }
  const gl = g.apps.gl_version ? `${g.apps.gl_version}${g.apps.gl_renderer ? ` · ${g.apps.gl_renderer}` : ''}` : null
  return <>
    <H1>{t('settings.nav.Graphics')}</H1>
    <div className={`${heroCard} flex items-center gap-4 px-5 py-[18px]`} role="status">
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-base font-semibold">{t('gfx.accel')}</span>
        <span className="text-[13px]" style={{ color: sum.on ? C.green : C.muted }}>{sum.text}</span>
      </span>
      {(g.compositor.fell_back || g.apps.disabled_reason === 'gpu_crashed') && <button type="button" onClick={() => void retry()} className={`${btnGhost} px-3.5 py-2 text-[13px]`}>{t('gfx.retry')}</button>}
    </div>

    <section aria-labelledby="gfx-hw" className="flex flex-col gap-2">
      <h2 id="gfx-hw" className={`m-0 font-normal ${sectionLabel}`}>{t('gfx.hardware')}</h2>
      {g.gpus.length === 0 ? <Empty title={t('gfx.noGpu')} /> : (
        <ul className={`${card} m-0 list-none overflow-hidden p-0`}>
          {g.gpus.map((x) => (
            <li key={x.ids + x.name} className={`flex items-center gap-3.5 px-[18px] py-[13px] ${rowLine}`}>
              <span className="flex flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">{x.vendor ? `${x.vendor} ${x.name}` : x.name}</span>
                <span className="text-xs text-[#8FA3C8]">
                  {x.driver ? t('gfx.driver', { driver: x.driver + (x.driver_version ? ` ${x.driver_version}` : '') }) : t('gfx.noDriver')}
                  {x.proprietary ? ` · ${t('gfx.proprietary')}` : ''}{x.virtual ? ` · ${t('gfx.virtual')}` : ''}
                </span>
              </span>
              {!x.driver && <button type="button" onClick={() => onOpen('Drivers')} className={`${btnGhost} px-3.5 py-2 text-[13px]`}>{t('radio.fix.driver')}</button>}
            </li>
          ))}
        </ul>
      )}
    </section>

    <section aria-labelledby="gfx-api" className="flex flex-col gap-2">
      <h2 id="gfx-api" className={`m-0 font-normal ${sectionLabel}`}>{t('gfx.apis')}</h2>
      <div className={`${card} overflow-hidden`}>
        <Row k={t('gfx.compositor')} v={g.compositor.renderer === 'gpu' ? t('gfx.r.gpu') : g.compositor.renderer === 'software' ? t('gfx.r.software') : t('common.unavailable')} />
        <Row k="OpenGL / EGL" v={gl ?? t('common.unavailable')} />
        <Row k={t('gfx.driverVersion')} v={g.apps.driver_vendor || g.apps.driver_version ? [g.apps.driver_vendor, g.apps.driver_version].filter(Boolean).join(' ') : t('common.unavailable')} />
        <Row k="Vulkan" v={g.vulkan.available ? `${g.vulkan.api_version ?? ''} · ${g.vulkan.devices.map((d) => d.name).join(', ')}` : t('gfx.none')} />
        <Row k={t('gfx.videoDecode')} v={g.vaapi.available ? (g.vaapi.decode.length ? g.vaapi.decode.join(', ') : t('gfx.none')) : t('gfx.none')} />
        <Row k={t('gfx.videoEncode')} v={g.vaapi.available && g.vaapi.encode.length ? g.vaapi.encode.join(', ') : t('gfx.none')} />
      </div>
      <div className="flex flex-wrap gap-1.5" aria-label={t('gfx.appFeatures')}>
        {FEATURES.filter(([k]) => k in g.apps.features).map(([k, label]) => (
          <span key={k} className={chip} style={{ color: featureOn(g.apps.features[k]) ? C.green : C.muted }}>{t(label)}: {featureOn(g.apps.features[k]) ? t('common.on') : t('common.off')}</span>
        ))}
      </div>
    </section>

    <section aria-labelledby="gfx-choice" className="flex flex-col gap-2">
      <h2 id="gfx-choice" className={`m-0 font-normal ${sectionLabel}`}>{t('gfx.renderer')}</h2>
      <div className="flex flex-col gap-2" role="radiogroup" aria-labelledby="gfx-choice">
        {CHOICES.map((c) => <OptionCard key={c} name="gfx-renderer" checked={g.compositor.choice === c} onPick={() => void choose(c)} title={t(`gfx.c.${c}` as MessageKey)} desc={t(`gfx.c.${c}.d` as MessageKey)} />)}
      </div>
      {msg && <span role="status" className="text-[13px] text-[#8FA3C8]">{msg}</span>}
    </section>
    <Note>
      {t('gfx.note')}{' '}
      <button type="button" onClick={() => onOpen('Power')} className={linkBtn}>{t('gfx.powerLink')}</button>{' · '}
      <button type="button" onClick={() => onOpen('Display')} className={linkBtn}>{t('gfx.displayLink')}</button>
    </Note>
  </>
}
