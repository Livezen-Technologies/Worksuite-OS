// Renderer side of the on-device AI assistant (electron/ai.ts → services/ai). Shapes as services/ai/src/types.ts;
// the setup helpers are WorkSuite Desktop's (src/modules/ai/setup.ts, src/core/local-ai.ts), so the first-use offer,
// the stages and the advice match the Desktop assistant. Outside Electron there is no service: the panel says so and
// never makes an answer up.
import { useCallback, useEffect, useState } from 'react'
import { t, type MessageKey } from '../i18n'

export type LocalAITier = 'minimal' | 'basic' | 'good' | 'strong'
export interface LocalModel {
  id: string; version: string; name: string; family: string; purpose: 'chat' | 'embedding' | 'router'; url: string
  sha256: string; bytes: number; approxBytes?: number; quantization: string; contextLength: number; minMemoryBytes: number
  tiers: LocalAITier[]; recommendedFor: LocalAITier[]; license: { id: string; name: string; url: string }; notice?: string
  languages: string[]; toolCalling: boolean
}
export type LocalModelState = 'available' | 'downloading' | 'paused' | 'verifying' | 'installed' | 'failed' | 'unpublished'
export type LocalModelReadiness = 'untested' | 'testing' | 'ready' | 'failed'
export interface LocalModelView {
  model: LocalModel; state: LocalModelState; received: number; error: string | null; fits: boolean; recommended: boolean
  isDefault: boolean; readiness: LocalModelReadiness; readinessError: string | null; bytesPerSecond?: number | null; system?: boolean
}
export interface LocalAIHardware {
  platform: string; arch: string; memoryBytes: number; freeDiskBytes: number | null; cpuCores: number; cpuModel: string
  gpu: string | false; vulkan: boolean; vramBytes: number; tier: LocalAITier; autoThreads: number
}
export type LocalRuntimeState = 'off' | 'starting' | 'ready' | 'loading' | 'busy' | 'error'
export interface AIPolicy { managed: boolean; enabled: boolean; models: string[] | null }
export interface AISettings { enabled: boolean; threads: number; gpu: boolean }
export interface LocalAIStatus {
  runtime: LocalRuntimeState; error: string | null; loaded: string | null; hardware: LocalAIHardware | null
  catalogError: string | null; catalogAt: string | null; policy: AIPolicy; settings: AISettings
}
export interface LocalMessage { role: 'system' | 'user' | 'assistant'; content: string }
export type LocalAIEvent =
  | { id: string; type: 'chunk'; text: string }
  | { id: string; type: 'done'; text: string; tokens: number; ms: number; cancelled: boolean }
  | { id: string; type: 'error'; code: string }
export type AIReply<T> = { ok: true; value: T } | { ok: false; error: string }

export interface AIApi {
  status(): Promise<AIReply<LocalAIStatus>>
  models(): Promise<AIReply<LocalModelView[]>>
  refresh(): Promise<AIReply<true>>
  install(id: string): Promise<AIReply<true>>
  cancel(id: string, discard: boolean): Promise<AIReply<true>>
  remove(id: string): Promise<AIReply<true>>
  setDefault(id: string): Promise<AIReply<true>>
  check(id: string): Promise<AIReply<boolean>>
  test(id: string): Promise<AIReply<boolean>>
  restart(): Promise<AIReply<true>>
  setSettings(patch: Partial<AISettings>): Promise<AIReply<AISettings>>
  ask(req: { id: string; messages: LocalMessage[]; maxTokens?: number; temperature?: number }): Promise<AIReply<true>>
  cancelAsk(id: string): Promise<AIReply<true>>
  selection(): Promise<AIReply<string>>
  clipboard(): Promise<AIReply<string>>
  readFile(root: string, rel: string): Promise<AIReply<{ name: string; text: string }>>
  onEvent(cb: (ev: LocalAIEvent) => void): () => void
  onChanged(cb: () => void): () => void
}

declare global {
  interface Window { worksuiteAI?: AIApi }
}

const none = async () => ({ ok: false as const, error: 'service_unavailable' })
/** A plain browser (design review): no service, so every call says so. */
export const unavailableAI: AIApi = {
  status: none, models: none, refresh: none, install: none, cancel: none, remove: none, setDefault: none, check: none, test: none,
  restart: none, setSettings: none, ask: none, cancelAsk: none, selection: none, clipboard: none, readFile: none,
  onEvent: () => () => {}, onChanged: () => () => {},
}

export const ai = (): AIApi => (typeof window !== 'undefined' && window.worksuiteAI) || unavailableAI

/** Status and models, re-read whenever the service says something changed (downloads, the runtime, policy). */
export function useAI(enabled = true) {
  const [status, setStatus] = useState<AIReply<LocalAIStatus> | null>(null)
  const [models, setModels] = useState<AIReply<LocalModelView[]> | null>(null)
  const reload = useCallback(async () => {
    const [s, m] = await Promise.all([ai().status(), ai().models()])
    setStatus(s)
    setModels(m)
  }, [])
  useEffect(() => {
    if (!enabled) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    // Changes come at most every 250 ms from the service; coalesce them here too.
    const soon = () => { if (timer) return; timer = setTimeout(() => { timer = null; if (live) void reload() }, 150) }
    void reload()
    const off = ai().onChanged(soon)
    return () => { live = false; off(); if (timer) clearTimeout(timer) }
  }, [enabled, reload])
  return { status, models, reload }
}

// ── Desktop's setup logic (src/modules/ai/setup.ts, src/core/local-ai.ts) ─────────────────────────────

export const STORAGE_MARGIN = 512 * 1024 * 1024
export type Stage = 'downloading' | 'verifying' | 'preparing' | 'ready'
export const STAGES: { id: Stage; label: MessageKey }[] = [
  { id: 'downloading', label: 'ai.stage.downloading' },
  { id: 'verifying', label: 'ai.stage.verifying' },
  { id: 'preparing', label: 'ai.stage.preparing' },
  { id: 'ready', label: 'ai.stage.ready' },
]

/** A model on this computer that can answer now: installed, and it passed (or predates) the readiness check. */
export function usableModel(models: LocalModelView[] | undefined): LocalModelView | null {
  return (models ?? []).find((m) => m.model.purpose === 'chat' && m.state === 'installed' && (m.readiness === 'ready' || m.readiness === 'untested')) ?? null
}

/** The default model, installed and not failing (or still in) its readiness check: the assistant can answer. */
export function localReady(models: LocalModelView[] | undefined): LocalModelView | null {
  return models?.find((m) => m.isDefault && m.state === 'installed' && m.readiness !== 'failed' && m.readiness !== 'testing') ?? null
}

export function inProgress(models: LocalModelView[] | undefined): LocalModelView | null {
  return (models ?? []).find((m) => m.model.purpose === 'chat' && (m.state === 'downloading' || m.state === 'verifying' || m.state === 'paused' || m.state === 'failed' || (m.state === 'installed' && (m.readiness === 'testing' || m.readiness === 'failed')))) ?? null
}

/** Recommended for this computer, else the smallest that fits, else the smallest (only downloadable models). */
export function suggestedModel(models: LocalModelView[] | undefined): LocalModelView | null {
  const chat = (models ?? []).filter((m) => m.model.purpose === 'chat')
  if (!chat.length || chat.some((m) => m.state === 'installed')) return null
  const offered = chat.filter((m) => m.state !== 'unpublished')
  const fitting = offered.filter((m) => m.fits)
  const smallest = (list: LocalModelView[]) => [...list].sort((a, b) => a.model.bytes - b.model.bytes)[0]
  return fitting.find((m) => m.recommended) ?? smallest(fitting) ?? smallest(offered) ?? null
}

export function firstUseOffer(models: LocalModelView[] | undefined, suggested: LocalModelView | null): LocalModelView | null {
  if (usableModel(models)) return null
  return inProgress(models) ?? suggested
}

export function stageOf(v: LocalModelView): { stage: Stage; stopped: 'paused' | 'failed' | null } {
  if (v.state === 'downloading') return { stage: 'downloading', stopped: null }
  if (v.state === 'paused') return { stage: 'downloading', stopped: 'paused' }
  if (v.state === 'verifying') return { stage: 'verifying', stopped: null }
  if (v.state === 'failed') return { stage: v.error === 'mismatch' || v.error === 'download_too_large' ? 'verifying' : 'downloading', stopped: 'failed' }
  if (v.state === 'installed') {
    if (v.readiness === 'testing') return { stage: 'preparing', stopped: null }
    if (v.readiness === 'failed') return { stage: 'preparing', stopped: 'failed' }
    return { stage: 'ready', stopped: null }
  }
  return { stage: 'downloading', stopped: null }
}

export type ProblemKind = 'connection' | 'storage' | 'mismatch' | 'setup' | 'memory' | 'other'
/** What kind of trouble an error code is, so the person is told what to do, not only what happened. */
export function problemKind(code: string | null | undefined, readiness = false): ProblemKind {
  if (code === 'out_of_memory') return 'memory'
  if (readiness) return 'setup'
  if (code === 'no_space') return 'storage'
  if (code === 'mismatch' || code === 'download_too_large' || code === 'mismatch_installed') return 'mismatch'
  if (code === 'connection' || code === 'download_failed') return 'connection'
  return 'other'
}
export const PROBLEM_ADVICE: Record<ProblemKind, MessageKey> = {
  connection: 'ai.advice.connection', storage: 'ai.advice.storage', mismatch: 'ai.advice.mismatch', setup: 'ai.advice.setup', memory: 'ai.advice.memory', other: 'ai.advice.other',
}

export function storageNeeded(v: Pick<LocalModelView, 'received' | 'model'>): number {
  return Math.max(0, (v.model.bytes || v.model.approxBytes || 0) - v.received) + STORAGE_MARGIN
}
export function compatibility(v: LocalModelView, hw: LocalAIHardware | null | undefined): { storage: boolean; slow: boolean; free: number | null } {
  const free = hw?.freeDiskBytes ?? null
  return { storage: free !== null && free < storageNeeded(v), slow: !v.fits, free }
}
export function secondsLeft(v: Pick<LocalModelView, 'received' | 'model' | 'bytesPerSecond'>): number | null {
  if (!v.bytesPerSecond || v.bytesPerSecond <= 0) return null
  return Math.max(0, Math.round((v.model.bytes - v.received) / v.bytesPerSecond))
}
export function timeLeftLabel(s: number | null): string | null {
  if (s === null) return null
  if (s < 60) return t('ai.left.lessThanMinute')
  if (s < 3600) return t('ai.left.minutes', { n: Math.round(s / 60) })
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return m ? t('ai.left.hoursMinutes', { h, m }) : t('ai.left.hours', { h })
}
/** The model's download size: exact once published, else "about". */
export function downloadSize(m: LocalModel, fmt: (n: number) => string): string {
  return m.bytes ? fmt(m.bytes) : m.approxBytes ? t('ai.aboutSize', { size: fmt(m.approxBytes) }) : t('common.unavailable')
}

const ERRORS: Record<string, MessageKey> = {
  service_unavailable: 'ai.err.service', service_timeout: 'ai.err.service', bad_reply: 'ai.err.service',
  no_model: 'ai.err.noModel', model_not_ready: 'ai.err.notReady', disabled: 'ai.err.disabled', disabled_by_policy: 'ai.err.policy',
  model_not_allowed: 'ai.err.notAllowed', not_in_catalog: 'ai.err.notInCatalog', unpublished: 'ai.err.unpublished',
  out_of_memory: 'ai.err.memory', crashed: 'ai.err.crashed', crashed_loading: 'ai.err.crashed', crashed_testing: 'ai.err.crashedTesting',
  crash_loop: 'ai.err.crashLoop', start_timeout: 'ai.err.start', engine_unavailable: 'ai.err.start', engine_failed: 'ai.err.start',
  load_timeout: 'ai.err.load', load_failed: 'ai.err.load', generate_failed: 'ai.err.generate', no_answer_timeout: 'ai.err.noAnswer', empty_answer: 'ai.err.noAnswer',
  too_large: 'ai.err.tooLarge', invalid_argument: 'ai.err.invalid', bad_request: 'ai.err.invalid',
  connection: 'ai.err.connection', download_failed: 'ai.err.connection', no_space: 'ai.err.space', mismatch: 'ai.err.mismatch',
  download_too_large: 'ai.err.mismatch', mismatch_installed: 'ai.err.mismatchInstalled', host_not_allowed: 'ai.err.host',
  catalog_missing: 'ai.err.catalog', catalog_invalid: 'ai.err.catalog', catalog_expired: 'ai.err.catalogExpired', catalog_bad_signature: 'ai.err.catalog',
  catalog_unknown_key: 'ai.err.catalog', catalog_fetch_failed: 'ai.err.catalog',
  no_selection: 'ai.err.noSelection', no_clipboard: 'ai.err.noClipboard', not_text: 'ai.err.notText', file_too_large: 'ai.err.fileTooLarge', not_a_file: 'ai.err.notText',
}
/** An error code from the service or the shell → a sentence in the person's language. */
export function aiErrorText(code: string | null | undefined): string {
  return t(ERRORS[code ?? ''] ?? 'ai.err.other')
}
export const needsSetup = (code: string) => code === 'no_model' || code === 'model_not_ready' || code === 'mismatch_installed' || code === 'out_of_memory'
