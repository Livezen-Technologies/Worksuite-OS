// The assistant's conversation, kept outside the panel (as Desktop's session.ts) so closing and reopening the panel —
// Super+A, the panel button, "Ask AI" from search — goes on with the same chat and an answer still on its way.
//
// History stays on this computer only (the shell's own storage); it can be turned off and cleared in Settings › AI.
// Nothing is ever answered except by the model: no canned replies, no fallback text dressed up as an answer.
import { useSyncExternalStore } from 'react'
import { ai, type LocalAIEvent, type LocalMessage } from './aiApi'
import { getLocale, t } from '../i18n'

export type ContextKind = 'selection' | 'clipboard' | 'file'
export interface AskEntry {
  role: 'user' | 'assistant'
  text: string
  /** What went with the question (shown as a chip; the model got the text). */
  context?: { kind: ContextKind; name?: string; chars: number }
  /** The prompt the model was given for this turn, when it differs from `text` (context actions). */
  prompt?: string
  /** An error code (aiApi ERRORS), shown as an error with Try again. */
  error?: string
  stopped?: boolean
}
export type AskPhase = 'idle' | 'thinking' | 'answering'
export interface AskState { entries: AskEntry[]; streaming: string | null; busy: boolean; phase: AskPhase; requestId: string | null; text: string }

/** Desktop's on-device system prompt (session.ts LOCAL_SYSTEM), for what the OS assistant can see. */
export const LOCAL_SYSTEM = "You are WorkSuite's assistant, running on this computer. Answer clearly and briefly. You cannot see the person's files, mail or other data, or change anything; you only see what they type here, or the text they chose to include (a selection, the clipboard or a file). Say so when a question needs more."
const LANGUAGE_NAMES: Record<string, string> = { en: 'English', si: 'Sinhala', ta: 'Tamil' }
/** Desktop's reply-language instruction (shared/localization.ts). */
export function replyLanguageInstruction(locale: string): string {
  return `Answer in ${LANGUAGE_NAMES[locale] ?? 'English'} by default, even if the question uses another language. If the user explicitly requests another reply language, follow that request. Preserve names, numbers, currencies and user-provided content unless translation is requested.`
}

/** Prompts for the context actions (after Desktop's textTools INSTRUCTIONS). */
export const CONTEXT_PROMPTS = {
  summarize: 'Summarise the text below for someone who has not read it, in a few short bullet points: what it is about, the key facts, and anything it asks or decides. Use only what the text says. Return only the summary.',
  explain: 'Explain the file below for someone who has not seen it: what kind of file it is, what it says or does, and anything notable in it. Be brief. Use only what the file contains.',
} as const

const HISTORY_KEY = 'ws.ai.history'
const PREFS_KEY = 'ws.ai.prefs'
const HISTORY_MAX = 100
/** How much of the earlier conversation goes back to the model (characters), newest first. */
const HISTORY_BUDGET = 24_000
const QUESTION_MAX = 4000

export interface AssistantPrefs { history: boolean }
export function loadPrefs(): AssistantPrefs {
  try { const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}'); return { history: p.history !== false } } catch { return { history: true } }
}
export function savePrefs(p: AssistantPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* a convenience */ }
  if (!p.history) clearHistory()
}
function loadHistory(): AskEntry[] {
  if (!loadPrefs().history) return []
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((e) => e && (e.role === 'user' || e.role === 'assistant') && typeof e.text === 'string').slice(-HISTORY_MAX) : []
  } catch { return [] }
}
function saveHistory(entries: AskEntry[]): void {
  if (!loadPrefs().history) return
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(-HISTORY_MAX))) } catch { /* full or blocked: the chat still works */ }
}
export function clearHistory(): void {
  try { localStorage.removeItem(HISTORY_KEY) } catch { /* nothing kept */ }
  if (!state.busy) set({ entries: [] })
}

let state: AskState = { entries: loadHistory(), streaming: null, busy: false, phase: 'idle', requestId: null, text: '' }
const listeners = new Set<() => void>()
function set(patch: Partial<AskState>): void {
  state = { ...state, ...patch }
  if ('entries' in patch) saveHistory(state.entries)
  listeners.forEach((l) => l())
}
export const assistantStore = {
  get: () => state,
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
  setText: (text: string) => set({ text: text.slice(0, QUESTION_MAX) }),
}
export function useAssistant(): AskState {
  return useSyncExternalStore(assistantStore.subscribe, assistantStore.get, assistantStore.get)
}

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`).replace(/[^A-Za-z0-9-]/g, '').slice(0, 64)

/** The conversation the model sees: the system text, the earlier turns that fit, then this question. */
export function buildMessages(before: AskEntry[], prompt: string, locale: string): LocalMessage[] {
  const turns: LocalMessage[] = []
  let room = HISTORY_BUDGET
  // Only answered turns: a question whose answer failed (or never came) is left out with its error.
  const answered = before.filter((e, i) => !e.error && (e.role === 'assistant' || (before[i + 1]?.role === 'assistant' && !before[i + 1]!.error)))
  for (const e of [...answered].reverse()) {
    const content = e.prompt ?? e.text
    if (content.length > room) break
    room -= content.length
    turns.unshift({ role: e.role, content })
  }
  // A conversation must alternate and the earlier part must start with the person.
  while (turns.length && turns[0]!.role !== 'user') turns.shift()
  return [{ role: 'system', content: `${LOCAL_SYSTEM}\n${replyLanguageInstruction(locale)}` }, ...turns, { role: 'user', content: prompt }]
}

let offEvents: (() => void) | null = null

async function run(entry: AskEntry): Promise<void> {
  const before = state.entries
  const id = newId()
  set({ entries: [...before, entry], busy: true, phase: 'thinking', streaming: null, requestId: id, text: '' })
  let text = ''
  offEvents?.()
  const finish = (patch: Partial<AskEntry> & { text: string }) => {
    offEvents?.(); offEvents = null
    set({ entries: [...state.entries, { role: 'assistant', ...patch }], busy: false, phase: 'idle', streaming: null, requestId: null })
  }
  offEvents = ai().onEvent((ev: LocalAIEvent) => {
    if (ev.id !== id) return
    if (ev.type === 'chunk') { text += ev.text; set({ streaming: text, phase: 'answering' }) }
    else if (ev.type === 'done') {
      const full = (ev.text || text).trim()
      if (ev.cancelled) finish({ text: full || t('ai.stopped'), stopped: true })
      else if (!full) finish({ text: t('ai.err.noAnswer'), error: 'empty_answer' })
      else finish({ text: full })
    } else finish({ text: '', error: ev.code })
  })
  const r = await ai().ask({ id, messages: buildMessages(before, entry.prompt ?? entry.text, getLocale()) })
  if (!r.ok && state.requestId === id) finish({ text: '', error: r.error })
}

/** Sends what is in the box. */
export function send(): Promise<void> {
  const q = state.text.trim()
  if (!q || state.busy) return Promise.resolve()
  return run({ role: 'user', text: q })
}

/** "Summarise the selection / the clipboard", "Explain this file": the person's own action, with that text only. */
export function sendWithContext(kind: ContextKind, body: string, name?: string): Promise<void> {
  if (state.busy || !body.trim()) return Promise.resolve()
  const label = kind === 'selection' ? t('ai.ctx.summarizeSelection') : kind === 'clipboard' ? t('ai.ctx.summarizeClipboard') : t('ai.ctx.explainFileNamed', { name: name ?? '' })
  const instruction = kind === 'file' ? CONTEXT_PROMPTS.explain : CONTEXT_PROMPTS.summarize
  const prompt = `${instruction}\n\n${kind === 'file' ? `File: ${name}\n` : ''}"""\n${body}\n"""`
  return run({ role: 'user', text: label, prompt, context: { kind, name, chars: body.length } })
}

export function cancel(): void {
  if (state.requestId) void ai().cancelAsk(state.requestId)
}

/** New chat: the conversation (and its saved history) starts again. */
export function reset(): void {
  if (state.busy) cancel()
  offEvents?.(); offEvents = null
  set({ entries: [], streaming: null, busy: false, phase: 'idle', requestId: null })
}

/** Try again: the last question, asked afresh. */
export function retry(): Promise<void> {
  const i = state.entries.map((e) => e.role).lastIndexOf('user')
  if (i < 0 || state.busy) return Promise.resolve()
  const q = state.entries[i]!
  set({ entries: state.entries.slice(0, i) })
  return run({ ...q })
}

/** Tests: start from nothing. */
export function resetForTests(): void {
  offEvents?.(); offEvents = null
  state = { entries: [], streaming: null, busy: false, phase: 'idle', requestId: null, text: '' }
}
