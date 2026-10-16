// Theme icons for installed apps (desktop entries' Icon=), fetched from the main process in batches and cached for
// the session. A name with no icon resolves to null, and the caller draws the letter mark instead.
import { useEffect, useState } from 'react'
import { os } from './os'

type Entry = string | null
const cache = new Map<string, Entry>()
const waiters = new Map<string, Set<(v: Entry) => void>>()
let queue = new Map<string, { name: string; size: number; scale: number }>()
let scheduled = false

const keyOf = (name: string, size: number, scale: number) => `${name}\0${size}\0${scale}`
const scaleNow = () => Math.min(4, Math.max(1, Math.ceil(globalThis.devicePixelRatio || 1)))

function flush() {
  scheduled = false
  const batch = queue
  queue = new Map()
  const groups = new Map<string, { size: number; scale: number; names: string[] }>()
  for (const q of batch.values()) {
    const g = groups.get(`${q.size}:${q.scale}`) ?? { size: q.size, scale: q.scale, names: [] }
    g.names.push(q.name)
    groups.set(`${q.size}:${q.scale}`, g)
  }
  const api = globalThis.window?.worksuite?.appIcons ?? os.appIcons?.bind(os)
  for (const g of groups.values()) {
    const done = (r: Record<string, string | null> | null) => {
      for (const n of g.names) {
        const v = r && typeof r[n] === 'string' && r[n]!.startsWith('data:image/') ? r[n]! : null
        const k = keyOf(n, g.size, g.scale)
        cache.set(k, v)
        waiters.get(k)?.forEach((f) => f(v))
        waiters.delete(k)
      }
    }
    if (!api) { done(null); continue }
    api(g.names, g.size, g.scale).then(done, () => done(null))
  }
}

/** Request an icon; `cb` gets the data: URL or null. Returns the cached value when there is one. */
export function requestIcon(name: string, size: number, cb: (v: Entry) => void): Entry | undefined {
  const scale = scaleNow()
  const k = keyOf(name, size, scale)
  if (cache.has(k)) return cache.get(k)
  if (!waiters.has(k)) waiters.set(k, new Set())
  waiters.get(k)!.add(cb)
  queue.set(k, { name, size, scale })
  if (!scheduled) { scheduled = true; queueMicrotask(flush) }
  return undefined
}

/** A theme icon's data: URL; undefined while loading, null when the theme has none. */
export function useThemeIcon(name: string | null | undefined, size: number): Entry | undefined {
  const [cur, setCur] = useState<{ k: string; v: Entry | undefined }>({ k: '', v: undefined })
  const k = name ? `${name}@${size}` : ''
  let v: Entry | undefined = cur.k === k ? cur.v : undefined
  if (name && v === undefined) {
    const c = cache.get(keyOf(name, size, scaleNow()))
    if (c !== undefined) v = c
  }
  useEffect(() => {
    if (!name) return
    let live = true
    const r = requestIcon(name, size, (x) => { if (live) setCur({ k, v: x }) })
    if (r !== undefined) setCur({ k, v: r })
    return () => { live = false }
  }, [name, size, k])
  return name ? v : null
}

/** Tests: forget everything. */
export function resetIconCache() { cache.clear(); waiters.clear(); queue = new Map(); scheduled = false }
