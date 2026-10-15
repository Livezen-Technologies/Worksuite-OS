// G14 "Update from a USB drive": offline .wsupdate bundles (WSOS-AUP-010) found at the top level of mounted
// removable drives, so the Updates page can offer one without a file dialog. Only file names and the drive label
// reach the renderer; main.ts keeps the paths behind opaque handles, the same as pickFile('wsupdate').
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export interface FoundBundle { path: string; name: string; drive: string; mtime: number }

/** Newest first; at most 4 per drive. Unreadable drives and non-files are skipped. */
export function findBundles(drives: { label: string; path: string }[]): FoundBundle[] {
  const out: FoundBundle[] = []
  for (const d of drives) {
    let names: string[]
    try { names = readdirSync(d.path) } catch { continue }
    const found: FoundBundle[] = []
    for (const n of names) {
      if (!n.endsWith('.wsupdate') || n.startsWith('.')) continue
      const p = path.join(d.path, n)
      try { const s = statSync(p); if (s.isFile()) found.push({ path: p, name: n, drive: d.label, mtime: s.mtimeMs }) } catch { /* skip */ }
    }
    out.push(...found.sort((a, b) => b.mtime - a.mtime).slice(0, 4))
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}
