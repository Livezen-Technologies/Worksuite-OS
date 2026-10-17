// Global search model (design board docs/design/boot-install/project/GlobalSearch.dc.html): groups, category chips
// and keyboard selection over real results only: apps, Settings pages, WorkSuite records by type and files.
import type { SearchHit, SourceResult, SourceState } from '../../electron/search'
import type { LauncherApp } from './launcher'
import type { MessageKey } from '../i18n'

export type GroupId = 'apps' | 'settings' | 'mail' | 'contact' | 'crm' | 'task' | 'chat' | 'event' | 'note' | 'project' | 'document' | 'record' | 'files' | 'ai'

export type Item =
  | { kind: 'app'; id: string; app: LauncherApp }
  | { kind: 'setting'; id: string; label: string; section: string }
  | { kind: 'hit'; id: string; hit: SearchHit }
  | { kind: 'more'; id: string }
  /** "Ask AI": the query goes to the on-device assistant (services/ai). */
  | { kind: 'ai'; id: string }

export interface Group { id: GroupId; items: Item[] }

/** Board order: apps and settings first, then WorkSuite records by type, then files. */
export const GROUP_ORDER: GroupId[] = ['apps', 'settings', 'mail', 'contact', 'crm', 'task', 'chat', 'event', 'note', 'project', 'document', 'record', 'files']

export const GROUP_LABEL: Record<GroupId, MessageKey> = {
  apps: 'search.group.apps', settings: 'search.group.settings', mail: 'search.group.mail', contact: 'search.group.contact', crm: 'search.group.crm',
  task: 'search.group.task', chat: 'search.group.chat', event: 'search.group.event', note: 'search.group.note', project: 'search.group.project',
  document: 'search.group.document', record: 'search.group.record', files: 'search.group.files', ai: 'search.group.ai',
}

/** Mark colours per result kind, from the board's palette. */
export const MARK: Record<GroupId, { c: string; i: string }> = {
  apps: { c: '#2E9E6A', i: 'A' }, settings: { c: '#5E739C', i: '⚙' }, mail: { c: '#D9572B', i: 'M' }, contact: { c: '#7A4FE0', i: 'P' },
  crm: { c: '#BE123C', i: 'CR' }, task: { c: '#B7791F', i: 'T' }, chat: { c: '#15803D', i: 'Ch' }, event: { c: '#4338CA', i: 'C' },
  note: { c: '#0E8FA8', i: 'N' }, project: { c: '#A21CAF', i: 'Pr' }, document: { c: '#1D4ED8', i: 'D' }, record: { c: '#5E739C', i: 'W' }, files: { c: '#1F6BFF', i: 'F' },
  ai: { c: '#7A4FE0', i: '✦' },
}

const EXT_MARK: Record<string, { c: string; i: string }> = {
  xlsx: { c: '#2E9E6A', i: 'X' }, xls: { c: '#2E9E6A', i: 'X' }, ods: { c: '#2E9E6A', i: 'X' }, csv: { c: '#2E9E6A', i: 'X' },
  pdf: { c: '#D9452B', i: 'P' }, docx: { c: '#1D4ED8', i: 'W' }, doc: { c: '#1D4ED8', i: 'W' }, odt: { c: '#1D4ED8', i: 'W' },
  pptx: { c: '#C2410C', i: 'S' }, odp: { c: '#C2410C', i: 'S' }, png: { c: '#7A4FE0', i: 'I' }, jpg: { c: '#7A4FE0', i: 'I' }, jpeg: { c: '#7A4FE0', i: 'I' },
}

export function markOf(item: Item): { c: string; i: string } {
  if (item.kind === 'app') return { c: '#1F6BFF', i: item.app.mark }
  if (item.kind === 'setting') return MARK.settings
  if (item.kind === 'more') return MARK.record
  if (item.kind === 'ai') return MARK.ai
  if (item.hit.type === 'file') return EXT_MARK[item.hit.ext ?? ''] ?? MARK.files
  return MARK[groupOfType(item.hit.type)]
}

export function groupOfType(type: string): GroupId {
  if (type === 'file') return 'files'
  return (GROUP_ORDER as string[]).includes(type) && type !== 'apps' && type !== 'settings' ? (type as GroupId) : 'record'
}

export interface Inputs {
  apps: LauncherApp[]
  settings: { label: string; section: string }[]
  /** Local recent files matching the query. */
  local: SearchHit[]
  /** Server results, merged by relevance (null while the first answer is pending). */
  hits: SearchHit[] | null
  query: string
}

/** Groups in board order; files merge local matches and Drive hits; "Search in WorkSuite" closes the WorkSuite part. */
export function buildGroups(i: Inputs, signedIn: boolean, askAI = false): Group[] {
  const by = new Map<GroupId, Item[]>()
  const push = (g: GroupId, it: Item) => { if (!by.has(g)) by.set(g, []); by.get(g)!.push(it) }
  for (const a of i.apps) push('apps', { kind: 'app', id: `app:${a.id}`, app: a })
  for (const s of i.settings) push('settings', { kind: 'setting', id: `set:${s.section}:${s.label}`, ...s })
  for (const h of i.hits ?? []) push(groupOfType(h.type), { kind: 'hit', id: h.id, hit: h })
  for (const h of i.local) push('files', { kind: 'hit', id: h.id, hit: h })
  const groups = GROUP_ORDER.filter((g) => by.has(g)).map((id) => ({ id, items: by.get(id)! }))
  if (signedIn && i.query.trim()) groups.push({ id: 'record', items: [{ kind: 'more', id: 'more' }] })
  // "Ask AI" closes the list: the question goes to the assistant on this computer.
  if (askAI && i.query.trim()) groups.push({ id: 'ai', items: [{ kind: 'ai', id: 'ai' }] })
  return groups
}


export type Category = 'all' | GroupId

/** Chips: All, then each group with a count (the "Search in WorkSuite" row is not counted). */
export function categories(groups: Group[]): { id: Category; n: number }[] {
  const count = (g: Group) => g.items.filter((x) => x.kind !== 'more' && x.kind !== 'ai').length
  return [{ id: 'all' as Category, n: groups.reduce((s, g) => s + count(g), 0) }, ...groups.filter((g) => count(g) > 0).map((g) => ({ id: g.id as Category, n: count(g) }))]
}

export function visible(groups: Group[], cat: Category): Group[] {
  return cat === 'all' ? groups : groups.filter((g) => g.id === cat).map((g) => ({ ...g, items: g.items.filter((x) => x.kind !== 'more' && x.kind !== 'ai') }))
}

export const flat = (groups: Group[]) => groups.flatMap((g) => g.items)

export type NavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' | 'Tab' | 'ShiftTab'

/** Keyboard: arrows move (wrapping), Home/End jump, Tab/Shift+Tab switch category (selection back to the top). */
export function navigate(state: { sel: number; cat: Category }, key: NavKey, count: number, cats: Category[]): { sel: number; cat: Category } {
  switch (key) {
    case 'ArrowDown': return { ...state, sel: count ? (state.sel + 1) % count : 0 }
    case 'ArrowUp': return { ...state, sel: count ? (state.sel - 1 + count) % count : 0 }
    case 'Home': return { ...state, sel: 0 }
    case 'End': return { ...state, sel: Math.max(0, count - 1) }
    case 'Tab': case 'ShiftTab': {
      const i = Math.max(0, cats.indexOf(state.cat))
      const n = cats.length || 1
      return { sel: 0, cat: cats[(i + (key === 'Tab' ? 1 : -1) + n) % n] ?? 'all' }
    }
  }
}

/** Footer status: what the search covers right now, from the source states. */
export function coverage(sources: SourceResult[] | null, loading: boolean): MessageKey {
  if (loading) return 'search.status.searching'
  if (!sources || sources.length === 0) return 'search.status.device'
  const st = (s: SourceState) => sources.some((x) => x.state === s)
  if (sources.every((x) => x.state === 'ok')) return 'search.status.all'
  if (st('not_signed_in')) return 'search.status.signedOut'
  if (st('locked')) return 'search.status.locked'
  if (st('auth_required')) return 'search.status.auth'
  if (st('offline')) return 'search.status.offline'
  if (st('timeout')) return 'search.status.timeout'
  return 'search.status.partial'
}
