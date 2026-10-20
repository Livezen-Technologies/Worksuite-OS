// System monitor (G11): live CPU, memory, disk and network from /proc through the Electron bridge
// (electron/monitor.ts), usage per app, the user's processes, startup apps and this device's performance numbers
// against the SRS §16 limits. Values the device doesn't measure say so instead of showing a number.
import { AnimatedProgress } from '../components/AnimatedProgress'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { WindowProps } from './types'
import { C, card, Svg } from '../components/Dk'
import { formatBytes } from '../lib/os'
import { monitorApi, niceTop, pushHistory, sparkPoints, type HealthItem, type MonitorGroup, type MonitorSnapshot, type StartupEntry } from '../lib/monitorApi'
import { formatDecimal, formatNumber, t, useT, type MessageKey } from '../i18n'

type Tab = 'overview' | 'processes' | 'startup' | 'health'
const TABS: Tab[] = ['overview', 'processes', 'startup', 'health']
const SAMPLE_MS = 2000
const ENERGY_COLOR = { high: C.amber, medium: C.soft, low: C.green } as const

const pct = (v: number | null) => (v == null ? '—' : `${formatDecimal(v, v < 10 ? 1 : 0)}%`)
const rate = (v: number | null) => (v == null ? '—' : t('monitor.perSecond', { size: formatBytes(Math.max(v, 1000)) }))

function groupName(g: MonitorGroup) {
  if (g.kind === 'shell') return t('monitor.shell')
  if (g.kind === 'system') return t('monitor.system', { count: formatNumber(g.count) })
  return g.count > 1 ? t('monitor.appCount', { name: g.name, count: formatNumber(g.count) }) : g.name
}

function healthValue(h: HealthItem): string {
  if (h.value == null) return t('monitor.notMeasured')
  if (h.unit === 's') return t('monitor.seconds', { n: formatDecimal(h.value, 1) })
  if (h.unit === 'bytes') return formatBytes(h.value)
  if (h.unit === 'pct') return pct(h.value)
  return formatNumber(h.value)
}
function healthGoal(h: HealthItem): string {
  if (h.unit === 's') return t('monitor.atMost', { v: t('monitor.seconds', { n: formatNumber(h.limit) }) })
  if (h.unit === 'bytes') return t('monitor.atMost', { v: formatBytes(h.limit) })
  if (h.unit === 'pct') return t('monitor.below', { v: `${h.limit}%` })
  return formatNumber(h.limit)
}

export default function Monitor({ onClose, active }: WindowProps) {
  const activeRef = useRef(active)
  activeRef.current = active
  useT()
  const [tab, setTab] = useState<Tab>('overview')
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [hist, setHist] = useState<{ cpu: number[]; mem: number[]; disk: number[]; net: number[] }>({ cpu: [], mem: [], disk: [], net: [] })
  const [health, setHealth] = useState<HealthItem[] | null>(null)
  const [startup, setStartup] = useState<StartupEntry[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const tick = () => void monitorApi.monitorSample().then((r) => {
      if (!live) return
      if (!r.available) { setUnavailable(true); return }
      const s = r.value
      setUnavailable(false); setSnap(s)
      setHist((h) => ({
        cpu: pushHistory(h.cpu, s.cpu.percent),
        mem: pushHistory(h.mem, s.memory.used),
        disk: pushHistory(h.disk, s.disk.read_bps == null ? null : s.disk.read_bps + (s.disk.write_bps ?? 0)),
        net: pushHistory(h.net, s.net.rx_bps == null ? null : s.net.rx_bps + (s.net.tx_bps ?? 0)),
      }))
    })
    tick()
    const id = setInterval(tick, SAMPLE_MS)
    return () => { live = false; clearInterval(id) }
  }, [])
  // Health reads the CPU figure of the latest sample, so it loads after the second one.
  const sampled = hist.cpu.length > 0
  useEffect(() => {
    if (!sampled) return
    void monitorApi.monitorHealth().then((r) => setHealth(r.available ? r.value : []))
  }, [sampled])
  useEffect(() => {
    if (tab === 'startup' && !startup) void monitorApi.monitorStartup().then((r) => setStartup(r.available ? r.value : []))
  }, [tab, startup])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && activeRef.current !== false) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const graphs = useMemo(() => {
    if (!snap) return []
    const ghz = snap.cpu.mhz ? formatDecimal(snap.cpu.mhz / 1000, 1) : null
    const memPct = Math.round((snap.memory.used / snap.memory.total) * 100)
    return [
      { id: 'cpu', label: t('monitor.cpu'), value: pct(snap.cpu.percent), detail: ghz ? t('monitor.coresGhz', { n: snap.cpu.cores, ghz }) : t('monitor.cores', { n: snap.cpu.cores }), color: C.cyan, meter: snap.cpu.percent, pts: sparkPoints(hist.cpu, 100) },
      { id: 'mem', label: t('monitor.memory'), value: formatBytes(snap.memory.used), detail: t('monitor.memOf', { total: formatBytes(snap.memory.total), pct: memPct }), color: C.link, meter: memPct, pts: sparkPoints(hist.mem, snap.memory.total) },
      { id: 'disk', label: t('monitor.disk'), value: rate(snap.disk.read_bps == null ? null : snap.disk.read_bps + (snap.disk.write_bps ?? 0)), detail: t('monitor.diskRw', { r: rate(snap.disk.read_bps), w: rate(snap.disk.write_bps) }), color: C.green, pts: sparkPoints(hist.disk, niceTop(hist.disk, 1e6)) },
      { id: 'net', label: t('monitor.network'), value: rate(snap.net.rx_bps == null ? null : snap.net.rx_bps + (snap.net.tx_bps ?? 0)), detail: t('monitor.netRx', { rx: rate(snap.net.rx_bps), tx: rate(snap.net.tx_bps) }), color: '#B9A0FF', pts: sparkPoints(hist.net, niceTop(hist.net, 1e5)) },
    ]
  }, [snap, hist])

  const end = async (pid: number, name: string) => {
    const r = await monitorApi.monitorEnd(pid)
    setNotice(r.ok ? t('monitor.ended', { name }) : t('monitor.endFailed', { name }))
  }

  const tabBtn = (id: Tab) => (
    <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
      className="cursor-pointer px-3.5 py-[7px] hover:bg-white/[0.06]" style={{ background: tab === id ? 'rgba(31,107,255,0.25)' : undefined, color: tab === id ? C.ink : C.soft }}>{t(`monitor.tab.${id}` as MessageKey)}</button>
  )
  const grid = 'grid grid-cols-[minmax(0,1fr)_70px_90px_80px] gap-2.5'

  // Memory and CPU rows follow the live sample; the rest are read once.
  const live = health?.map((h) => {
    if (!snap) return h
    const v = h.id === 'memory' ? snap.memory.used : h.id === 'cpu' ? snap.cpu.percent : undefined
    return v === undefined ? h : { ...h, value: v, ok: v == null ? null : h.id === 'cpu' ? v < h.limit : v <= h.limit }
  })
  const healthList = (big = false) => (
    <ul className={`m-0 flex list-none flex-col p-0 ${big ? 'gap-3' : 'gap-2'}`}>
      {(live ?? []).map((h) => (
        <li key={h.id} className="flex items-center gap-2.5 text-[13px]">
          <span aria-hidden="true" className="size-2 flex-none rounded-full" style={{ background: h.ok == null ? C.dim : h.ok ? C.green : C.amber }} />
          <span className="flex-1">{t(`monitor.health.${h.id}` as MessageKey)}</span>
          <span className="font-mono text-xs" style={{ color: h.value == null ? C.muted : C.ink }}>{healthValue(h)}</span>
          <span className="w-[76px] text-right font-mono text-[11px]" style={{ color: C.muted }}>{healthGoal(h)}</span>
        </li>
      ))}
      {health && !health.length && <li className="text-[13px]" style={{ color: C.muted }}>{t('monitor.unavailable')}</li>}
    </ul>
  )

  return (
    <div role="dialog" aria-modal="false" aria-label={t('monitor.title')} className="relative flex h-full w-full flex-col gap-4 overflow-hidden px-8 py-[26px] font-sans"
      style={{ color: C.ink, background: 'radial-gradient(ellipse 80% 50% at 80% 0%, var(--ws-g-glow) 0%, var(--ws-g-page) 60%)' }}>
      <div className="flex items-center gap-3">
        <h1 className="m-0 text-2xl font-bold">{t('monitor.title')}</h1>
        <div role="tablist" aria-label={t('monitor.title')} className="ml-5 flex overflow-hidden rounded-[9px] border border-[rgba(127,178,255,0.2)] text-[13px]">{TABS.map(tabBtn)}</div>
      </div>

      {notice && <div role="status" className="rounded-xl px-4 py-2 text-[13px]" style={{ background: 'rgba(31,107,255,0.15)' }}>{notice}</div>}
      {unavailable && !snap && <div role="status" className={`${card} px-5 py-6 text-sm`} style={{ color: C.soft }}>{t('monitor.unavailable')}</div>}

      {snap && tab === 'overview' && <>
        <div className="grid grid-cols-4 gap-3">
          {graphs.map((g) => (
            <div key={g.id} className={`${card} flex flex-col gap-1.5 px-4 py-3.5`}>
              <div className="flex items-baseline justify-between"><span className="text-[13px]" style={{ color: C.soft }}>{g.label}</span><span className="font-mono text-xl font-medium">{g.value}</span></div>
              <svg width="100%" height="56" viewBox="0 0 200 56" preserveAspectRatio="none" role="img" aria-label={t('monitor.graphLabel', { name: g.label })}>
                {g.pts && <polyline points={g.pts} fill="none" stroke={g.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
              </svg>
              {'meter' in g && g.meter != null && <AnimatedProgress value={g.meter} height={4} decorative shimmer={false} tone={g.meter >= 90 ? 'error' : 'default'} />}
              <span className="text-[11px]" style={{ color: C.muted }}>{g.detail}</span>
            </div>
          ))}
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-3.5">
          <div className={`${card} overflow-hidden`}>
            <div className={`${grid} border-b border-[rgba(127,178,255,0.1)] px-4 py-2.5 text-xs`} style={{ color: C.muted }}>
              <span>{t('monitor.col.process')}</span><span>{t('monitor.cpu')}</span><span>{t('monitor.memory')}</span><span>{t('monitor.col.energy')}</span>
            </div>
            {snap.groups.slice(0, 9).map((g) => (
              <div key={g.key} className={`${grid} px-4 py-2 text-[13px]`}>
                <span className="truncate">{groupName(g)}</span>
                <span className="font-mono text-xs">{pct(g.cpu)}</span>
                <span className="font-mono text-xs">{formatBytes(g.mem)}</span>
                <span className="text-xs" style={{ color: g.energy ? ENERGY_COLOR[g.energy] : C.muted }}>{g.energy ? t(`monitor.energy.${g.energy}` as MessageKey) : '—'}</span>
              </div>
            ))}
          </div>
          <div className={`${card} flex flex-col gap-2 p-4`}>
            <span className="text-sm font-semibold">{t('monitor.targets')}</span>
            <span className="mb-1 text-[11px]" style={{ color: C.muted }}>{t('monitor.targetsSub')}</span>
            {healthList()}
          </div>
        </div>
      </>}

      {snap && tab === 'processes' && (
        <div className={`${card} min-h-0 flex-1 overflow-auto`}>
          <table className="w-full border-collapse text-[13px]">
            <thead><tr className="text-left text-xs" style={{ color: C.muted }}>
              <th className="px-4 py-2.5 font-normal">{t('monitor.col.process')}</th><th className="font-normal">{t('monitor.col.pid')}</th><th className="font-normal">{t('monitor.cpu')}</th><th className="font-normal">{t('monitor.memory')}</th><th><span className="sr-only">{t('monitor.col.actions')}</span></th>
            </tr></thead>
            <tbody>
              {snap.processes.slice(0, 200).map((p) => (
                <tr key={p.pid} className="border-t border-[rgba(127,178,255,0.08)]">
                  <td className="px-4 py-1.5">{p.name}</td>
                  <td className="font-mono text-xs" style={{ color: C.muted }}>{p.pid}</td>
                  <td className="font-mono text-xs">{pct(p.cpu)}</td>
                  <td className="font-mono text-xs">{formatBytes(p.mem)}</td>
                  <td className="pr-4 text-right">{p.own && p.group !== 'shell' && <button type="button" onClick={() => void end(p.pid, p.name)} aria-label={t('monitor.endNamed', { name: p.name })} className="cursor-pointer rounded-md px-2 py-0.5 text-xs hover:bg-white/10" style={{ color: C.red }}>{t('monitor.end')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'startup' && (
        <div className={`${card} flex flex-col`}>
          <p className="m-0 px-4 py-3 text-xs" style={{ color: C.muted }}>{t('monitor.startupIntro')}</p>
          {startup == null ? <p className="m-0 px-4 pb-4 text-[13px]" style={{ color: C.muted }}>{t('common.loading')}</p>
            : !startup.length ? <p className="m-0 px-4 pb-4 text-[13px]" style={{ color: C.muted }}>{t('monitor.startupNone')}</p>
            : startup.map((s) => (
              <div key={s.id} className="flex items-center gap-3 border-t border-[rgba(127,178,255,0.1)] px-4 py-2.5">
                <span className="flex flex-1 flex-col"><span className="text-[13px] font-medium">{s.name}</span>{s.comment && <span className="text-[11px]" style={{ color: C.muted }}>{s.comment}</span>}</span>
                <span className="text-xs" style={{ color: s.enabled ? C.green : C.muted }}>{s.enabled ? t('common.on') : t('common.off')}</span>
                <span className="w-24 text-right text-[11px]" style={{ color: C.muted }}>{t(s.scope === 'user' ? 'monitor.scopeUser' : 'monitor.scopeSystem')}</span>
              </div>
            ))}
        </div>
      )}

      {tab === 'health' && (
        <div className={`${card} flex max-w-[640px] flex-col gap-2 p-5`}>
          <span className="text-sm font-semibold">{t('monitor.targets')}</span>
          <span className="mb-2 text-[11px]" style={{ color: C.muted }}>{t('monitor.targetsSub')}</span>
          {health ? healthList(true) : <span className="text-[13px]" style={{ color: C.muted }}>{t('common.loading')}</span>}
        </div>
      )}
    </div>
  )
}
