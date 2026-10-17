// The AI assistant panel (Super+A, the taskbar's AI button, "Ask AI" in search). It is WorkSuite Desktop's assistant
// panel (src/modules/ai/AskPanel.tsx with LocalSetup.tsx) brought to the shell: the same first-use setup card and its
// stages, the conversation with "Processed locally" answers drawn from Markdown, the Chat-style composer with Stop and
// Send, and the status line saying where the answer comes from. It answers only with the model on this computer — the
// OS has no online fallback — so the panel says plainly when no model can answer, and never makes an answer up.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { C, Spinner, Svg } from './Dk'
import { Markdown } from './Markdown'
import { formatBytes } from '../lib/os'
import { PROBLEM_ADVICE, STAGES, ai, aiErrorText, compatibility, downloadSize, firstUseOffer, localReady, needsSetup, problemKind, secondsLeft, stageOf, storageNeeded, suggestedModel, timeLeftLabel, useAI, type LocalAIHardware, type LocalModelView } from '../lib/aiApi'
import { assistantStore, cancel, reset, retry, send, sendWithContext, useAssistant, type AskEntry } from '../lib/assistant'
import type { AssistantRequest } from '../lib/assistantNav'
import { t, useT } from '../i18n'

export const AI_ICON = 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9zM5 3l.6 1.4L7 5l-1.4.6L5 7l-.6-1.4L3 5l1.4-.6z'
const CPU = 'M7 7h10v10H7zM10 10h4v4h-4zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4'
const SHIELD = 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4'
const D = {
  close: 'M6 6l12 12M18 6L6 18', gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  plus: 'M12 5v14M5 12h14', send: 'M4 12l16-8-6 16-2-6z', stop: 'M7 7h10v10H7z', copy: 'M9 9h11v11H9zM5 15V4h11', retry: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4',
  check: 'M5 12.5l4.5 4.5L19 7.5', alert: 'M12 8v5M12 16.5v.5M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  select: 'M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3M8 12h8', clip: 'M9 4h6v3H9zM7 5H5v15h14V5h-2', file: 'M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6', clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
}
const smallBtn = 'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[8px] px-3 text-[12.5px] font-semibold disabled:cursor-default disabled:opacity-50'

export interface AssistantProps {
  onClose(): void
  onOpenSettings(): void
  /** What opened it (a file from Files, a question from search), handled once. */
  request?: AssistantRequest | null
  onRequestHandled?(): void
}

export default function Assistant({ onClose, onOpenSettings, request, onRequestHandled }: AssistantProps) {
  const tr = useT()
  const { status, models, reload } = useAI()
  const st = useAssistant()
  const input = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const s = status?.ok ? status.value : null
  const list = models?.ok ? models.value : undefined
  const serviceDown = status !== null && !status.ok
  const policyOff = !!s && !s.policy.enabled
  const userOff = !!s && s.policy.enabled && !s.settings.enabled
  const model = localReady(list)
  const off = serviceDown ? 'service' : policyOff ? 'policy' : userOff ? 'user' : s && list && !model ? 'model' : null
  const canAsk = !!model && !off

  useEffect(() => { input.current?.focus() }, [])
  // The conversation follows a growing answer while the reader is at the end.
  useEffect(() => {
    const el = scroller.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }, [st.entries.length, st.streaming, st.busy])

  // Opened from Files ("Explain with AI") or search ("Ask AI").
  useEffect(() => {
    if (!request || request.kind === 'open') { if (request) onRequestHandled?.(); return }
    if (request.kind === 'ask') { assistantStore.setText(request.text); onRequestHandled?.(); input.current?.focus(); return }
    if (!canAsk) return
    onRequestHandled?.()
    void ai().readFile(request.root, request.rel).then((r) => {
      if (r.ok) void sendWithContext('file', r.value.text, r.value.name)
      else setNotice(aiErrorText(r.error))
    })
  }, [request, canAsk, onRequestHandled])

  const withContext = async (kind: 'selection' | 'clipboard') => {
    setNotice(null)
    const r = kind === 'selection' ? await ai().selection() : await ai().clipboard()
    if (r.ok) void sendWithContext(kind, r.value)
    else setNotice(aiErrorText(r.error))
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (canAsk) void send() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
  }
  const phase = st.busy ? (st.phase === 'answering' ? tr('ai.answeringLocal') : tr('ai.thinkingLocal')) : canAsk ? tr('ai.readyLocal') : tr('ai.notReady')

  return (
    <aside id="ws-assistant" role="dialog" aria-modal="false" aria-label={tr('ai.title')} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
      className="ws-rise absolute top-3 right-3 bottom-[64px] z-[65] box-border flex w-[420px] max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-[18px] border border-[rgba(127,178,255,0.2)] bg-[rgba(10,24,56,0.97)] font-sans text-[#E8EEFA] shadow-[0_30px_80px_rgba(0,0,0,0.55)] backdrop-blur-[24px]">
      <header className="flex items-center gap-3 border-b border-[rgba(127,178,255,0.12)] px-4 py-3">
        <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-[10px] bg-[linear-gradient(135deg,#1F6BFF,#18D4F0)]"><Svg d={AI_ICON} size={18} stroke="#FFFFFF" /></span>
        <span className="flex min-w-0 flex-1 flex-col">
          <h2 className="m-0 text-[15px] font-semibold">{tr('ai.title')}</h2>
          <span className="truncate text-[11.5px] text-[#8FA3C8]">{model ? model.model.name : tr('ai.noModelShort')}</span>
        </span>
        <button type="button" aria-label={tr('ai.newChat')} title={tr('ai.newChat')} disabled={!st.entries.length && !st.busy} onClick={reset} className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-[#C9D6EE] hover:bg-white/10 disabled:cursor-default disabled:opacity-40"><Svg d={D.plus} size={16} /></button>
        <button type="button" aria-label={tr('ai.settings')} title={tr('ai.settings')} onClick={onOpenSettings} className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-[#C9D6EE] hover:bg-white/10"><Svg d={D.gear} size={16} /></button>
        <button type="button" aria-label={tr('ai.close')} title={tr('ai.close')} onClick={onClose} className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-[#C9D6EE] hover:bg-white/10"><Svg d={D.close} size={16} /></button>
      </header>
      <p className="m-0 flex items-center gap-2 border-b border-[rgba(127,178,255,0.08)] bg-[rgba(46,158,106,0.1)] px-4 py-2 text-[12px] text-[#9FE3BF]">
        <Svg d={SHIELD} size={14} stroke="#5FD39A" />{tr('ai.privacy')}
      </p>

      <div ref={scroller} data-testid="ai-conversation" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3" aria-live="polite">
        {off === 'service' && <OffCard title={tr('ai.off.serviceTitle')} body={tr('ai.off.serviceBody')} action={<button type="button" onClick={() => void reload()} className={`${smallBtn} bg-white/10 text-white hover:bg-white/15`}>{tr('ai.retry')}</button>} />}
        {off === 'policy' && <OffCard title={tr('ai.off.policyTitle')} body={tr('ai.off.policyBody')} />}
        {off === 'user' && <OffCard title={tr('ai.off.userTitle')} body={tr('ai.off.userBody')} action={<button type="button" onClick={() => void ai().setSettings({ enabled: true }).then(reload)} className={`${smallBtn} bg-[#1F6BFF] text-white hover:bg-[#3A7DFF]`}>{tr('ai.turnOn')}</button>} />}
        {off === 'model' && !firstUseOffer(list, suggestedModel(list)) && <OffCard title={tr('ai.off.modelTitle')} body={tr('ai.off.modelBody')} action={<button type="button" onClick={onOpenSettings} className={`${smallBtn} bg-white/10 text-white hover:bg-white/15`}>{tr('ai.setUp')}</button>} />}
        {!serviceDown && !policyOff && !userOff && list && <LocalSetup models={list} hw={s?.hardware ?? null} onStart={() => input.current?.focus()} onSettings={onOpenSettings} />}
        {status === null && <p role="status" className="m-0 flex items-center gap-2 text-[13px] text-[#8FA3C8]"><Spinner />{tr('common.loading')}</p>}

        {st.entries.length === 0 && canAsk && (
          <div className="flex flex-col gap-2.5">
            <p className="m-0 text-[12.5px] leading-[1.5] text-[#8FA3C8]">{tr('ai.intro')}</p>
            <div className="flex flex-wrap gap-1.5" aria-label={tr('ai.ctx.label')} role="group">
              <button type="button" onClick={() => void withContext('selection')} className="cursor-pointer rounded-full border border-[rgba(127,178,255,0.25)] px-2.5 py-1 text-[12px] font-semibold hover:bg-white/[0.06]">{tr('ai.ctx.summarizeSelection')}</button>
              <button type="button" onClick={() => void withContext('clipboard')} className="cursor-pointer rounded-full border border-[rgba(127,178,255,0.25)] px-2.5 py-1 text-[12px] font-semibold hover:bg-white/[0.06]">{tr('ai.ctx.summarizeClipboard')}</button>
            </div>
            <p className="m-0 flex items-center gap-1.5 text-[11.5px] text-[#8FA3C8]"><Svg d={D.file} size={12} stroke={C.muted} />{tr('ai.ctx.fileHint')}</p>
          </div>
        )}
        {st.entries.map((e, i) => <Bubble key={i} e={e} onRetry={e.role === 'assistant' && (e.error || e.stopped) && i === st.entries.length - 1 && !st.busy && canAsk ? () => void retry() : undefined} onSetup={onOpenSettings} />)}
        {/* A growing answer is not read out word by word: the whole one is, once it lands. */}
        {st.streaming && <div aria-live="off"><Bubble e={{ role: 'assistant', text: st.streaming }} streaming /></div>}
        {st.busy && !st.streaming && (
          <p data-testid="ai-thinking" className="m-0 flex items-center gap-2 text-[13px] text-[#C9D6EE]"><Svg d={AI_ICON} size={16} stroke="#18D4F0" className="shrink-0 motion-safe:animate-pulse" />{tr('ai.thinking')}</p>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-[rgba(127,178,255,0.12)] px-4 pt-3 pb-2.5">
        {notice && <p role="alert" className="m-0 flex items-start gap-1.5 rounded-lg bg-[rgba(217,69,43,0.15)] px-2.5 py-1.5 text-[12px] text-[#FF8A7A]"><Svg d={D.alert} size={14} />{notice}</p>}
        {!!st.entries.length && canAsk && !st.busy && (
          <div className="flex gap-1.5" role="group" aria-label={tr('ai.ctx.label')}>
            <button type="button" onClick={() => void withContext('selection')} title={tr('ai.ctx.summarizeSelection')} className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-white/[0.06] px-2.5 py-1 text-[11.5px] text-[#C9D6EE] hover:bg-white/[0.1]"><Svg d={D.select} size={12} />{tr('ai.ctx.selection')}</button>
            <button type="button" onClick={() => void withContext('clipboard')} title={tr('ai.ctx.summarizeClipboard')} className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-white/[0.06] px-2.5 py-1 text-[11.5px] text-[#C9D6EE] hover:bg-white/[0.1]"><Svg d={D.clip} size={12} />{tr('ai.ctx.clipboard')}</button>
          </div>
        )}
        {/* The Chat composer's box: the field and its buttons in one bordered, focus-ringed frame (as Desktop). */}
        <div className={`flex items-end gap-1 rounded-[12px] border px-2 py-1.5 ${canAsk ? 'border-[rgba(127,178,255,0.25)] bg-[rgba(4,10,26,0.5)] focus-within:border-[#1F6BFF]' : 'border-[rgba(127,178,255,0.12)] bg-[rgba(4,10,26,0.3)]'}`}>
          <textarea ref={input} value={st.text} rows={1} disabled={!canAsk} onChange={(e) => assistantStore.setText(e.target.value)} onKeyDown={onKey}
            placeholder={tr('ai.placeholder')} aria-label={tr('ai.question')}
            className="field-sizing-content max-h-40 min-h-[34px] min-w-0 flex-1 resize-none border-0 bg-transparent focus-visible:shadow-none focus-visible:outline-none px-1 py-[7px] text-[13.5px] text-[#E8EEFA] outline-none placeholder:text-[#8FA3C8] disabled:cursor-not-allowed" />
          {st.busy && (
            <button type="button" onClick={cancel} aria-label={tr('ai.stop')} title={tr('ai.stop')} className="flex size-[34px] shrink-0 cursor-pointer items-center justify-center rounded-[9px] border border-[rgba(127,178,255,0.25)] text-white hover:bg-white/10"><Svg d={D.stop} size={13} /></button>
          )}
          <button type="button" onClick={() => void send()} disabled={st.busy || !st.text.trim() || !canAsk} aria-label={tr('ai.send')} title={tr('ai.sendHint')}
            className="flex size-[34px] shrink-0 cursor-pointer items-center justify-center rounded-[9px] bg-[#1F6BFF] text-white hover:bg-[#3A7DFF] disabled:cursor-default disabled:bg-white/[0.06] disabled:text-[#8FA3C8]"><Svg d={D.send} size={15} /></button>
        </div>
        <div className="flex items-center gap-2 px-1 text-[11px] text-[#8FA3C8]">
          <span data-testid="ai-mode" className="flex min-w-0 flex-1 items-center gap-1 truncate"><Svg d={CPU} size={11} />{phase}{canAsk && !st.busy ? ` · ${tr('ai.enterToSend')}` : ''}</span>
          {!!st.entries.length && !st.busy && <button type="button" onClick={reset} className="shrink-0 cursor-pointer font-semibold text-[#C9D6EE] hover:text-white">{tr('ai.newConversation')}</button>}
        </div>
      </div>
    </aside>
  )
}

function OffCard({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div role="status" className="flex flex-col gap-2 rounded-[12px] border border-[rgba(240,180,41,0.35)] bg-[rgba(240,180,41,0.1)] px-3 py-2.5 text-[12.5px] text-[#F5D58A]">
      <b className="text-[13px] text-[#FFE6A8]">{title}</b>
      <span className="leading-[1.5]">{body}</span>
      {action && <div className="flex gap-1.5">{action}</div>}
    </div>
  )
}

function Bubble({ e, onRetry, onSetup, streaming }: { e: AskEntry; onRetry?: () => void; onSetup?: () => void; streaming?: boolean }) {
  const tr = useT()
  const [copied, setCopied] = useState(false)
  if (e.role === 'user') {
    return (
      <div className="ml-8 flex flex-col items-end gap-1 self-end">
        {e.context && <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.08] px-2 py-0.5 text-[11px] text-[#C9D6EE]"><Svg d={e.context.kind === 'file' ? D.file : e.context.kind === 'clipboard' ? D.clip : D.select} size={11} />{tr('ai.ctx.chars', { count: e.context.chars })}</span>}
        <p className="m-0 rounded-[12px] bg-[#1F6BFF] px-3 py-2 text-[13px] whitespace-pre-wrap text-white select-text">{e.text}</p>
      </div>
    )
  }
  if (e.error) {
    const kind = problemKind(e.error)
    return (
      <div className="flex flex-col gap-1.5">
        <p role="alert" className="m-0 flex items-start gap-1.5 rounded-[10px] bg-[rgba(217,69,43,0.15)] px-3 py-2 text-[12.5px] text-[#FF8A7A]"><Svg d={D.alert} size={15} className="mt-0.5 shrink-0" />
          <span className="flex flex-col gap-0.5"><span>{aiErrorText(e.error)}</span>{kind === 'memory' && <span className="text-[11.5px] opacity-85">{tr(PROBLEM_ADVICE.memory)}</span>}</span></p>
        <div className="flex flex-wrap gap-1.5">
          {onRetry && <button type="button" onClick={onRetry} className={`${smallBtn} border border-[rgba(127,178,255,0.25)] text-white hover:bg-white/[0.06]`}><Svg d={D.retry} size={13} />{tr('ai.retry')}</button>}
          {needsSetup(e.error) && onSetup && <button type="button" onClick={onSetup} className={`${smallBtn} border border-[rgba(127,178,255,0.25)] text-white hover:bg-white/[0.06]`}><Svg d={CPU} size={13} />{tr('ai.setUp')}</button>}
        </div>
      </div>
    )
  }
  const copy = () => { void navigator.clipboard?.writeText(e.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {}) }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="inline-flex w-fit items-center gap-1 rounded-full bg-white/[0.07] px-2 py-0.5 text-[11px] text-[#C9D6EE]">
        <Svg d={e.stopped ? D.stop : CPU} size={10} />{e.stopped ? tr('ai.stopped') : tr('ai.processedLocally')}
      </span>
      {!(e.stopped && e.text === t('ai.stopped')) && <Markdown text={e.text} className="text-[13.5px] leading-[1.55] text-[#E8EEFA] select-text" />}
      {!streaming && (
        <div className="flex gap-1.5">
          <button type="button" onClick={copy} aria-label={tr('ai.copy')} className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#8FA3C8] hover:bg-white/[0.06] hover:text-white"><Svg d={copied ? D.check : D.copy} size={12} />{copied ? tr('ai.copied') : tr('ai.copy')}</button>
          {onRetry && <button type="button" onClick={onRetry} className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[#8FA3C8] hover:bg-white/[0.06] hover:text-white"><Svg d={D.retry} size={12} />{tr('ai.retry')}</button>}
        </div>
      )}
    </div>
  )
}

/**
 * "Set up your AI Assistant" (Desktop's LocalSetup, worksuite-desktop#49/#55): the model that suits this computer, its
 * size and the space it needs, Download and set up / Not now; then the stages (Downloading → Verifying → Preparing AI →
 * Ready) with percentage, size and time left, Pause, Resume, Cancel and Try again; then "ready to use" once.
 */
const SNOOZE = 'ws.ai.localSetup.snoozed'
const SETTING_UP = 'ws.ai.localSetup.model'
const SNOOZE_MS = 7 * 24 * 3600_000
const read = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const write = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* a convenience */ } }

export function LocalSetup({ models, hw, onStart, onSettings }: { models: LocalModelView[]; hw: LocalAIHardware | null; onStart: () => void; onSettings: () => void }) {
  const tr = useT()
  const [hidden, setHidden] = useState(() => Number(read(SNOOZE) ?? 0) > Date.now() - SNOOZE_MS)
  const [mine, setMine] = useState(() => read(SETTING_UP))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const offer = firstUseOffer(models, suggestedModel(models))
  const ours = mine ? models.find((m) => m.model.id === mine) : undefined
  const justReady = !!ours && ours.state === 'installed' && ours.readiness === 'ready'
  const v = justReady ? ours : offer
  if (!v) return null
  const m = v.model
  if (hidden && v.state === 'available' && !justReady) return null
  const go = (p: Promise<{ ok: boolean; error?: string }>) => { setBusy(true); setErr(null); void p.then((r) => { if (!r.ok) setErr(aiErrorText(r.error)) }).finally(() => setBusy(false)) }
  const start = () => { write(SETTING_UP, m.id); setMine(m.id); go(ai().install(m.id)) }

  if (justReady) {
    return (
      <section aria-label={tr('ai.setup.readyTitle')} className="flex flex-col gap-2 rounded-[12px] border border-[rgba(95,211,154,0.4)] bg-[rgba(95,211,154,0.1)] p-3 text-[12.5px]">
        <div className="flex items-start gap-2"><Svg d={D.check} size={18} stroke="#5FD39A" className="mt-0.5 shrink-0" />
          <span className="flex flex-col"><b className="text-[13.5px]">{tr('ai.setup.readyTitle')}</b><span className="text-[#C9D6EE]">{tr('ai.setup.readyBody', { name: m.name })}</span></span></div>
        <button type="button" onClick={() => { write(SETTING_UP, null); setMine(null); onStart() }} className={`${smallBtn} w-fit bg-[#1F6BFF] text-white hover:bg-[#3A7DFF]`}>{tr('ai.setup.startChatting')}</button>
      </section>
    )
  }
  const fit = compatibility(v, hw)
  const { stage, stopped } = stageOf(v)
  const started = v.state !== 'available' && v.state !== 'unpublished'
  const pct = m.bytes ? Math.min(100, Math.round((v.received / m.bytes) * 100)) : 0
  const readinessFailed = v.state === 'installed' && v.readiness === 'failed'
  const problem = v.state === 'failed' ? v.error : readinessFailed ? v.readinessError : null
  const kind = problemKind(problem, readinessFailed && problem !== 'out_of_memory')
  const left = v.state === 'downloading' ? timeLeftLabel(secondsLeft(v)) : null
  return (
    <section aria-label={tr('ai.setup.title')} className="flex flex-col gap-2.5 rounded-[12px] border border-[rgba(127,178,255,0.18)] bg-[rgba(14,32,72,0.6)] p-3 text-[12.5px]">
      <div className="flex items-start gap-2"><Svg d={CPU} size={17} stroke={C.soft} className="mt-0.5 shrink-0" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <b className="text-[13.5px]">{tr('ai.setup.title')}</b>
          <span className="text-[#C9D6EE]">{tr('ai.setup.summary', { name: m.name, size: downloadSize(m, formatBytes), space: formatBytes(storageNeeded({ model: m, received: 0 })) })}</span>
          {!started && <span className="text-[#8FA3C8]">{tr('ai.setup.privacy')}</span>}
        </span>
      </div>
      {v.state === 'unpublished' && <p className="m-0 rounded-lg bg-white/[0.05] p-2 text-[#C9D6EE]">{tr('ai.setup.unpublished')}</p>}
      {!started && v.state !== 'unpublished' && fit.storage && <p role="alert" className="m-0 rounded-lg bg-[rgba(217,69,43,0.15)] p-2 text-[#FF8A7A]">{tr('ai.setup.noSpace', { need: formatBytes(storageNeeded(v)), free: formatBytes(fit.free ?? 0) })}</p>}
      {!started && !fit.storage && fit.slow && hw && <p className="m-0 rounded-lg bg-[rgba(240,180,41,0.12)] p-2 text-[#F5D58A]">{tr('ai.setup.slow', { need: formatBytes(m.minMemoryBytes), have: formatBytes(Math.max(hw.memoryBytes, hw.vramBytes)) })}</p>}
      {!started && v.state !== 'unpublished' && <p className="m-0 text-[11.5px] text-[#8FA3C8]">{tr('ai.setup.licence', { licence: m.license.name })}{m.notice ? ` ${m.notice}` : ''}</p>}
      {started && (
        <ol aria-label={tr('ai.setup.stages')} className="m-0 flex list-none flex-wrap items-center gap-1 p-0 text-[11.5px]">
          {STAGES.map((x, i) => {
            const at = STAGES.findIndex((y) => y.id === stage)
            const done = i < at, now = i === at
            return (
              <li key={x.id} aria-current={now ? 'step' : undefined} className={`flex items-center gap-1 ${done ? 'text-[#5FD39A]' : now ? (stopped === 'failed' ? 'font-bold text-[#FF8A7A]' : 'font-bold text-white') : 'text-[#8FA3C8]'}`}>
                {now && !stopped ? <Spinner size={11} /> : <Svg d={done ? D.check : now && stopped === 'failed' ? D.alert : D.clock} size={12} />}
                {tr(x.label)}{i < STAGES.length - 1 && <span aria-hidden="true" className="mx-0.5 text-[#8FA3C8]">→</span>}
              </li>
            )
          })}
        </ol>
      )}
      {(v.state === 'downloading' || v.state === 'paused' || (v.state === 'failed' && v.received > 0)) && (
        <div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label={tr('ai.setup.download')} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className={`h-full rounded-full ${v.state === 'downloading' ? 'bg-[#1F6BFF] transition-[width]' : 'bg-[#8FA3C8]'}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 text-[11.5px] text-[#8FA3C8]">
            {tr('ai.setup.progress', { pct, got: formatBytes(v.received), total: formatBytes(m.bytes) })}{v.state === 'paused' ? ` · ${tr('ai.setup.paused')}` : left ? ` · ${left}` : v.state === 'downloading' ? ` · ${tr('ai.setup.estimating')}` : ''}
          </div>
        </div>
      )}
      {v.state === 'installed' && v.readiness === 'testing' && <p className="m-0 text-[#C9D6EE]">{tr('ai.setup.testing')}</p>}
      {problem && (
        <div role="alert" className="flex flex-col gap-0.5 rounded-lg bg-[rgba(217,69,43,0.15)] p-2 text-[#FF8A7A]">
          <b className="font-semibold">{tr(PROBLEM_ADVICE[kind])}</b><span className="text-[11.5px] opacity-85">{aiErrorText(problem)}</span>
        </div>
      )}
      {err && <p role="alert" className="m-0 text-[#FF8A7A]">{err}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        {v.state === 'available' && <>
          <button type="button" disabled={busy || fit.storage} onClick={start} className={`${smallBtn} bg-[#1F6BFF] text-white hover:bg-[#3A7DFF]`}>{fit.slow && !fit.storage ? tr('ai.setup.downloadAnyway') : tr('ai.setup.download')}</button>
          <button type="button" onClick={() => { write(SNOOZE, String(Date.now())); setHidden(true) }} className={`${smallBtn} text-[#C9D6EE] hover:bg-white/[0.06]`}>{tr('ai.setup.notNow')}</button>
        </>}
        {v.state === 'unpublished' && <button type="button" onClick={onSettings} className={`${smallBtn} border border-[rgba(127,178,255,0.25)] text-white hover:bg-white/[0.06]`}>{tr('ai.settings')}</button>}
        {v.state === 'failed' && <button type="button" disabled={busy} onClick={start} className={`${smallBtn} bg-[#1F6BFF] text-white hover:bg-[#3A7DFF]`}>{kind === 'connection' && v.received > 0 ? tr('ai.setup.resume') : tr('ai.retry')}</button>}
        {v.state === 'downloading' && <button type="button" onClick={() => go(ai().cancel(m.id, false))} className={`${smallBtn} border border-[rgba(127,178,255,0.25)] text-white hover:bg-white/[0.06]`}>{tr('ai.setup.pause')}</button>}
        {v.state === 'paused' && <button type="button" disabled={busy} onClick={start} className={`${smallBtn} bg-[#1F6BFF] text-white hover:bg-[#3A7DFF]`}>{tr('ai.setup.resume')}</button>}
        {(v.state === 'downloading' || v.state === 'paused' || v.state === 'failed') && <button type="button" onClick={() => { write(SETTING_UP, null); go(ai().cancel(m.id, true)) }} className={`${smallBtn} text-[#C9D6EE] hover:bg-white/[0.06]`}>{tr('common.cancel')}</button>}
        {readinessFailed && <>
          <button type="button" disabled={busy} onClick={() => go(ai().test(m.id))} className={`${smallBtn} bg-[#1F6BFF] text-white hover:bg-[#3A7DFF]`}>{tr('ai.setup.testAgain')}</button>
          <button type="button" onClick={onSettings} className={`${smallBtn} border border-[rgba(127,178,255,0.25)] text-white hover:bg-white/[0.06]`}>{tr('ai.setup.chooseAnother')}</button>
        </>}
      </div>
    </section>
  )
}

