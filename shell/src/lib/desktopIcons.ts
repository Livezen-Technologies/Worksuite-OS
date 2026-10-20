// Desktop icons and the desktop's right-click menu (#27): the XDG Desktop folder shown on the wallpaper, its sort
// order and icon size. The view is a per-computer convenience (localStorage), like Files' own view choice.
import type { FileEntry } from './os'

export type DeskSort = 'name' | 'modified' | 'type' | 'size'
export type DeskSize = 'small' | 'medium' | 'large'
export interface DeskView { show: boolean; size: DeskSize; sort: DeskSort }
export const DEFAULT_DESK_VIEW: DeskView = { show: true, size: 'medium', sort: 'name' }
export const DESK_SORTS: DeskSort[] = ['name', 'modified', 'type', 'size']
export const DESK_SIZES: DeskSize[] = ['large', 'medium', 'small']
/** Tile and glyph size (px) per icon size. */
export const DESK_PX: Record<DeskSize, { tile: number; glyph: number }> = { small: { tile: 76, glyph: 32 }, medium: { tile: 92, glyph: 44 }, large: { tile: 116, glyph: 60 } }

const KEY = 'ws.desktopView'

export function loadDeskView(store: Pick<Storage, 'getItem'> | null = safeStorage()): DeskView {
  try {
    const v = JSON.parse(store?.getItem(KEY) ?? 'null') as Partial<DeskView> | null
    if (!v || typeof v !== 'object') return DEFAULT_DESK_VIEW
    return {
      show: v.show !== false,
      size: DESK_SIZES.includes(v.size as DeskSize) ? v.size as DeskSize : DEFAULT_DESK_VIEW.size,
      sort: DESK_SORTS.includes(v.sort as DeskSort) ? v.sort as DeskSort : DEFAULT_DESK_VIEW.sort,
    }
  } catch { return DEFAULT_DESK_VIEW }
}
export function saveDeskView(v: DeskView, store: Pick<Storage, 'setItem'> | null = safeStorage()) {
  try { store?.setItem(KEY, JSON.stringify(v)) } catch { /* private window: this session only */ }
}
function safeStorage(): Storage | null { try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null } }

export const extOf = (name: string) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : '' }

/** Folders first, then by the chosen key (name breaks ties), like Files and other desktops. */
export function sortDesk(entries: FileEntry[], by: DeskSort): FileEntry[] {
  const name = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  const key: Record<DeskSort, (a: FileEntry, b: FileEntry) => number> = {
    name,
    modified: (a, b) => (b.modified ?? 0) - (a.modified ?? 0),
    type: (a, b) => extOf(a.name).localeCompare(extOf(b.name)),
    size: (a, b) => (b.size ?? 0) - (a.size ?? 0),
  }
  return entries.filter((e) => !e.name.startsWith('.')).slice().sort((a, b) => Number(b.dir) - Number(a.dir) || key[by](a, b) || name(a, b))
}

/** "New folder", then "New folder (2)"…; the extension stays last ("New text document (2).txt"). */
export function uniqueName(existing: Iterable<string>, base: string): string {
  const taken = new Set([...existing].map((n) => n.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base, ext = dot > 0 ? base.slice(dot) : ''
  for (let i = 2; ; i++) { const n = `${stem} (${i})${ext}`; if (!taken.has(n.toLowerCase())) return n }
}
