// Settings › Display (WSOS-DSK-005/006): per monitor resolution, refresh rate, scale (100–200 %), position,
// primary, wallpaper, and mirror/extend. Applying starts a 15-second "Keep these settings?" countdown; without an
// answer the previous layout comes back (electron/displays.ts). Kept layouts are saved per monitor set and
// re-applied at login and when monitors are plugged in.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  REVERT_SECONDS, SCALES, WALLPAPERS, displays, modeLabel, refreshRates, resolutions, secondsLeft, useDisplayState,
  type Arrangement, type DisplayLayout, type DisplayOutputConfig, type DisplayState, type Side,
} from '../lib/displays'
import { Dialog, btnGhost, btnPrimary, card, dialogFooter, rowLine } from '../components/Dk'

const select = 'box-border min-w-[200px] rounded-[9px] border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-3 py-[9px] text-[13px] text-[#E8EEFA]'
const ERRORS: Record<string, string> = {
  bad_scale: 'Scale must be between 100% and 200%.',
  bad_mode: 'That resolution and refresh rate isn’t offered by the monitor.',
  bad_primary: 'The main display has to stay on.',
  no_enabled_output: 'At least one display has to stay on.',
  apply_failed: 'The compositor refused this layout.',
  missing_wlr_randr: 'Display configuration needs wlr-randr, which isn’t installed.',
}

/** Where a secondary monitor sits relative to the primary, read back from positions. */
export function sideOf(o: DisplayOutputConfig, p: DisplayOutputConfig): Side {
  const dx = o.x - p.x, dy = o.y - p.y
  return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'above' : 'below')
}

export function DisplayPanel() {
  const live = useDisplayState()
  const [draft, setDraft] = useState<DisplayLayout | null>(null)
  const [sides, setSides] = useState<Record<string, Side>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  // A fresh compositor state (hotplug, revert, keep) resets the draft.
  useEffect(() => {
    if (!live) return
    setDraft(structuredClone(live.layout))
    const p = live.layout.outputs.find((o) => o.name === live.layout.primary)
    setSides(Object.fromEntries(live.layout.outputs.filter((o) => p && o.name !== p.name).map((o) => [o.name, sideOf(o, p!)])))
    setSelected((s) => (s && live.outputs.some((o) => o.name === s) ? s : live.layout.primary || live.outputs[0]?.name || null))
  }, [live])

  if (!live || !draft) return <><h1 className="m-0 text-[26px] font-bold tracking-[-0.4px]">Display</h1><p className="text-[13px] text-[#8FA3C8]">Reading displays…</p></>
  const out = live.outputs.find((o) => o.name === selected) ?? live.outputs[0]
  const cfg = draft.outputs.find((o) => o.name === out?.name)
  const changed = JSON.stringify(draft) !== JSON.stringify(live.layout) || Object.entries(sides).some(([n, s]) => {
    const p = live.layout.outputs.find((o) => o.name === live.layout.primary)
    const o = live.layout.outputs.find((x) => x.name === n)
    return p && o && sideOf(o, p) !== s
  })
  const edit = (patch: Partial<DisplayOutputConfig>) => setDraft((d) => d && { ...d, outputs: d.outputs.map((o) => (o.name === out.name ? { ...o, ...patch } : o)) })
  const apply = async () => {
    setBusy(true); setError(null)
    const r = await displays.displayApply(draft, sides)
    setBusy(false)
    if (!r.ok) setError(ERRORS[r.error] ?? `Couldn’t apply (${r.error}).`)
  }
  const multi = live.outputs.length > 1
  const res = out ? resolutions(out) : []
  const rates = out && cfg ? refreshRates(out, cfg.width, cfg.height) : []

  return <>
    <h1 className="m-0 text-[26px] font-bold tracking-[-0.4px]">Display</h1>
    <div className="flex min-h-[160px] flex-wrap items-center justify-center gap-4 rounded-[14px] border border-[rgba(127,178,255,0.12)] bg-[rgba(4,10,26,0.5)] p-4" role="group" aria-label="Connected displays">
      {live.outputs.map((o, i) => {
        const on = draft.outputs.find((c) => c.name === o.name)?.enabled
        return (
          <button key={o.name} type="button" aria-pressed={o.name === out?.name} onClick={() => setSelected(o.name)}
            className={`box-border flex h-[100px] w-[170px] cursor-pointer flex-col items-start justify-end rounded-[10px] p-2.5 text-left text-[13px] ${o.name === out?.name ? 'border-2 border-[#1F6BFF]' : 'border border-[rgba(127,178,255,0.3)]'} ${on ? '' : 'opacity-50'}`}
            style={{ background: WALLPAPERS[live.wallpapers[o.name] ?? 'default']?.css }}>
            <span className="font-semibold text-white">{i + 1} · {o.description || o.name}</span>
            <span className="text-[11px] text-[#C9D6EE]">{o.name}{o.name === draft.primary ? ' · main' : ''}{on ? '' : ' · off'}</span>
          </button>
        )
      })}
      {live.outputs.length === 0 && <span className="text-[13px] text-[#8FA3C8]">No connected displays reported</span>}
    </div>

    {multi && (
      <div className={`${card} flex items-center gap-4 px-[18px] py-3.5`}>
        <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm font-medium">Multiple displays</span><span className="text-xs text-[#8FA3C8]">Extend the desktop or show the same picture on every display</span></span>
        <select aria-label="Multiple displays" className={select} value={draft.arrangement} onChange={(e) => setDraft({ ...draft, arrangement: e.target.value as Arrangement })}>
          <option value="extend" className="bg-[#0F2350]">Extend these displays</option>
          <option value="mirror" className="bg-[#0F2350]">Duplicate these displays</option>
        </select>
      </div>
    )}

    {out && cfg && (
      <div className={`${card} overflow-hidden`} aria-label={`Settings for ${out.description || out.name}`} role="group">
        {multi && (
          <Row k="Display on" d="Turn this display off without unplugging it">
            <input type="checkbox" aria-label="Display on" checked={cfg.enabled} onChange={(e) => edit({ enabled: e.target.checked })} className="size-4" />
          </Row>
        )}
        {multi && (
          <Row k="Main display" d="Gets the launcher, notifications and new windows">
            <input type="radio" aria-label="Make this my main display" checked={draft.primary === out.name} disabled={!cfg.enabled} onChange={() => setDraft({ ...draft, primary: out.name })} className="size-4" />
          </Row>
        )}
        <Row k="Resolution" d="Current mode">
          <select aria-label="Resolution" className={select} value={`${cfg.width}x${cfg.height}`} disabled={!cfg.enabled} onChange={(e) => {
            const [w, h] = e.target.value.split('x').map(Number)
            edit({ width: w, height: h, refresh: refreshRates(out, w, h)[0] ?? 0 })
          }}>
            {res.map((m) => <option key={`${m.width}x${m.height}`} value={`${m.width}x${m.height}`} className="bg-[#0F2350]">{modeLabel(m)}{out.modes.some((x) => x.preferred && x.width === m.width && x.height === m.height) ? ' (recommended)' : ''}</option>)}
          </select>
        </Row>
        <Row k="Refresh rate" d="Smoother motion">
          <select aria-label="Refresh rate" className={select} value={String(cfg.refresh)} disabled={!cfg.enabled || rates.length < 2} onChange={(e) => edit({ refresh: Number(e.target.value) })}>
            {rates.map((r) => <option key={r} value={String(r)} className="bg-[#0F2350]">{r ? `${Math.round(r * 100) / 100} Hz` : 'Fixed'}</option>)}
          </select>
        </Row>
        <Row k="Scale" d="Make text and apps larger on this display">
          <select aria-label="Scale" className={select} value={String(cfg.scale)} disabled={!cfg.enabled} onChange={(e) => edit({ scale: Number(e.target.value) })}>
            {[...new Set([...SCALES, cfg.scale])].sort((a, b) => a - b).map((s) => <option key={s} value={String(s)} className="bg-[#0F2350]">{Math.round(s * 100)}%</option>)}
          </select>
        </Row>
        {multi && draft.arrangement === 'extend' && out.name !== draft.primary && (
          <Row k="Position" d="Where this display sits next to the main one">
            <select aria-label="Position" className={select} value={sides[out.name] ?? 'right'} disabled={!cfg.enabled} onChange={(e) => setSides({ ...sides, [out.name]: e.target.value as Side })}>
              {(['left', 'right', 'above', 'below'] as Side[]).map((s) => <option key={s} value={s} className="bg-[#0F2350]">{{ left: 'Left of', right: 'Right of', above: 'Above', below: 'Below' }[s]} main display</option>)}
            </select>
          </Row>
        )}
        <Row k="Wallpaper" d="Background for this display">
          <select aria-label="Wallpaper" className={select} value={live.wallpapers[out.name] ?? 'default'} onChange={(e) => void displays.displayWallpaper(out.name, e.target.value)}>
            {Object.entries(WALLPAPERS).map(([id, w]) => <option key={id} value={id} className="bg-[#0F2350]">{w.label}</option>)}
          </select>
        </Row>
      </div>
    )}

    {error && <p role="alert" className="m-0 text-[13px] text-[#FF9C8A]">{error}</p>}
    <div className="flex justify-end gap-2.5">
      <button type="button" className={btnGhost} disabled={!changed || busy} onClick={() => { setDraft(structuredClone(live.layout)); setError(null) }}>Reset</button>
      <button type="button" className={btnPrimary} disabled={!changed || busy || !!live.pending} onClick={() => void apply()}>Apply</button>
    </div>
    <p className="m-0 text-xs leading-[1.5] text-[#8FA3C8]">Changes are tried for {REVERT_SECONDS} seconds first. Kept settings are remembered for this set of monitors and come back when you plug them in again.</p>
    {live.pending && <KeepDialog state={live} />}
  </>
}

function Row({ k, d, children }: { k: string; d: string; children: ReactNode }) {
  return (
    <div className={`flex items-center gap-4 px-[18px] py-3.5 ${rowLine}`}>
      <span className="flex flex-1 flex-col gap-0.5"><span className="text-sm font-medium">{k}</span><span className="text-xs text-[#8FA3C8]">{d}</span></span>
      {children}
    </div>
  )
}

/** "Keep these settings?" with a live countdown; Escape or no answer reverts. */
export function KeepDialog({ state, now = Date.now }: { state: DisplayState; now?: () => number }) {
  const deadline = state.pending?.deadline ?? 0
  const [left, setLeft] = useState(() => secondsLeft(deadline, now()))
  useEffect(() => {
    const i = setInterval(() => setLeft(secondsLeft(deadline, now())), 250)
    return () => clearInterval(i)
  }, [deadline, now])
  const text = useMemo(() => `Reverting in ${left} second${left === 1 ? '' : 's'}.`, [left])
  return (
    <Dialog alert width={420} onClose={() => void displays.displayRevert()}>
      {(tid) => <>
        <div className="flex flex-col gap-3 px-6 pt-6 pb-4">
          <h2 id={tid} className="m-0 text-[19px] font-bold">Keep these display settings?</h2>
          <p className="m-0 text-[13px] text-[#C9D6EE]" aria-live="polite">{text}</p>
        </div>
        <div className={dialogFooter}>
          <button type="button" className={btnGhost} onClick={() => void displays.displayRevert()}>Revert</button>
          <button type="button" className={btnPrimary} data-autofocus onClick={() => void displays.displayKeep()}>Keep changes</button>
        </div>
      </>}
    </Dialog>
  )
}
