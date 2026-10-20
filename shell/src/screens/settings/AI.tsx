// Settings › AI: WorkSuite Desktop's Settings › Local AI (src/modules/settings/SettingsPage.tsx LocalAISection) in the
// shell's Settings look — this computer and its tier, the runtime with Restart, the model catalog with download, pause,
// resume, discard, test, check, use and remove — plus what the OS adds: the on/off switch, performance (threads, GPU),
// privacy (history on/off, clear) and the organization's policy, which can turn the assistant off or limit the models.
import { useState } from 'react'
import { C, Spinner, Svg, btnGhost, card, rowLine, sectionLabel } from '../../components/Dk'
import { formatBytes } from '../../lib/os'
import { ai, aiErrorText, downloadSize, secondsLeft, timeLeftLabel, useAI, type LocalAITier, type LocalModelView, type LocalRuntimeState } from '../../lib/aiApi'
import { clearHistory, loadPrefs, savePrefs } from '../../lib/assistant'
import { formatDate, formatNumber, t, type MessageKey } from '../../i18n'
import { BigSwitch, H1, Note } from './ui'
import { Empty } from '../Hardware'

const TIER: Record<LocalAITier, MessageKey> = { minimal: 'ai.tier.minimal', basic: 'ai.tier.basic', good: 'ai.tier.good', strong: 'ai.tier.strong' }
const RUNTIME: Record<LocalRuntimeState, MessageKey> = { off: 'ai.rt.off', starting: 'ai.rt.starting', ready: 'ai.rt.ready', loading: 'ai.rt.loading', busy: 'ai.rt.busy', error: 'ai.rt.error' }
const SHIELD = 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4'
const BUILDING = 'M3 21h18M5 21V7l7-4 7 4v14M9 10h.01M15 10h.01M9 14h.01M15 14h.01'
const small = `${btnGhost} px-3 py-1.5 text-[13px]`
const smallPrimary = 'inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-[10px] bg-[#1F6BFF] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[#3A7DFF] disabled:cursor-default disabled:opacity-50'

function Chip({ tone, children }: { tone: 'ok' | 'info' | 'warn' | 'bad' | 'muted'; children: string }) {
  const s = { ok: ['rgba(95,211,154,0.16)', '#5FD39A'], info: ['rgba(31,107,255,0.2)', '#9CC2FF'], warn: ['rgba(240,180,41,0.16)', '#F5C451'], bad: ['rgba(217,69,43,0.18)', '#FF8A7A'], muted: ['rgba(255,255,255,0.08)', '#C9D6EE'] }[tone]
  return <span className="rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: s[0], color: s[1] }}>{children}</span>
}

function Row({ label, hint, children }: { label: string; hint?: string | null; children?: React.ReactNode }) {
  return (
    <div className={`flex items-center gap-4 px-[18px] py-3.5 ${rowLine}`}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="text-sm font-medium">{label}</span>{hint && <span className="text-xs text-[#8FA3C8]">{hint}</span>}</span>
      {children}
    </div>
  )
}

export function AIPanel() {
  const { status, models, reload } = useAI()
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [prefs, setPrefs] = useState(loadPrefs)
  const run = (key: string, p: Promise<{ ok: boolean; error?: string; value?: unknown }>, ok?: (v: unknown) => string | null) => {
    setBusy(key); setMsg(null)
    void p.then((r) => {
      if (!r.ok) setMsg({ ok: false, text: aiErrorText(r.error) })
      else if (ok) { const text = ok(r.value); if (text) setMsg({ ok: r.value !== false, text }) }
      void reload()
    }).finally(() => setBusy(null))
  }
  if (status === null) return <><H1>{t('settings.nav.AI')}</H1><Empty title={t('common.loading')} /></>
  if (!status.ok) return <><H1>{t('settings.nav.AI')}</H1><Empty title={t('ai.off.serviceTitle')}>{t('ai.off.serviceBody')}</Empty></>
  const st = status.value
  const hw = st.hardware
  const chat = (models?.ok ? models.value : []).filter((m) => m.model.purpose === 'chat')
  const managedOff = st.policy.managed && !st.policy.enabled
  const on = st.policy.enabled && st.settings.enabled
  const threadChoices = hw ? [0, ...[1, 2, 4, 6, 8, 12, 16].filter((n) => n <= hw.cpuCores)] : [0]

  return <>
    <H1>{t('settings.nav.AI')}</H1>
    <p className="m-0 max-w-[720px] text-[13px] leading-[1.55] text-[#C9D6EE]">{t('ai.set.intro')}</p>

    {st.policy.managed && (
      <section aria-label={t('ai.set.policy')} className="flex items-start gap-3 rounded-[14px] border border-[rgba(31,107,255,0.35)] bg-[rgba(31,107,255,0.1)] px-4 py-3 text-[13px]">
        <Svg d={BUILDING} size={18} stroke="#7FB2FF" />
        <span className="flex flex-col gap-0.5">
          <b>{managedOff ? t('ai.set.policyOff') : st.policy.models ? t('ai.set.policyLimited', { count: st.policy.models.length }) : t('ai.set.policyOn')}</b>
          <span className="text-xs text-[#8FA3C8]">{t('ai.set.policyHint')}</span>
        </span>
      </section>
    )}

    <div className={`${card} flex items-center gap-4 px-5 py-[18px]`}>
      <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#1F6BFF,#18D4F0)]"><Svg d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" size={24} stroke="#FFFFFF" /></span>
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-base font-semibold">{t('ai.title')}</span>
        <span className="text-[13px]" style={{ color: on ? C.green : C.muted }}>{managedOff ? t('ai.set.offByOrg') : on ? t('ai.set.onHint') : t('common.off')}</span>
      </span>
      <BigSwitch label={t('ai.title')} checked={on} unavailable={managedOff ? t('ai.set.offByOrg') : undefined} loading={busy === 'enabled'} onChange={(v) => run('enabled', ai().setSettings({ enabled: v }))} />
    </div>
    <p className="m-0 flex items-center gap-2 text-xs text-[#9FE3BF]"><Svg d={SHIELD} size={14} stroke="#5FD39A" />{t('ai.privacy')}</p>

    {msg && <p role="status" className="m-0 text-[13px]" style={{ color: msg.ok ? C.green : C.red }}>{msg.text}</p>}

    <section aria-labelledby="ai-computer" className="flex flex-col gap-2">
      <h2 id="ai-computer" className={`m-0 font-normal ${sectionLabel}`}>{t('ai.set.thisComputer')}</h2>
      <div className={`${card} overflow-hidden`}>
        <Row label={t('ai.set.hardware')} hint={hw ? t('ai.set.hardwareHint', { cores: hw.cpuCores, memory: formatBytes(hw.memoryBytes), gpu: hw.gpu ? t('ai.set.gpuIn', { gpu: hw.gpu }) : hw.vulkan ? t('ai.set.vulkanFound') : t('ai.set.cpuOnly'), free: hw.freeDiskBytes !== null ? formatBytes(hw.freeDiskBytes) : '—' }) : t('common.loading')}>
          {hw && <Chip tone={hw.tier === 'minimal' ? 'warn' : 'info'}>{t('ai.set.tier', { tier: t(TIER[hw.tier]) })}</Chip>}
        </Row>
        <Row label={t('ai.set.runtime')} hint={st.error ? aiErrorText(st.error) : st.loaded ? t('ai.set.loaded', { name: chat.find((m) => m.model.id === st.loaded)?.model.name ?? st.loaded }) : t('ai.set.loadsOnFirst')}>
          <span className="flex items-center gap-2">
            <Chip tone={st.runtime === 'error' ? 'bad' : st.runtime === 'off' ? 'muted' : 'ok'}>{t(RUNTIME[st.runtime])}</Chip>
            <button type="button" disabled={busy === 'restart'} onClick={() => run('restart', ai().restart(), () => t('ai.set.restarted'))} className={small}>{t('ai.set.restart')}</button>
          </span>
        </Row>
      </div>
    </section>

    <section aria-labelledby="ai-perf" className="flex flex-col gap-2">
      <h2 id="ai-perf" className={`m-0 font-normal ${sectionLabel}`}>{t('ai.set.performance')}</h2>
      <div className={`${card} overflow-hidden`}>
        <Row label={t('ai.set.threads')} hint={hw ? t('ai.set.threadsHint', { n: hw.autoThreads }) : null}>
          <select aria-label={t('ai.set.threads')} value={st.settings.threads} disabled={busy === 'threads'} onChange={(e) => run('threads', ai().setSettings({ threads: Number(e.target.value) }))}
            className="h-9 rounded-[9px] border border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] px-2.5 text-[13px] text-[#E8EEFA]">
            {threadChoices.map((n) => <option key={n} value={n}>{n === 0 ? t('ai.set.threadsAuto', { n: hw?.autoThreads ?? 0 }) : formatNumber(n)}</option>)}
          </select>
        </Row>
        <Row label={t('ai.set.gpu')} hint={hw?.gpu ? t('ai.set.gpuUsing', { gpu: hw.gpu }) : hw?.vulkan ? t('ai.set.gpuVulkan') : t('ai.set.gpuNone')}>
          <BigSwitch label={t('ai.set.gpu')} checked={st.settings.gpu} disabled={busy === 'gpu'} onChange={(v) => run('gpu', ai().setSettings({ gpu: v }))} />
        </Row>
      </div>
      <Note>{t('ai.set.perfNote')}</Note>
    </section>

    <section aria-labelledby="ai-privacy" className="flex flex-col gap-2">
      <h2 id="ai-privacy" className={`m-0 font-normal ${sectionLabel}`}>{t('ai.set.privacy')}</h2>
      <div className={`${card} overflow-hidden`}>
        <Row label={t('ai.set.history')} hint={t('ai.set.historyHint')}>
          <BigSwitch label={t('ai.set.history')} checked={prefs.history} onChange={(v) => { const p = { history: v }; savePrefs(p); setPrefs(p) }} />
        </Row>
        <Row label={t('ai.set.clear')} hint={t('ai.set.clearHint')}>
          <button type="button" onClick={() => { clearHistory(); setMsg({ ok: true, text: t('ai.set.cleared') }) }} className={small}>{t('ai.set.clearBtn')}</button>
        </Row>
      </div>
    </section>

    <section aria-labelledby="ai-models" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h2 id="ai-models" className={`m-0 font-normal ${sectionLabel}`}>{t('ai.set.models')}</h2>
        <button type="button" disabled={busy === 'catalog'} onClick={() => run('catalog', ai().refresh())} className={small}>{t('ai.set.checkModels')}</button>
      </div>
      <Note>{st.catalogError ? aiErrorText(st.catalogError) : st.catalogAt ? t('ai.set.catalogAt', { when: formatDate(Date.parse(st.catalogAt)) }) : t('ai.set.catalogNone')}</Note>
      {!chat.length ? <Empty title={st.policy.models ? t('ai.set.noneAllowed') : t('ai.set.noModels')} /> : (
        <ul className={`${card} m-0 list-none overflow-hidden p-0`}>
          {chat.map((v) => <ModelRow key={v.model.id} v={v} busy={busy} disabled={!on} run={run} />)}
        </ul>
      )}
    </section>
  </>
}

function ModelRow({ v, busy, disabled, run }: { v: LocalModelView; busy: string | null; disabled: boolean; run: (k: string, p: Promise<{ ok: boolean; error?: string; value?: unknown }>, ok?: (v: unknown) => string | null) => void }) {
  const m = v.model
  const pct = m.bytes ? Math.min(100, Math.round((v.received / m.bytes) * 100)) : 0
  const left = v.state === 'downloading' ? timeLeftLabel(secondsLeft(v)) : null
  return (
    <li className={`flex flex-col gap-2 px-[18px] py-3.5 ${rowLine}`}>
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">{m.name}
            {v.recommended && <Chip tone="info">{t('ai.set.recommended')}</Chip>}
            {v.isDefault && v.state === 'installed' && <Chip tone="ok">{t('ai.set.default')}</Chip>}
            {!v.fits && <Chip tone="warn">{t('ai.set.maySlow')}</Chip>}
            {v.system && <Chip tone="muted">{t('ai.set.forEveryone')}</Chip>}
          </span>
          <span className="text-xs text-[#8FA3C8]">{t('ai.set.modelLine', { size: downloadSize(m, formatBytes), quant: m.quantization, ram: formatBytes(m.minMemoryBytes) })}</span>
          <span className="text-xs text-[#8FA3C8]">{t('ai.set.licence', { licence: m.license.name })}</span>
          {m.notice && <span className="mt-1 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[11.5px] text-[#C9D6EE]">{m.notice}</span>}
          {v.state === 'unpublished' && <span className="text-xs text-[#C9D6EE]">{t('ai.setup.unpublished')}</span>}
          {v.error && <span className="text-xs text-[#FF8A7A]">{aiErrorText(v.error)}</span>}
          {v.state === 'installed' && v.readiness === 'failed' && <span className="text-xs text-[#FF8A7A]">{t('ai.set.didNotAnswer', { why: aiErrorText(v.readinessError) })}</span>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {(v.state === 'available' || v.state === 'failed') && <button type="button" disabled={disabled || busy === `i:${m.id}`} onClick={() => run(`i:${m.id}`, ai().install(m.id))} className={smallPrimary}>{v.state === 'failed' ? t('ai.retry') : t('ai.setup.download')}</button>}
          {v.state === 'downloading' && <>
            <button type="button" onClick={() => run(`c:${m.id}`, ai().cancel(m.id, false))} className={small}>{t('ai.setup.pause')}</button>
            <button type="button" onClick={() => run(`c:${m.id}`, ai().cancel(m.id, true))} className={small}>{t('common.cancel')}</button>
          </>}
          {v.state === 'paused' && <>
            <button type="button" disabled={disabled} onClick={() => run(`i:${m.id}`, ai().install(m.id))} className={smallPrimary}>{t('ai.setup.resume')}</button>
            <button type="button" onClick={() => run(`c:${m.id}`, ai().cancel(m.id, true))} className={small}>{t('ai.set.discard')}</button>
          </>}
          {v.state === 'verifying' && <span className="flex items-center gap-1.5 text-xs text-[#9CC2FF]"><Spinner size={12} />{t('ai.set.verifying')}</span>}
          {v.state === 'installed' && v.readiness === 'testing' && <span className="flex items-center gap-1.5 text-xs text-[#9CC2FF]"><Spinner size={12} />{t('ai.set.settingUp')}</span>}
          {v.state === 'installed' && v.readiness === 'ready' && <Chip tone="ok">{t('ai.set.readyToUse')}</Chip>}
          {v.state === 'installed' && (v.readiness === 'failed' || v.readiness === 'untested') && (
            <button type="button" disabled={disabled || busy === `t:${m.id}`} onClick={() => run(`t:${m.id}`, ai().test(m.id), (ok) => ok ? t('ai.set.testOk', { name: m.name }) : t('ai.set.testFailed', { name: m.name }))} className={small}>{v.readiness === 'failed' ? t('ai.setup.testAgain') : t('ai.set.test')}</button>
          )}
          {v.state === 'installed' && v.readiness !== 'testing' && <>
            {!v.isDefault && v.readiness !== 'failed' && <button type="button" disabled={busy === `d:${m.id}`} onClick={() => run(`d:${m.id}`, ai().setDefault(m.id), () => t('ai.set.useOk', { name: m.name }))} className={small}>{t('ai.set.use')}</button>}
            <button type="button" disabled={busy === `k:${m.id}`} onClick={() => run(`k:${m.id}`, ai().check(m.id), (ok) => ok ? t('ai.set.checkOk') : t('ai.err.mismatchInstalled'))} className={small}>{t('ai.set.check')}</button>
            {!v.system && <button type="button" disabled={busy === `r:${m.id}`} onClick={() => run(`r:${m.id}`, ai().remove(m.id), () => t('ai.set.removed', { name: m.name }))} className={`${small} text-[#FF8A7A]`}>{t('ai.set.remove')}</button>}
          </>}
        </div>
      </div>
      {(v.state === 'downloading' || v.state === 'paused') && (
        <div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label={t('ai.setup.download')} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className={`h-full rounded-full transition-[width] ${v.state === 'paused' ? 'bg-[#8FA3C8]' : 'bg-[#1F6BFF]'}`} style={{ width: `${pct}%` }} />
          </div>
          <span className="mt-1 block text-[11.5px] text-[#8FA3C8]">{v.state === 'paused' ? t('ai.setup.paused') : t('ai.stage.downloading')} · {t('ai.setup.progress', { pct, got: formatBytes(v.received), total: formatBytes(m.bytes) })}{left ? ` · ${left}` : ''}</span>
        </div>
      )}
    </li>
  )
}
